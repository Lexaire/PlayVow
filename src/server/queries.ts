import { and, asc, count, desc, eq, gt, inArray, lt, sql, sum } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import type { DbOrTx } from '#/db/client'
import type {
  SteamAppId,
  SteamGiftsGiveawayCode,
  SteamGiftsUsername,
  SteamId,
  SteamSubId,
  WinStatus,
} from '#/db/schema'
import {
  achievementEvents,
  giveaways,
  groups,
  steamAchievements,
  steamApps,
  steamSubs,
  users,
  winObservations,
  wins,
  WIN_STATUSES,
} from '#/db/schema'
import { listAuditEntriesForTarget } from '#/repos/auditLog'
import type { AuditEntry, AuditEntryReadError } from '#/repos/auditLog'
import {
  COMMON_ACHIEVEMENT_THRESHOLD,
  type CommonAchievementProgress,
} from '#/domain/achievement-criteria'
import {
  getCommonAchievementProgress,
  getCommonAchievementProgressBatch,
} from '#/repos/achievements'
import { findSteamAppById, type SteamApp } from '#/repos/steamApps'
import { findSteamSubById, type SteamSub } from '#/repos/steamSubs'
import {
  batchGetOpenMembershipSteamIds,
  findUserGroupsWithOpenMembership,
  getLatestMembership,
  type MembershipStatusView,
  type UserGroupMembershipView,
} from '#/repos/groupMemberships'

export type { MembershipStatusView, UserGroupMembershipView }
import type { Result } from '#/lib/result'

const WIN_AUDIT_LOG_LIMIT = 50

export const DEFAULT_PAGE_SIZE = 50

