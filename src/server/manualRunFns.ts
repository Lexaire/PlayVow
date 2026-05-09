import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { db, dbWrite } from '#/db/client'
import type { SteamAppId } from '#/db/schema'
import type { SgCookieTestOutcome } from '#/external/steamgifts-cookie-test'
import { testSgCookie } from '#/external/steamgifts-cookie-test'
import { env } from '#/config/env'
import { STALE_THRESHOLD_MS } from '#/lib/health-rollup'
import { createLogger } from '#/lib/logger'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { findGiveawayById } from '#/repos/giveaways'
import { getDecryptedCookie, recordTestResult } from '#/repos/groupSecrets'
import { findGroupById } from '#/repos/groups'
import { hasUnfinishedJobRun } from '#/repos/jobRuns'
import { enqueueJobTrigger, hasPendingJobTrigger } from '#/repos/jobTriggers'
import { findWinById } from '#/repos/wins'
import { requireAdmin } from '#/server/auth'
import { buildJobDeps } from '#/worker/build-deps'
import { pollSingleWin } from '#/worker/jobs/poll-playtime'
import type { PollSingleWinResult } from '#/worker/jobs/poll-playtime'
import type { ScrapeGroupSummary } from '#/worker/jobs/scrape-group'
import { scrapeGroup } from '#/worker/jobs/scrape-group'
import { syncOneApp } from '#/worker/jobs/sync-app-details'
import type { SyncOneAppResult } from '#/worker/jobs/sync-app-details'
import { runJob } from '#/worker/scheduler'

// Manual job triggers ("Run now" buttons on /admin/jobs).
//
// Two routes depending on blast radius:
//
// - Single-item actions (test one cookie, scrape one group, poll one win,
//   sync one app) run **in-process** via runJob(). Bounded by a single
//   group/win/app, finish in seconds, and the admin gets a synchronous
//   result. Same dep bag the worker uses (buildJobDeps).
//
// - Full-run actions (full scrape, full poll, backfill winners, scrape
//   steam members) **enqueue a job_triggers row** that the worker picks up
//   on its next 30s poll. The web process never runs these itself — long
//   jobs in the web process compete with HTTP traffic for sockets/GC and
//   were responsible for stalling /admin pages while a scrape ran. The
//   server fn returns once the trigger is enqueued; the admin watches
//   /admin/jobs for the row to materialize.
//
// Concurrency: a click is refused if either (a) a 'running' job_runs row
// exists for the same job_name younger than STALE_THRESHOLD_MS, or (b) a
// 'queued'/'claimed' job_triggers row exists for the same job_name. (b)
// catches the case where two clicks land in the same 30s window before the
// worker has claimed the first one.

const SCRAPE_GROUPS_JOB = 'scrape_groups'
const BACKFILL_WINNERS_JOB = 'backfill_winners'
const POLL_PLAYTIME_JOB = 'poll_playtime'
const SCRAPE_STEAM_MEMBERS_JOB = 'scrape_steam_group_members'
const SYNC_APP_DETAILS_JOB = 'sync_app_details'

export type ManualRunBusy = { readonly kind: 'busy'; readonly jobName: string }
export type ManualGroupNotFound = { readonly kind: 'group_not_found' }
export type ManualWinNotFound = { readonly kind: 'win_not_found' }

const isBusy = async (jobName: string, now: Date): Promise<boolean> => {
  const cutoff = new Date(now.getTime() - STALE_THRESHOLD_MS)
  // Two reasons a job is "in flight": its job_runs row is still 'running',
  // or a job_triggers mailbox row is queued (or claimed but not yet
  // finalized within the stale threshold). Both are checked against the
  // same cutoff so a crashed worker can't permanently block the busy guard.
  const dbW = dbWrite()
  const [running, pending] = await Promise.all([
    hasUnfinishedJobRun(dbW, jobName, cutoff),
    hasPendingJobTrigger(dbW, jobName, cutoff),
  ])
  return running || pending
}

// ----- Test SteamGifts login --------------------------------------------

