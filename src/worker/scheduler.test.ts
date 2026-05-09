import { desc } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { jobRuns } from '#/db/schema'
import type { AnalyticsEvent } from '#/lib/analytics'
import { createCountingFetcher } from '#/lib/counting-fetcher'
import { createLogger } from '#/lib/logger'
import { createTestDb } from '#/repos/__test__/db'
import { runJob } from '#/worker/scheduler'

const collectLogs = (): {
  readonly lines: ReadonlyArray<Record<string, unknown>>
  readonly write: (line: string) => void
} => {
  const lines: Record<string, unknown>[] = []
  return {
    lines,
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  }
}

describe('runJob', () => {
  it('emits job_started and job_completed for a successful run', async () => {
    const sink = collectLogs()
    const logger = createLogger({ write: sink.write })
    let invoked = 0
    await runJob(
      {
        name: 'scrape',
        cron: '0 0 * * *',
        run: async () => {
          invoked += 1
        },
      },
      { logger },
    )
    expect(invoked).toBe(1)
    const messages = sink.lines.map((l) => l['msg'])
    expect(messages).toEqual(['job_started', 'job_completed'])
    expect(sink.lines[0]?.['job']).toBe('scrape')
    expect(sink.lines[1]?.['durationMs']).toBeTypeOf('number')
  })

  it('catches a thrown error and emits job_failed', async () => {
    const sink = collectLogs()
    const logger = createLogger({ write: sink.write })
    await runJob(
      {
        name: 'poll',
        cron: '0 * * * *',
        run: () => {
          throw new Error('boom')
        },
      },
      { logger },
    )
    const messages = sink.lines.map((l) => l['msg'])
    expect(messages).toEqual(['job_started', 'job_failed'])
    expect(sink.lines[1]?.['error']).toBe('boom')
    expect(sink.lines[1]?.['level']).toBe('error')
  })

  it('captures per-job API call deltas and emits a worker_job_completed analytics event', async () => {
    const sink = collectLogs()
    const logger = createLogger({ write: sink.write })
    const captured: AnalyticsEvent[] = []
    const analytics = {
      capture: (e: AnalyticsEvent) => captured.push(e),
      shutdown: () => Promise.resolve(),
    }
    const steam = createCountingFetcher(() => Promise.resolve(new Response('')))
    const sg = createCountingFetcher(() => Promise.resolve(new Response('')))

    // Pre-existing calls before this job started — should NOT count toward
    // the job's delta.
    await steam('https://steam.test/preheat')
    await sg('https://sg.test/preheat')

    await runJob(
      {
        name: 'poll_playtime',
        cron: '0 */4 * * *',
        run: async () => {
          await steam('https://steam.test/a')
          await steam('https://steam.test/b')
          await steam('https://steam.test/c')
          await sg('https://sg.test/a')
        },
      },
      { logger, analytics, counters: { steam, sg } },
    )

    const completed = sink.lines[1]
    expect(completed?.['msg']).toBe('job_completed')
    expect(completed?.['steamCalls']).toBe(3)
    expect(completed?.['sgCalls']).toBe(1)

    expect(captured).toHaveLength(1)
    const event = captured[0]
    expect(event?.name).toBe('worker_job_completed')
    expect(event?.distinctId).toBe('worker')
    expect(event?.properties?.['job']).toBe('poll_playtime')
    expect(event?.properties?.['steamCalls']).toBe(3)
    expect(event?.properties?.['sgCalls']).toBe(1)
  })

  it('emits worker_job_failed with the error and call deltas when the job throws', async () => {
    const sink = collectLogs()
    const logger = createLogger({ write: sink.write })
    const captured: AnalyticsEvent[] = []
    const analytics = {
      capture: (e: AnalyticsEvent) => captured.push(e),
      shutdown: () => Promise.resolve(),
    }
    const steam = createCountingFetcher(() => Promise.resolve(new Response('')))
    const sg = createCountingFetcher(() => Promise.resolve(new Response('')))

    await runJob(
      {
        name: 'scrape_groups',
        cron: '0 4 * * *',
        run: async () => {
          await sg('https://sg.test/list')
          throw new Error('rate limited')
        },
      },
      { logger, analytics, counters: { steam, sg } },
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]?.name).toBe('worker_job_failed')
    expect(captured[0]?.properties?.['error']).toBe('rate limited')
    expect(captured[0]?.properties?.['sgCalls']).toBe(1)
    expect(captured[0]?.properties?.['steamCalls']).toBe(0)
  })

  it('persists a succeeded job_runs row with summary, duration, and api-call counts', async () => {
    const sink = collectLogs()
    const logger = createLogger({ write: sink.write })
    const tdb = await createTestDb()
    try {
      const steam = createCountingFetcher(() => Promise.resolve(new Response('')))
      const sg = createCountingFetcher(() => Promise.resolve(new Response('')))

      await runJob(
        {
          name: 'poll_playtime',
          cron: '0 * * * *',
          run: async () => {
            await steam('https://steam.test/a')
            await steam('https://steam.test/b')
            await sg('https://sg.test/a')
            return { winsExamined: 7, errors: 0 }
          },
        },
        { logger, dbWrite: tdb.db, counters: { steam, sg } },
      )

      const rows = await tdb.db.select().from(jobRuns).orderBy(desc(jobRuns.id))
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row?.jobName).toBe('poll_playtime')
      expect(row?.status).toBe('succeeded')
      expect(row?.startedAt).toBeInstanceOf(Date)
      expect(row?.finishedAt).toBeInstanceOf(Date)
      expect(row?.durationMs).toBeTypeOf('number')
      expect(row?.steamCalls).toBe(2)
      expect(row?.sgCalls).toBe(1)
      expect(row?.errorMessage).toBeNull()
      expect(row?.summary).toEqual({ winsExamined: 7, errors: 0 })
    } finally {
      tdb.close()
    }
  })

  it('persists a failed job_runs row with error_message when the job throws', async () => {
    const sink = collectLogs()
    const logger = createLogger({ write: sink.write })
    const tdb = await createTestDb()
    try {
      await runJob(
        {
          name: 'scrape_groups',
          cron: '30 4 * * *',
          run: () => Promise.reject(new Error('rate limited')),
        },
        { logger, dbWrite: tdb.db },
      )

      const rows = await tdb.db.select().from(jobRuns)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe('failed')
      expect(rows[0]?.errorMessage).toBe('rate limited')
      expect(rows[0]?.finishedAt).toBeInstanceOf(Date)
      expect(rows[0]?.summary).toBeNull()
    } finally {
      tdb.close()
    }
  })

  it('reports duration based on the supplied clock', async () => {
    const sink = collectLogs()
    const logger = createLogger({ write: sink.write })
    let t = 1_000
    const now = (): Date => new Date(t)
    await runJob(
      {
        name: 'timed',
        cron: '* * * * *',
        run: async () => {
          t = 1_750
        },
      },
      { logger, now },
    )
    expect(sink.lines[1]?.['durationMs']).toBe(750)
  })
})
