import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import type { Db, DbOrTx } from '#/db/client'
import type { SteamAppId } from '#/db/schema'
import { achievementEvents, steamAchievements } from '#/db/schema'

export type SteamAchievement = typeof steamAchievements.$inferSelect
export type AchievementEvent = typeof achievementEvents.$inferSelect

export type UpsertSteamAchievementInput = {
  readonly appId: SteamAppId
  readonly apiname: string
  readonly displayName: string | null
  readonly description: string | null
  readonly lastSyncedAt: Date
}

export const upsertSteamAchievement = async (
  db: DbOrTx,
  input: UpsertSteamAchievementInput,
): Promise<SteamAchievement> => {
  const [row] = await db
    .insert(steamAchievements)
    .values({
      appId: input.appId,
      apiname: input.apiname,
      displayName: input.displayName,
      description: input.description,
      lastSyncedAt: input.lastSyncedAt,
    })
    .onConflictDoUpdate({
      target: [steamAchievements.appId, steamAchievements.apiname],
      set: {
        displayName: sql`coalesce(excluded.display_name, ${steamAchievements.displayName})`,
        description: sql`coalesce(excluded.description, ${steamAchievements.description})`,
        lastSyncedAt: sql`excluded.last_synced_at`,
      },
    })
    .returning()
  if (!row) {
    throw new Error(
      `upsertSteamAchievement returned no row for ${String(input.appId)}/${input.apiname}`,
    )
  }
  return row
}

// Used by the playtime-poll job to skip the per-achievement metadata upsert
// for games whose achievements are already in our DB. Steam achievement
// metadata is essentially static, so a known (app_id, apiname) row never
// needs re-syncing for the same data.
export const listSteamAchievementsByAppIds = async (
  db: DbOrTx,
  appIds: ReadonlyArray<SteamAppId>,
): Promise<ReadonlyArray<SteamAchievement>> => {
  if (appIds.length === 0) return []
  return db.select().from(steamAchievements).where(inArray(steamAchievements.appId, appIds))
}

export type AchievementKey = {
  readonly userId: number
  readonly achievementId: number
}

export const findLatestAchievementEvent = async (
  db: DbOrTx,
  key: AchievementKey,
): Promise<AchievementEvent | null> => {
  const [row] = await db
    .select()
    .from(achievementEvents)
    .where(
      and(
        eq(achievementEvents.userId, key.userId),
        eq(achievementEvents.achievementId, key.achievementId),
      ),
    )
    .orderBy(desc(achievementEvents.id))
    .limit(1)
  return row ?? null
}

export type InsertAchievementEventInput = AchievementKey & {
  readonly winId: number
  readonly achieved: boolean
  readonly unlockedAt: Date | null
  readonly observedAt: Date
}

export const insertAchievementEvent = async (
  db: DbOrTx,
  input: InsertAchievementEventInput,
): Promise<AchievementEvent> => {
  const [row] = await db
    .insert(achievementEvents)
    .values({
      userId: input.userId,
      achievementId: input.achievementId,
      winId: input.winId,
      achieved: input.achieved,
      unlockedAt: input.unlockedAt,
      observedAt: input.observedAt,
    })
    .returning()
  if (!row) throw new Error('insertAchievementEvent: insert failed')
  return row
}

export type RecordAchievementStateInput = InsertAchievementEventInput

export type RecordAchievementStateResult = { readonly inserted: boolean }

// Append-only event log: insert a new event only when the achieved state has
// changed since the last observation. Locked-by-default is the empty state, so
// the very first observation of an achievement only writes a row when
// achieved=true.
export const recordAchievementStateIfChanged = async (
  db: Db,
  input: RecordAchievementStateInput,
): Promise<RecordAchievementStateResult> => {
  const latest = await findLatestAchievementEvent(db, {
    userId: input.userId,
    achievementId: input.achievementId,
  })
  if (latest === null) {
    if (!input.achieved) return { inserted: false }
    await insertAchievementEvent(db, input)
    return { inserted: true }
  }
  if (latest.achieved === input.achieved) return { inserted: false }
  await insertAchievementEvent(db, input)
  return { inserted: true }
}

export const listAchievementEventsByWin = async (
  db: DbOrTx,
  winId: number,
): Promise<ReadonlyArray<AchievementEvent>> =>
  db
    .select()
    .from(achievementEvents)
    .where(eq(achievementEvents.winId, winId))
    .orderBy(desc(achievementEvents.id))
