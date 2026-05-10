import { eq } from 'drizzle-orm'

import type { Db } from '#/db/client'
import { groups } from '#/db/schema'
import type { SteamGroupId, SteamId } from '#/db/schema'
import type { GroupMembersPage, SteamCommunityClient } from '#/external/steam-community'
import type { Logger } from '#/lib/logger'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { applyMembershipDiff } from '#/repos/groupMemberships'
import type { Group } from '#/repos/groups'
import { listGroups } from '#/repos/groups'

export type ScrapeSteamGroupMembersDeps = {
  readonly db: Db
  readonly dbWrite: Db
  readonly steam: SteamCommunityClient
  readonly logger: Logger
  readonly now?: () => Date
}

export type ScrapeSteamGroupMembersSummary = {
  readonly groupId: number
  readonly pagesFetched: number
  readonly membersSeen: number
  readonly joined: number
  readonly stillPresent: number
  readonly left: number
  readonly stickyUntouched: number
}

const MAX_PAGES = 50

const fetchAllMembers = async (
  steam: SteamCommunityClient,
  gid64: SteamGroupId,
  logger: Logger,
): Promise<Result<ReadonlySet<SteamId>, 'fetch_failed'>> => {
  const members = new Set<SteamId>()
  let pagesFetched = 0

  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await steam.getGroupMembersPage(gid64, page)
    if (!r.ok) {
      logger.warn('steam_members_page_failed', {
        gid64,
        page,
        error: r.ok ? undefined : (r.error as { kind: string }).kind,
      })
      if (pagesFetched === 0) return err('fetch_failed' as const)
      // Partial data — don't apply a partial diff
      return err('fetch_failed' as const)
    }

    const data: GroupMembersPage = r.value
    for (const id of data.members) members.add(id)
    pagesFetched += 1

    if (data.currentPage >= data.totalPages) break
  }

  return ok(members)
}

export const scrapeSteamGroupMembers = async (
  deps: ScrapeSteamGroupMembersDeps,
  group: Group,
): Promise<ScrapeSteamGroupMembersSummary> => {
  const log = deps.logger.child({ groupSlug: group.slug, groupId: group.id })
  const ranAt = deps.now?.() ?? new Date()

  if (group.steamGroupId === null) {
    log.warn('steam_members_skipped_no_group_id')
    return {
      groupId: group.id,
      pagesFetched: 0,
      membersSeen: 0,
      joined: 0,
      stillPresent: 0,
      left: 0,
      stickyUntouched: 0,
    }
  }
  const steamGroupId = group.steamGroupId

  const rosterR = await fetchAllMembers(deps.steam, steamGroupId, log)
  if (!rosterR.ok) {
    log.error('steam_members_scrape_failed', { gid64: steamGroupId })
    return {
      groupId: group.id,
      pagesFetched: 0,
      membersSeen: 0,
      joined: 0,
      stillPresent: 0,
      left: 0,
      stickyUntouched: 0,
    }
  }

  const currentRoster = rosterR.value
  const diff = await applyMembershipDiff(deps.dbWrite, {
    groupId: group.id,
    currentRoster,
    ranAt,
  })

  await deps.dbWrite
    .update(groups)
    .set({ lastSteamMembersScrapedAt: ranAt })
    .where(eq(groups.id, group.id))

  log.info('steam_members_scraped', {
    membersSeen: currentRoster.size,
    ...diff,
  })

  return {
    groupId: group.id,
    pagesFetched: Math.ceil(currentRoster.size / 1000) || 1,
    membersSeen: currentRoster.size,
    ...diff,
  }
}

export type ScrapeAllSteamGroupMembersSummary = {
  readonly groups: ReadonlyArray<ScrapeSteamGroupMembersSummary>
  readonly errors: ReadonlyArray<string>
}

export const scrapeAllSteamGroupMembers = async (
  deps: ScrapeSteamGroupMembersDeps,
): Promise<ScrapeAllSteamGroupMembersSummary> => {
  const allGroups = await listGroups(deps.db)
  const summaries: ScrapeSteamGroupMembersSummary[] = []
  const errors: string[] = []

  for (const group of allGroups) {
    // Steam group linkage is optional on manual groups (and absent on any
    // group that hasn't filled in the Steam fields). Without an id there's
    // nothing to scrape.
    if (group.steamGroupId === null) continue
    try {
      const summary = await scrapeSteamGroupMembers(deps, group)
      summaries.push(summary)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${group.slug}: ${msg}`)
      deps.logger.error('steam_members_group_error', {
        groupSlug: group.slug,
        error: msg,
      })
    }
  }

  return { groups: summaries, errors }
}
