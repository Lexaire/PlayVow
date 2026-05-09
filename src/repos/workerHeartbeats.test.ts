import { describe, expect, it } from 'vitest'

import { workerHeartbeats } from '#/db/schema'
import { createTestDb } from '#/repos/__test__/db'
import { getLatestHeartbeat, recordHeartbeat } from '#/repos/workerHeartbeats'

describe('workerHeartbeats', () => {
  it('returns null when no row exists', async () => {
    const tdb = await createTestDb()
    try {
      expect(await getLatestHeartbeat(tdb.db)).toBeNull()
    } finally {
      tdb.close()
    }
  })

  it('inserts a row on first call', async () => {
    const tdb = await createTestDb()
    try {
      const startedAt = new Date('2026-05-02T10:00:00Z')
      const lastSeenAt = new Date('2026-05-02T10:00:00Z')
      await recordHeartbeat(tdb.db, { startedAt, lastSeenAt, pid: 1234 })

      const row = await getLatestHeartbeat(tdb.db)
      expect(row).not.toBeNull()
      expect(row?.startedAt.getTime()).toBe(startedAt.getTime())
      expect(row?.lastSeenAt.getTime()).toBe(lastSeenAt.getTime())
      expect(row?.pid).toBe(1234)
    } finally {
      tdb.close()
    }
  })

  it('upserts on subsequent calls — last_seen_at advances, single row remains', async () => {
    const tdb = await createTestDb()
    try {
      const startedAt = new Date('2026-05-02T10:00:00Z')
      await recordHeartbeat(tdb.db, {
        startedAt,
        lastSeenAt: new Date('2026-05-02T10:00:00Z'),
        pid: 1234,
      })
      await recordHeartbeat(tdb.db, {
        startedAt,
        lastSeenAt: new Date('2026-05-02T10:05:00Z'),
        pid: 1234,
      })

      const all = await tdb.db.select().from(workerHeartbeats)
      expect(all).toHaveLength(1)
      expect(all[0]?.lastSeenAt.getTime()).toBe(new Date('2026-05-02T10:05:00Z').getTime())
      expect(all[0]?.startedAt.getTime()).toBe(startedAt.getTime())
    } finally {
      tdb.close()
    }
  })

  it('replaces startedAt and pid when the worker restarts', async () => {
    const tdb = await createTestDb()
    try {
      await recordHeartbeat(tdb.db, {
        startedAt: new Date('2026-05-02T10:00:00Z'),
        lastSeenAt: new Date('2026-05-02T10:00:00Z'),
        pid: 1234,
      })
      // Simulate a worker restart with a new pid + new startedAt.
      await recordHeartbeat(tdb.db, {
        startedAt: new Date('2026-05-02T11:00:00Z'),
        lastSeenAt: new Date('2026-05-02T11:00:00Z'),
        pid: 5678,
      })

      const row = await getLatestHeartbeat(tdb.db)
      expect(row?.pid).toBe(5678)
      expect(row?.startedAt.getTime()).toBe(new Date('2026-05-02T11:00:00Z').getTime())
    } finally {
      tdb.close()
    }
  })
})
