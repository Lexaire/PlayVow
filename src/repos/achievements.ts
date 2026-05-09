import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import type { Db, DbOrTx } from '#/db/client'
import type { SteamAppId } from '#/db/schema'
import { achievementEvents, giveaways, steamAchievements, wins } from '#/db/schema'
import type { CommonAchievementProgress } from '#/domain/achievement-criteria'

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

// AppIds with at least one achievement row whose global_percent has either
// never been refreshed or is older than the cutoff. Used by
// refresh_app_achievement_percents to find batches of work each tick. We
// dedupe app_ids in SQL so the caller can iterate apps directly.
export const findAppIdsNeedingPercentRefresh = async (
  db: DbOrTx,
  cutoff: Date,
  limit: number,
): Promise<ReadonlyArray<SteamAppId>> => {
  const rows = await db
    .selectDistinct({ appId: steamAchievements.appId })
    .from(steamAchievements)
    .where(
      or(
        isNull(steamAchievements.percentRefreshedAt),
        lt(steamAchievements.percentRefreshedAt, cutoff),
      ),
    )
    .limit(limit)
  return rows.map((r) => r.appId)
}

export type AppPercentUpdate = {
  readonly appId: SteamAppId
  readonly percents: ReadonlyArray<{ readonly apiname: string; readonly percent: number }>
  readonly refreshedAt: Date
}

// Updates global_percent and percent_refreshed_at for every existing
// (app_id, apiname) row where the apiname is in the new percents list. Rows
// for apinames Steam no longer reports keep their stale percent but still
// get percent_refreshed_at bumped — they fall out of the refresh queue but
// their old number is preserved (which is a more honest signal than NULL
// when Steam temporarily mis-reports). Apinames Steam reports that we don't
// have a row for are silently dropped — the metadata-creation path is
// owned by poll_playtime upserting from per-player calls.
export type RefreshPercentsResult = {
  readonly rowsUpdated: number
  readonly apinamesNotInDb: number
}

export const refreshAppAchievementPercents = async (
  db: Db,
  update: AppPercentUpdate,
): Promise<RefreshPercentsResult> => {
  const known = await db
    .select({ id: steamAchievements.id, apiname: steamAchievements.apiname })
    .from(steamAchievements)
    .where(eq(steamAchievements.appId, update.appId))
  const knownByApiname = new Map(known.map((k) => [k.apiname, k.id]))

  let rowsUpdated = 0
  let apinamesNotInDb = 0
  for (const p of update.percents) {
    const id = knownByApiname.get(p.apiname)
    if (id === undefined) {
      apinamesNotInDb += 1
      continue
    }
    await db
      .update(steamAchievements)
      .set({ globalPercent: p.percent, percentRefreshedAt: update.refreshedAt })
      .where(eq(steamAchievements.id, id))
    rowsUpdated += 1
  }

  // Bump the refresh timestamp on rows whose apiname Steam didn't return
  // (so we don't keep retrying them every tick). Their globalPercent stays
  // at its previous value (possibly null).
  const reportedApinames = new Set(update.percents.map((p) => p.apiname))
  const stale = known.filter((k) => !reportedApinames.has(k.apiname))
  if (stale.length > 0) {
    await db
      .update(steamAchievements)
      .set({ percentRefreshedAt: update.refreshedAt })
      .where(
        inArray(
          steamAchievements.id,
          stale.map((s) => s.id),
        ),
      )
  }

  return { rowsUpdated, apinamesNotInDb }
}

// Per-win compute for the YIRG criteria evidence panel. Reads:
//   1. The win's giveaway → user + app
//   2. All steam_achievements for that app
//   3. The user's latest achievement_event per (user, achievement) for the
//      common ones
// Returns one of three states; see CommonAchievementProgress for semantics.
//
// Bounded by one app's achievement set (typically tens) and one user's
// events for those achievements — so this stays cheap even on a list page.
// If list pages get slow, the right fix is to batch by winId, not to
// pre-compute on the wins row (premature for the per-page volume).
export const getCommonAchievementProgress = async (
  db: DbOrTx,
  args: { readonly winId: number; readonly threshold: number },
): Promise<CommonAchievementProgress> => {
  const [winRow] = await db
    .select({ appId: giveaways.steamAppId, userId: wins.userId })
    .from(wins)
    .innerJoin(giveaways, eq(giveaways.id, wins.giveawayId))
    .where(eq(wins.id, args.winId))
    .limit(1)
  // Sub-targeted giveaways have no appId, so the criterion doesn't apply
  // (subs don't have achievements directly — only the apps they bundle do).
  if (!winRow || winRow.appId === null) return { status: 'no_achievements' }

  const allAchievements = await db
    .select({
      id: steamAchievements.id,
      globalPercent: steamAchievements.globalPercent,
      percentRefreshedAt: steamAchievements.percentRefreshedAt,
    })
    .from(steamAchievements)
    .where(eq(steamAchievements.appId, winRow.appId))
  if (allAchievements.length === 0) return { status: 'no_achievements' }

  const refreshed = allAchievements.filter((a) => a.percentRefreshedAt !== null)
  if (refreshed.length === 0) return { status: 'no_percent_data' }

  const common = refreshed.filter(
    (a) => a.globalPercent !== null && a.globalPercent >= args.threshold,
  )
  const total = common.length
  if (total === 0) {
    return { status: 'computed', unlocked: 0, total: 0, threshold: args.threshold }
  }

  const commonIds = common.map((c) => c.id)
  // Ascending by id so the last assignment to the per-achievement map wins
  // → the latest event survives. Cheap because (user_id, achievement_id, id)
  // is indexed and we filter to a small id list.
  const events = await db
    .select({
      achievementId: achievementEvents.achievementId,
      achieved: achievementEvents.achieved,
    })
    .from(achievementEvents)
    .where(
      and(
        eq(achievementEvents.userId, winRow.userId),
        inArray(achievementEvents.achievementId, commonIds),
      ),
    )
    .orderBy(asc(achievementEvents.id))

  const latestByAchId = new Map<number, boolean>()
  for (const e of events) latestByAchId.set(e.achievementId, e.achieved)

  let unlocked = 0
  for (const achieved of latestByAchId.values()) if (achieved) unlocked += 1

  return { status: 'computed', unlocked, total, threshold: args.threshold }
}

