import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'

import type { Db, DbOrTx } from '#/db/client'
import { withTransaction } from '#/db/client'
import type { SteamAppId, SteamId, WinStatus } from '#/db/schema'
import { giveaways, groups, users, winObservations, wins } from '#/db/schema'

// Resolves the group that owns a given giveaway. Used by the win-counter
// maintenance paths below — they need to know which row in `groups` to bump.
const findGroupIdByGiveaway = async (db: DbOrTx, giveawayId: number): Promise<number> => {
  const [row] = await db
    .select({ groupId: giveaways.groupId })
    .from(giveaways)
    .where(eq(giveaways.id, giveawayId))
    .limit(1)
  if (!row) throw new Error(`giveaway ${String(giveawayId)} not found`)
  return row.groupId
}

export type Win = typeof wins.$inferSelect
export type WinObservation = typeof winObservations.$inferSelect

export type WinObservableFields = {
  readonly currentPlaytimeMinutes: number | null
  readonly playtime2WeeksMinutes: number | null
  readonly hasReview: boolean | null
  readonly screenshotCount: number | null
  readonly achievementsUnlocked: number | null
  readonly achievementsTotal: number | null
}

export type InsertWinInput = {
  readonly giveawayId: number
  readonly userId: number
  readonly wonAt: Date
  readonly playDeadline: Date
}

export type WinPlaytimeBaselineUpdate = {
  readonly playtimeAtWinMinutes: number | null
  readonly currentPlaytimeMinutes: number | null
  readonly playtime2WeeksMinutes: number | null
  readonly hasReview: boolean | null
  readonly screenshotCount: number | null
  readonly achievementsUnlocked: number | null
  readonly achievementsTotal: number | null
  readonly checkedAt: Date
}

export type WinPlaytimeProgressUpdate = {
  readonly currentPlaytimeMinutes: number | null
  readonly playtime2WeeksMinutes: number | null
  readonly hasReview: boolean | null
  readonly screenshotCount: number | null
  readonly achievementsUnlocked: number | null
  readonly achievementsTotal: number | null
  readonly checkedAt: Date
}

export const findWinById = async (db: DbOrTx, id: number): Promise<Win | null> => {
  const [row] = await db.select().from(wins).where(eq(wins.id, id)).limit(1)
  return row ?? null
}

// Cheap lookup used by mod-fn auth gates: given a winId, return the
// groupId so the caller can run requireGroupModerator(groupId) before
// loading the rest of the win data. Returns null if the win doesn't exist.
export const findGroupIdByWinId = async (
  db: DbOrTx,
  winId: number,
): Promise<number | null> => {
  const [row] = await db
    .select({ groupId: giveaways.groupId })
    .from(wins)
    .innerJoin(giveaways, eq(giveaways.id, wins.giveawayId))
    .where(eq(wins.id, winId))
    .limit(1)
  return row?.groupId ?? null
}

export const findWinByGiveawayAndUser = async (
  db: DbOrTx,
  giveawayId: number,
  userId: number,
): Promise<Win | null> => {
  const [row] = await db
    .select()
    .from(wins)
    .where(and(eq(wins.giveawayId, giveawayId), eq(wins.userId, userId)))
    .limit(1)
  return row ?? null
}

export const insertWinIfAbsent = async (db: DbOrTx, input: InsertWinInput): Promise<Win | null> => {
  const inserted = await db.insert(wins).values(input).onConflictDoNothing().returning()
  const row = inserted[0]
  if (!row) return null
  // New wins start as 'pending', so both counters increment. No-op when the
  // insert was suppressed by ON CONFLICT (we returned above).
  const groupId = await findGroupIdByGiveaway(db, row.giveawayId)
  await db
    .update(groups)
    .set({
      totalWins: sql`${groups.totalWins} + 1`,
      pendingWins: sql`${groups.pendingWins} + 1`,
    })
    .where(eq(groups.id, groupId))
  return row
}

