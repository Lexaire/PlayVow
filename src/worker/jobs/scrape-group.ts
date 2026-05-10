import type { Db } from '#/db/client'
import type { SgCookieTestResult, SteamGiftsUsername, SteamSubId } from '#/db/schema'
import type { SteamApiClient } from '#/external/steam-api'
import type { SgClient, SgError, SgGiveawayRow, SgSteamRef } from '#/external/steamgifts'
import type { Logger } from '#/lib/logger'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { findGiveawayByGroupAndCode } from '#/repos/giveaways'
import { recordScrapeOutcome } from '#/repos/groupSecrets'
import type { Group } from '#/repos/groups'
import { listGroups, updateGroupLastScrapedAt } from '#/repos/groups'
import {
  recordScrapedGiveaway,
  recordScrapedWin,
  type ScrapedSgUser,
  type ScrapedSteamTarget,
} from '#/repos/scrapeWrite'
import { findUserBySteamgiftsUsername } from '#/repos/users'
import { syncAppDetails } from '#/worker/jobs/sync-app-details'

// Per-group SG client factory. The worker builds this once at startup; on each
// invocation it pulls the group's encrypted cookie from the DB and constructs
// a freshly-bound SgClient. Anonymous fallback when no cookie is set — most
// SG endpoints (listings, profiles, 1–2 copy winners) work without auth, so
// missing cookies are partial-degradation, not a hard skip.
export type SgClientFactory = (groupId: number) => Promise<SgClient>

export type ScrapeGroupDeps = {
  readonly db: Db
  readonly dbWrite: Db
  readonly sg: SgClient
  readonly logger: Logger
  readonly now?: () => Date
}

export type ScrapeGroupSummary = {
  readonly groupId: number
  readonly pagesScraped: number
  readonly giveawaysSeen: number
  readonly giveawaysCreatedOrUpdated: number
  readonly giveawaysSkipped: number
  readonly creatorErrors: number
  readonly winnersSeen: number
  readonly winsCreated: number
  readonly winsExisting: number
  readonly winnerErrors: number
}

type ResolveError = { readonly kind: 'sg_profile_failed'; readonly cause: SgError }

// parse_failed = SG served a page but no Steam profile link (deleted/banned
// account). http_status 404 = the SG profile is gone entirely. Both are
// permanent — record a stub user keyed on the SG username from the listing
// instead of dropping the giveaway. A future successful re-fetch will fill in
// the Steam fields via the coalescing upsert.
const isPermanentResolveFailure = (e: SgError): boolean =>
  e.kind === 'parse_failed' || (e.kind === 'http_status' && e.status === 404)

const ensureSgUser = async (
  deps: ScrapeGroupDeps,
  sgUsername: SteamGiftsUsername,
): Promise<Result<ScrapedSgUser, ResolveError>> => {
  const cached = await findUserBySteamgiftsUsername(deps.db, sgUsername)
  // Found by SG username predicate — column must be non-null on cached.
  if (cached && cached.steamgiftsUsername !== null) {
    return ok({
      steamgiftsUsername: cached.steamgiftsUsername,
      steamId: cached.steamId,
      avatarUrl: cached.avatarUrl,
      profileVisibility: cached.profileVisibility,
    })
  }
  const profileR = await deps.sg.getProfile(sgUsername)
  if (profileR.ok) {
    return ok({
      steamgiftsUsername: profileR.value.steamgiftsUsername,
      steamId: profileR.value.steamId,
      avatarUrl: profileR.value.avatarUrl,
      profileVisibility: null,
    })
  }
  if (isPermanentResolveFailure(profileR.error)) {
    deps.logger.info('sg_user_unresolved_stub', {
      username: sgUsername,
      error: profileR.error.kind,
    })
    return ok({
      steamgiftsUsername: sgUsername,
      steamId: null,
      avatarUrl: null,
      profileVisibility: null,
    })
  }
  return err({ kind: 'sg_profile_failed', cause: profileR.error })
}

const errorTag = (e: ResolveError): string => `sg:${e.cause.kind}`