// Batched variant for list pages — same compute as getCommonAchievementProgress
// but in 3 queries total instead of 2 per win. The shape is a Map keyed by
// winId so callers can render inline without hash lookups.
//
// Wins missing from the returned map (because we couldn't resolve their
// app/user) get rendered as no_achievements at the call site, which keeps
// the renderer simple.
export const getCommonAchievementProgressBatch = async (
  db: DbOrTx,
  args: { readonly winIds: ReadonlyArray<number>; readonly threshold: number },
): Promise<ReadonlyMap<number, CommonAchievementProgress>> => {
  const out = new Map<number, CommonAchievementProgress>()
  if (args.winIds.length === 0) return out

  // Step 1: resolve (winId → appId, userId). Sub-targeted wins have a null
  // appId — we mark them no_achievements upfront and skip them in the joins.
  const winContexts = await db
    .select({
      winId: wins.id,
      appId: giveaways.steamAppId,
      userId: wins.userId,
    })
    .from(wins)
    .innerJoin(giveaways, eq(giveaways.id, wins.giveawayId))
    .where(inArray(wins.id, [...args.winIds]))

  const appIds = new Set<SteamAppId>()
  const userIds = new Set<number>()
  type WinCtx = { readonly winId: number; readonly appId: SteamAppId; readonly userId: number }
  const ctxByWinId = new Map<number, WinCtx>()
  for (const w of winContexts) {
    if (w.appId === null) {
      out.set(w.winId, { status: 'no_achievements' })
      continue
    }
    appIds.add(w.appId)
    userIds.add(w.userId)
    ctxByWinId.set(w.winId, { winId: w.winId, appId: w.appId, userId: w.userId })
  }
  if (ctxByWinId.size === 0) return out

  // Step 2: all achievements for the involved apps. We over-fetch slightly
  // (achievements for apps that ended up with no surviving win contexts are
  // skipped at the per-win stage) but it's bounded by the page's distinct
  // appIds.
  const achievementRows = await db
    .select({
      id: steamAchievements.id,
      appId: steamAchievements.appId,
      globalPercent: steamAchievements.globalPercent,
      percentRefreshedAt: steamAchievements.percentRefreshedAt,
    })
    .from(steamAchievements)
    .where(inArray(steamAchievements.appId, [...appIds]))

  type PerAppAch = {
    readonly anyAchievements: boolean
    readonly anyRefreshed: boolean
    readonly commonIds: ReadonlyArray<number>
  }
  const perApp = new Map<SteamAppId, PerAppAch>()
  const allCommonIds = new Set<number>()
  // Bucket by app, then collapse to summary per app.
  const grouped = new Map<SteamAppId, typeof achievementRows>()
  for (const a of achievementRows) {
    let g = grouped.get(a.appId)
    if (!g) {
      g = []
      grouped.set(a.appId, g)
    }
    g.push(a)
  }
  for (const appId of appIds) {
    const rows = grouped.get(appId) ?? []
    const refreshed = rows.filter((r) => r.percentRefreshedAt !== null)
    const common = refreshed.filter(
      (r) => r.globalPercent !== null && r.globalPercent >= args.threshold,
    )
    const commonIds = common.map((c) => c.id)
    for (const id of commonIds) allCommonIds.add(id)
    perApp.set(appId, {
      anyAchievements: rows.length > 0,
      anyRefreshed: refreshed.length > 0,
      commonIds,
    })
  }

  // Step 3: latest event per (user, achievement) for all common achievement
  // ids across all involved users. Asc by id so the last assignment to the
  // map wins → latest event survives.
  const latestByUserAch = new Map<string, boolean>()
  if (allCommonIds.size > 0 && userIds.size > 0) {
    const events = await db
      .select({
        userId: achievementEvents.userId,
        achievementId: achievementEvents.achievementId,
        achieved: achievementEvents.achieved,
      })
      .from(achievementEvents)
      .where(
        and(
          inArray(achievementEvents.userId, [...userIds]),
          inArray(achievementEvents.achievementId, [...allCommonIds]),
        ),
      )
      .orderBy(asc(achievementEvents.id))
    for (const e of events) {
      latestByUserAch.set(`${String(e.userId)}:${String(e.achievementId)}`, e.achieved)
    }
  }

  // Step 4: per-win compute.
  for (const [winId, ctx] of ctxByWinId) {
    const app = perApp.get(ctx.appId)
    if (!app || !app.anyAchievements) {
      out.set(winId, { status: 'no_achievements' })
      continue
    }
    if (!app.anyRefreshed) {
      out.set(winId, { status: 'no_percent_data' })
      continue
    }
    let unlocked = 0
    for (const achId of app.commonIds) {
      if (latestByUserAch.get(`${String(ctx.userId)}:${String(achId)}`) === true) {
        unlocked += 1
      }
    }
    out.set(winId, {
      status: 'computed',
      unlocked,
      total: app.commonIds.length,
      threshold: args.threshold,
    })
  }
  return out
}
