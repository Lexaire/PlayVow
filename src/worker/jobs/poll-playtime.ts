import { and, inArray, isNotNull } from 'drizzle-orm'

import type { Db } from '#/db/client'
import type { SteamAppId, SteamId } from '#/db/schema'
import { giveaways } from '#/db/schema'
import type {
  AchievementDetail,
  AchievementsResult,
  OwnedGame,
  SteamApiClient,
} from '#/external/steam-api'
import type { SteamCommunityClient } from '#/external/steam-community'
import type { Logger } from '#/lib/logger'
import type { SteamAchievement } from '#/repos/achievements'
import {
  listSteamAchievementsByAppIds,
  recordAchievementStateIfChanged,
  upsertSteamAchievement,
} from '#/repos/achievements'
import { findGiveawayById } from '#/repos/giveaways'
import { findUserById } from '#/repos/users'
import type { Win } from '#/repos/wins'
import {
  findWinById,
  listPendingForPlaytimePoll,
  recordWinPlaytimeBaseline,
  recordWinPlaytimeProgress,
} from '#/repos/wins'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_POLL_WINDOW_DAYS_AFTER_DEADLINE = 30

export type PollPlaytimeDeps = {
  readonly db: Db
  readonly dbWrite: Db
  readonly steam: SteamApiClient
  readonly steamCommunity: SteamCommunityClient
  readonly logger: Logger
  readonly now?: () => Date
  readonly pollWindowDaysAfterDeadline?: number
}

export type PollPlaytimeSummary = {
  readonly winsExamined: number
  readonly baselinesWritten: number
  readonly progressWritten: number
  readonly observationsWritten: number
  readonly privateProfiles: number
  readonly missingGames: number
  readonly steamErrors: number
  readonly skippedNoContext: number
  readonly achievementEventsWritten: number
  readonly achievementsUpserted: number
}

type WinContext = {
  readonly steamId: SteamId
  readonly appId: SteamAppId
}

type ResolvedWin = { readonly win: Win; readonly ctx: WinContext }

// Per-win result of pollOneWin. All boolean fields count once per win; the
// numeric fields can be 0+. Aggregated into PollPlaytimeSummary at the end.
type WinPollResult = {
  readonly baseline: boolean
  readonly progress: boolean
  readonly observation: boolean
  readonly missingGame: boolean
  readonly achievementsCallFailed: boolean
  readonly screenshotsCallFailed: boolean
  readonly achievementEventsWritten: number
  readonly achievementsUpserted: number
}

type ResolveAchievement = (
  appId: SteamAppId,
  detail: AchievementDetail,
) => Promise<{ readonly row: SteamAchievement; readonly inserted: boolean }>

type AchievementCounts = {
  readonly unlocked: number | null
  readonly total: number | null
}

const NULL_ACHIEVEMENTS: AchievementCounts = { unlocked: null, total: null }

const countsFromAchievementsResult = (r: AchievementsResult): AchievementCounts => {
  if (r.kind === 'public') {
    if (r.achievements.length === 0) return { unlocked: null, total: 0 }
    return {
      unlocked: r.achievements.reduce((n, a) => n + (a.achieved ? 1 : 0), 0),
      total: r.achievements.length,
    }
  }
  if (r.kind === 'no_stats') return { unlocked: null, total: 0 }
  return NULL_ACHIEVEMENTS
}

// The four reasons a win has no pollable context. The bulk poll path
// collapses them all into `skippedNoContext`; the single-win admin button
// shows the specific reason so the operator knows whether it's a fixable
// data gap (missing app id from a stale scrape) or a permanent state
// (sub-only giveaway, unlinked Steam account).
export type LoadContextResult =
  | { readonly kind: 'ok'; readonly ctx: WinContext }
  | { readonly kind: 'user_missing' }
  | { readonly kind: 'giveaway_missing' }
  | { readonly kind: 'user_no_steam_id' }
  | { readonly kind: 'giveaway_no_app_id' }