export const scrapeGroup = async (
  deps: ScrapeGroupDeps,
  group: Group,
): Promise<ScrapeGroupSummary> => {
  const log = deps.logger.child({ groupSlug: group.slug, groupId: group.id })
  const now = deps.now ?? (() => new Date())
  const scrapedAt = now()
  const MAX_PAGES = 10

  // SG scrape requires the SG group code and Steam group slug. scrapeAllGroups
  // already filters by source='steamgifts' so this is just a typing guard
  // (and a defensive log if the caller ever invokes us on a misconfigured row).
  const { steamgiftsGroupCode, steamGroupSlug } = group
  if (steamgiftsGroupCode === null || steamGroupSlug === null) {
    log.warn('scrape_skipped_missing_sg_fields')
    return {
      groupId: group.id,
      pagesScraped: 0,
      giveawaysSeen: 0,
      giveawaysCreatedOrUpdated: 0,
      giveawaysSkipped: 0,
      creatorErrors: 0,
      winnersSeen: 0,
      winsCreated: 0,
      winsExisting: 0,
      winnerErrors: 0,
    }
  }

  let pagesScraped = 0
  let giveawaysSeen = 0
  let giveawaysCreatedOrUpdated = 0
  let giveawaysSkipped = 0
  let creatorErrors = 0
  let winnersSeen = 0
  let winsCreated = 0
  let winsExisting = 0
  let winnerErrors = 0
  // Cookie health is tracked ONLY from getGiveawayWinners outcomes (the one
  // auth-gated SG path). Listings are public, so a successful listing scrape
  // says nothing about whether the cookie works. observedOk wins ties:
  // any cookie-bearing winners-page success means the cookie is good, even
  // if other winners-page calls in the same scrape failed for unrelated
  // reasons.
  let observedOk = false
  let firstFailure: SgCookieTestResult | null = null

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageR = await deps.sg.getGroupGiveaways(steamgiftsGroupCode, steamGroupSlug, page)
    if (!pageR.ok) {
      log.error('sg_fetch_failed', { kind: pageR.error.kind, page })
      break
    }

    const { rows, hasNextPage, signedOut } = pageR.value
    // Listings are normally public. Empty page + nav showing sign-in on the
    // first page is the signal that SG started gating listings (very rare,
    // would require a SG policy change). Worth surfacing so we'd notice.
    if (page === 1 && rows.length === 0 && signedOut) {
      log.warn('listing_empty_and_signed_out')
    }
    pagesScraped += 1
    giveawaysSeen += rows.length
    log.info('page_scraped', { page, rows: rows.length, hasNextPage })

    for (const giveaway of rows) {
      // Short-circuit: settled giveaways don't need re-processing. The listing
      // truncates to ≤2 winners regardless of quantity, so without this check
      // every multi-copy giveaway with quantity > 2 would re-fire the inline
      // winners-page fetch every scrape day.
      const existing = await findGiveawayByGroupAndCode(deps.db, group.id, giveaway.giveawayCode)
      if (existing?.winnersScrapedAt) {
        giveawaysSkipped += 1
        continue
      }

      const creatorR = await ensureSgUser(deps, giveaway.creatorUsername)
      if (!creatorR.ok) {
        creatorErrors += 1
        log.warn('creator_resolve_failed', {
          code: giveaway.giveawayCode,
          username: giveaway.creatorUsername,
          error: errorTag(creatorR.error),
        })
        continue
      }

      const summary = await ingestGiveawayWithWinners(
        deps,
        group,
        giveaway,
        creatorR.value,
        scrapedAt,
      )
      giveawaysCreatedOrUpdated += 1
      winnersSeen += summary.winnersSeen
      winsCreated += summary.winsCreated
      winsExisting += summary.winsExisting
      winnerErrors += summary.winnerErrors
      for (const e of summary.errorTags) {
        log.warn('winner_resolve_failed', { code: giveaway.giveawayCode, error: e })
      }
      if (summary.winnersPageOutcome === 'ok') observedOk = true
      else if (summary.winnersPageOutcome !== null && firstFailure === null) {
        firstFailure = summary.winnersPageOutcome
      }
    }

    if (!hasNextPage) break

    if (group.lastScrapedAt) {
      const newestEndedAt = Math.max(...rows.map((r) => r.endedAt.getTime()))
      if (newestEndedAt < group.lastScrapedAt.getTime()) break
    }
  }

  await updateGroupLastScrapedAt(deps.dbWrite, group.id, scrapedAt)
  // Only update cookie health if (a) we actually had a cookie this run and
  // (b) at least one auth-gated call exercised it. Without both, the prior
  // status is preserved — we don't claim "ok" for an anonymous scrape, and
  // we don't claim "login_required" against a cookie that was never sent.
  if (deps.sg.hasCookie) {
    const cookieOutcome: SgCookieTestResult | null = observedOk ? 'ok' : firstFailure
    if (cookieOutcome !== null) {
      await recordScrapeOutcome(deps.dbWrite, {
        groupId: group.id,
        result: cookieOutcome,
        now: scrapedAt,
      })
    }
  }

  log.info('scrape_completed', {
    pagesScraped,
    giveawaysSeen,
    giveawaysCreatedOrUpdated,
    giveawaysSkipped,
    creatorErrors,
    winnersSeen,
    winsCreated,
    winsExisting,
    winnerErrors,
  })

  return {
    groupId: group.id,
    pagesScraped,
    giveawaysSeen,
    giveawaysCreatedOrUpdated,
    giveawaysSkipped,
    creatorErrors,
    winnersSeen,
    winsCreated,
    winsExisting,
    winnerErrors,
  }
}

