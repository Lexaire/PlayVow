import { eq } from 'drizzle-orm'

import type { Db } from '#/db/client'
import { steamApps, steamSubs, users } from '#/db/schema'
import type { SgClient } from '#/external/steamgifts'
import type { Logger } from '#/lib/logger'
import { listGiveawaysNeedingWinnersBackfill, setWinnersScrapedAt } from '#/repos/giveaways'
import { findGroupById } from '#/repos/groups'
import { recordScrapedWin, type ScrapedSgUser, type ScrapedSteamTarget } from '#/repos/scrapeWrite'
import type { SgClientFactory } from '#/worker/jobs/scrape-group'

export type BackfillWinnersDeps = {
  readonly db: Db
  readonly dbWrite: Db
  readonly sgClientForGroup: SgClientFactory
  readonly logger: Logger
  readonly now?: () => Date
}

export type BackfillWinnersSummary = {
  readonly processed: number
  readonly winners: number
  readonly errors: number
}

export const backfillWinners = async (
  deps: BackfillWinnersDeps,
): Promise<BackfillWinnersSummary> => {
  const log = deps.logger.child({ job: 'backfill_winners' })
  const now = deps.now ?? (() => new Date())
  const backedAt = now()
  const BATCH_LIMIT = 100

  const candidates = await listGiveawaysNeedingWinnersBackfill(deps.db, { limit: BATCH_LIMIT })

  if (candidates.length === 0) {
    log.info('backfill_completed', { processed: 0 })
    return { processed: 0, winners: 0, errors: 0 }
  }

  let processedCount = 0
  let winnersRecordedCount = 0
  let errors = 0

  // Cache SG clients per group across the batch to avoid one DB lookup +
  // decrypt per giveaway when several share a group.
  const sgByGroup = new Map<number, SgClient>()
  const skippedGroupIds = new Set<number>()

  for (const giveaway of candidates) {
    if (!giveaway.slug) {
      log.info('skipping_no_slug', { giveawayId: giveaway.id })
      continue
    }
    // Manual giveaways have no SG code; the listGiveawaysNeedingWinnersBackfill
    // query already filters on lastScrapedAt being set, which manual groups
    // never set, so we shouldn't see one here. Belt-and-braces guard for the
    // type narrowing.
    if (giveaway.steamgiftsCode === null) {
      continue
    }
    const sgCode = giveaway.steamgiftsCode

    const group = await findGroupById(deps.db, giveaway.groupId)
    if (!group) {
      log.error('group_not_found', { groupId: giveaway.groupId })
      await setWinnersScrapedAt(deps.dbWrite, giveaway.id, backedAt)
      continue
    }

    if (skippedGroupIds.has(group.id)) continue
    let sg = sgByGroup.get(group.id)
    if (!sg) {
      sg = await deps.sgClientForGroup(group.id)
      // Backfill only calls getGiveawayWinners — the auth-gated path. Without
      // a cookie, every call would return login_required. Skip cleanly so we
      // don't burn rate-limit budget on guaranteed failures. The daily
      // listing scrape still runs anonymously and brings in 1–2 copy
      // winners; only the multi-copy reconciliation needs a cookie.
      if (!sg.hasCookie) {
        skippedGroupIds.add(group.id)
        log.warn('backfill_skip_no_cookie', {
          groupId: group.id,
          groupSlug: group.slug,
        })
        continue
      }
      sgByGroup.set(group.id, sg)
    }

    const winnersR = await sg.getGiveawayWinners(sgCode, giveaway.slug)
    if (!winnersR.ok) {
      errors += 1
      log.warn('get_winners_failed', {
        giveawayId: giveaway.id,
        code: sgCode,
        error: winnersR.error.kind,
      })
      // Don't mark settled — transient error, retry on next backfill run.
      continue
    }

    const { activated: winnerUsernames, awaitingCount } = winnersR.value

    // True no-winners (fa-ban): dedicated page is completely empty.
    if (winnerUsernames.length === 0 && awaitingCount === 0) {
      await setWinnersScrapedAt(deps.dbWrite, giveaway.id, backedAt)
      processedCount += 1
      continue
    }

    // Dedicated page is authoritative — settled iff nothing is still awaiting.
    // activated.length may be < quantity (low-entry giveaways finalize with
    // fewer winners than copies); that's fine, the page is in terminal state.
    const settled = awaitingCount === 0

    if (winnerUsernames.length === 0) {
      // Only awaiting-feedback rows visible — nothing to record yet.
      log.info('still_awaiting', {
        giveawayId: giveaway.id,
        awaitingCount,
      })
      processedCount += 1
      continue
    }

    const [creator] = await deps.db
      .select()
      .from(users)
      .where(eq(users.id, giveaway.creatorUserId))
      .limit(1)
    if (!creator) {
      log.error('creator_not_found', { creatorUserId: giveaway.creatorUserId })
      continue
    }
    if (creator.steamgiftsUsername === null) {
      log.error('creator_missing_sg_username', { creatorUserId: giveaway.creatorUserId })
      continue
    }

    const creatorMeta: ScrapedSgUser = {
      steamgiftsUsername: creator.steamgiftsUsername,
      steamId: creator.steamId,
      avatarUrl: creator.avatarUrl,
      profileVisibility: creator.profileVisibility,
    }

    let target: ScrapedSteamTarget
    if (giveaway.steamAppId !== null) {
      const [app] = await deps.db
        .select()
        .from(steamApps)
        .where(eq(steamApps.appId, giveaway.steamAppId))
        .limit(1)
      target = { kind: 'app', appId: giveaway.steamAppId, name: app?.name ?? 'Unknown' }
    } else if (giveaway.steamSubId !== null) {
      const [sub] = await deps.db
        .select()
        .from(steamSubs)
        .where(eq(steamSubs.subId, giveaway.steamSubId))
        .limit(1)
      target = { kind: 'sub', subId: giveaway.steamSubId, name: sub?.name ?? 'Unknown' }
    } else {
      log.error('no_target', { giveawayId: giveaway.id })
      continue
    }

    for (const username of winnerUsernames) {
      const [winner] = await deps.db
        .select()
        .from(users)
        .where(eq(users.steamgiftsUsername, username))
        .limit(1)
      if (!winner) {
        log.warn('winner_not_found', { username })
        continue
      }
      if (winner.steamgiftsUsername === null) {
        log.warn('winner_missing_sg_username', { username })
        continue
      }

      const winnerMeta: ScrapedSgUser = {
        steamgiftsUsername: winner.steamgiftsUsername,
        steamId: winner.steamId,
        avatarUrl: winner.avatarUrl,
        profileVisibility: winner.profileVisibility,
      }

      await recordScrapedWin(deps.dbWrite, {
        groupId: giveaway.groupId,
        playWindowDays: group.playWindowDays,
        target,
        giveaway: {
          steamgiftsCode: sgCode,
          slug: giveaway.slug,
          quantity: giveaway.quantity,
          startedAt: giveaway.startedAt,
          endedAt: giveaway.endedAt,
          winnersScrapedAt: settled ? backedAt : null,
        },
        creator: creatorMeta,
        winner: winnerMeta,
        wonAt: giveaway.endedAt,
        scrapedAt: backedAt,
      })
      winnersRecordedCount += 1
    }

    if (settled) {
      await setWinnersScrapedAt(deps.dbWrite, giveaway.id, backedAt)
    }
    processedCount += 1
  }

  const summary: BackfillWinnersSummary = {
    processed: processedCount,
    winners: winnersRecordedCount,
    errors,
  }
  log.info('backfill_completed', summary)
  return summary
}