const loadContext = async (deps: PollPlaytimeDeps, win: Win): Promise<LoadContextResult> => {
  const [user, giveaway] = await Promise.all([
    findUserById(deps.db, win.userId),
    findGiveawayById(deps.db, win.giveawayId),
  ])
  if (!user) return { kind: 'user_missing' }
  if (!giveaway) return { kind: 'giveaway_missing' }
  if (user.steamId === null) return { kind: 'user_no_steam_id' }
  if (giveaway.steamAppId === null) return { kind: 'giveaway_no_app_id' }
  return { kind: 'ok', ctx: { steamId: user.steamId, appId: giveaway.steamAppId } }
}

// Steam returns null/missing for a game when per-game privacy hides it. We
// preserve that distinction (null vs 0) all the way to the DB so we can tell
// "private" from "owned, never played".
const writePlaytime = async (
  deps: PollPlaytimeDeps,
  win: Win,
  game: OwnedGame | null,
  achievements: AchievementCounts,
  screenshotCount: number | null,
  checkedAt: Date,
): Promise<
  { kind: 'baseline'; observationWritten: boolean } | { kind: 'progress'; changed: boolean }
> => {
  const fields = {
    currentPlaytimeMinutes: game?.playtimeMinutes ?? null,
    playtime2WeeksMinutes: game?.playtime2WeeksMinutes ?? null,
    hasReview: null,
    screenshotCount,
    achievementsUnlocked: achievements.unlocked,
    achievementsTotal: achievements.total,
    checkedAt,
  }
  if (win.playtimeAtWinMinutes === null) {
    const r = await recordWinPlaytimeBaseline(deps.dbWrite, win.id, {
      playtimeAtWinMinutes: fields.currentPlaytimeMinutes,
      ...fields,
    })
    return { kind: 'baseline', observationWritten: r.observationWritten }
  }
  const r = await recordWinPlaytimeProgress(deps.dbWrite, win.id, fields)
  return { kind: 'progress', changed: r.changed }
}

// Process one win, given an already-fetched OwnedGame for it (or null when
// per-game privacy / not-owned). Caller is responsible for getOwnedGames;
// this only handles the per-win achievements call + DB writes.
const pollOneWin = async (
  deps: PollPlaytimeDeps,
  win: Win,
  ctx: WinContext,
  game: OwnedGame | null,
  resolveAchievement: ResolveAchievement,
  now: Date,
  log: Logger,
): Promise<WinPollResult> => {
  const achR = await deps.steam.getPlayerAchievements(ctx.steamId, ctx.appId)
  let achievements = NULL_ACHIEVEMENTS
  let achievementDetails: ReadonlyArray<AchievementDetail> = []
  if (achR.ok) {
    achievements = countsFromAchievementsResult(achR.value)
    if (achR.value.kind === 'public') achievementDetails = achR.value.achievements
  } else {
    log.warn('steam_achievements_failed', { winId: win.id, error: achR.error.kind })
  }

  // Screenshots come from the public profile page (no Web API for this). We
  // keep null as the "couldn't see" sentinel — distinct from 0 ("public, none
  // posted"). profile_private here is the per-game screenshot tab being
  // hidden, which is independent of overall profile visibility. The parser
  // returns the full list (fileId/thumbUrl/caption); we only persist the
  // count today, but the structured data is ready for a gallery view.
  const ssR = await deps.steamCommunity.getScreenshots(ctx.steamId, ctx.appId)
  let screenshotCount: number | null = null
  let screenshotsCallFailed = false
  if (ssR.ok) {
    screenshotCount = ssR.value.length
  } else if (ssR.error.kind !== 'profile_private') {
    screenshotsCallFailed = true
    log.warn('steam_screenshots_failed', { winId: win.id, error: ssR.error.kind })
  }

  const outcome = await writePlaytime(deps, win, game, achievements, screenshotCount, now)

  let achievementEventsWritten = 0
  let achievementsUpserted = 0
  for (const a of achievementDetails) {
    const { row: achievement, inserted } = await resolveAchievement(ctx.appId, a)
    if (inserted) achievementsUpserted += 1
    const r = await recordAchievementStateIfChanged(deps.dbWrite, {
      userId: win.userId,
      achievementId: achievement.id,
      winId: win.id,
      achieved: a.achieved,
      unlockedAt: a.unlockedAt,
      observedAt: now,
    })
    if (r.inserted) {
      achievementEventsWritten += 1
      log.debug('achievement_event_written', {
        winId: win.id,
        apiname: a.apiname,
        achieved: a.achieved,
        unlockedAt: a.unlockedAt?.toISOString() ?? null,
      })
    }
  }

  return {
    baseline: outcome.kind === 'baseline',
    progress: outcome.kind === 'progress',
    observation:
      (outcome.kind === 'baseline' && outcome.observationWritten) ||
      (outcome.kind === 'progress' && outcome.changed),
    missingGame: game === null,
    achievementsCallFailed: !achR.ok,
    screenshotsCallFailed,
    achievementEventsWritten,
    achievementsUpserted,
  }
}