// Pagination envelope. `total` is the count BEFORE limit/offset, used to
// render "Showing 51–100 of 248" and decide whether to show next-page links.
export type Page<T> = {
  readonly rows: ReadonlyArray<T>
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

const toOffset = (page: number, pageSize: number): number => Math.max(0, (page - 1) * pageSize)

// Wins/giveaways always reference an SG-scraped user, so the user's
// steamgifts_username column is non-null in practice even though the schema
// allows null (Steam-only users never appear in these joins). Assert at the
// boundary so view types stay honest.
const requireSgUsername = (user: {
  readonly id: number
  readonly steamgiftsUsername: SteamGiftsUsername | null
}): SteamGiftsUsername => {
  if (user.steamgiftsUsername === null) {
    throw new Error(`user ${user.id} has null steamgifts_username on a wins/giveaways join`)
  }
  return user.steamgiftsUsername
}

export type GroupSummary = {
  readonly id: number
  readonly slug: string
  readonly name: string
  readonly playWindowDays: number
  readonly description: string | null
}

export type WinUserSummary = {
  readonly id: number
  readonly steamId: SteamId | null
  readonly steamgiftsUsername: SteamGiftsUsername
  readonly avatarUrl: string | null
}

export type GiveawayCreatorSummary = {
  readonly id: number
  readonly steamgiftsUsername: SteamGiftsUsername
  readonly steamId: SteamId | null
  readonly avatarUrl: string | null
}

export type GiveawayTargetView =
  | {
      readonly kind: 'app'
      readonly appId: number
      readonly name: string
      // Asset path strings + the URL-format template; combine via
      // steamAssetUrl() to render a capsule. We carry both small (231x87,
      // also serves 184x69) and main (616x353) so list and detail pages
      // can render without re-querying. Kept small enough that list pages
      // aren't meaningfully bloated.
      readonly assetSmallCapsule: string | null
      readonly assetMainCapsule: string | null
      readonly assetUrlFormat: string | null
    }
  | {
      readonly kind: 'sub'
      readonly subId: number
      readonly name: string
      readonly assetSmallCapsule: string | null
      readonly assetMainCapsule: string | null
      readonly assetUrlFormat: string | null
    }

export type GiveawayView = {
  readonly id: number
  readonly steamgiftsCode: SteamGiftsGiveawayCode
  readonly target: GiveawayTargetView
  readonly quantity: number
  readonly startedAt: Date
  readonly endedAt: Date
  readonly winnersScrapedAt: Date | null
  readonly winnerCount: number
  readonly creator: GiveawayCreatorSummary
}

export type UserCreatedGiveawayView = GiveawayView & {
  readonly group: { readonly slug: string; readonly name: string }
}

export type CreatorStats = {
  readonly total: number
  readonly active: number
  readonly ended: number
  readonly keysGiven: number
  readonly winnersDrawn: number
}

export type WinGiveawaySummary = {
  readonly id: number
  readonly steamgiftsCode: SteamGiftsGiveawayCode
  readonly groupSlug: string
  readonly groupName: string
  readonly target: GiveawayTargetView
  readonly creator: GiveawayCreatorSummary
}

export type WinView = {
  readonly id: number
  readonly status: WinStatus
  readonly wonAt: Date
  readonly playDeadline: Date
  readonly resolvedAt: Date | null
  readonly playtimeAtWinMinutes: number | null
  readonly currentPlaytimeMinutes: number | null
  readonly playtime2WeeksMinutes: number | null
  readonly hasReview: boolean | null
  readonly screenshotCount: number | null
  readonly achievementsUnlocked: number | null
  readonly achievementsTotal: number | null
  readonly modNotes: string | null
  readonly user: WinUserSummary
  readonly giveaway: WinGiveawaySummary
}

const buildTarget = (
  app: typeof steamApps.$inferSelect | null,
  sub: typeof steamSubs.$inferSelect | null,
): GiveawayTargetView => {
  if (app)
    return {
      kind: 'app',
      appId: app.appId,
      name: app.name,
      assetSmallCapsule: app.assetSmallCapsule,
      assetMainCapsule: app.assetMainCapsule,
      assetUrlFormat: app.assetUrlFormat,
    }
  if (sub)
    return {
      kind: 'sub',
      subId: sub.subId,
      name: sub.name,
      assetSmallCapsule: sub.assetSmallCapsule,
      assetMainCapsule: sub.assetMainCapsule,
      assetUrlFormat: sub.assetUrlFormat,
    }
  throw new Error('giveaway has neither steam_app nor steam_sub')
}

const toWinView = (row: {
  win: typeof wins.$inferSelect
  user: typeof users.$inferSelect
  giveaway: typeof giveaways.$inferSelect
  group: typeof groups.$inferSelect
  app: typeof steamApps.$inferSelect | null
  sub: typeof steamSubs.$inferSelect | null
  creator: typeof users.$inferSelect
}): WinView => ({
  id: row.win.id,
  status: row.win.status,
  wonAt: row.win.wonAt,
  playDeadline: row.win.playDeadline,
  resolvedAt: row.win.resolvedAt,
  playtimeAtWinMinutes: row.win.playtimeAtWinMinutes,
  currentPlaytimeMinutes: row.win.currentPlaytimeMinutes,
  playtime2WeeksMinutes: row.win.playtime2WeeksMinutes,
  hasReview: row.win.hasReview,
  screenshotCount: row.win.screenshotCount,
  achievementsUnlocked: row.win.achievementsUnlocked,
  achievementsTotal: row.win.achievementsTotal,
  modNotes: row.win.modNotes,
  user: {
    id: row.user.id,
    steamId: row.user.steamId,
    steamgiftsUsername: requireSgUsername(row.user),
    avatarUrl: row.user.avatarUrl,
  },
  giveaway: {
    id: row.giveaway.id,
    steamgiftsCode: row.giveaway.steamgiftsCode,
    groupSlug: row.group.slug,
    groupName: row.group.name,
    target: buildTarget(row.app, row.sub),
    creator: {
      id: row.creator.id,
      steamgiftsUsername: requireSgUsername(row.creator),
      steamId: row.creator.steamId,
      avatarUrl: row.creator.avatarUrl,
    },
  },
})

export type ActivityFeedRow =
  | { readonly kind: 'win'; readonly effectiveAt: Date; readonly win: WinView }
  | {
      readonly kind: 'no_winner_giveaway'
      readonly effectiveAt: Date
      readonly giveaway: GiveawayView
    }

export type GroupOverviewPageData = {
  readonly group: GroupSummary
  // In-progress giveaways are surfaced in their own paginated section (above
  // the feed) sorted by soonest-ending. They never appear in the feed since
  // they have no winners by definition.
  readonly inProgress: Page<GiveawayView>
  readonly feed: Page<ActivityFeedRow>
}

export const IN_PROGRESS_PAGE_SIZE = 10
export const FEED_PAGE_SIZE = 25

// Per-status page numbers. Each entry is optional; undefined means page 1.
// `| undefined` in the value type lets callers pass parsed-but-empty objects
// without filtering out undefined entries (exactOptionalPropertyTypes friendly).
export type StatusPages = Readonly<{ [K in WinStatus]?: number | undefined }>

export type UserPageData = {
  readonly user: WinUserSummary
  readonly winsByStatus: Readonly<Record<WinStatus, Page<WinView>>>
  readonly winsOnCreatedByStatus: Readonly<Record<WinStatus, Page<WinView>>>
  readonly noWinnersGiveaways: Page<UserCreatedGiveawayView>
  readonly creatorStats: CreatorStats
  readonly groupMemberships: ReadonlyArray<UserGroupMembershipView>
  // One map covering every winId visible across all status panels (own +
  // created × all five statuses). Routes consume via new Map(commonByWinId).
  readonly commonByWinId: CommonByWinId
}

export type GiveawayPageData = {
  readonly group: GroupSummary
  readonly giveaway: {
    readonly id: number
    readonly steamgiftsCode: SteamGiftsGiveawayCode
    readonly quantity: number
    readonly startedAt: Date
    readonly endedAt: Date
    readonly target: GiveawayTargetView
    readonly creator: GiveawayCreatorSummary
  }
  readonly wins: ReadonlyArray<WinView>
  readonly commonByWinId: CommonByWinId
}

// Game pages aggregate every win and every giveaway for a single Steam app
// (or sub bundle) across all groups. Both lists paginate independently with
// `winsPage` / `giveawaysPage` query params on the route.
export type GamePageData = {
  readonly app: SteamApp
  readonly wins: Page<WinView>
  readonly giveaways: Page<UserCreatedGiveawayView>
  readonly commonByWinId: CommonByWinId
}

export type SubPageData = {
  readonly sub: SteamSub
  readonly wins: Page<WinView>
  readonly giveaways: Page<UserCreatedGiveawayView>
  readonly commonByWinId: CommonByWinId
}

export const listGroupSummaries = async (db: DbOrTx): Promise<ReadonlyArray<GroupSummary>> => {
  const rows = await db
    .select({
      id: groups.id,
      slug: groups.slug,
      name: groups.name,
      playWindowDays: groups.playWindowDays,
      description: groups.description,
    })
    .from(groups)
    .orderBy(asc(groups.name))
  return rows
}

const selectWinJoin = (db: DbOrTx) => {
  const creators = alias(users, 'win_creators')
  return db
    .select({
      win: wins,
      user: users,
      giveaway: giveaways,
      group: groups,
      app: steamApps,
      sub: steamSubs,
      creator: creators,
    })
    .from(wins)
    .innerJoin(users, eq(users.id, wins.userId))
    .innerJoin(giveaways, eq(giveaways.id, wins.giveawayId))
    .innerJoin(groups, eq(groups.id, giveaways.groupId))
    .leftJoin(steamApps, eq(steamApps.appId, giveaways.steamAppId))
    .leftJoin(steamSubs, eq(steamSubs.subId, giveaways.steamSubId))
    .innerJoin(creators, eq(creators.id, giveaways.creatorUserId))
}

const findGroupBySlug = async (db: DbOrTx, slug: string): Promise<GroupSummary | null> => {
  const [row] = await db
    .select({
      id: groups.id,
      slug: groups.slug,
      name: groups.name,
      playWindowDays: groups.playWindowDays,
      description: groups.description,
    })
    .from(groups)
    .where(eq(groups.slug, slug))
    .limit(1)
  return row ?? null
}

export const getGroupSummaryBySlug = async (
  db: DbOrTx,
  slug: string,
): Promise<GroupSummary | null> => findGroupBySlug(db, slug)

// Builds a giveaway view from the same join shape used by `listGiveawaysByGroupId`
// and `listNoWinnersGiveawaysByUserId`. Used to hydrate no-winner rows for the
// activity feed and the in-progress section.
const toGiveawayView = (r: {
  giveaway: typeof giveaways.$inferSelect
  app: typeof steamApps.$inferSelect | null
  sub: typeof steamSubs.$inferSelect | null
  creator: typeof users.$inferSelect
  winnerCount: number
}): GiveawayView => ({
  id: r.giveaway.id,
  steamgiftsCode: r.giveaway.steamgiftsCode,
  target: buildTarget(r.app, r.sub),
  quantity: r.giveaway.quantity,
  startedAt: r.giveaway.startedAt,
  endedAt: r.giveaway.endedAt,
  winnersScrapedAt: r.giveaway.winnersScrapedAt,
  winnerCount: r.winnerCount,
  creator: {
    id: r.creator.id,
    steamgiftsUsername: requireSgUsername(r.creator),
    steamId: r.creator.steamId,
    avatarUrl: r.creator.avatarUrl,
  },
})

type FeedKey =
  | { readonly kind: 'win'; readonly id: number; readonly effectiveAt: Date }
  | { readonly kind: 'no_winner_giveaway'; readonly id: number; readonly effectiveAt: Date }

// Sort by effective date desc; tie-break on kind then id so pagination is
// deterministic when multiple rows share a timestamp (e.g. multi-key giveaways).
const compareFeedKeys = (a: FeedKey, b: FeedKey): number => {
  const dt = b.effectiveAt.getTime() - a.effectiveAt.getTime()
  if (dt !== 0) return dt
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  return a.id - b.id
}

export const getGroupOverviewPage = async (
  db: DbOrTx,
  slug: string,
  inProgressPage: number,
  feedPage: number,
  now: Date,
): Promise<GroupOverviewPageData | null> => {
  const groupRow = await findGroupBySlug(db, slug)
  if (!groupRow) return null

  // Four concurrent queries: in-progress giveaways (paginated, hydrated) and
  // their count, feed keys for wins, feed keys for no-winner giveaways. The
  // feed is paginated in JS after merging keys — payload is bounded (a few
  // thousand IDs + timestamps for a busy group), and the result is wrapped in
  // a TTL cache upstream.
  const inProgressCreators = alias(users, 'in_progress_creators')
  const [inProgressRows, inProgressTotalRow, winKeyRows, noWinnerKeyRows] = await Promise.all([
    db
      .select({
        giveaway: giveaways,
        app: steamApps,
        sub: steamSubs,
        creator: inProgressCreators,
      })
      .from(giveaways)
      .leftJoin(steamApps, eq(steamApps.appId, giveaways.steamAppId))
      .leftJoin(steamSubs, eq(steamSubs.subId, giveaways.steamSubId))
      .innerJoin(inProgressCreators, eq(inProgressCreators.id, giveaways.creatorUserId))
      .where(and(eq(giveaways.groupId, groupRow.id), gt(giveaways.endedAt, now)))
      .orderBy(asc(giveaways.endedAt))
      .limit(IN_PROGRESS_PAGE_SIZE)
      .offset(toOffset(inProgressPage, IN_PROGRESS_PAGE_SIZE)),
    db
      .select({ n: count() })
      .from(giveaways)
      .where(and(eq(giveaways.groupId, groupRow.id), gt(giveaways.endedAt, now))),
    db
      .select({ id: wins.id, effectiveAt: wins.wonAt })
      .from(wins)
      .innerJoin(giveaways, eq(giveaways.id, wins.giveawayId))
      .where(eq(giveaways.groupId, groupRow.id)),
    db
      .select({ id: giveaways.id, effectiveAt: giveaways.endedAt })
      .from(giveaways)
      .where(
        and(
          eq(giveaways.groupId, groupRow.id),
          // Only ended giveaways count as "no winner"; in-progress ones live
          // in the dedicated section above and would otherwise double-count.
          lt(giveaways.endedAt, now),
          sql`NOT EXISTS (SELECT 1 FROM ${wins} WHERE ${wins.giveawayId} = ${giveaways.id})`,
        ),
      ),
  ])

  const inProgress: Page<GiveawayView> = {
    rows: inProgressRows.map((r) => toGiveawayView({ ...r, winnerCount: 0 })),
    total: inProgressTotalRow[0]?.n ?? 0,
    page: inProgressPage,
    pageSize: IN_PROGRESS_PAGE_SIZE,
  }

  const allKeys: FeedKey[] = [
    ...winKeyRows.map((r): FeedKey => ({ kind: 'win', id: r.id, effectiveAt: r.effectiveAt })),
    ...noWinnerKeyRows.map(
      (r): FeedKey => ({ kind: 'no_winner_giveaway', id: r.id, effectiveAt: r.effectiveAt }),
    ),
  ]
  allKeys.sort(compareFeedKeys)

  const feedTotal = allKeys.length
  const feedOffset = toOffset(feedPage, FEED_PAGE_SIZE)
  const pageKeys = allKeys.slice(feedOffset, feedOffset + FEED_PAGE_SIZE)

  const winIds = pageKeys.flatMap((k) => (k.kind === 'win' ? [k.id] : []))
  const noWinnerIds = pageKeys.flatMap((k) => (k.kind === 'no_winner_giveaway' ? [k.id] : []))

  const noWinnerCreators = alias(users, 'no_winner_creators')
  const [winHydratedRows, noWinnerHydratedRows] = await Promise.all([
    winIds.length === 0 ? Promise.resolve([]) : selectWinJoin(db).where(inArray(wins.id, winIds)),
    noWinnerIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            giveaway: giveaways,
            app: steamApps,
            sub: steamSubs,
            creator: noWinnerCreators,
          })
          .from(giveaways)
          .leftJoin(steamApps, eq(steamApps.appId, giveaways.steamAppId))
          .leftJoin(steamSubs, eq(steamSubs.subId, giveaways.steamSubId))
          .innerJoin(noWinnerCreators, eq(noWinnerCreators.id, giveaways.creatorUserId))
          .where(inArray(giveaways.id, noWinnerIds)),
  ])

  const winById = new Map(winHydratedRows.map((r) => [r.win.id, toWinView(r)] as const))
  const noWinnerById = new Map(
    noWinnerHydratedRows.map(
      (r) => [r.giveaway.id, toGiveawayView({ ...r, winnerCount: 0 })] as const,
    ),
  )

  const rows: ReadonlyArray<ActivityFeedRow> = pageKeys.flatMap((k): ActivityFeedRow[] => {
    if (k.kind === 'win') {
      const win = winById.get(k.id)
      return win ? [{ kind: 'win', effectiveAt: k.effectiveAt, win }] : []
    }
    const giveaway = noWinnerById.get(k.id)
    return giveaway ? [{ kind: 'no_winner_giveaway', effectiveAt: k.effectiveAt, giveaway }] : []
  })

  return {
    group: groupRow,
    inProgress,
    feed: { rows, total: feedTotal, page: feedPage, pageSize: FEED_PAGE_SIZE },
  }
}

