import type { Db } from '#/db/client'
import type { SteamAppId, SteamId } from '#/db/schema'
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
import type { Win, WinForPoll } from '#/repos/wins'
import {
  findWinById,
  listForPlaytimePoll,
  markWinsChecked,
  recordWinPlaytimeBaseline,
  recordWinPlaytimePiggyback,
  recordWinPlaytimeProgress,
} from '#/repos/wins'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_POLL_WINDOW_DAYS_AFTER_DEADLINE = 30

// Cadence parameters for the resolved-win refresh path. Mirrors the SQL
// predicate in src/repos/wins.ts so the in-process "is this win due?"
// check gives the same answer the trigger-user query would. See that file
// for the rationale on the cadence values and the per-id spread offset.
const FRESH_THRESHOLD_MS = 365 * MS_PER_DAY
const FRESH_CADENCE_MS = 14 * MS_PER_DAY
const OLD_CADENCE_MS = 30 * MS_PER_DAY
const SPREAD_MULT = 2654435761n

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
  readonly fullPolls: number
  readonly piggybackPolls: number
  readonly baselinesWritten: number
  readonly progressWritten: number
  readonly piggybackChanges: number
  readonly observationsWritten: number
  // Count of distinct users whose getOwnedGames came back private this
  // tick. Equals the number of Steam calls we "spent" on private users —
  // not the number of wins they own (those ride along on one call).
  readonly privateUsers: number
  readonly missingGames: number
  // Subset of fullPolls where we skipped the achievement + screenshot
  // Steam calls because there was no playtime delta and we already had
  // prior data. Each skipped win saves 2 Steam calls.
  readonly extraCallsSkipped: number
  readonly steamErrors: number
  readonly skippedNoContext: number
  readonly achievementEventsWritten: number
  readonly achievementsUpserted: number
}

type WinContext = {
  readonly steamId: SteamId
  readonly appId: SteamAppId
}

type PollMode = 'full' | 'piggyback'
type PollTask = { readonly win: WinForPoll; readonly mode: PollMode }