export const listRecentWinsByGroup = async (
  db: DbOrTx,
  groupId: number,
  limit: number,
): Promise<ReadonlyArray<Win>> =>
  db
    .select({
      id: wins.id,
      giveawayId: wins.giveawayId,
      userId: wins.userId,
      wonAt: wins.wonAt,
      playDeadline: wins.playDeadline,
      playtimeAtWinMinutes: wins.playtimeAtWinMinutes,
      currentPlaytimeMinutes: wins.currentPlaytimeMinutes,
      playtime2WeeksMinutes: wins.playtime2WeeksMinutes,
      hasReview: wins.hasReview,
      screenshotCount: wins.screenshotCount,
      achievementsUnlocked: wins.achievementsUnlocked,
      achievementsTotal: wins.achievementsTotal,
      status: wins.status,
      lastCheckedAt: wins.lastCheckedAt,
      resolvedAt: wins.resolvedAt,
      modNotes: wins.modNotes,
    })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .where(and(eq(giveaways.groupId, groupId), isNull(giveaways.deletedAt)))
    .orderBy(desc(wins.wonAt))
    .limit(limit)

// Wins on soft-deleted giveaways are filtered out so user profiles, polling,
// and mod views don't surface entries the admin removed. The DB rows stay
// (preserving observation history); reads bridge through giveaways.deletedAt.
export const listWinsByUser = async (db: DbOrTx, userId: number): Promise<ReadonlyArray<Win>> =>
  db
    .select({
      id: wins.id,
      giveawayId: wins.giveawayId,
      userId: wins.userId,
      wonAt: wins.wonAt,
      playDeadline: wins.playDeadline,
      playtimeAtWinMinutes: wins.playtimeAtWinMinutes,
      currentPlaytimeMinutes: wins.currentPlaytimeMinutes,
      playtime2WeeksMinutes: wins.playtime2WeeksMinutes,
      hasReview: wins.hasReview,
      screenshotCount: wins.screenshotCount,
      achievementsUnlocked: wins.achievementsUnlocked,
      achievementsTotal: wins.achievementsTotal,
      status: wins.status,
      lastCheckedAt: wins.lastCheckedAt,
      resolvedAt: wins.resolvedAt,
      modNotes: wins.modNotes,
    })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .where(and(eq(wins.userId, userId), isNull(giveaways.deletedAt)))
    .orderBy(desc(wins.wonAt))

export const listWinsByGiveaway = async (
  db: DbOrTx,
  giveawayId: number,
): Promise<ReadonlyArray<Win>> =>
  db.select().from(wins).where(eq(wins.giveawayId, giveawayId)).orderBy(asc(wins.wonAt))

export const listPendingPastDeadlineByGroup = async (
  db: DbOrTx,
  groupId: number,
  now: Date,
): Promise<ReadonlyArray<Win>> =>
  db
    .select({
      id: wins.id,
      giveawayId: wins.giveawayId,
      userId: wins.userId,
      wonAt: wins.wonAt,
      playDeadline: wins.playDeadline,
      playtimeAtWinMinutes: wins.playtimeAtWinMinutes,
      currentPlaytimeMinutes: wins.currentPlaytimeMinutes,
      playtime2WeeksMinutes: wins.playtime2WeeksMinutes,
      hasReview: wins.hasReview,
      screenshotCount: wins.screenshotCount,
      achievementsUnlocked: wins.achievementsUnlocked,
      achievementsTotal: wins.achievementsTotal,
      status: wins.status,
      lastCheckedAt: wins.lastCheckedAt,
      resolvedAt: wins.resolvedAt,
      modNotes: wins.modNotes,
    })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .where(
      and(
        eq(giveaways.groupId, groupId),
        eq(wins.status, 'pending'),
        lt(wins.playDeadline, now),
        isNull(giveaways.deletedAt),
      ),
    )
    .orderBy(asc(wins.playDeadline))