const ALL_STATUSES: ReadonlyArray<WinStatus> = WIN_STATUSES

const emptyPage = (page: number, pageSize: number): Page<WinView> => ({
  rows: [],
  total: 0,
  page,
  pageSize,
})

const listNoWinnersGiveawaysByUserId = async (
  db: DbOrTx,
  userId: number,
  page: number,
  pageSize: number,
): Promise<ReadonlyArray<UserCreatedGiveawayView>> => {
  const creators = alias(users, 'created_creators')

  const rows = await db
    .select({
      giveaway: giveaways,
      group: { slug: groups.slug, name: groups.name },
      app: steamApps,
      sub: steamSubs,
      creator: creators,
    })
    .from(giveaways)
    .innerJoin(groups, eq(groups.id, giveaways.groupId))
    .leftJoin(steamApps, eq(steamApps.appId, giveaways.steamAppId))
    .leftJoin(steamSubs, eq(steamSubs.subId, giveaways.steamSubId))
    .innerJoin(creators, eq(creators.id, giveaways.creatorUserId))
    .where(
      and(
        eq(giveaways.creatorUserId, userId),
        sql`NOT EXISTS (SELECT 1 FROM ${wins} WHERE ${wins.giveawayId} = ${giveaways.id})`,
      ),
    )
    .orderBy(desc(giveaways.endedAt))
    .limit(pageSize)
    .offset(toOffset(page, pageSize))

  return rows.map((r) => ({
    id: r.giveaway.id,
    steamgiftsCode: r.giveaway.steamgiftsCode,
    target: buildTarget(r.app, r.sub),
    quantity: r.giveaway.quantity,
    startedAt: r.giveaway.startedAt,
    endedAt: r.giveaway.endedAt,
    winnersScrapedAt: r.giveaway.winnersScrapedAt,
    winnerCount: 0,
    creator: {
      id: r.creator.id,
      steamgiftsUsername: requireSgUsername(r.creator),
      steamId: r.creator.steamId,
      avatarUrl: r.creator.avatarUrl,
    },
    group: r.group,
  }))
}

