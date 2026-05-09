import { and, desc, eq, sql } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { JobRunStatus, JobRunTrigger } from '#/db/schema'
import { jobRuns } from '#/db/schema'

// Recursive JSON value. Used to type job_runs.summary so server-fn
// serialization validators accept it — bare `unknown` is rejected.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [k: string]: JsonValue }
  | ReadonlyArray<JsonValue>

export type JobRunRow = {
  readonly id: number
  readonly jobName: string
  readonly status: JobRunStatus
  readonly triggeredBy: JobRunTrigger
  readonly triggeredByUserId: number | null
  readonly startedAt: Date
  readonly finishedAt: Date | null
  readonly durationMs: number | null
  readonly steamCalls: number | null
  readonly sgCalls: number | null
  readonly errorMessage: string | null
  readonly summary: JsonValue
  readonly createdAt: Date
}

export const insertJobRunStart = async (
  db: DbOrTx,
  args: {
    readonly jobName: string
    readonly startedAt: Date
    readonly triggeredBy?: JobRunTrigger
    readonly triggeredByUserId?: number | null
  },
): Promise<number> => {
  const [row] = await db
    .insert(jobRuns)
    .values({
      jobName: args.jobName,
      status: 'running',
      startedAt: args.startedAt,
      ...(args.triggeredBy ? { triggeredBy: args.triggeredBy } : {}),
      ...(args.triggeredByUserId !== undefined
        ? { triggeredByUserId: args.triggeredByUserId }
        : {}),
    })
    .returning({ id: jobRuns.id })
  if (!row) throw new Error('insertJobRunStart: insert returned no rows')
  return row.id
}

// True iff a 'running' row exists for the given job_name with started_at
// newer than the given staleThreshold. Used by manual-run server fns to
// refuse a click while a cron-fired run of the same job is still going (the
// dual-process design shares the SG/Steam rate budget, and overlapping the
// same job would corrupt the per-job API call counters).
export const hasUnfinishedJobRun = async (
  db: DbOrTx,
  jobName: string,
  staleThreshold: Date,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.jobName, jobName),
        eq(jobRuns.status, 'running'),
        sql`${jobRuns.startedAt} > ${Math.floor(staleThreshold.getTime() / 1000)}`,
      ),
    )
    .limit(1)
  return row !== undefined
}

export type FinalizeJobRunInput = {
  readonly id: number
  readonly status: 'succeeded' | 'failed'
  readonly finishedAt: Date
  readonly durationMs: number
  readonly steamCalls: number
  readonly sgCalls: number
  readonly errorMessage?: string
  readonly summary?: unknown
}

export const finalizeJobRun = async (db: DbOrTx, input: FinalizeJobRunInput): Promise<void> => {
  await db
    .update(jobRuns)
    .set({
      status: input.status,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      steamCalls: input.steamCalls,
      sgCalls: input.sgCalls,
      errorMessage: input.errorMessage ?? null,
      summary: input.summary ?? null,
    })
    .where(eq(jobRuns.id, input.id))
}

export type ListJobRunsInput = {
  readonly page: number
  readonly pageSize: number
  readonly jobName?: string
  readonly status?: JobRunStatus
}

export type ListJobRunsResult = {
  readonly rows: ReadonlyArray<JobRunRow>
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export const listJobRuns = async (
  db: DbOrTx,
  input: ListJobRunsInput,
): Promise<ListJobRunsResult> => {
  const conditions = []
  if (input.jobName) conditions.push(eq(jobRuns.jobName, input.jobName))
  if (input.status) conditions.push(eq(jobRuns.status, input.status))
  const where = conditions.length === 0 ? sql`1=1` : and(...conditions)
  const offset = Math.max(0, (input.page - 1) * input.pageSize)

  const [totalRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobRuns)
    .where(where)

  const rows = await db
    .select()
    .from(jobRuns)
    .where(where)
    .orderBy(desc(jobRuns.id))
    .limit(input.pageSize)
    .offset(offset)

  return {
    rows: rows.map(toJobRunRow),
    total: totalRow?.n ?? 0,
    page: input.page,
    pageSize: input.pageSize,
  }
}

// Latest run per job_name. Used by /admin/jobs to render per-job summary
// cards. Single round-trip via a correlated MAX(id) subquery — index
// (job_name, started_at) covers the inner aggregate, and id ordering is
// monotonic with started_at because rows are inserted in real time.
export const findLatestJobRunPerName = async (db: DbOrTx): Promise<ReadonlyArray<JobRunRow>> => {
  const rows = await db
    .select()
    .from(jobRuns)
    .where(sql`${jobRuns.id} IN (SELECT MAX(id) FROM ${jobRuns} GROUP BY job_name)`)
  return rows.map(toJobRunRow)
}

// Latest *succeeded* run per job_name. Used by the health summary to compute
// scrape freshness (overdue threshold). Same MAX(id) pattern scoped to succeeded rows.
export const findLatestSuccessfulJobRunPerName = async (
  db: DbOrTx,
): Promise<ReadonlyArray<JobRunRow>> => {
  const rows = await db
    .select()
    .from(jobRuns)
    .where(
      sql`${jobRuns.status} = 'succeeded' AND ${jobRuns.id} IN (SELECT MAX(id) FROM ${jobRuns} WHERE status = 'succeeded' GROUP BY job_name)`,
    )
  return rows.map(toJobRunRow)
}

const toJobRunRow = (row: typeof jobRuns.$inferSelect): JobRunRow => ({
  id: row.id,
  jobName: row.jobName,
  status: row.status,
  triggeredBy: row.triggeredBy,
  triggeredByUserId: row.triggeredByUserId,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  durationMs: row.durationMs,
  steamCalls: row.steamCalls,
  sgCalls: row.sgCalls,
  errorMessage: row.errorMessage,
  // Drizzle types JSON-mode columns as `unknown`. Only the worker writes
  // here, and only with JSON-serializable summaries, so the cast is sound.
  summary: (row.summary ?? null) as JsonValue,
  createdAt: row.createdAt,
})
