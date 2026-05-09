import { createServerFn } from '@tanstack/react-start'

import { db } from '#/db/client'
import {
  cookiesRollup,
  overallHealth,
  scrapeJobHealth,
  scrapesRollup,
  workerHealth,
} from '#/lib/health-rollup'
import type {
  CookieRollup,
  OverallStatus,
  ScrapeJobStatus,
  WorkerHealthStatus,
} from '#/lib/health-rollup'
import type { JobRunRow } from '#/repos/jobRuns'
import { findLatestJobRunPerName, findLatestSuccessfulJobRunPerName } from '#/repos/jobRuns'
import { listGroupCookieStatuses } from '#/repos/groupSecrets'
import type { WorkerHeartbeatRow } from '#/repos/workerHeartbeats'
import { getLatestHeartbeat } from '#/repos/workerHeartbeats'
import { requireAdmin } from '#/server/auth'
import type { JobCatalogueEntry } from '#/worker/job-catalogue'
import { JOB_CATALOGUE } from '#/worker/job-catalogue'

export type ScrapeJobSummary = {
  readonly catalogue: JobCatalogueEntry
  readonly latest: JobRunRow | null
  readonly lastSuccessAt: Date | null
  readonly status: ScrapeJobStatus
}

export type AdminHealthSummary = {
  readonly now: Date
  readonly worker: {
    readonly status: WorkerHealthStatus
    readonly heartbeat: WorkerHeartbeatRow | null
  }
  readonly cookies: CookieRollup & { readonly total: number }
  readonly scrapes: {
    readonly status: ScrapeJobStatus
    readonly perJob: ReadonlyArray<ScrapeJobSummary>
  }
  readonly overall: OverallStatus
}

export const getAdminHealthSummary = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminHealthSummary> => {
    await requireAdmin()
    const dbR = db()
    const now = new Date()

    const [heartbeat, cookieStatuses, latestRuns, latestSuccessRuns] = await Promise.all([
      getLatestHeartbeat(dbR),
      listGroupCookieStatuses(dbR),
      findLatestJobRunPerName(dbR),
      findLatestSuccessfulJobRunPerName(dbR),
    ])

    const latestByName = new Map(latestRuns.map((r) => [r.jobName, r]))
    const lastSuccessByName = new Map(latestSuccessRuns.map((r) => [r.jobName, r]))

    const perJob: ReadonlyArray<ScrapeJobSummary> = JOB_CATALOGUE.map((catalogue) => {
      const latest = latestByName.get(catalogue.name) ?? null
      const lastSuccessRun = lastSuccessByName.get(catalogue.name) ?? null
      const lastSuccessAt = lastSuccessRun?.finishedAt ?? lastSuccessRun?.startedAt ?? null
      return {
        catalogue,
        latest,
        lastSuccessAt,
        status: scrapeJobHealth(catalogue.expectedIntervalMs, latest, lastSuccessRun, now),
      }
    })

    const worker = { status: workerHealth(heartbeat, now), heartbeat }
    const cookieRollup = cookiesRollup(cookieStatuses)
    const cookies = { ...cookieRollup, total: cookieStatuses.length }
    const scrapeStatuses = perJob.map((j) => j.status)
    const scrapes = { status: scrapesRollup(scrapeStatuses), perJob }
    const overall = overallHealth(worker.status, cookies.status, scrapes.status)

    return { now, worker, cookies, scrapes, overall }
  },
)