// Polling skips wins whose giveaway was soft-deleted — no point burning
// Steam API quota on tracking that won't surface in any view.
export const listPendingForPolling = async (db: DbOrTx): Promise<ReadonlyArray<Win>> =>
  db
    .select({
      id: wins.id,
      giveawayId: wins.giveawayId,
      userId: wins.userId,
      wonAt: wins.wonAt,
      playDeadline: wins.playDeadline,
      playtimeAtWinMinutes: wins.playtimeAtWinMinutes,
      currentPlaytimeMinutes: wins.currentPlaytimeMinutes,
      playtime2WeeksMinutes: wins.playtime2WeeksMinutes,
      hasReview: wins.hasReview,
      screenshotCount: wins.screenshotCount,
      achievementsUnlocked: wins.achievementsUnlocked,
      achievementsTotal: wins.achievementsTotal,
      status: wins.status,
      lastCheckedAt: wins.lastCheckedAt,
      resolvedAt: wins.resolvedAt,
      modNotes: wins.modNotes,
    })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .where(and(eq(wins.status, 'pending'), isNull(giveaways.deletedAt)))
    .orderBy(asc(wins.lastCheckedAt))

export const listPendingForPlaytimePoll = async (
  db: DbOrTx,
  deadlineCutoff: Date,
): Promise<ReadonlyArray<Win>> =>
  db
    .select({
      id: wins.id,
      giveawayId: wins.giveawayId,
      userId: wins.userId,
      wonAt: wins.wonAt,
      playDeadline: wins.playDeadline,
      playtimeAtWinMinutes: wins.playtimeAtWinMinutes,
      currentPlaytimeMinutes: wins.currentPlaytimeMinutes,
      playtime2WeeksMinutes: wins.playtime2WeeksMinutes,
      hasReview: wins.hasReview,
      screenshotCount: wins.screenshotCount,
      achievementsUnlocked: wins.achievementsUnlocked,
      achievementsTotal: wins.achievementsTotal,
      status: wins.status,
      lastCheckedAt: wins.lastCheckedAt,
      resolvedAt: wins.resolvedAt,
      modNotes: wins.modNotes,
    })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .where(
      and(
        eq(wins.status, 'pending'),
        gte(wins.playDeadline, deadlineCutoff),
        isNull(giveaways.deletedAt),
      ),
    )
    .orderBy(asc(wins.lastCheckedAt))

// Cadence and pre-spread parameters for the resolved-win refresh path.
// Wins resolved within the last year are refreshed every ~14d; older wins
// every ~30d. Each win gets a stable per-id offset (Fibonacci hashing) so
// a batch that resolved together doesn't all become "due" in the same hour
// — the offset distributes them across the full cadence window.
const RESOLVED_FRESH_THRESHOLD_S = 365 * 24 * 60 * 60
const RESOLVED_FRESH_CADENCE_S = 14 * 24 * 60 * 60
const RESOLVED_OLD_CADENCE_S = 30 * 24 * 60 * 60
// Knuth's multiplicative hashing constant. Coprime to the cadence values
// above and small enough that id * MULT stays within SQLite's 64-bit signed
// int range for any plausible win id.
const SPREAD_MULT = 2654435761

// SQL: this resolved win is past its individually-spread next-due time.
// Encoded as a single boolean expression so the planner can use the
// status/playDeadline index for its sibling pending predicate.
//
// Drizzle stores `timestamp` columns as integer unix seconds, so compare
// directly to nowSeconds — wrapping the column with `unixepoch(...)` would
// re-interpret it as a Julian Day number and produce nonsense. `now` is
// threaded in (rather than using SQLite's `unixepoch()`) so tests with
// synthetic dates stay deterministic.
const buildResolvedDueExpr = (nowSeconds: number) => sql`(
  ${wins.lastCheckedAt} IS NULL
  OR (
    ${nowSeconds} - ${wins.lastCheckedAt} >=
      CASE
        WHEN ${wins.resolvedAt} IS NULL
          OR ${nowSeconds} - ${wins.resolvedAt} <= ${RESOLVED_FRESH_THRESHOLD_S}
        THEN ${RESOLVED_FRESH_CADENCE_S}
          + ((${wins.id} * ${SPREAD_MULT}) % ${RESOLVED_FRESH_CADENCE_S})
        ELSE ${RESOLVED_OLD_CADENCE_S}
          + ((${wins.id} * ${SPREAD_MULT}) % ${RESOLVED_OLD_CADENCE_S})
      END
  )
)`