type UserPollResult =
  | { readonly kind: 'success'; readonly outcomes: ReadonlyArray<WinPollResult> }
  | { readonly kind: 'private' }
  | { readonly kind: 'error' }

// Batched per-user poll. One getOwnedGames call covers every pending win for
// the user (Steam supports an appids_filter array); per-win achievement and
// DB writes still happen sequentially since the rate limiter serializes them
// anyway and the achievement state lookup is read-then-write.
const pollUser = async (
  deps: PollPlaytimeDeps,
  steamId: SteamId,
  userWins: ReadonlyArray<ResolvedWin>,
  resolveAchievement: ResolveAchievement,
  now: Date,
  log: Logger,
): Promise<UserPollResult> => {
  const userAppIds = userWins.map((w) => w.ctx.appId)
  const ownedR = await deps.steam.getOwnedGames(steamId, userAppIds)
  if (!ownedR.ok) {
    log.warn('steam_owned_games_failed', {
      steamId,
      winCount: userWins.length,
      error: ownedR.error.kind,
    })
    return { kind: 'error' }
  }
  if (ownedR.value.visibility === 'private') {
    log.info('profile_private', { steamId, winCount: userWins.length })
    return { kind: 'private' }
  }
  const gamesByApp = new Map(ownedR.value.games.map((g) => [g.appId, g] as const))

  const outcomes: WinPollResult[] = []
  for (const { win, ctx } of userWins) {
    const game = gamesByApp.get(ctx.appId) ?? null
    outcomes.push(await pollOneWin(deps, win, ctx, game, resolveAchievement, now, log))
  }
  return { kind: 'success', outcomes }
}

// Group resolved wins by steamId. Order within each group preserves the input
// order, which preserves the upstream `lastCheckedAt asc` ordering — wins
// neglected the longest get polled first.
const groupBySteamId = (
  resolved: ReadonlyArray<ResolvedWin>,
): ReadonlyMap<SteamId, ReadonlyArray<ResolvedWin>> => {
  const m = new Map<SteamId, ResolvedWin[]>()
  for (const r of resolved) {
    const list = m.get(r.ctx.steamId) ?? []
    list.push(r)
    m.set(r.ctx.steamId, list)
  }
  return m
}

const buildAchievementCache = async (
  deps: PollPlaytimeDeps,
  appIds: ReadonlyArray<SteamAppId>,
): Promise<Map<SteamAppId, Map<string, SteamAchievement>>> => {
  const cache = new Map<SteamAppId, Map<string, SteamAchievement>>()
  if (appIds.length === 0) return cache
  const known = await listSteamAchievementsByAppIds(deps.db, appIds)
  for (const a of known) {
    let perApp = cache.get(a.appId)
    if (!perApp) {
      perApp = new Map()
      cache.set(a.appId, perApp)
    }
    perApp.set(a.apiname, a)
  }
  return cache
}

