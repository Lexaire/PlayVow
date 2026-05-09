import { env } from '#/config/env'
import { db, dbWrite } from '#/db/client'
import { createPostHogAnalytics } from '#/lib/analytics'
import { createLogger } from '#/lib/logger'
import { claimNextJobTrigger, finalizeJobTrigger } from '#/repos/jobTriggers'
import { recordHeartbeat } from '#/repos/workerHeartbeats'
import { buildJobDeps } from '#/worker/build-deps'
import { findJobInCatalogue } from '#/worker/job-catalogue'
import { backfillWinners } from '#/worker/jobs/backfill-winners'
import { pollPlaytime } from '#/worker/jobs/poll-playtime'
import { scrapeAllGroups } from '#/worker/jobs/scrape-group'
import { scrapeAllSteamGroupMembers } from '#/worker/jobs/scrape-steam-group-members'
import type { ScheduledJob } from '#/worker/scheduler'
import { runJob, startScheduler } from '#/worker/scheduler'

const cronOf = (name: string): string => {
  const entry = findJobInCatalogue(name)
  if (!entry) throw new Error(`job_catalogue_missing_entry: ${name}`)
  return entry.cron
}

// Cron expressions live in src/worker/job-catalogue.ts (single source of
// truth so /admin/jobs can render the same schedule the worker runs). Scrape
// and backfill are offset 30 minutes from the hour so they don't fire in the
// same slot as the hourly poll — concurrent jobs cross-pollute the per-process
// API call counters used for analytics. The 30-minute stagger is sized for up
// to ~900 pending wins per poll (~30 min wall-clock at the 1s/call Steam rate
// limit). At ~1500+ wins you'd need to widen the stagger or implement
// per-job counter wrappers so jobs can safely overlap.

// Pin all cron expressions to a single business timezone so DST transitions
// and "4 AM" mean the same thing regardless of the host OS. Hardcoded rather
// than env-driven because we deploy from one timezone; revisit if that
// changes.
const CRON_TIMEZONE = 'America/Chicago'

// Heartbeat tick. Long enough to keep Turso sync volume tiny (~96/day),
// short enough that /admin/jobs flags a dead worker within ~45 min (3 missed
// ticks per HEARTBEAT_STALE_MS). See admin ideas.md → "Worker Heartbeat".
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000

// Trigger-mailbox poll interval. /admin/jobs "Run now" buttons write a
// job_triggers row; this tick drains the queue. 30s strikes the same balance
// the heartbeat does — admin sees the run start before they refresh, and
// idle ticks are a single SELECT against an indexed (status, id).
const TRIGGER_POLL_INTERVAL_MS = 30 * 1000