const getCreatorStats = async (db: DbOrTx, userId: number, now: Date): Promise<CreatorStats> => {
  // Active uses gt() so drizzle encodes `now` against the integer-timestamp
  // column mode. Don't put the Date into a raw sql`` template — the driver
  // won't know to convert it and the predicate silently never matches.
  const [aggRow, activeRow, winnersRow] = await Promise.all([
    db
      .select({
        total: count(),
        keysGiven: sum(giveaways.quantity),
      })
      .from(giveaways)
      .where(eq(giveaways.creatorUserId, userId)),
    db
      .select({ n: count() })
      .from(giveaways)
      .where(and(eq(giveaways.creatorUserId, userId), gt(giveaways.endedAt, now))),
    db
      .select({ n: count() })
      .from(wins)
      .innerJoin(giveaways, eq(giveaways.id, wins.giveawayId))
      .where(eq(giveaways.creatorUserId, userId)),
  ])

  const total = aggRow[0]?.total ?? 0
  const active = activeRow[0]?.n ?? 0
  // drizzle's sum() returns string | null (sqlite numeric); coerce.
  const keysGiven = Number(aggRow[0]?.keysGiven ?? 0)
  return {
    total,
    active,
    ended: total - active,
    keysGiven,
    winnersDrawn: winnersRow[0]?.n ?? 0,
  }
}

