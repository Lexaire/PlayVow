import { and, eq, sql } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { JobTriggerStatus } from '#/db/schema'
import { jobTriggers } from '#/db/schema'

export type JobTriggerRow = {
  readonly id: number
  readonly jobName: string
  readonly requestedByUserId: number | null
  readonly status: JobTriggerStatus
  readonly requestedAt: Date
  readonly claimedAt: Date | null
  readonly finishedAt: Date | null
  readonly jobRunId: number | null
  readonly errorMessage: string | null
}

export type EnqueueJobTriggerInput = {
  readonly jobName: string
  readonly requestedByUserId: number | null
  readonly now?: Date
}

export const enqueueJobTrigger = async (
  db: DbOrTx,
  input: EnqueueJobTriggerInput,
): Promise<number> => {
  const [row] = await db
    .insert(jobTriggers)
    .values({
      jobName: input.jobName,
      requestedByUserId: input.requestedByUserId,
      status: 'queued',
      ...(input.now ? { requestedAt: input.now } : {}),
    })
    .returning({ id: jobTriggers.id })
  if (!row) throw new Error('enqueueJobTrigger: insert returned no rows')
  return row.id
}

// Atomic FIFO claim. A single UPDATE … RETURNING flips the next 'queued' row
// to 'claimed' and hands it back. SQLite executes this as one statement so
// two concurrent claimers cannot pick the same row even without an explicit
// transaction.
export const claimNextJobTrigger = async (db: DbOrTx): Promise<JobTriggerRow | null> => {
  const rows = await db
    .update(jobTriggers)
    .set({
      status: 'claimed',
      claimedAt: sql`(unixepoch())`,
    })
    .where(
      sql`${jobTriggers.id} = (SELECT id FROM ${jobTriggers} WHERE status = 'queued' ORDER BY id LIMIT 1)`,
    )
    .returning()
  const row = rows[0]
  if (!row) return null
  return toJobTriggerRow(row)
}

export type FinalizeJobTriggerInput = {
  readonly id: number
  readonly status: 'done' | 'failed'
  readonly jobRunId?: number | null
  readonly errorMessage?: string | null
  readonly now?: Date
}

export const finalizeJobTrigger = async (
  db: DbOrTx,
  input: FinalizeJobTriggerInput,
): Promise<void> => {
  await db
    .update(jobTriggers)
    .set({
      status: input.status,
      finishedAt: input.now ?? new Date(),
      jobRunId: input.jobRunId ?? null,
      errorMessage: input.errorMessage ?? null,
    })
    .where(eq(jobTriggers.id, input.id))
}

// True iff there is a queued trigger for the given job, or a claimed
// trigger younger than staleThreshold. Used by manual-run server fns
// alongside hasUnfinishedJobRun() so a second click while the first is
// still waiting in the mailbox returns the same "busy" toast.
//
// The staleThreshold defends against a worker that crashed between
// claimNextJobTrigger and finalizeJobTrigger — without it, a stuck
// 'claimed' row would block all further "Run now" clicks for that job
// until someone manually fixed the row. We use the same 2h threshold the
// job_runs in-flight check uses, so the operator's mental model is
// consistent: anything older than 2h is presumed crashed.
export const hasPendingJobTrigger = async (
  db: DbOrTx,
  jobName: string,
  staleThreshold: Date,
): Promise<boolean> => {
  const cutoffSec = Math.floor(staleThreshold.getTime() / 1000)
  const [row] = await db
    .select({ id: jobTriggers.id })
    .from(jobTriggers)
    .where(
      and(
        eq(jobTriggers.jobName, jobName),
        sql`(
          ${jobTriggers.status} = 'queued'
          OR (${jobTriggers.status} = 'claimed' AND ${jobTriggers.claimedAt} > ${cutoffSec})
        )`,
      ),
    )
    .limit(1)
  return row !== undefined
}

const toJobTriggerRow = (row: typeof jobTriggers.$inferSelect): JobTriggerRow => ({
  id: row.id,
  jobName: row.jobName,
  requestedByUserId: row.requestedByUserId,
  status: row.status,
  requestedAt: row.requestedAt,
  claimedAt: row.claimedAt,
  finishedAt: row.finishedAt,
  jobRunId: row.jobRunId,
  errorMessage: row.errorMessage,
})