const main = async (): Promise<void> => {
  const logger = createLogger({ bindings: { service: 'worker' } })
  logger.info('worker_starting', { dbMode: env.db.mode })
  if (env.STEAM_WEB_API_KEY.trim().length === 0) {
    logger.error('worker_missing_external_credentials', {
      missing: ['STEAM_WEB_API_KEY'],
    })
    process.exit(1)
  }

  // Captured once and held across the process lifetime — startedAt and pid
  // are stable for the worker's run; only lastSeenAt is observed live each
  // tick. Without this, started_at would drift to "now" on every upsert.
  const workerStartedAt = new Date()
  const workerPid = process.pid

  const dbi = db()
  const dbiWrite = dbWrite()
  // Shared dep bag (rate-limited counting fetchers, sg client factory, steam
  // clients). Same factory used by /admin/jobs "Run now" server fns and the
  // one-shot scripts so manual runs throttle the same way the worker does.
  const deps = buildJobDeps(dbi, logger)
  const { sgClientForGroup, steam, steamCommunity } = deps

  // No-op when POSTHOG_API_KEY is unset (dev/CI/ad-hoc shells).
  const analytics = createPostHogAnalytics({
    apiKey: env.POSTHOG_API_KEY.length === 0 ? null : env.POSTHOG_API_KEY,
    ...(env.POSTHOG_HOST ? { host: env.POSTHOG_HOST } : {}),
  })

  // Initial heartbeat synchronously, before the scheduler starts — without
  // this, /admin/jobs would show "no heartbeat recorded yet" for the first
  // 5 min after deploy. Failures are logged but don't block startup; the
  // tick below will retry every interval.
  try {
    await recordHeartbeat(dbiWrite, {
      startedAt: workerStartedAt,
      lastSeenAt: workerStartedAt,
      pid: workerPid,
    })
  } catch (e) {
    logger.error('heartbeat_initial_write_failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }
  const heartbeatHandle = setInterval(() => {
    void recordHeartbeat(dbiWrite, {
      startedAt: workerStartedAt,
      lastSeenAt: new Date(),
      pid: workerPid,
    }).catch((e: unknown) => {
      logger.error('heartbeat_write_failed', {
        error: e instanceof Error ? e.message : String(e),
      })
    })
  }, HEARTBEAT_INTERVAL_MS)
  // Don't keep the process alive solely for the heartbeat — if the scheduler
  // is gone, the worker should exit cleanly.
  heartbeatHandle.unref()

  // Single source of truth for the worker's job set — both the cron
  // scheduler and the trigger-mailbox poller dispatch from this array. Adding
  // a new job here makes it both schedulable (via job-catalogue cron) and
  // manually triggerable (via /admin/jobs).
  const jobs: ReadonlyArray<ScheduledJob> = [
    {
      name: 'scrape_groups',
      cron: cronOf('scrape_groups'),
      run: () =>
        scrapeAllGroups({
          db: dbi,
          dbWrite: dbiWrite,
          sgClientForGroup,
          steam,
          logger,
        }),
    },
    {
      name: 'backfill_winners',
      cron: cronOf('backfill_winners'),
      run: () => backfillWinners({ db: dbi, dbWrite: dbiWrite, sgClientForGroup, logger }),
    },
    {
      name: 'poll_playtime',
      cron: cronOf('poll_playtime'),
      run: () => pollPlaytime({ db: dbi, dbWrite: dbiWrite, steam, steamCommunity, logger }),
    },
    {
      name: 'scrape_steam_group_members',
      cron: cronOf('scrape_steam_group_members'),
      run: () =>
        scrapeAllSteamGroupMembers({
          db: dbi,
          dbWrite: dbiWrite,
          steam: steamCommunity,
          logger,
        }),
    },
  ]
  const jobsByName = new Map(jobs.map((j) => [j.name, j]))

  const scheduler = startScheduler({
    logger,
    analytics,
    counters: deps.counters,
    dbWrite: dbiWrite,
    timezone: CRON_TIMEZONE,
    jobs,
  })

  // Drain the trigger mailbox. Loops until empty so a burst of admin clicks
  // doesn't have to wait one tick per request. Errors per-trigger are caught
  // here so a single bad row doesn't kill the loop. The runJob call inside
  // already handles its own failures (and writes them to job_runs); we only
  // see thrown errors from the trigger I/O itself.
  const drainTriggers = async (): Promise<void> => {
    while (true) {
      let trigger
      try {
        trigger = await claimNextJobTrigger(dbiWrite)
      } catch (e) {
        logger.error('trigger_claim_failed', {
          error: e instanceof Error ? e.message : String(e),
        })
        return
      }
      if (!trigger) return
      const job = jobsByName.get(trigger.jobName)
      if (!job) {
        logger.warn('trigger_unknown_job', {
          triggerId: trigger.id,
          jobName: trigger.jobName,
        })
        await finalizeJobTrigger(dbiWrite, {
          id: trigger.id,
          status: 'failed',
          errorMessage: `unknown job: ${trigger.jobName}`,
        })
        continue
      }
      logger.info('trigger_claimed', {
        triggerId: trigger.id,
        jobName: trigger.jobName,
        requestedByUserId: trigger.requestedByUserId,
      })
      const outcome = await runJob(job, {
        logger,
        analytics,
        counters: deps.counters,
        dbWrite: dbiWrite,
        triggeredBy: 'manual',
        triggeredByUserId: trigger.requestedByUserId,
      })
      await finalizeJobTrigger(dbiWrite, {
        id: trigger.id,
        status: outcome.status === 'succeeded' ? 'done' : 'failed',
        jobRunId: outcome.jobRunId,
        errorMessage: outcome.errorMessage,
      })
    }
  }
  // setInterval, not setTimeout-loop: triggers are rare so re-entrancy is
  // a non-issue, and a long-running trigger drain (e.g. a 30-min full
  // scrape) must not block the next tick — the scheduler itself fires
  // independently. drainTriggers is single-claimer-safe by virtue of the
  // atomic claimNextJobTrigger statement.
  //
  // activeDrain is captured so shutdown can await the in-flight I/O before
  // closing the DB clients. The drain is bounded on shutdown (see below) —
  // a 30-min scrape mid-flight will get killed by process.exit just like
  // a cron-fired run does today; that's a pre-existing limitation worth
  // calling out but not solving here.
  let activeDrain: Promise<void> | null = null
  const triggerHandle = setInterval(() => {
    if (activeDrain !== null) return
    activeDrain = drainTriggers().finally(() => {
      activeDrain = null
    })
  }, TRIGGER_POLL_INTERVAL_MS)
  triggerHandle.unref()

  // Cap on how long shutdown waits for the in-flight drain. SIGTERM grace
  // periods are typically 10–30s on most platforms (systemd/k8s), so we
  // err on the short side. If a long-running runJob is mid-statement when
  // this fires, it gets killed by process.exit — same fate as cron jobs.
  const SHUTDOWN_DRAIN_WAIT_MS = 5000

  const shutdown = (signal: string) => async () => {
    logger.info('worker_stopping', { signal })
    clearInterval(heartbeatHandle)
    clearInterval(triggerHandle)
    scheduler.stop()
    if (activeDrain !== null) {
      const drain = activeDrain
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout')
        }, SHUTDOWN_DRAIN_WAIT_MS).unref()
      })
      const winner = await Promise.race([drain.then(() => 'drained' as const), timeout])
      if (winner === 'timeout') {
        logger.warn('shutdown_drain_timed_out', { waitMs: SHUTDOWN_DRAIN_WAIT_MS })
      }
    }
    // Flush queued PostHog events before tearing down. Bounded internally
    // by the SDK; if the network is unreachable, events are lost — that's
    // acceptable for observability data.
    try {
      await analytics.shutdown()
    } catch (e) {
      logger.warn('analytics_shutdown_failed', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
    dbi.$client.close()
    if (dbiWrite.$client !== dbi.$client) dbiWrite.$client.close()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void shutdown('SIGINT')()
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')()
  })

  logger.info('worker_started')
}

void main()