export type TestSgLoginInput = { readonly groupId: number }
export type TestSgLoginOk = {
  readonly result: SgCookieTestOutcome['kind']
  readonly httpStatus?: number
}
export type TestSgLoginError =
  | ManualGroupNotFound
  | { readonly kind: 'cookie_not_set' }
  | { readonly kind: 'cookie_decrypt_failed' }

const TestSgLoginSchema = z.object({ groupId: z.number().int().positive() })

// Exposed separately on /admin/jobs even though the same machinery exists on
// /admin/cookies — the operator should be able to test the cookie from the
// jobs page without bouncing between tabs. Result is recorded to
// group_secrets.last_test_result so /admin/cookies stays in sync.
export const testSgLoginFn = createServerFn({ method: 'POST' })
  .inputValidator((input: TestSgLoginInput) => TestSgLoginSchema.parse(input))
  .handler(async ({ data }): Promise<Result<TestSgLoginOk, TestSgLoginError>> => {
    const admin = await requireAdmin()
    const group = await findGroupById(dbWrite(), data.groupId)
    if (!group) return err({ kind: 'group_not_found' })

    const cookieR = await getDecryptedCookie(dbWrite(), data.groupId)
    if (!cookieR.ok) {
      if (cookieR.error.kind === 'not_set') return err({ kind: 'cookie_not_set' })
      return err({ kind: 'cookie_decrypt_failed' })
    }

    const sgBase = env.SG_PROXY_BASE ?? 'https://www.steamgifts.com'
    const testUrl = `${sgBase}/group/${group.steamgiftsGroupCode}/${encodeURIComponent(group.steamGroupSlug)}/search?page=1`
    const outcome = await testSgCookie({ cookie: cookieR.value, testUrl })

    await recordTestResult(dbWrite(), {
      groupId: data.groupId,
      result: outcome.kind,
      actorUserId: admin.id,
    })

    return ok(
      outcome.kind === 'http_error'
        ? { result: outcome.kind, httpStatus: outcome.status }
        : { result: outcome.kind },
    )
  })

// ----- Scrape one group (synchronous, fast enough to await) -------------

export type ScrapeOneGroupInput = { readonly groupId: number }
export type ScrapeOneGroupOk = { readonly summary: ScrapeGroupSummary | null }
export type ScrapeOneGroupError = ManualGroupNotFound | ManualRunBusy

const ScrapeOneGroupSchema = z.object({ groupId: z.number().int().positive() })

export const scrapeOneGroupFn = createServerFn({ method: 'POST' })
  .inputValidator((input: ScrapeOneGroupInput) => ScrapeOneGroupSchema.parse(input))
  .handler(async ({ data }): Promise<Result<ScrapeOneGroupOk, ScrapeOneGroupError>> => {
    const admin = await requireAdmin()
    const dbR = db()
    const dbW = dbWrite()
    const group = await findGroupById(dbR, data.groupId)
    if (!group) return err({ kind: 'group_not_found' })
    if (await isBusy(SCRAPE_GROUPS_JOB, new Date())) {
      return err({ kind: 'busy', jobName: SCRAPE_GROUPS_JOB })
    }

    const logger = createLogger({ bindings: { service: 'admin-manual-run' } })
    const deps = buildJobDeps(dbR, logger)
    const sg = await deps.sgClientForGroup(group.id)

    let summary: ScrapeGroupSummary | null = null
    await runJob(
      {
        name: SCRAPE_GROUPS_JOB,
        cron: 'manual',
        run: async () => {
          summary = await scrapeGroup({ db: dbR, dbWrite: dbW, sg, logger }, group)
          return summary
        },
      },
      {
        logger,
        dbWrite: dbW,
        counters: deps.counters,
        triggeredBy: 'manual',
        triggeredByUserId: admin.id,
      },
    )
    return ok({ summary })
  })

// ----- Run full daily scrape (enqueue trigger; worker dispatches) -------

export type RunScrapeAllInput = Record<string, never>
export type RunScrapeAllOk = { readonly queued: true }
export type RunScrapeAllError = ManualRunBusy