export type WinForPoll = Win & {
  readonly steamId: SteamId
  readonly appId: SteamAppId
}

export type ListForPlaytimePollResult = {
  // Wins to actually poll. Pre-filtered to pollable rows (giveaway not
  // soft-deleted, app id and steam id both present), keyed by win.id with
  // joined steamId/appId so the worker doesn't have to round-trip per win.
  readonly wins: ReadonlyArray<WinForPoll>
  // Number of pending wins inside the deadline window that we couldn't
  // poll (missing steamId or steam app id). Reported as a metric so the
  // operator can spot data integrity gaps.
  readonly skippedNoContext: number
}

const winForPollColumns = {
  id: wins.id,
  giveawayId: wins.giveawayId,
  userId: wins.userId,
  wonAt: wins.wonAt,
  playDeadline: wins.playDeadline,
  playtimeAtWinMinutes: wins.playtimeAtWinMinutes,
  currentPlaytimeMinutes: wins.currentPlaytimeMinutes,
  playtime2WeeksMinutes: wins.playtime2WeeksMinutes,
  hasReview: wins.hasReview,
  screenshotCount: wins.screenshotCount,
  achievementsUnlocked: wins.achievementsUnlocked,
  achievementsTotal: wins.achievementsTotal,
  status: wins.status,
  lastCheckedAt: wins.lastCheckedAt,
  resolvedAt: wins.resolvedAt,
  modNotes: wins.modNotes,
  steamId: users.steamId,
  appId: giveaways.steamAppId,
} as const

// Returns every pollable win for any user with at least one "trigger" win.
// Trigger = pending-within-deadline-window OR resolved-and-due-for-refresh.
// Once a user is selected, all their pollable wins ride along (one
// getOwnedGames call covers them all — see worker poll job for the
// piggyback semantics on the resolved-but-not-due rows).
//
// Two queries:
//   1) trigger user_ids (sub-select would also work but keeping it explicit
//      makes the IN(...) cheap — typical worker tick selects ≤ a few dozen
//      users, well below SQLite's IN list threshold).
//   2) all pollable wins for those users, ordered oldest-checked first so
//      a per-tick cap (if ever added) drains the most-neglected first.
export const listForPlaytimePoll = async (
  db: DbOrTx,
  pendingDeadlineCutoff: Date,
  now: Date,
): Promise<ListForPlaytimePollResult> => {
  const resolvedDueExpr = buildResolvedDueExpr(Math.floor(now.getTime() / 1000))
  const triggerRows = await db
    .selectDistinct({ userId: wins.userId })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .innerJoin(users, eq(wins.userId, users.id))
    .where(
      and(
        isNull(giveaways.deletedAt),
        isNotNull(giveaways.steamAppId),
        isNotNull(users.steamId),
        or(
          and(eq(wins.status, 'pending'), gte(wins.playDeadline, pendingDeadlineCutoff)),
          and(ne(wins.status, 'pending'), resolvedDueExpr),
        ),
      ),
    )

  if (triggerRows.length === 0) {
    return { wins: [], skippedNoContext: 0 }
  }

  const userIds = triggerRows.map((r) => r.userId)

  // Pull every pollable win for the trigger users in one shot. The same
  // sub-select on giveaways.deletedAt / NOT NULL guards we used to find the
  // trigger users apply here too — a user with a missing-context win in
  // their set just gets that row dropped, not the whole user.
  const rows = await db
    .select(winForPollColumns)
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .innerJoin(users, eq(wins.userId, users.id))
    .where(
      and(
        inArray(wins.userId, userIds),
        isNull(giveaways.deletedAt),
        isNotNull(giveaways.steamAppId),
        isNotNull(users.steamId),
        // Don't carry pending wins past the deadline cutoff into the poll —
        // those are presumed kicked/exempt and live outside the poll window.
        // Resolved wins of trigger users are always included (cadence gate
        // is applied in TS so the worker can branch full vs piggyback).
        or(
          and(eq(wins.status, 'pending'), gte(wins.playDeadline, pendingDeadlineCutoff)),
          ne(wins.status, 'pending'),
        ),
      ),
    )
    .orderBy(asc(wins.lastCheckedAt))

  // Count pending-in-window rows for these trigger users that were skipped
  // for missing context. Resolved wins missing context are ignored by design
  // — they're permanent gaps that don't need re-flagging on every tick.
  const skippedRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .leftJoin(users, eq(wins.userId, users.id))
    .where(
      and(
        eq(wins.status, 'pending'),
        gte(wins.playDeadline, pendingDeadlineCutoff),
        isNull(giveaways.deletedAt),
        or(isNull(giveaways.steamAppId), isNull(users.steamId)),
      ),
    )
  const skippedNoContext = skippedRows[0]?.count ?? 0

  // The select shape narrows steamId/appId to non-null via the inner joins
  // and IS NOT NULL filters, but Drizzle's type for joined nullable columns
  // stays nullable. Cast at the boundary; runtime is guaranteed by the WHERE.
  const polled: WinForPoll[] = rows.map((r) => ({
    ...r,
    steamId: r.steamId as SteamId,
    appId: r.appId as SteamAppId,
  }))
  return { wins: polled, skippedNoContext }
}

