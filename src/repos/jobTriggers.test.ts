import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { createTestDb } from '#/repos/__test__/db'
import {
  claimNextJobTrigger,
  enqueueJobTrigger,
  finalizeJobTrigger,
  hasPendingJobTrigger,
} from '#/repos/jobTriggers'

describe('jobTriggersRepo', () => {
  let db: Db
  let close: () => void
  beforeEach(async () => {
    const t = await createTestDb()
    db = t.db
    close = t.close
  })
  afterEach(() => {
    close()
  })

  it('claims queued triggers in FIFO order and returns null when empty', async () => {
    const id1 = await enqueueJobTrigger(db, { jobName: 'scrape_groups', requestedByUserId: null })
    const id2 = await enqueueJobTrigger(db, { jobName: 'poll_playtime', requestedByUserId: null })

    const first = await claimNextJobTrigger(db)
    expect(first?.id).toBe(id1)
    expect(first?.status).toBe('claimed')
    expect(first?.claimedAt).toBeInstanceOf(Date)

    const second = await claimNextJobTrigger(db)
    expect(second?.id).toBe(id2)

    const third = await claimNextJobTrigger(db)
    expect(third).toBeNull()
  })

  it('does not re-claim a row that is already claimed', async () => {
    await enqueueJobTrigger(db, { jobName: 'scrape_groups', requestedByUserId: null })
    const claimed = await claimNextJobTrigger(db)
    expect(claimed).not.toBeNull()
    const next = await claimNextJobTrigger(db)
    expect(next).toBeNull()
  })

  it('finalizes a claimed trigger to done', async () => {
    const id = await enqueueJobTrigger(db, { jobName: 'scrape_groups', requestedByUserId: null })
    await claimNextJobTrigger(db)
    // jobRunId is deliberately left null so we don't have to seed a job_runs
    // row in the test — finalizeJobTrigger's FK accepts null.
    await finalizeJobTrigger(db, { id, status: 'done' })

    expect(await hasPendingJobTrigger(db, 'scrape_groups', recentCutoff())).toBe(false)
  })

  it('hasPendingJobTrigger reports true while queued or claimed and false after done/failed', async () => {
    await enqueueJobTrigger(db, { jobName: 'poll_playtime', requestedByUserId: null })
    expect(await hasPendingJobTrigger(db, 'poll_playtime', recentCutoff())).toBe(true)

    const claimed = await claimNextJobTrigger(db)
    expect(claimed).not.toBeNull()
    expect(await hasPendingJobTrigger(db, 'poll_playtime', recentCutoff())).toBe(true)

    if (!claimed) throw new Error('unreachable')
    await finalizeJobTrigger(db, { id: claimed.id, status: 'done' })
    expect(await hasPendingJobTrigger(db, 'poll_playtime', recentCutoff())).toBe(false)

    // A separate job's pending trigger doesn't satisfy the predicate.
    await enqueueJobTrigger(db, { jobName: 'scrape_groups', requestedByUserId: null })
    expect(await hasPendingJobTrigger(db, 'poll_playtime', recentCutoff())).toBe(false)
    expect(await hasPendingJobTrigger(db, 'scrape_groups', recentCutoff())).toBe(true)
  })

  it('treats a claimed trigger older than the stale threshold as not-pending', async () => {
    // Simulate a worker that crashed mid-run: the row is 'claimed' but its
    // claimed_at is way in the past. The busy guard must not lock forever.
    await enqueueJobTrigger(db, { jobName: 'scrape_groups', requestedByUserId: null })
    const claimed = await claimNextJobTrigger(db)
    if (!claimed) throw new Error('unreachable')

    // Backdate claimed_at to 3h ago — older than any reasonable stale threshold.
    const threeHoursAgoSec = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000)
    db.$client.execute({
      sql: `UPDATE job_triggers SET claimed_at = ? WHERE id = ?`,
      args: [threeHoursAgoSec, claimed.id],
    })

    const cutoffOneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    expect(await hasPendingJobTrigger(db, 'scrape_groups', cutoffOneHourAgo)).toBe(false)
  })
})

const recentCutoff = (): Date => new Date(Date.now() - 60 * 60 * 1000)