export const runScrapeAllFn = createServerFn({ method: 'POST' })
  .inputValidator((_: RunScrapeAllInput) => z.object({}).parse({}))
  .handler(async (): Promise<Result<RunScrapeAllOk, RunScrapeAllError>> => {
    const admin = await requireAdmin()
    if (await isBusy(SCRAPE_GROUPS_JOB, new Date())) {
      return err({ kind: 'busy', jobName: SCRAPE_GROUPS_JOB })
    }
    await enqueueJobTrigger(dbWrite(), {
      jobName: SCRAPE_GROUPS_JOB,
      requestedByUserId: admin.id,
    })
    return ok({ queued: true })
  })

// ----- Run full hourly poll (enqueue trigger; worker dispatches) --------

export type RunPollAllInput = Record<string, never>
export type RunPollAllOk = { readonly queued: true }
export type RunPollAllError = ManualRunBusy

export const runPollAllFn = createServerFn({ method: 'POST' })
  .inputValidator((_: RunPollAllInput) => z.object({}).parse({}))
  .handler(async (): Promise<Result<RunPollAllOk, RunPollAllError>> => {
    const admin = await requireAdmin()
    if (await isBusy(POLL_PLAYTIME_JOB, new Date())) {
      return err({ kind: 'busy', jobName: POLL_PLAYTIME_JOB })
    }
    await enqueueJobTrigger(dbWrite(), {
      jobName: POLL_PLAYTIME_JOB,
      requestedByUserId: admin.id,
    })
    return ok({ queued: true })
  })

// ----- Poll one pending win (synchronous) -------------------------------

export type PollOneWinInput = { readonly winId: number }
export type PollOneWinOk = { readonly result: PollSingleWinResult['kind'] }
export type PollOneWinError =
  | ManualWinNotFound
  | ManualRunBusy
  | { readonly kind: 'poll_threw'; readonly message: string }

const PollOneWinSchema = z.object({ winId: z.number().int().positive() })

export const pollOneWinFn = createServerFn({ method: 'POST' })
  .inputValidator((input: PollOneWinInput) => PollOneWinSchema.parse(input))
  .handler(async ({ data }): Promise<Result<PollOneWinOk, PollOneWinError>> => {
    const admin = await requireAdmin()
    const dbR = db()
    const win = await findWinById(dbR, data.winId)
    if (!win) return err({ kind: 'win_not_found' })
    // Sanity check the giveaway exists — failing fast surfaces a clearer
    // error than letting pollSingleWin discover it later.
    const giveaway = await findGiveawayById(dbR, win.giveawayId)
    if (!giveaway) return err({ kind: 'win_not_found' })
    if (await isBusy(POLL_PLAYTIME_JOB, new Date())) {
      return err({ kind: 'busy', jobName: POLL_PLAYTIME_JOB })
    }

    const logger = createLogger({ bindings: { service: 'admin-manual-run' } })
    const deps = buildJobDeps(dbR, logger)
    // Captured from inside runJob's run callback. Wrapped in an object so
    // TS keeps the union type — a bare `let outcome: T | null = null`
    // narrows to `null` under flow analysis because the assignment happens
    // inside a closure that isn't traced linearly. When the job throws,
    // .value stays null and we surface runJob's errorMessage instead of
    // pretending we got a normal poll outcome.
    const captured: { value: PollSingleWinResult | null } = { value: null }
    const runOutcome = await runJob(
      {
        name: POLL_PLAYTIME_JOB,
        cron: 'manual',
        run: async () => {
          const result = await pollSingleWin(
            { db: dbR, dbWrite: dbWrite(), steam: deps.steam, logger },
            data.winId,
          )
          captured.value = result
          return { winId: data.winId, kind: result.kind }
        },
      },
      {
        logger,
        dbWrite: dbWrite(),
        counters: deps.counters,
        triggeredBy: 'manual',
        triggeredByUserId: admin.id,
      },
    )
    if (captured.value === null) {
      return err({
        kind: 'poll_threw',
        message: runOutcome.errorMessage ?? 'poll failed without an error message',
      })
    }
    return ok({ result: captured.value.kind })
  })

