import { and, asc, eq, isNull } from 'drizzle-orm'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { db } from '#/db/client'
import { JOB_RUN_STATUSES, giveaways, wins } from '#/db/schema'
import type { JobRunStatus } from '#/db/schema'
import type { JobRunRow } from '#/repos/jobRuns'
import { findLatestJobRunPerName, listJobRuns } from '#/repos/jobRuns'
import type { Group } from '#/repos/groups'
import { listGroups } from '#/repos/groups'
import type { WorkerHeartbeatRow } from '#/repos/workerHeartbeats'
import { getLatestHeartbeat } from '#/repos/workerHeartbeats'
import { requireAdmin } from '#/server/auth'
import type { JobCatalogueEntry } from '#/worker/job-catalogue'
import { JOB_CATALOGUE } from '#/worker/job-catalogue'

const DEFAULT_PAGE_SIZE = 50

export type AdminJobLatest = {
  readonly catalogue: JobCatalogueEntry
  readonly latest: JobRunRow | null
}

// Compact pending-win row for the "Poll one win" dropdown. Limited to the
// 25 oldest pending wins (lastCheckedAt asc, NULLS first) — the operator
// almost always wants to nudge the most-stale entry, and an unbounded list
// would be unusable on groups with thousands of pending wins.
export type PendingWinOption = {
  readonly winId: number
  readonly giveawayCode: string | null
  readonly groupSlug: string
  readonly steamAppId: number | null
  readonly lastCheckedAt: Date | null
}

export type AdminJobsPage = {
  readonly heartbeat: WorkerHeartbeatRow | null
  readonly latest: ReadonlyArray<AdminJobLatest>
  readonly history: ReadonlyArray<JobRunRow>
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly filter: {
    readonly jobName: string | null
    readonly status: JobRunStatus | null
  }
  readonly groups: ReadonlyArray<Group>
  readonly pendingWins: ReadonlyArray<PendingWinOption>
}

const PENDING_WIN_OPTION_LIMIT = 25

const ListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
  jobName: z.string().min(1).max(64).optional(),
  status: z.enum(JOB_RUN_STATUSES).optional(),
})

export const listJobRunsForAdmin = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: { page?: number; pageSize?: number; jobName?: string; status?: JobRunStatus }) =>
      ListSchema.parse(input),
  )
  .handler(async ({ data }): Promise<AdminJobsPage> => {
    await requireAdmin()
    const dbR = db()

    const [latestRuns, history, heartbeat, groups, pendingWinRows] = await Promise.all([
      findLatestJobRunPerName(dbR),
      listJobRuns(dbR, {
        page: data.page,
        pageSize: data.pageSize,
        ...(data.jobName ? { jobName: data.jobName } : {}),
        ...(data.status ? { status: data.status } : {}),
      }),
      getLatestHeartbeat(dbR),
      listGroups(dbR),
      // Pending wins joined to giveaways/groups for the manual-poll dropdown.
      // 25 oldest by lastCheckedAt — the operator wants to poke the entries
      // that haven't been touched in a while.
      dbR
        .select({
          winId: wins.id,
          giveawayCode: giveaways.steamgiftsCode,
          groupId: giveaways.groupId,
          steamAppId: giveaways.steamAppId,
          lastCheckedAt: wins.lastCheckedAt,
        })
        .from(wins)
        .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
        .where(and(eq(wins.status, 'pending'), isNull(giveaways.deletedAt)))
        .orderBy(asc(wins.lastCheckedAt))
        .limit(PENDING_WIN_OPTION_LIMIT),
    ])

    const latestByName = new Map(latestRuns.map((r) => [r.jobName, r]))
    const latest: ReadonlyArray<AdminJobLatest> = JOB_CATALOGUE.map((c) => ({
      catalogue: c,
      latest: latestByName.get(c.name) ?? null,
    }))

    const groupsById = new Map(groups.map((g) => [g.id, g]))
    const pendingWins: ReadonlyArray<PendingWinOption> = pendingWinRows.map((r) => ({
      winId: r.winId,
      giveawayCode: r.giveawayCode,
      groupSlug: groupsById.get(r.groupId)?.slug ?? `group#${String(r.groupId)}`,
      steamAppId: r.steamAppId,
      lastCheckedAt: r.lastCheckedAt,
    }))

    return {
      heartbeat,
      latest,
      history: history.rows,
      total: history.total,
      page: history.page,
      pageSize: history.pageSize,
      filter: {
        jobName: data.jobName ?? null,
        status: data.status ?? null,
      },
      groups,
      pendingWins,
    }
  })
