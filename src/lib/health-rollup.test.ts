import { describe, expect, it } from 'vitest'

import type { GroupCookieStatus } from '#/repos/groupSecrets'
import type { JobRunRow } from '#/repos/jobRuns'
import type { WorkerHeartbeatRow } from '#/repos/workerHeartbeats'
import {
  HEARTBEAT_STALE_MS,
  cookiesRollup,
  overallHealth,
  scrapeJobHealth,
  scrapesRollup,
  workerHealth,
} from './health-rollup'

const NOW = new Date('2026-01-01T12:00:00Z')

const heartbeat = (minsAgo: number): WorkerHeartbeatRow => ({
  startedAt: new Date(NOW.getTime() - minsAgo * 60_000 - 60 * 60_000),
  lastSeenAt: new Date(NOW.getTime() - minsAgo * 60_000),
  pid: 1234,
})

const cookieRow = (
  isSet: boolean,
  lastTestResult: GroupCookieStatus['lastTestResult'],
): GroupCookieStatus => ({
  groupId: 1,
  groupSlug: 'test',
  groupName: 'Test',
  isSet,
  updatedAt: null,
  updatedBy: null,
  lastTestedAt: lastTestResult ? NOW : null,
  lastTestResult,
  lastSuccessAt: lastTestResult === 'ok' ? NOW : null,
})

const jobRun = (
  status: JobRunRow['status'],
  startedAt: Date,
  finishedAt: Date | null = null,
): JobRunRow => ({
  id: 1,
  jobName: 'test_job',
  status,
  triggeredBy: 'cron',
  triggeredByUserId: null,
  startedAt,
  finishedAt,
  durationMs: finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
  steamCalls: 0,
  sgCalls: 0,
  errorMessage: null,
  summary: null,
  createdAt: startedAt,
})

const HOUR = 60 * 60_000
const INTERVAL = 36 * HOUR

describe('workerHealth', () => {
  it('returns unknown when no heartbeat', () => {
    expect(workerHealth(null, NOW)).toBe('unknown')
  })

  it('returns healthy when just within threshold', () => {
    const staleThresholdMins = HEARTBEAT_STALE_MS / 60_000
    expect(workerHealth(heartbeat(staleThresholdMins - 1), NOW)).toBe('healthy')
  })

  it('returns stale when past threshold', () => {
    const staleThresholdMins = HEARTBEAT_STALE_MS / 60_000
    expect(workerHealth(heartbeat(staleThresholdMins + 1), NOW)).toBe('stale')
  })
})

describe('cookiesRollup', () => {
  it('returns anonymous when no rows', () => {
    expect(cookiesRollup([])).toMatchObject({ status: 'anonymous' })
  })

  it('returns anonymous when all groups have no cookie', () => {
    const result = cookiesRollup([cookieRow(false, null), cookieRow(false, null)])
    expect(result).toMatchObject({ status: 'anonymous', counts: { anonymous: 2, working: 0 } })
  })

  it('returns working when all set cookies are ok', () => {
    const result = cookiesRollup([cookieRow(true, 'ok'), cookieRow(false, null)])
    expect(result).toMatchObject({ status: 'working', counts: { working: 1, anonymous: 1 } })
  })

  it('returns untested when a cookie is set but never tested', () => {
    const result = cookiesRollup([cookieRow(true, null)])
    expect(result).toMatchObject({ status: 'untested', counts: { untested: 1 } })
  })

  it('failing dominates untested', () => {
    const result = cookiesRollup([cookieRow(true, 'login_required'), cookieRow(true, null)])
    expect(result.status).toBe('failing')
  })

  it('failing dominates working', () => {
    const result = cookiesRollup([cookieRow(true, 'ok'), cookieRow(true, 'http_error')])
    expect(result.status).toBe('failing')
  })
})

describe('scrapeJobHealth', () => {
  const succeeded = (minsAgo: number) => {
    const finished = new Date(NOW.getTime() - minsAgo * 60_000)
    const started = new Date(finished.getTime() - 5 * 60_000)
    return jobRun('succeeded', started, finished)
  }

  it('returns never when no runs at all', () => {
    expect(scrapeJobHealth(INTERVAL, null, null, NOW)).toBe('never')
  })

  it('returns failing when latest is failed and no success ever', () => {
    const run = jobRun('failed', new Date(NOW.getTime() - HOUR))
    expect(scrapeJobHealth(INTERVAL, run, null, NOW)).toBe('failing')
  })

  it('returns healthy when last success is within interval', () => {
    const run = succeeded(INTERVAL / 60_000 / 2)
    expect(scrapeJobHealth(INTERVAL, run, run, NOW)).toBe('healthy')
  })

  it('returns overdue when last success exceeds interval', () => {
    const run = succeeded((INTERVAL / 60_000) * 2)
    expect(scrapeJobHealth(INTERVAL, run, run, NOW)).toBe('overdue')
  })

  it('returns failing when latest failed run is newer than last success', () => {
    const success = succeeded(10 * 60)
    const failure = jobRun('failed', new Date(NOW.getTime() - 30 * 60_000))
    expect(scrapeJobHealth(INTERVAL, failure, success, NOW)).toBe('failing')
  })

  it('returns healthy when latest failed run is older than last success', () => {
    const recentSuccess = succeeded(60)
    expect(scrapeJobHealth(INTERVAL, recentSuccess, recentSuccess, NOW)).toBe('healthy')
  })
})

describe('scrapesRollup', () => {
  it('returns healthy when all healthy', () => {
    expect(scrapesRollup(['healthy', 'healthy'])).toBe('healthy')
  })

  it('failing dominates overdue', () => {
    expect(scrapesRollup(['overdue', 'failing', 'never'])).toBe('failing')
  })

  it('overdue dominates never', () => {
    expect(scrapesRollup(['never', 'overdue'])).toBe('overdue')
  })

  it('never dominates healthy', () => {
    expect(scrapesRollup(['healthy', 'never'])).toBe('never')
  })
})

describe('overallHealth', () => {
  it('returns healthy when all good', () => {
    expect(overallHealth('healthy', 'working', 'healthy')).toBe('healthy')
  })

  it('returns failing when cookies failing', () => {
    expect(overallHealth('healthy', 'failing', 'healthy')).toBe('failing')
  })

  it('returns failing when scrapes failing', () => {
    expect(overallHealth('healthy', 'working', 'failing')).toBe('failing')
  })

  it('failing beats degraded', () => {
    expect(overallHealth('stale', 'failing', 'overdue')).toBe('failing')
  })

  it('returns degraded when worker stale', () => {
    expect(overallHealth('stale', 'working', 'healthy')).toBe('degraded')
  })

  it('returns degraded when scrapes overdue', () => {
    expect(overallHealth('healthy', 'working', 'overdue')).toBe('degraded')
  })

  it('returns degraded when scrapes never', () => {
    expect(overallHealth('healthy', 'working', 'never')).toBe('degraded')
  })

  it('returns unknown when worker unknown but anonymous+healthy', () => {
    expect(overallHealth('unknown', 'anonymous', 'healthy')).toBe('unknown')
  })

  it('returns degraded when worker unknown but scrapes overdue', () => {
    expect(overallHealth('unknown', 'anonymous', 'overdue')).toBe('degraded')
  })
})