type GiveawayIngestSummary = {
  readonly winnersSeen: number
  readonly winsCreated: number
  readonly winsExisting: number
  readonly winnerErrors: number
  readonly errorTags: ReadonlyArray<string>
  // null when the dedicated winners page wasn't called (1–2 copy giveaway,
  // already-fully-revealed listing, or no listed winners). Otherwise reports
  // what SG returned for that auth-gated call so the caller can derive
  // cookie health.
  readonly winnersPageOutcome: SgCookieTestResult | null
}

const toScrapedTarget = (ref: SgSteamRef, title: string): ScrapedSteamTarget =>
  ref.kind === 'app'
    ? { kind: 'app', appId: ref.appId, name: title }
    : { kind: 'sub', subId: ref.subId as SteamSubId, name: title }

type ResolvedWinners = {
  readonly activated: ReadonlyArray<SteamGiftsUsername>
  readonly settled: boolean
  // Reports the dedicated-winners-page outcome when we had to call it.
  // null when no call was made (anonymous-safe paths). The caller uses this
  // to update cookie health, since the winners page is the only auth-gated
  // SG endpoint we hit.
  readonly winnersPageOutcome: SgCookieTestResult | null
}

const sgErrorToCookieOutcome = (err: SgError): SgCookieTestResult => {
  switch (err.kind) {
    case 'login_required':
      return 'login_required'
    case 'http_status':
      return 'http_error'
    case 'network':
      return 'network_error'
    case 'parse_failed':
      // parseGiveawayWinnersHtml never produces parse_failed, but the union
      // includes it for getProfile. Treat as http_error if it ever surfaces.
      return 'http_error'
  }
}

const resolveWinners = async (
  deps: ScrapeGroupDeps,
  giveaway: SgGiveawayRow,
): Promise<ResolvedWinners> => {
  // No winners on the listing yet (live or awaiting feedback): nothing to fetch.
  // Mark settled only if listing explicitly showed fa-ban.
  if (giveaway.winners.length === 0) {
    return { activated: [], settled: giveaway.noWinners, winnersPageOutcome: null }
  }
  // Listing showed all copies' winners: trust it, settled.
  if (giveaway.winners.length >= giveaway.quantity) {
    return { activated: giveaway.winners, settled: true, winnersPageOutcome: null }
  }
  // Partial: listing truncates for multi-copy. Hit the dedicated winners page
  // for the full activated list AND the awaiting count. THIS is the
  // auth-gated call; cookie health is derived from its outcome.
  const r = await deps.sg.getGiveawayWinners(giveaway.giveawayCode, giveaway.giveawaySlug)
  if (!r.ok) {
    deps.logger.warn('full_winners_fetch_failed', {
      code: giveaway.giveawayCode,
      error: r.error.kind,
    })
    return {
      activated: giveaway.winners,
      settled: false,
      winnersPageOutcome: sgErrorToCookieOutcome(r.error),
    }
  }
  const { activated, awaitingCount } = r.value
  // Defensive: if the dedicated page reveals fewer activated than the listing
  // showed, prefer the listing — never lose recorded winners.
  const winners = activated.length >= giveaway.winners.length ? activated : giveaway.winners
  // The dedicated page is authoritative. With zero awaiting it's in its
  // terminal state, even if activated.length < quantity (e.g. a 5-copy
  // giveaway with only 1 entry has 1 winner forever).
  return { activated: winners, settled: awaitingCount === 0, winnersPageOutcome: 'ok' }
}

