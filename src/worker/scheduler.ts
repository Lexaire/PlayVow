import { Cron } from 'croner'

import type { DbOrTx } from '#/db/client'
import type { JobRunTrigger } from '#/db/schema'
import type { Analytics } from '#/lib/analytics'
import type { CountingFetcher } from '#/lib/counting-fetcher'
import type { Logger } from '#/lib/logger'
import { finalizeJobRun, insertJobRunStart } from '#/repos/jobRuns'

export type ScheduledJob = {
  readonly name: string
  readonly cron: string
  // Returned value (if any) is JSON-stringified into job_runs.summary so the
  // admin UI can show domain-specific stats (rows changed, errors, etc.).
  // Jobs that have nothing to report can return void.
  readonly run: () => Promise<unknown>
}

// Wired by the worker entrypoint when these are available. Counters are
// observed before/after each job's run() so we can report API spend per job
// without touching individual job code.
export type ApiCallCounters = {
  readonly steam: CountingFetcher
  readonly sg: CountingFetcher
}

export type RunJobOptions = {
  readonly logger: Logger
  readonly now?: () => Date
  readonly analytics?: Analytics
  readonly counters?: ApiCallCounters
  // When provided, runJob writes a row to job_runs at start and finalizes it
  // with status/duration/api-calls/summary on completion. Optional so unit
  // tests can exercise runJob without spinning up a DB.
  readonly dbWrite?: DbOrTx
  // 'cron' (default) for scheduler-fired runs; 'manual' when an admin clicks
  // "Run now". Persisted to job_runs.triggered_by so /admin/jobs can
  // distinguish them.
  readonly triggeredBy?: JobRunTrigger
  // Admin user id when triggeredBy='manual'. Recorded for traceability.
  readonly triggeredByUserId?: number | null
  // PostHog requires a distinctId per event. The worker is a single long-lived
  // process so a constant id ('worker' by default) is appropriate; tests can
  // override.
  readonly distinctId?: string
}

const ANALYTICS_DISTINCT_ID_DEFAULT = 'worker'

export type JobRunOutcome = {
  // The inserted job_runs.id (null when dbWrite is not provided or the
  // initial insert failed). Callers that wrote a job_triggers row use this
  // id to link the trigger to its run for traceability.
  readonly jobRunId: number | null
  readonly status: 'succeeded' | 'failed'
  readonly errorMessage: string | null
}

export const runJob = async (job: ScheduledJob, opts: RunJobOptions): Promise<JobRunOutcome> => {
  const now = opts.now ?? (() => new Date())
  const log = opts.logger.child({ job: job.name })
  const startedAt = now()
  const steamBefore = opts.counters?.steam.getCount() ?? 0
  const sgBefore = opts.counters?.sg.getCount() ?? 0
  log.info('job_started')

  // Persist a 'running' row up front so a crashed worker leaves an
  // identifiable orphan (status=running, finished_at=null) instead of no
  // trace at all. If the insert itself fails, we log and continue — losing
  // observability is preferable to skipping the actual job.
  let runId: number | null = null
  if (opts.dbWrite) {
    try {
      runId = await insertJobRunStart(opts.dbWrite, {
        jobName: job.name,
        startedAt,
        ...(opts.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
        ...(opts.triggeredByUserId !== undefined
          ? { triggeredByUserId: opts.triggeredByUserId }
          : {}),
      })
    } catch (e) {
      log.error('job_run_persist_start_failed', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  let outcome: 'completed' | 'failed' = 'completed'
  let errorMessage: string | undefined
  let summary: unknown
  try {
    summary = await job.run()
  } catch (e) {
    outcome = 'failed'
    errorMessage = e instanceof Error ? e.message : String(e)
  }
  const finishedAt = now()
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  const steamCalls = (opts.counters?.steam.getCount() ?? 0) - steamBefore
  const sgCalls = (opts.counters?.sg.getCount() ?? 0) - sgBefore
  if (outcome === 'completed') {
    log.info('job_completed', { durationMs, steamCalls, sgCalls })
  } else {
    log.error('job_failed', { durationMs, steamCalls, sgCalls, error: errorMessage })
  }

  if (runId !== null && opts.dbWrite) {
    try {
      await finalizeJobRun(opts.dbWrite, {
        id: runId,
        status: outcome === 'completed' ? 'succeeded' : 'failed',
        finishedAt,
        durationMs,
        steamCalls,
        sgCalls,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        ...(summary !== undefined ? { summary } : {}),
      })
    } catch (e) {
      log.error('job_run_persist_finalize_failed', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  opts.analytics?.capture({
    name: outcome === 'completed' ? 'worker_job_completed' : 'worker_job_failed',
    distinctId: opts.distinctId ?? ANALYTICS_DISTINCT_ID_DEFAULT,
    properties: {
      job: job.name,
      cron: job.cron,
      triggeredBy: opts.triggeredBy ?? 'cron',
      durationMs,
      steamCalls,
      sgCalls,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    },
  })

  return {
    jobRunId: runId,
    status: outcome === 'completed' ? 'succeeded' : 'failed',
    errorMessage: errorMessage ?? null,
  }
}

export type StartSchedulerConfig = {
  readonly jobs: ReadonlyArray<ScheduledJob>
  readonly logger: Logger
  readonly analytics?: Analytics
  readonly counters?: ApiCallCounters
  readonly dbWrite?: DbOrTx
  // IANA timezone for cron expressions. Without this, croner uses the server's
  // local time, which on most VPS hosts is UTC — meaning a `0 4 * * *` cron
  // would fire at 4 AM UTC, not 4 AM in any meaningful business timezone. Pin
  // it explicitly so DST transitions are handled correctly and dev/prod stay
  // consistent.
  readonly timezone?: string
}

export type RunningScheduler = {
  readonly stop: () => void
}

export const startScheduler = (cfg: StartSchedulerConfig): RunningScheduler => {
  const log = cfg.logger.child({ component: 'scheduler' })
  const crons = cfg.jobs.map(
    (job) =>
      new Cron(
        job.cron,
        {
          protect: true,
          name: job.name,
          ...(cfg.timezone ? { timezone: cfg.timezone } : {}),
        },
        async () => {
          await runJob(job, {
            logger: cfg.logger,
            ...(cfg.analytics ? { analytics: cfg.analytics } : {}),
            ...(cfg.counters ? { counters: cfg.counters } : {}),
            ...(cfg.dbWrite ? { dbWrite: cfg.dbWrite } : {}),
          })
        },
      ),
  )
  for (const job of cfg.jobs) {
    log.info('job_registered', {
      job: job.name,
      cron: job.cron,
      timezone: cfg.timezone ?? 'system',
    })
  }
  return {
    stop: () => {
      for (const c of crons) c.stop()
    },
  }
}