// Bumps lastCheckedAt for a batch of wins without writing any observation
// or observable-fields data. Used by the poll job when a user's profile
// comes back private — we couldn't actually see their data, but we did
// "check," so the cadence pointer should advance. Without this, private
// profiles would dominate the lastCheckedAt-asc ordering forever and cost
// a Steam call per (user, win) per tick to confirm "still private."
//
// Resolved wins naturally defer to their per-id-spread cadence after this.
// Pending wins still re-trigger hourly because the pending selector
// doesn't gate on lastCheckedAt — that path remains a known re-poll cost
// (worth measuring before deciding to add a separate backoff).
export const markWinsChecked = async (
  db: DbOrTx,
  winIds: ReadonlyArray<number>,
  checkedAt: Date,
): Promise<void> => {
  if (winIds.length === 0) return
  await db.update(wins).set({ lastCheckedAt: checkedAt }).where(inArray(wins.id, winIds))
}

export const updateWinStatus = async (
  db: DbOrTx,
  winId: number,
  status: WinStatus,
  resolvedAt: Date | null,
): Promise<Win> => {
  // Read previous status before the update so we know how to adjust the
  // group's pending_wins counter. The PK lookup is cheap (~0.18ms) compared
  // to keeping a stale count.
  const [existing] = await db
    .select({ status: wins.status, giveawayId: wins.giveawayId })
    .from(wins)
    .where(eq(wins.id, winId))
    .limit(1)
  if (!existing) throw new Error(`updateWinStatus: win ${String(winId)} not found`)

  const [row] = await db
    .update(wins)
    .set({ status, resolvedAt })
    .where(eq(wins.id, winId))
    .returning()
  if (!row) throw new Error(`updateWinStatus: win ${String(winId)} not found`)

  const wasPending = existing.status === 'pending'
  const isPending = status === 'pending'
  if (wasPending !== isPending) {
    const groupId = await findGroupIdByGiveaway(db, existing.giveawayId)
    const delta = isPending ? 1 : -1
    await db
      .update(groups)
      .set({ pendingWins: sql`${groups.pendingWins} + ${delta}` })
      .where(eq(groups.id, groupId))
  }

  return row
}

export const updateWinNotes = async (
  db: DbOrTx,
  winId: number,
  notes: string | null,
): Promise<Win> => {
  const [row] = await db.update(wins).set({ modNotes: notes }).where(eq(wins.id, winId)).returning()
  if (!row) throw new Error(`updateWinNotes: win ${String(winId)} not found`)
  return row
}