// ----- Sync one Steam app (synchronous) ---------------------------------

export type SyncOneAppInput = { readonly appId: number }
export type SyncOneAppOk = { readonly result: SyncOneAppResult['kind'] }
export type SyncOneAppErrorOut =
  | ManualRunBusy
  | { readonly kind: 'sync_threw'; readonly message: string }

const SyncOneAppSchema = z.object({ appId: z.number().int().positive() })

export const syncOneAppFn = createServerFn({ method: 'POST' })
  .inputValidator((input: SyncOneAppInput) => SyncOneAppSchema.parse(input))
  .handler(async ({ data }): Promise<Result<SyncOneAppOk, SyncOneAppErrorOut>> => {
    const admin = await requireAdmin()
    if (await isBusy(SYNC_APP_DETAILS_JOB, new Date())) {
      return err({ kind: 'busy', jobName: SYNC_APP_DETAILS_JOB })
    }

    const logger = createLogger({ bindings: { service: 'admin-manual-run' } })
    const deps = buildJobDeps(db(), logger)
    // See the matching captured-value pattern in pollOneWinFn for why this
    // is wrapped in an object instead of a `let` binding.
    const captured: { value: SyncOneAppResult | null } = { value: null }
    const runOutcome = await runJob(
      {
        name: SYNC_APP_DETAILS_JOB,
        cron: 'manual',
        run: async () => {
          const result = await syncOneApp(
            { db: db(), dbWrite: dbWrite(), steam: deps.steam, logger },
            data.appId as SteamAppId,
          )
          captured.value = result
          return result
        },
      },
      {
        logger,
        dbWrite: dbWrite(),
        counters: deps.counters,
        triggeredBy: 'manual',
        triggeredByUserId: admin.id,
      },
    )
    if (captured.value === null) {
      return err({
        kind: 'sync_threw',
        message: runOutcome.errorMessage ?? 'sync failed without an error message',
      })
    }
    return ok({ result: captured.value.kind })
  })

// ----- Run backfill winners (enqueue trigger; worker dispatches) --------

export type RunBackfillWinnersInput = Record<string, never>
export type RunBackfillWinnersOk = { readonly queued: true }
export type RunBackfillWinnersError = ManualRunBusy

export const runBackfillWinnersFn = createServerFn({ method: 'POST' })
  .inputValidator((_: RunBackfillWinnersInput) => z.object({}).parse({}))
  .handler(async (): Promise<Result<RunBackfillWinnersOk, RunBackfillWinnersError>> => {
    const admin = await requireAdmin()
    if (await isBusy(BACKFILL_WINNERS_JOB, new Date())) {
      return err({ kind: 'busy', jobName: BACKFILL_WINNERS_JOB })
    }
    await enqueueJobTrigger(dbWrite(), {
      jobName: BACKFILL_WINNERS_JOB,
      requestedByUserId: admin.id,
    })
    return ok({ queued: true })
  })

// ----- Run scrape steam group members (enqueue trigger; worker dispatches) -

export type RunScrapeSteamMembersInput = Record<string, never>
export type RunScrapeSteamMembersOk = { readonly queued: true }
export type RunScrapeSteamMembersError = ManualRunBusy

export const runScrapeSteamMembersFn = createServerFn({ method: 'POST' })
  .inputValidator((_: RunScrapeSteamMembersInput) => z.object({}).parse({}))
  .handler(async (): Promise<Result<RunScrapeSteamMembersOk, RunScrapeSteamMembersError>> => {
    const admin = await requireAdmin()
    if (await isBusy(SCRAPE_STEAM_MEMBERS_JOB, new Date())) {
      return err({ kind: 'busy', jobName: SCRAPE_STEAM_MEMBERS_JOB })
    }
    await enqueueJobTrigger(dbWrite(), {
      jobName: SCRAPE_STEAM_MEMBERS_JOB,
      requestedByUserId: admin.id,
    })
    return ok({ queued: true })
  })