export const getUserPageDataByUsername = async (
  db: DbOrTx,
  username: SteamGiftsUsername,
  winsPages: StatusPages,
  createdWinsPages: StatusPages,
  noWinnersPage: number,
  pageSize: number,
  now: Date,
): Promise<UserPageData | null> => {
  const [userRow] = await db
    .select({
      id: users.id,
      steamId: users.steamId,
      steamgiftsUsername: users.steamgiftsUsername,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(sql`lower(${users.steamgiftsUsername}) = lower(${username})`)
    .limit(1)

  if (!userRow) return null

  // Two grouped count queries — one for wins-as-winner, one for wins-on-created.
  // Each gives totals for all five statuses in a single round trip; we then
  // only fetch list pages for statuses with non-zero counts.
  const [winsCountRows, createdWinsCountRows] = await Promise.all([
    db
      .select({ status: wins.status, n: count() })
      .from(wins)
      .where(eq(wins.userId, userRow.id))
      .groupBy(wins.status),
    db
      .select({ status: wins.status, n: count() })
      .from(wins)
      .innerJoin(giveaways, eq(giveaways.id, wins.giveawayId))
      .where(eq(giveaways.creatorUserId, userRow.id))
      .groupBy(wins.status),
  ])

  const winsTotalsByStatus = new Map<WinStatus, number>(
    winsCountRows.map((r) => [r.status, r.n] as const),
  )
  const createdWinsTotalsByStatus = new Map<WinStatus, number>(
    createdWinsCountRows.map((r) => [r.status, r.n] as const),
  )

  const fetchWinsListForStatus = async (status: WinStatus): Promise<Page<WinView>> => {
    const total = winsTotalsByStatus.get(status) ?? 0
    const page = winsPages[status] ?? 1
    if (total === 0) return emptyPage(page, pageSize)
    const rows = await selectWinJoin(db)
      .where(and(eq(wins.userId, userRow.id), eq(wins.status, status)))
      .orderBy(desc(wins.wonAt))
      .limit(pageSize)
      .offset(toOffset(page, pageSize))
    return { rows: rows.map(toWinView), total, page, pageSize }
  }

  const fetchCreatedWinsListForStatus = async (status: WinStatus): Promise<Page<WinView>> => {
    const total = createdWinsTotalsByStatus.get(status) ?? 0
    const page = createdWinsPages[status] ?? 1
    if (total === 0) return emptyPage(page, pageSize)
    const rows = await selectWinJoin(db)
      .where(and(eq(giveaways.creatorUserId, userRow.id), eq(wins.status, status)))
      .orderBy(desc(wins.wonAt))
      .limit(pageSize)
      .offset(toOffset(page, pageSize))
    return { rows: rows.map(toWinView), total, page, pageSize }
  }

  const [
    winsPages_,
    createdWinsPages_,
    noWinnersRows,
    creatorStats,
    noWinnersTotalRow,
    groupMemberships,
  ] = await Promise.all([
    Promise.all(ALL_STATUSES.map(fetchWinsListForStatus)),
    Promise.all(ALL_STATUSES.map(fetchCreatedWinsListForStatus)),
    listNoWinnersGiveawaysByUserId(db, userRow.id, noWinnersPage, pageSize),
    getCreatorStats(db, userRow.id, now),
    // Count of created giveaways with zero winner rows. Same NOT EXISTS
    // predicate as the list query so the count matches the rendered set.
    db
      .select({ n: count() })
      .from(giveaways)
      .where(
        and(
          eq(giveaways.creatorUserId, userRow.id),
          sql`NOT EXISTS (SELECT 1 FROM ${wins} WHERE ${wins.giveawayId} = ${giveaways.id})`,
        ),
      ),
    userRow.steamId ? findUserGroupsWithOpenMembership(db, userRow.steamId) : Promise.resolve([]),
  ])
  const winsByStatus = Object.fromEntries(
    ALL_STATUSES.map((s, i) => [s, winsPages_[i] ?? emptyPage(1, pageSize)]),
  ) as Record<WinStatus, Page<WinView>>
  const winsOnCreatedByStatus = Object.fromEntries(
    ALL_STATUSES.map((s, i) => [s, createdWinsPages_[i] ?? emptyPage(1, pageSize)]),
  ) as Record<WinStatus, Page<WinView>>

  const noWinnersGiveaways: Page<UserCreatedGiveawayView> = {
    rows: noWinnersRows,
    total: noWinnersTotalRow[0]?.n ?? 0,
    page: noWinnersPage,
    pageSize,
  }

  const user: WinUserSummary = {
    id: userRow.id,
    steamId: userRow.steamId,
    steamgiftsUsername: requireSgUsername(userRow),
    avatarUrl: userRow.avatarUrl,
  }

  // Aggregate every visible winId across both grids (5 statuses × {own,
  // created}). Deduped because a single win can technically appear in only
  // one status, but collecting from all 10 lists in a Set keeps the code
  // tolerant of future overlap.
  const allVisibleWinIds = new Set<number>()
  for (const s of ALL_STATUSES) {
    for (const w of winsByStatus[s].rows) allVisibleWinIds.add(w.id)
    for (const w of winsOnCreatedByStatus[s].rows) allVisibleWinIds.add(w.id)
  }
  const commonByWinIdMap = await getCommonAchievementProgressBatch(db, {
    winIds: [...allVisibleWinIds],
    threshold: COMMON_ACHIEVEMENT_THRESHOLD,
  })

  return {
    user,
    winsByStatus,
    winsOnCreatedByStatus,
    noWinnersGiveaways,
    creatorStats,
    groupMemberships,
    commonByWinId: Array.from(commonByWinIdMap),
  }
}

export type ModWinsFilter = 'all' | 'pending'

// Per-win common-achievement progress as entries (serializable across the
// server-fn boundary; Map collapses to {} during type inference). Routes
// reconstruct Map(commonByWinId) before passing to WinsTable.
export type CommonByWinId = ReadonlyArray<readonly [number, CommonAchievementProgress]>

export type ModWinsPageData = {
  readonly group: GroupSummary
  readonly wins: Page<WinView>
  readonly filter: ModWinsFilter
  readonly inGroupSteamIds: ReadonlyArray<SteamId>
  readonly commonByWinId: CommonByWinId
}

export const getModWinsPage = async (
  db: DbOrTx,
  slug: string,
  filter: ModWinsFilter,
  page: number,
  pageSize: number,
): Promise<ModWinsPageData | null> => {
  const groupRow = await findGroupBySlug(db, slug)
  if (!groupRow) return null

  const baseWhere =
    filter === 'pending'
      ? and(eq(groups.id, groupRow.id), eq(wins.status, 'pending'))
      : eq(groups.id, groupRow.id)

  // Total comes from the denormalized counter on `groups` (see
  // wins repo + 0010 migration backfill), not a count(*) join. One column
  // read by PK instead of scanning every win in the group.
  const counterColumn = filter === 'pending' ? groups.pendingWins : groups.totalWins
  const [winRows, totalRows] = await Promise.all([
    selectWinJoin(db)
      .where(baseWhere)
      .orderBy(desc(wins.wonAt))
      .limit(pageSize)
      .offset(toOffset(page, pageSize)),
    db.select({ n: counterColumn }).from(groups).where(eq(groups.id, groupRow.id)).limit(1),
  ])

  const winViews = winRows.map(toWinView)
  const steamIds = Array.from(
    new Set(winViews.flatMap((w) => (w.user.steamId ? [w.user.steamId] : []))),
  )
  const [inGroupSteamIdsSet, commonByWinIdMap] = await Promise.all([
    batchGetOpenMembershipSteamIds(db, groupRow.id, steamIds),
    getCommonAchievementProgressBatch(db, {
      winIds: winViews.map((w) => w.id),
      threshold: COMMON_ACHIEVEMENT_THRESHOLD,
    }),
  ])
  const inGroupSteamIds = Array.from(inGroupSteamIdsSet)

  return {
    group: groupRow,
    wins: { rows: winViews, total: totalRows[0]?.n ?? 0, page, pageSize },
    filter,
    inGroupSteamIds,
    commonByWinId: Array.from(commonByWinIdMap),
  }
}

export type WinAuditEntry = Result<AuditEntry, AuditEntryReadError>

export type WinObservationView = {
  readonly id: number
  readonly observedAt: Date
  readonly currentPlaytimeMinutes: number | null
  readonly playtime2WeeksMinutes: number | null
  readonly achievementsUnlocked: number | null
  readonly achievementsTotal: number | null
}

export type AchievementUnlockView = {
  readonly id: number
  readonly displayName: string | null
  readonly apiname: string
  readonly unlockedAt: Date
  readonly observedAt: Date
}

export type ModWinDetailData = {
  readonly win: WinView
  readonly auditEntries: ReadonlyArray<WinAuditEntry>
  readonly observations: ReadonlyArray<WinObservationView>
  readonly achievementUnlocks: ReadonlyArray<AchievementUnlockView>
  readonly membershipStatus: MembershipStatusView | null
  readonly commonAchievements: CommonAchievementProgress
}

export const getModWinDetail = async (
  db: DbOrTx,
  winId: number,
): Promise<ModWinDetailData | null> => {
  const [row] = await selectWinJoin(db).where(eq(wins.id, winId)).limit(1)
  if (!row) return null

  const [auditEntries, observationRows, unlockRows, membershipStatus, commonAchievements] = await Promise.all([
    listAuditEntriesForTarget(db, 'win', winId, WIN_AUDIT_LOG_LIMIT),
    db
      .select({
        id: winObservations.id,
        observedAt: winObservations.observedAt,
        currentPlaytimeMinutes: winObservations.currentPlaytimeMinutes,
        playtime2WeeksMinutes: winObservations.playtime2WeeksMinutes,
        achievementsUnlocked: winObservations.achievementsUnlocked,
        achievementsTotal: winObservations.achievementsTotal,
      })
      .from(winObservations)
      .where(eq(winObservations.winId, winId))
      .orderBy(asc(winObservations.observedAt)),
    db
      .select({
        id: achievementEvents.id,
        displayName: steamAchievements.displayName,
        apiname: steamAchievements.apiname,
        unlockedAt: achievementEvents.unlockedAt,
        observedAt: achievementEvents.observedAt,
      })
      .from(achievementEvents)
      .innerJoin(steamAchievements, eq(achievementEvents.achievementId, steamAchievements.id))
      .where(
        and(
          eq(achievementEvents.winId, winId),
          eq(achievementEvents.achieved, true),
          sql`${achievementEvents.unlockedAt} is not null`,
        ),
      )
      .orderBy(asc(achievementEvents.unlockedAt)),
    row.user.steamId
      ? getLatestMembership(db, row.group.id, row.user.steamId)
      : Promise.resolve(null),
    getCommonAchievementProgress(db, { winId, threshold: COMMON_ACHIEVEMENT_THRESHOLD }),
  ])

  const achievementUnlocks: ReadonlyArray<AchievementUnlockView> = unlockRows
    .filter((u): u is typeof u & { unlockedAt: Date } => u.unlockedAt !== null)
    .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      apiname: u.apiname,
      unlockedAt: u.unlockedAt,
      observedAt: u.observedAt,
    }))

  return {
    win: toWinView(row),
    auditEntries,
    observations: observationRows,
    achievementUnlocks,
    membershipStatus,
    commonAchievements,
  }
}