const ingestGiveawayWithWinners = async (
  deps: ScrapeGroupDeps,
  group: Group,
  giveaway: SgGiveawayRow,
  creator: ScrapedSgUser,
  scrapedAt: Date,
): Promise<GiveawayIngestSummary> => {
  const target = toScrapedTarget(giveaway.steamRef, giveaway.title)
  const { activated: winners, settled, winnersPageOutcome } = await resolveWinners(deps, giveaway)
  const winnersScrapedAt = settled ? scrapedAt : null
  const giveawayMeta = {
    steamgiftsCode: giveaway.giveawayCode,
    slug: giveaway.giveawaySlug,
    quantity: giveaway.quantity,
    startedAt: giveaway.startedAt,
    endedAt: giveaway.endedAt,
    winnersScrapedAt,
  }

  if (winners.length === 0) {
    await recordScrapedGiveaway(deps.dbWrite, {
      groupId: group.id,
      target,
      giveaway: giveawayMeta,
      creator,
      scrapedAt,
    })
    return {
      winnersSeen: 0,
      winsCreated: 0,
      winsExisting: 0,
      winnerErrors: 0,
      errorTags: [],
      winnersPageOutcome,
    }
  }

  let winsCreated = 0
  let winsExisting = 0
  let winnerErrors = 0
  const errorTags: string[] = []

  for (const username of winners) {
    const winnerR = await ensureSgUser(deps, username)
    if (!winnerR.ok) {
      winnerErrors += 1
      errorTags.push(errorTag(winnerR.error))
      continue
    }
    const result = await recordScrapedWin(deps.dbWrite, {
      groupId: group.id,
      playWindowDays: group.playWindowDays,
      target,
      giveaway: giveawayMeta,
      creator,
      winner: winnerR.value,
      wonAt: giveaway.endedAt,
      scrapedAt,
    })
    if (result.created) winsCreated += 1
    else winsExisting += 1
  }

  return {
    winnersSeen: winners.length,
    winsCreated,
    winsExisting,
    winnerErrors,
    errorTags,
    winnersPageOutcome,
  }
}

export type ScrapeAllGroupsDeps = {
  readonly db: Db
  readonly dbWrite: Db
  readonly sgClientForGroup: SgClientFactory
  readonly steam: SteamApiClient
  readonly logger: Logger
  readonly now?: () => Date
}

export const scrapeAllGroups = async (
  deps: ScrapeAllGroupsDeps,
): Promise<ReadonlyArray<ScrapeGroupSummary>> => {
  // Manual groups have no SG presence to scrape. They share the giveaways/wins
  // tables, so polling and mod tooling work on their wins, but the SG scrape
  // path is skipped entirely.
  const groups = await listGroups(deps.db, { source: 'steamgifts' })
  const summaries: ScrapeGroupSummary[] = []
  for (const group of groups) {
    const sg = await deps.sgClientForGroup(group.id)
    summaries.push(
      await scrapeGroup(
        {
          db: deps.db,
          dbWrite: deps.dbWrite,
          sg,
          logger: deps.logger,
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        },
        group,
      ),
    )
  }
  // Resolve Steam store metadata for any apps the scrape just inserted (or
  // any prior NULL rows from before this sync existed). One batched call to
  // IStoreBrowseService per ~50 apps; failures are logged and retried on
  // the next scrape since detailsSyncedAt stays NULL.
  await syncAppDetails({
    db: deps.db,
    dbWrite: deps.dbWrite,
    steam: deps.steam,
    logger: deps.logger,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  return summaries
}
