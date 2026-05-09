import type { Db } from '#/db/client'
import type { SteamApiClient } from '#/external/steam-api'
import type { Logger } from '#/lib/logger'
import {
  findAppIdsNeedingPercentRefresh,
  refreshAppAchievementPercents,
} from '#/repos/achievements'

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Refresh community-completion percentages for app achievements that we
// already know about (rows discovered lazily by poll_playtime). Each tick
// pulls a bounded batch of apps whose percent_refreshed_at is null or
// older than DEFAULT_REFRESH_INTERVAL_DAYS, and updates them in place.
//
// Why daily cron + per-app staleness check (vs. scheduling per-app):
// new apps appear continuously as new wins land. A daily pass naturally
// picks them up without extra wiring. The 90-day staleness floor keeps
// the call volume tiny — for the steady state of ~few-hundred apps, the
// average per-day batch is single-digit.
const DEFAULT_REFRESH_INTERVAL_DAYS = 90

// Per-tick cap. The Steam rate limiter (1s + jitter) is the actual throttle;
// this just bounds how long any single tick can run. Sized at 1000 so the
// initial backfill drains in a small number of cron ticks (or one manual
// click) without anyone needing to babysit it. Once the steady state
// quarterly refresh kicks in, the daily delta is tiny and this cap is
// irrelevant.
const DEFAULT_MAX_APPS_PER_TICK = 1000

export type RefreshAppAchievementPercentsDeps = {
  readonly db: Db
  readonly dbWrite: Db
  readonly steam: SteamApiClient
  readonly logger: Logger
  readonly now?: () => Date
  readonly refreshIntervalDays?: number
  readonly maxAppsPerTick?: number
}

export type RefreshAppAchievementPercentsSummary = {
  readonly appsExamined: number
  readonly appsRefreshed: number
  readonly appsNoData: number // 403/empty from Steam — app has no achievements
  readonly appsErrored: number
  readonly rowsUpdated: number
  readonly apinamesNotInDb: number
}

export const refreshAppAchievementPercentsJob = async (
  deps: RefreshAppAchievementPercentsDeps,
): Promise<RefreshAppAchievementPercentsSummary> => {
  const log = deps.logger.child({ job: 'refresh_app_achievement_percents' })
  const now = (deps.now ?? (() => new Date()))()
  const intervalDays = deps.refreshIntervalDays ?? DEFAULT_REFRESH_INTERVAL_DAYS
  const maxPerTick = deps.maxAppsPerTick ?? DEFAULT_MAX_APPS_PER_TICK
  const cutoff = new Date(now.getTime() - intervalDays * MS_PER_DAY)

  const appIds = await findAppIdsNeedingPercentRefresh(deps.db, cutoff, maxPerTick)
  log.info('candidates_loaded', {
    total: appIds.length,
    cutoff: cutoff.toISOString(),
    intervalDays,
    maxPerTick,
  })

  let appsRefreshed = 0
  let appsNoData = 0
  let appsErrored = 0
  let rowsUpdated = 0
  let apinamesNotInDb = 0

  for (const appId of appIds) {
    const r = await deps.steam.getGlobalAchievementPercents(appId)
    if (!r.ok) {
      appsErrored += 1
      log.warn('steam_global_percents_failed', { appId, error: r.error.kind })
      continue
    }
    if (r.value.length === 0) {
      // Steam returned 403 or an empty list — bump the timestamp on every
      // row for this app so we don't keep retrying. Pass an empty percents
      // list; refreshAppAchievementPercents handles the "all rows are
      // stale" case by updating timestamps without touching globalPercent.
      const result = await refreshAppAchievementPercents(deps.dbWrite, {
        appId,
        percents: [],
        refreshedAt: now,
      })
      appsNoData += 1
      apinamesNotInDb += result.apinamesNotInDb
      continue
    }
    const result = await refreshAppAchievementPercents(deps.dbWrite, {
      appId,
      percents: r.value,
      refreshedAt: now,
    })
    appsRefreshed += 1
    rowsUpdated += result.rowsUpdated
    apinamesNotInDb += result.apinamesNotInDb
  }

  const summary: RefreshAppAchievementPercentsSummary = {
    appsExamined: appIds.length,
    appsRefreshed,
    appsNoData,
    appsErrored,
    rowsUpdated,
    apinamesNotInDb,
  }
  log.info('refresh_completed', summary)
  return summary
}