const makeResolveAchievement =
  (
    deps: PollPlaytimeDeps,
    cache: Map<SteamAppId, Map<string, SteamAchievement>>,
    now: Date,
  ): ResolveAchievement =>
  async (appId, detail) => {
    const cached = cache.get(appId)?.get(detail.apiname)
    if (cached) return { row: cached, inserted: false }
    const row = await upsertSteamAchievement(deps.dbWrite, {
      appId,
      apiname: detail.apiname,
      displayName: detail.displayName,
      description: detail.description,
      lastSyncedAt: now,
    })
    let perApp = cache.get(appId)
    if (!perApp) {
      perApp = new Map()
      cache.set(appId, perApp)
    }
    perApp.set(detail.apiname, row)
    return { row, inserted: true }
  }

type Aggregate = {
  baselinesWritten: number
  progressWritten: number
  observationsWritten: number
  missingGames: number
  achievementsCallFailures: number
  screenshotsCallFailures: number
  achievementEventsWritten: number
  achievementsUpserted: number
}

const sumOutcomes = (outcomes: ReadonlyArray<WinPollResult>): Aggregate => {
  const a: Aggregate = {
    baselinesWritten: 0,
    progressWritten: 0,
    observationsWritten: 0,
    missingGames: 0,
    achievementsCallFailures: 0,
    screenshotsCallFailures: 0,
    achievementEventsWritten: 0,
    achievementsUpserted: 0,
  }
  for (const o of outcomes) {
    if (o.baseline) a.baselinesWritten += 1
    if (o.progress) a.progressWritten += 1
    if (o.observation) a.observationsWritten += 1
    if (o.missingGame) a.missingGames += 1
    if (o.achievementsCallFailed) a.achievementsCallFailures += 1
    if (o.screenshotsCallFailed) a.screenshotsCallFailures += 1
    a.achievementEventsWritten += o.achievementEventsWritten
    a.achievementsUpserted += o.achievementsUpserted
  }
  return a
}

export type PollSingleWinResult =
  | { readonly kind: 'win_not_found' }
  | { readonly kind: 'user_missing' }
  | { readonly kind: 'giveaway_missing' }
  | { readonly kind: 'user_no_steam_id' }
  | { readonly kind: 'giveaway_no_app_id' }
  | { readonly kind: 'profile_private' }
  | { readonly kind: 'owned_games_failed' }
  | { readonly kind: 'success'; readonly outcome: WinPollResult }

// Manual entry point for /admin/jobs "Poll one pending win". Reuses the same
// per-win pipeline as the bulk poll but skips the candidate-list scan and the
// achievement-cache prefetch (one win = at most one app, so caching buys
// nothing). The achievement upserts still go through resolveAchievement so
// repeat manual polls of the same win remain idempotent.
export const pollSingleWin = async (
  deps: PollPlaytimeDeps,
  winId: number,
): Promise<PollSingleWinResult> => {
  const log = deps.logger.child({ job: 'poll_playtime', winId })
  const now = (deps.now ?? (() => new Date()))()

  const win = await findWinById(deps.db, winId)
  if (!win) return { kind: 'win_not_found' }
  const ctxR = await loadContext(deps, win)
  if (ctxR.kind !== 'ok') return { kind: ctxR.kind }
  const { ctx } = ctxR

  const ownedR = await deps.steam.getOwnedGames(ctx.steamId, [ctx.appId])
  if (!ownedR.ok) {
    log.warn('steam_owned_games_failed', { error: ownedR.error.kind })
    return { kind: 'owned_games_failed' }
  }
  if (ownedR.value.visibility === 'private') return { kind: 'profile_private' }

  const game = ownedR.value.games.find((g) => g.appId === ctx.appId) ?? null
  const achievementCache = new Map<SteamAppId, Map<string, SteamAchievement>>()
  const resolveAchievement = makeResolveAchievement(deps, achievementCache, now)
  const outcome = await pollOneWin(deps, win, ctx, game, resolveAchievement, now, log)
  return { kind: 'success', outcome }
}