export const getGiveawayPageData = async (
  db: DbOrTx,
  slug: string,
  code: SteamGiftsGiveawayCode,
): Promise<GiveawayPageData | null> => {
  const creators = alias(users, 'creators')
  const [row] = await db
    .select({
      group: {
        id: groups.id,
        slug: groups.slug,
        name: groups.name,
        playWindowDays: groups.playWindowDays,
        description: groups.description,
      },
      giveaway: giveaways,
      app: steamApps,
      sub: steamSubs,
      creator: creators,
    })
    .from(giveaways)
    .innerJoin(groups, eq(groups.id, giveaways.groupId))
    .leftJoin(steamApps, eq(steamApps.appId, giveaways.steamAppId))
    .leftJoin(steamSubs, eq(steamSubs.subId, giveaways.steamSubId))
    .innerJoin(creators, eq(creators.id, giveaways.creatorUserId))
    .where(and(eq(groups.slug, slug), eq(giveaways.steamgiftsCode, code)))
    .limit(1)

  if (!row) return null

  const winRows = await selectWinJoin(db)
    .where(eq(wins.giveawayId, row.giveaway.id))
    .orderBy(asc(wins.wonAt))
  const winViews = winRows.map(toWinView)
  const commonByWinId = await getCommonAchievementProgressBatch(db, {
    winIds: winViews.map((w) => w.id),
    threshold: COMMON_ACHIEVEMENT_THRESHOLD,
  })

  return {
    group: row.group,
    giveaway: {
      id: row.giveaway.id,
      steamgiftsCode: row.giveaway.steamgiftsCode,
      quantity: row.giveaway.quantity,
      startedAt: row.giveaway.startedAt,
      endedAt: row.giveaway.endedAt,
      target: buildTarget(row.app, row.sub),
      creator: {
        id: row.creator.id,
        steamgiftsUsername: requireSgUsername(row.creator),
        steamId: row.creator.steamId,
        avatarUrl: row.creator.avatarUrl,
      },
    },
    wins: winViews,
    commonByWinId: Array.from(commonByWinId),
  }
}

