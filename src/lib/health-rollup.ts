import { cookieHealth } from '#/components/admin/cookie-ui'
import type { GroupCookieStatus } from '#/repos/groupSecrets'
import type { JobRunRow } from '#/repos/jobRuns'
import type { WorkerHeartbeatRow } from '#/repos/workerHeartbeats'

// Heartbeat tick is every 15 min; 45 min = 3 missed ticks. Keep this and
// HEARTBEAT_INTERVAL_MS in worker/index.ts in 3:1 ratio so a single late
// tick doesn't flip the worker to "stale".
export const HEARTBEAT_STALE_MS = 45 * 60 * 1000

// A `running` job older than 2h is almost certainly orphaned (worker died).
export const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000

export type WorkerHealthStatus = 'healthy' | 'stale' | 'unknown'
export type CookieRollupStatus = 'working' | 'anonymous' | 'untested' | 'failing'
export type ScrapeJobStatus = 'healthy' | 'overdue' | 'failing' | 'never'
export type OverallStatus = 'healthy' | 'degraded' | 'failing' | 'unknown'

export type CookieCounts = {
  readonly working: number
  readonly anonymous: number
  readonly untested: number
  readonly failing: number
}

export type CookieRollup = {
  readonly status: CookieRollupStatus
  readonly counts: CookieCounts
}

export const workerHealth = (
  heartbeat: WorkerHeartbeatRow | null,
  now: Date,
): WorkerHealthStatus => {
  if (!heartbeat) return 'unknown'
  return now.getTime() - heartbeat.lastSeenAt.getTime() > HEARTBEAT_STALE_MS ? 'stale' : 'healthy'
}

export const cookiesRollup = (rows: ReadonlyArray<GroupCookieStatus>): CookieRollup => {
  let working = 0
  let anonymous = 0
  let untested = 0
  let failing = 0
  for (const row of rows) {
    const h = cookieHealth(row)
    if (h === 'working') working++
    else if (h === 'anonymous') anonymous++
    else if (h === 'untested') untested++
    else failing++
  }
  let status: CookieRollupStatus
  if (failing > 0) status = 'failing'
  else if (untested > 0) status = 'untested'
  else if (working > 0) status = 'working'
  else status = 'anonymous'
  return { status, counts: { working, anonymous, untested, failing } }
}

export const scrapeJobHealth = (
  expectedIntervalMs: number,
  latestRun: JobRunRow | null,
  lastSuccessRun: JobRunRow | null,
  now: Date,
): ScrapeJobStatus => {
  if (lastSuccessRun === null) {
    return latestRun?.status === 'failed' ? 'failing' : 'never'
  }
  if (latestRun?.status === 'failed' && latestRun.startedAt > lastSuccessRun.startedAt) {
    return 'failing'
  }
  const lastSuccessTime = (lastSuccessRun.finishedAt ?? lastSuccessRun.startedAt).getTime()
  return now.getTime() - lastSuccessTime > expectedIntervalMs ? 'overdue' : 'healthy'
}

const SCRAPE_SEVERITY: Readonly<Record<ScrapeJobStatus, number>> = {
  healthy: 0,
  never: 1,
  overdue: 2,
  failing: 3,
}

export const scrapesRollup = (statuses: ReadonlyArray<ScrapeJobStatus>): ScrapeJobStatus => {
  let worst: ScrapeJobStatus = 'healthy'
  for (const s of statuses) {
    if (SCRAPE_SEVERITY[s] > SCRAPE_SEVERITY[worst]) worst = s
  }
  return worst
}

export const overallHealth = (
  worker: WorkerHealthStatus,
  cookies: CookieRollupStatus,
  scrapes: ScrapeJobStatus,
): OverallStatus => {
  if (cookies === 'failing' || scrapes === 'failing') return 'failing'
  if (
    worker === 'stale' ||
    cookies === 'untested' ||
    scrapes === 'overdue' ||
    scrapes === 'never'
  ) {
    return 'degraded'
  }
  if (worker === 'unknown') return 'unknown'
  return 'healthy'
}