const insertWinObservationTx = async (
  tx: DbOrTx,
  winId: number,
  observedAt: Date,
  fields: WinObservableFields,
): Promise<WinObservation> => {
  const [row] = await tx
    .insert(winObservations)
    .values({
      winId,
      observedAt,
      currentPlaytimeMinutes: fields.currentPlaytimeMinutes,
      playtime2WeeksMinutes: fields.playtime2WeeksMinutes,
      hasReview: fields.hasReview,
      screenshotCount: fields.screenshotCount,
      achievementsUnlocked: fields.achievementsUnlocked,
      achievementsTotal: fields.achievementsTotal,
    })
    .returning()
  if (!row) throw new Error(`insertWinObservation: insert failed for win ${String(winId)}`)
  return row
}

export const insertWinObservation = async (
  db: DbOrTx,
  winId: number,
  observedAt: Date,
  fields: WinObservableFields,
): Promise<WinObservation> => insertWinObservationTx(db, winId, observedAt, fields)

export const listWinObservations = async (
  db: DbOrTx,
  winId: number,
): Promise<ReadonlyArray<WinObservation>> =>
  db
    .select()
    .from(winObservations)
    .where(eq(winObservations.winId, winId))
    .orderBy(asc(winObservations.observedAt))

const observablesChanged = (a: WinObservableFields, b: WinObservableFields): boolean =>
  a.currentPlaytimeMinutes !== b.currentPlaytimeMinutes ||
  a.playtime2WeeksMinutes !== b.playtime2WeeksMinutes ||
  a.hasReview !== b.hasReview ||
  a.screenshotCount !== b.screenshotCount ||
  a.achievementsUnlocked !== b.achievementsUnlocked ||
  a.achievementsTotal !== b.achievementsTotal

export type RecordWinPlaytimeBaselineResult = {
  readonly win: Win
  readonly observationWritten: boolean
}

export const recordWinPlaytimeBaseline = async (
  db: Db,
  winId: number,
  update: WinPlaytimeBaselineUpdate,
): Promise<RecordWinPlaytimeBaselineResult> =>
  withTransaction(db, async (tx) => {
    const [row] = await tx
      .update(wins)
      .set({
        playtimeAtWinMinutes: update.playtimeAtWinMinutes,
        currentPlaytimeMinutes: update.currentPlaytimeMinutes,
        playtime2WeeksMinutes: update.playtime2WeeksMinutes,
        hasReview: update.hasReview,
        screenshotCount: update.screenshotCount,
        achievementsUnlocked: update.achievementsUnlocked,
        achievementsTotal: update.achievementsTotal,
        lastCheckedAt: update.checkedAt,
      })
      .where(eq(wins.id, winId))
      .returning()
    if (!row) throw new Error(`recordWinPlaytimeBaseline: win ${String(winId)} not found`)
    // Skip the observation row when we have no playtime data — Steam hid the
    // game from us. We'll keep retrying baseline path on subsequent polls
    // (since playtimeAtWinMinutes stays null) without spamming null rows.
    let observationWritten = false
    if (update.currentPlaytimeMinutes !== null) {
      await insertWinObservationTx(tx, winId, update.checkedAt, {
        currentPlaytimeMinutes: update.currentPlaytimeMinutes,
        playtime2WeeksMinutes: update.playtime2WeeksMinutes,
        hasReview: update.hasReview,
        screenshotCount: update.screenshotCount,
        achievementsUnlocked: update.achievementsUnlocked,
        achievementsTotal: update.achievementsTotal,
      })
      observationWritten = true
    }
    return { win: row, observationWritten }
  })

export type WinPlaytimePiggybackUpdate = {
  readonly currentPlaytimeMinutes: number | null
  readonly playtime2WeeksMinutes: number | null
  readonly observedAt: Date
}

export type RecordWinPlaytimePiggybackResult = {
  readonly win: Win
  readonly changed: boolean
}