// Cross-group "wins for this Steam app/sub" page. Mirrors selectWinJoin's
// shape but filters by the giveaway's target. One round-trip pulls the rows;
// a second pulls the unfiltered total so pagination can show "showing
// 51–100 of 248" the same way every other paged list does.
const listWinsForGiveawayWhere = async (
  db: DbOrTx,
  whereExpr: ReturnType<typeof eq>,
  page: number,
  pageSize: number,
): Promise<Page<WinView>> => {
  const [rows, totalRow] = await Promise.all([
    selectWinJoin(db)
      .where(whereExpr)
      .orderBy(desc(wins.wonAt))
      .limit(pageSize)
      .offset(toOffset(page, pageSize)),
    db
      .select({ n: count() })
      .from(wins)
      .innerJoin(giveaways, eq(giveaways.id, wins.giveawayId))
      .where(whereExpr),
  ])
  return {
    rows: rows.map(toWinView),
    total: totalRow[0]?.n ?? 0,
    page,
    pageSize,
  }
}

// Cross-group giveaway list filtered by target. winnerCount uses a
// correlated subquery instead of a LEFT JOIN + GROUP BY because the
// outer SELECT already pulls every column of `giveaways` plus joins to
// groups/apps/subs/creators, so a GROUP BY would have to repeat every
// non-aggregated column. The subquery is indexed (wins.giveawayId is
// the FK).
const listGiveawaysForGiveawayWhere = async (
  db: DbOrTx,
  whereExpr: ReturnType<typeof eq>,
  page: number,
  pageSize: number,
): Promise<Page<UserCreatedGiveawayView>> => {
  const creators = alias(users, 'cross_target_creators')
  const winnerCountSql = sql<number>`(SELECT COUNT(*) FROM ${wins} WHERE ${wins.giveawayId} = ${giveaways.id})`
  const [rows, totalRow] = await Promise.all([
    db
      .select({
        giveaway: giveaways,
        group: { slug: groups.slug, name: groups.name },
        app: steamApps,
        sub: steamSubs,
        creator: creators,
        winnerCount: winnerCountSql,
      })
      .from(giveaways)
      .innerJoin(groups, eq(groups.id, giveaways.groupId))
      .leftJoin(steamApps, eq(steamApps.appId, giveaways.steamAppId))
      .leftJoin(steamSubs, eq(steamSubs.subId, giveaways.steamSubId))
      .innerJoin(creators, eq(creators.id, giveaways.creatorUserId))
      .where(whereExpr)
      .orderBy(desc(giveaways.endedAt))
      .limit(pageSize)
      .offset(toOffset(page, pageSize)),
    db.select({ n: count() }).from(giveaways).where(whereExpr),
  ])
  return {
    rows: rows.map((r) => ({
      id: r.giveaway.id,
      steamgiftsCode: r.giveaway.steamgiftsCode,
      target: buildTarget(r.app, r.sub),
      quantity: r.giveaway.quantity,
      startedAt: r.giveaway.startedAt,
      endedAt: r.giveaway.endedAt,
      winnersScrapedAt: r.giveaway.winnersScrapedAt,
      winnerCount: r.winnerCount,
      creator: {
        id: r.creator.id,
        steamgiftsUsername: requireSgUsername(r.creator),
        steamId: r.creator.steamId,
        avatarUrl: r.creator.avatarUrl,
      },
      group: r.group,
    })),
    total: totalRow[0]?.n ?? 0,
    page,
    pageSize,
  }
}