// Per-win result. Numeric fields are 0+; booleans count once. piggyback
// tasks only ever set `piggybackChanged` (and possibly `missingGame` /
// `observation`). Full polls populate the rest.
type WinPollResult = {
  readonly mode: PollMode
  readonly baseline: boolean
  readonly progress: boolean
  readonly piggybackChanged: boolean
  readonly observation: boolean
  readonly missingGame: boolean
  // True when we were eligible for a full poll but skipped the
  // achievement + screenshot Steam calls because there was no playtime
  // delta and we already had prior data for both. The win still went
  // through the lastCheckedAt-bumping write path; we just saved 2 calls.
  readonly extraCallsSkipped: boolean
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

// True when a resolved win has crossed its individually-spread next-due
// time. Mirrors the SQL `resolvedDueExpr` in #/repos/wins so the in-process
// branch matches the trigger-user query. BigInt for the spread arithmetic
// matches SQLite's 64-bit integer math exactly even for large win ids.
const isResolvedDue = (win: Win, now: Date): boolean => {
  if (win.lastCheckedAt === null) return true
  const sinceMs = now.getTime() - win.lastCheckedAt.getTime()
  const isFresh =
    win.resolvedAt === null || now.getTime() - win.resolvedAt.getTime() <= FRESH_THRESHOLD_MS
  const cadenceMs = isFresh ? FRESH_CADENCE_MS : OLD_CADENCE_MS
  const cadenceS = BigInt(cadenceMs / 1000)
  const offsetS = (BigInt(win.id) * SPREAD_MULT) % cadenceS
  return sinceMs >= cadenceMs + Number(offsetS) * 1000
}

const classifyTask = (win: WinForPoll, now: Date): PollTask => {
  const mode: PollMode = win.status === 'pending' || isResolvedDue(win, now) ? 'full' : 'piggyback'
  return { win, mode }
}

// The four reasons a win has no pollable context. Only used by the
// single-win admin path (pollSingleWin); the bulk path filters
// missing-context wins out at the SQL boundary so it doesn't even see them.
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

// Decides whether the achievement + screenshot Steam calls are worth
// making this tick. The optimization: if a user hasn't played (no
// currentPlaytime delta), they almost certainly haven't earned new
// achievements or uploaded new screenshots either. Skip the two calls.
//
// Always-fetch cases (in priority order):
//   1) Baseline — first ever successful poll, capture full state.
//   2) Achievements never captured — null only when we've never gotten a
//      successful response. 0 means "tried, game has none"; N means
//      "tried, got the list." Either of those counts as captured.
//   3) Screenshots never captured — same null sentinel meaning.
//
// Skip cases:
//   - Per-game privacy hides the game (game === null) and we already have
//     prior data for both. There's no signal to act on; spec is to skip.
//   - currentPlaytime matches the prior wins-row value — no activity.
const needsFullDataFetch = (win: Win, game: OwnedGame | null): boolean => {
  if (win.playtimeAtWinMinutes === null) return true
  if (win.achievementsTotal === null) return true
  if (win.screenshotCount === null) return true
  if (game === null) return false
  return win.currentPlaytimeMinutes !== game.playtimeMinutes
}

type ExtraData = {
  readonly achievements: AchievementCounts
  readonly achievementDetails: ReadonlyArray<AchievementDetail>
  readonly screenshotCount: number | null
  readonly achievementsCallFailed: boolean
  readonly screenshotsCallFailed: boolean
}

// Fetches achievements + screenshots for one win. Failures (network /
// parse / private-profile) come back as call-failed flags + null counts;
// the caller still proceeds with the poll using whatever else it has.
//
// Screenshots come from the public profile page (no Web API for this). We
// keep null as the "couldn't see" sentinel — distinct from 0 ("public,
// none posted"). profile_private here is the per-game screenshot tab
// being hidden, independent of overall profile visibility. The parser
// returns the full list (fileId/thumbUrl/caption); we only persist the
// count today, but the structured data is ready for a gallery view.
const fetchExtraData = async (
  deps: PollPlaytimeDeps,
  ctx: WinContext,
  winId: number,
  log: Logger,
): Promise<ExtraData> => {
  const achR = await deps.steam.getPlayerAchievements(ctx.steamId, ctx.appId)
  let achievements = NULL_ACHIEVEMENTS
  let achievementDetails: ReadonlyArray<AchievementDetail> = []
  if (achR.ok) {
    achievements = countsFromAchievementsResult(achR.value)
    if (achR.value.kind === 'public') achievementDetails = achR.value.achievements
  } else {
    log.warn('steam_achievements_failed', { winId, error: achR.error.kind })
  }

  const ssR = await deps.steamCommunity.getScreenshots(ctx.steamId, ctx.appId)
  let screenshotCount: number | null = null
  let screenshotsCallFailed = false
  if (ssR.ok) {
    screenshotCount = ssR.value.length
  } else if (ssR.error.kind !== 'profile_private') {
    screenshotsCallFailed = true
    log.warn('steam_screenshots_failed', { winId, error: ssR.error.kind })
  }

  return {
    achievements,
    achievementDetails,
    screenshotCount,
    achievementsCallFailed: !achR.ok,
    screenshotsCallFailed,
  }
}

// Steam returns null/missing for a game when per-game privacy hides it.
// We preserve that distinction (null vs 0) all the way to the DB so we
// can tell "private" from "owned, never played".
const writeFullPoll = async (
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

// Persists one achievement_event per achievement-state change. Pure I/O;
// the achievement metadata cache is threaded in via resolveAchievement.
const persistAchievementEvents = async (
  deps: PollPlaytimeDeps,
  win: Win,
  ctx: WinContext,
  details: ReadonlyArray<AchievementDetail>,
  resolveAchievement: ResolveAchievement,
  now: Date,
  log: Logger,
): Promise<{ readonly eventsWritten: number; readonly upserted: number }> => {
  let eventsWritten = 0
  let upserted = 0
  for (const a of details) {
    const { row: achievement, inserted } = await resolveAchievement(ctx.appId, a)
    if (inserted) upserted += 1
    const r = await recordAchievementStateIfChanged(deps.dbWrite, {
      userId: win.userId,
      achievementId: achievement.id,
      winId: win.id,
      achieved: a.achieved,
      unlockedAt: a.unlockedAt,
      observedAt: now,
    })
    if (r.inserted) {
      eventsWritten += 1
      log.debug('achievement_event_written', {
        winId: win.id,
        apiname: a.apiname,
        achieved: a.achieved,
        unlockedAt: a.unlockedAt?.toISOString() ?? null,
      })
    }
  }
  return { eventsWritten, upserted }
}

const EMPTY_RESULT: Omit<WinPollResult, 'mode'> = {
  baseline: false,
  progress: false,
  piggybackChanged: false,
  observation: false,
  missingGame: false,
  extraCallsSkipped: false,
  achievementsCallFailed: false,
  screenshotsCallFailed: false,
  achievementEventsWritten: 0,
  achievementsUpserted: 0,
}

// Full poll: getOwnedGames already gave us playtime; this adds the
// achievement + screenshot Steam calls (when justified) and writes the
// full observable-fields snapshot. Always bumps lastCheckedAt.
//
// When `needsFullDataFetch` returns false we skip the two extra calls and
// reuse the win row's existing achievement / screenshot values for the
// write — same lastCheckedAt bump, no Steam cost. Worth ~half the per-tick
// Steam budget once the typical "user didn't play this hour" case is hit.
const pollOneWinFull = async (
  deps: PollPlaytimeDeps,
  win: Win,
  ctx: WinContext,
  game: OwnedGame | null,
  resolveAchievement: ResolveAchievement,
  now: Date,
  log: Logger,
): Promise<WinPollResult> => {
  const fetchExtras = needsFullDataFetch(win, game)
  const extras = fetchExtras ? await fetchExtraData(deps, ctx, win.id, log) : null

  const achievements: AchievementCounts = extras
    ? extras.achievements
    : { unlocked: win.achievementsUnlocked, total: win.achievementsTotal }
  const screenshotCount = extras ? extras.screenshotCount : win.screenshotCount

  const outcome = await writeFullPoll(deps, win, game, achievements, screenshotCount, now)

  const events = extras
    ? await persistAchievementEvents(
        deps,
        win,
        ctx,
        extras.achievementDetails,
        resolveAchievement,
        now,
        log,
      )
    : { eventsWritten: 0, upserted: 0 }

  return {
    mode: 'full',
    baseline: outcome.kind === 'baseline',
    progress: outcome.kind === 'progress',
    piggybackChanged: false,
    observation:
      (outcome.kind === 'baseline' && outcome.observationWritten) ||
      (outcome.kind === 'progress' && outcome.changed),
    missingGame: game === null,
    extraCallsSkipped: !fetchExtras,
    achievementsCallFailed: extras?.achievementsCallFailed ?? false,
    screenshotsCallFailed: extras?.screenshotsCallFailed ?? false,
    achievementEventsWritten: events.eventsWritten,
    achievementsUpserted: events.upserted,
  }
}

// Piggyback: the user's getOwnedGames call already covered this win's app,
// and this win isn't yet due for a full refresh. Just persist the playtime
// (one tx, conditional observation insert on change) without bumping
// lastCheckedAt or making any extra Steam calls.
const pollOneWinPiggyback = async (
  deps: PollPlaytimeDeps,
  win: Win,
  game: OwnedGame | null,
  now: Date,
): Promise<WinPollResult> => {
  // Piggyback on a missing game (per-game privacy / not owned) is a no-op:
  // there's nothing to write and nothing changed. Don't even open the tx.
  if (game === null) {
    return { ...EMPTY_RESULT, mode: 'piggyback', missingGame: true }
  }
  const r = await recordWinPlaytimePiggyback(deps.dbWrite, win.id, {
    currentPlaytimeMinutes: game.playtimeMinutes,
    playtime2WeeksMinutes: game.playtime2WeeksMinutes,
    observedAt: now,
  })
  return {
    ...EMPTY_RESULT,
    mode: 'piggyback',
    piggybackChanged: r.changed,
    observation: r.changed,
  }
}

const pollOneWin = async (
  deps: PollPlaytimeDeps,
  task: PollTask,
  ctx: WinContext,
  game: OwnedGame | null,
  resolveAchievement: ResolveAchievement,
  now: Date,
  log: Logger,
): Promise<WinPollResult> => {
  if (task.mode === 'full') {
    return pollOneWinFull(deps, task.win, ctx, game, resolveAchievement, now, log)
  }
  return pollOneWinPiggyback(deps, task.win, game, now)
}

type UserPollResult =
  | { readonly kind: 'success'; readonly outcomes: ReadonlyArray<WinPollResult> }
  | { readonly kind: 'private' }
  | { readonly kind: 'error' }

// Batched per-user poll. One getOwnedGames call covers every task for the
// user — both full-poll wins and piggyback wins ride along on the same
// appids_filter array, since the array size is irrelevant to API cost. Per-
// win achievement / screenshot calls and DB writes still happen
// sequentially since the rate limiter serializes them anyway and the
// achievement state lookup is read-then-write.
const pollUser = async (
  deps: PollPlaytimeDeps,
  steamId: SteamId,
  tasks: ReadonlyArray<PollTask>,
  resolveAchievement: ResolveAchievement,
  now: Date,
  log: Logger,
): Promise<UserPollResult> => {
  const userAppIds = tasks.map((t) => t.win.appId)
  const ownedR = await deps.steam.getOwnedGames(steamId, userAppIds)
  if (!ownedR.ok) {
    log.warn('steam_owned_games_failed', {
      steamId,
      winCount: tasks.length,
      error: ownedR.error.kind,
    })
    return { kind: 'error' }
  }
  if (ownedR.value.visibility === 'private') {
    log.info('profile_private', { steamId, winCount: tasks.length })
    return { kind: 'private' }
  }
  const gamesByApp = new Map(ownedR.value.games.map((g) => [g.appId, g] as const))

  const outcomes: WinPollResult[] = []
  for (const task of tasks) {
    const game = gamesByApp.get(task.win.appId) ?? null
    const ctx: WinContext = { steamId, appId: task.win.appId }
    outcomes.push(await pollOneWin(deps, task, ctx, game, resolveAchievement, now, log))
  }
  return { kind: 'success', outcomes }
}

// Group tasks by steamId. Order within each group preserves the input
// order (which preserves the upstream `lastCheckedAt asc` ordering — the
// most-neglected wins lead each user's batch).
const groupBySteamId = (
  tasks: ReadonlyArray<PollTask>,
): ReadonlyMap<SteamId, ReadonlyArray<PollTask>> => {
  const m = new Map<SteamId, PollTask[]>()
  for (const t of tasks) {
    const list = m.get(t.win.steamId) ?? []
    list.push(t)
    m.set(t.win.steamId, list)
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
  fullPolls: number
  piggybackPolls: number
  baselinesWritten: number
  progressWritten: number
  piggybackChanges: number
  observationsWritten: number
  missingGames: number
  extraCallsSkipped: number
  achievementsCallFailures: number
  screenshotsCallFailures: number
  achievementEventsWritten: number
  achievementsUpserted: number
}

const sumOutcomes = (outcomes: ReadonlyArray<WinPollResult>): Aggregate => {
  const a: Aggregate = {
    fullPolls: 0,
    piggybackPolls: 0,
    baselinesWritten: 0,
    progressWritten: 0,
    piggybackChanges: 0,
    observationsWritten: 0,
    missingGames: 0,
    extraCallsSkipped: 0,
    achievementsCallFailures: 0,
    screenshotsCallFailures: 0,
    achievementEventsWritten: 0,
    achievementsUpserted: 0,
  }
  for (const o of outcomes) {
    if (o.mode === 'full') a.fullPolls += 1
    else a.piggybackPolls += 1
    if (o.baseline) a.baselinesWritten += 1
    if (o.progress) a.progressWritten += 1
    if (o.piggybackChanged) a.piggybackChanges += 1
    if (o.observation) a.observationsWritten += 1
    if (o.missingGame) a.missingGames += 1
    if (o.extraCallsSkipped) a.extraCallsSkipped += 1
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

// Manual entry point for /admin/jobs "Poll one pending win". Always runs
// the full pipeline regardless of the win's status / cadence — operators
// invoking this want a forced refresh, not a cadence-gated one.
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
  const outcome = await pollOneWinFull(deps, win, ctx, game, resolveAchievement, now, log)
  return { kind: 'success', outcome }
}

export const pollPlaytime = async (deps: PollPlaytimeDeps): Promise<PollPlaytimeSummary> => {
  const log = deps.logger.child({ job: 'poll_playtime' })
  const now = (deps.now ?? (() => new Date()))()
  const pollWindowDays = deps.pollWindowDaysAfterDeadline ?? DEFAULT_POLL_WINDOW_DAYS_AFTER_DEADLINE
  const cutoff = new Date(now.getTime() - pollWindowDays * MS_PER_DAY)

  const { wins: candidates, skippedNoContext } = await listForPlaytimePoll(deps.db, cutoff, now)
  log.info('candidates_loaded', {
    total: candidates.length,
    skippedNoContext,
    cutoff: cutoff.toISOString(),
    pollWindowDays,
  })

  const tasks = candidates.map((w) => classifyTask(w, now))

  // Pre-load known achievement metadata only for apps with a full-poll task
  // queued. Piggyback tasks don't fetch achievements, so caching their apps
  // would be wasted reads. The cache short-circuits the per-achievement
  // upsert (Steam achievement metadata is essentially static; >99%
  // cache-hit in practice).
  const fullAppIds = [
    ...new Set(tasks.filter((t) => t.mode === 'full').map((t) => t.win.appId)),
  ]
  const achievementCache = await buildAchievementCache(deps, fullAppIds)
  log.info('achievement_cache_loaded', {
    appIds: fullAppIds.length,
    knownAchievements: [...achievementCache.values()].reduce((n, m) => n + m.size, 0),
  })

  const resolveAchievement = makeResolveAchievement(deps, achievementCache, now)
  const tasksByUser = groupBySteamId(tasks)
  log.info('users_grouped', {
    users: tasksByUser.size,
    wins: tasks.length,
    fullPolls: tasks.filter((t) => t.mode === 'full').length,
    piggybackPolls: tasks.filter((t) => t.mode === 'piggyback').length,
  })

  const allOutcomes: WinPollResult[] = []
  let privateUsers = 0
  let ownedGamesFailures = 0
  for (const [steamId, userTasks] of tasksByUser) {
    const result = await pollUser(deps, steamId, userTasks, resolveAchievement, now, log)
    if (result.kind === 'success') {
      allOutcomes.push(...result.outcomes)
    } else if (result.kind === 'private') {
      // One Steam call (getOwnedGames) was spent regardless of how many
      // wins the user has — count users, not wins. Bump lastCheckedAt on
      // every win in the batch so private-profile wins don't dominate the
      // oldest-neglected ordering and resolved wins fall onto their
      // normal cadence (next due in 14d/30d, same as a successful poll).
      // owned_games_failed is treated as transient and intentionally NOT
      // bumped — those wins should retry on the next tick.
      privateUsers += 1
      await markWinsChecked(
        deps.dbWrite,
        userTasks.map((t) => t.win.id),
        now,
      )
    } else {
      ownedGamesFailures += userTasks.length
    }
  }

  const a = sumOutcomes(allOutcomes)
  const summary: PollPlaytimeSummary = {
    winsExamined: candidates.length,
    fullPolls: a.fullPolls,
    piggybackPolls: a.piggybackPolls,
    baselinesWritten: a.baselinesWritten,
    progressWritten: a.progressWritten,
    piggybackChanges: a.piggybackChanges,
    observationsWritten: a.observationsWritten,
    privateUsers,
    missingGames: a.missingGames,
    extraCallsSkipped: a.extraCallsSkipped,
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