// Playtime-only refresh that piggybacks on a getOwnedGames call made for
// some other reason (typically: this user has a pending or due-resolved
// win, and including their not-yet-due resolved wins in the same call is
// free). Three differences from recordWinPlaytimeProgress:
//   1) Only currentPlaytimeMinutes / playtime2WeeksMinutes are written —
//      we didn't fetch achievements/screenshots so we don't touch them.
//   2) lastCheckedAt is NOT bumped. That column is the cadence pointer
//      for the resolved-due predicate; updating it here would mean
//      resolved wins of users with active pending wins never become due
//      for a full refresh.
//   3) The observation row carries the piggybacked playtime alongside the
//      currently-known achievement/screenshot fields from `wins` — each
//      observation stays a complete state snapshot rather than holding
//      nulls for fields we didn't refresh.
export const recordWinPlaytimePiggyback = async (
  db: Db,
  winId: number,
  update: WinPlaytimePiggybackUpdate,
): Promise<RecordWinPlaytimePiggybackResult> =>
  withTransaction(db, async (tx) => {
    const [existing] = await tx.select().from(wins).where(eq(wins.id, winId)).limit(1)
    if (!existing) throw new Error(`recordWinPlaytimePiggyback: win ${String(winId)} not found`)

    const changed =
      existing.currentPlaytimeMinutes !== update.currentPlaytimeMinutes ||
      existing.playtime2WeeksMinutes !== update.playtime2WeeksMinutes

    if (!changed) return { win: existing, changed: false }

    const [row] = await tx
      .update(wins)
      .set({
        currentPlaytimeMinutes: update.currentPlaytimeMinutes,
        playtime2WeeksMinutes: update.playtime2WeeksMinutes,
      })
      .where(eq(wins.id, winId))
      .returning()
    if (!row) throw new Error(`recordWinPlaytimePiggyback: win ${String(winId)} not found`)

    await insertWinObservationTx(tx, winId, update.observedAt, {
      currentPlaytimeMinutes: update.currentPlaytimeMinutes,
      playtime2WeeksMinutes: update.playtime2WeeksMinutes,
      hasReview: existing.hasReview,
      screenshotCount: existing.screenshotCount,
      achievementsUnlocked: existing.achievementsUnlocked,
      achievementsTotal: existing.achievementsTotal,
    })
    return { win: row, changed: true }
  })

export type RecordWinPlaytimeProgressResult = {
  readonly win: Win
  readonly changed: boolean
}

export const recordWinPlaytimeProgress = async (
  db: Db,
  winId: number,
  update: WinPlaytimeProgressUpdate,
): Promise<RecordWinPlaytimeProgressResult> =>
  withTransaction(db, async (tx) => {
    const [existing] = await tx.select().from(wins).where(eq(wins.id, winId)).limit(1)
    if (!existing) throw new Error(`recordWinPlaytimeProgress: win ${String(winId)} not found`)

    const next: WinObservableFields = {
      currentPlaytimeMinutes: update.currentPlaytimeMinutes,
      playtime2WeeksMinutes: update.playtime2WeeksMinutes,
      hasReview: update.hasReview,
      screenshotCount: update.screenshotCount,
      achievementsUnlocked: update.achievementsUnlocked,
      achievementsTotal: update.achievementsTotal,
    }
    const prev: WinObservableFields = {
      currentPlaytimeMinutes: existing.currentPlaytimeMinutes,
      playtime2WeeksMinutes: existing.playtime2WeeksMinutes,
      hasReview: existing.hasReview,
      screenshotCount: existing.screenshotCount,
      achievementsUnlocked: existing.achievementsUnlocked,
      achievementsTotal: existing.achievementsTotal,
    }
    const changed = observablesChanged(prev, next)

    const [row] = await tx
      .update(wins)
      .set({
        currentPlaytimeMinutes: update.currentPlaytimeMinutes,
        playtime2WeeksMinutes: update.playtime2WeeksMinutes,
        hasReview: update.hasReview,
        screenshotCount: update.screenshotCount,
        achievementsUnlocked: update.achievementsUnlocked,
        achievementsTotal: update.achievementsTotal,
        lastCheckedAt: update.checkedAt,
      })
      .where(eq(wins.id, winId))
      .returning()
    if (!row) throw new Error(`recordWinPlaytimeProgress: win ${String(winId)} not found`)

    if (changed) {
      await insertWinObservationTx(tx, winId, update.checkedAt, next)
    }
    return { win: row, changed }
  })