export const pollPlaytime = async (deps: PollPlaytimeDeps): Promise<PollPlaytimeSummary> => {
  const log = deps.logger.child({ job: 'poll_playtime' })
  const now = (deps.now ?? (() => new Date()))()
  const pollWindowDays = deps.pollWindowDaysAfterDeadline ?? DEFAULT_POLL_WINDOW_DAYS_AFTER_DEADLINE
  const cutoff = new Date(now.getTime() - pollWindowDays * MS_PER_DAY)

  const candidates = await listPendingForPlaytimePoll(deps.db, cutoff)
  log.info('candidates_loaded', {
    total: candidates.length,
    cutoff: cutoff.toISOString(),
    pollWindowDays,
  })

  // Resolve (steamId, appId) for every candidate. Wins missing context (deleted
  // user, no steamId, etc.) are reported but skipped from polling.
  const ctxs = await Promise.all(candidates.map((w) => loadContext(deps, w)))
  const resolved: ResolvedWin[] = []
  let skippedNoContext = 0
  for (let i = 0; i < candidates.length; i += 1) {
    const win = candidates[i]
    const ctxR = ctxs[i]
    if (!win || !ctxR) continue
    if (ctxR.kind !== 'ok') {
      skippedNoContext += 1
      log.warn('win_context_missing', { winId: win.id, reason: ctxR.kind })
      continue
    }
    resolved.push({ win, ctx: ctxR.ctx })
  }

  // Pre-load known achievement metadata across all the apps we're about to
  // poll. The cache then short-circuits the per-achievement upsert (Steam
  // achievement metadata is essentially static; >99% cache-hit in practice).
  const allAppIdsRows =
    candidates.length === 0
      ? []
      : await deps.db
          .selectDistinct({ appId: giveaways.steamAppId })
          .from(giveaways)
          .where(
            and(
              inArray(giveaways.id, [...new Set(candidates.map((c) => c.giveawayId))]),
              isNotNull(giveaways.steamAppId),
            ),
          )
  const allAppIds: SteamAppId[] = allAppIdsRows.flatMap((r) => (r.appId === null ? [] : [r.appId]))
  const achievementCache = await buildAchievementCache(deps, allAppIds)
  log.info('achievement_cache_loaded', {
    appIds: allAppIds.length,
    knownAchievements: [...achievementCache.values()].reduce((n, m) => n + m.size, 0),
  })

  const resolveAchievement = makeResolveAchievement(deps, achievementCache, now)
  const winsByUser = groupBySteamId(resolved)
  log.info('users_grouped', { users: winsByUser.size, wins: resolved.length })

  const allOutcomes: WinPollResult[] = []
  let privateProfiles = 0
  let ownedGamesFailures = 0
  for (const [steamId, userWins] of winsByUser) {
    const result = await pollUser(deps, steamId, userWins, resolveAchievement, now, log)
    if (result.kind === 'success') {
      allOutcomes.push(...result.outcomes)
    } else if (result.kind === 'private') {
      privateProfiles += userWins.length
    } else {
      ownedGamesFailures += userWins.length
    }
  }

  const a = sumOutcomes(allOutcomes)
  const summary: PollPlaytimeSummary = {
    winsExamined: candidates.length,
    baselinesWritten: a.baselinesWritten,
    progressWritten: a.progressWritten,
    observationsWritten: a.observationsWritten,
    privateProfiles,
    missingGames: a.missingGames,
    // Per-win count of any Steam call failure: getOwnedGames failures count
    // every win in the affected user batch; achievement and screenshot
    // failures count the single win they happened on.
    steamErrors: ownedGamesFailures + a.achievementsCallFailures + a.screenshotsCallFailures,
    skippedNoContext,
    achievementEventsWritten: a.achievementEventsWritten,
    achievementsUpserted: a.achievementsUpserted,
  }
  log.info('poll_completed', summary)
  return summary
}