export const getGamePageData = async (
  db: DbOrTx,
  appId: SteamAppId,
  winsPage: number,
  giveawaysPage: number,
  pageSize: number,
): Promise<GamePageData | null> => {
  const app = await findSteamAppById(db, appId)
  if (!app) return null
  const [winsPageData, giveawaysPageData] = await Promise.all([
    listWinsForGiveawayWhere(db, eq(giveaways.steamAppId, appId), winsPage, pageSize),
    listGiveawaysForGiveawayWhere(db, eq(giveaways.steamAppId, appId), giveawaysPage, pageSize),
  ])
  const commonByWinId = await getCommonAchievementProgressBatch(db, {
    winIds: winsPageData.rows.map((w) => w.id),
    threshold: COMMON_ACHIEVEMENT_THRESHOLD,
  })
  return {
    app,
    wins: winsPageData,
    giveaways: giveawaysPageData,
    commonByWinId: Array.from(commonByWinId),
  }
}

export const getSubPageData = async (
  db: DbOrTx,
  subId: SteamSubId,
  winsPage: number,
  giveawaysPage: number,
  pageSize: number,
): Promise<SubPageData | null> => {
  const sub = await findSteamSubById(db, subId)
  if (!sub) return null
  const [winsPageData, giveawaysPageData] = await Promise.all([
    listWinsForGiveawayWhere(db, eq(giveaways.steamSubId, subId), winsPage, pageSize),
    listGiveawaysForGiveawayWhere(db, eq(giveaways.steamSubId, subId), giveawaysPage, pageSize),
  ])
  const commonByWinId = await getCommonAchievementProgressBatch(db, {
    winIds: winsPageData.rows.map((w) => w.id),
    threshold: COMMON_ACHIEVEMENT_THRESHOLD,
  })
  return {
    sub,
    wins: winsPageData,
    giveaways: giveawaysPageData,
    commonByWinId: Array.from(commonByWinId),
  }
}
