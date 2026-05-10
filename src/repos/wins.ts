import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm'

import type { Db, DbOrTx } from '#/db/client'
import { withTransaction } from '#/db/client'
import type { WinStatus } from '#/db/schema'
import { giveaways, groups, winObservations, wins } from '#/db/schema'

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
