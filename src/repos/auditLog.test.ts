import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { createTestDb } from '#/repos/__test__/db'
import { listAuditEntriesForTarget, writeAuditEvent } from '#/repos/auditLog'

describe('auditLogRepo', () => {
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

  it('writes a typed event and reads it back parsed', async () => {
    await writeAuditEvent(db, {
      event: { kind: 'win_status_changed', from: 'pending', to: 'played' },
      targetType: 'win',
      targetId: 42,
    })
    const entries = await listAuditEntriesForTarget(db, 'win', 42, 10)
    expect(entries).toHaveLength(1)
    const first = entries[0]
    expect(first?.ok).toBe(true)
    if (!first?.ok) return
    expect(first.value.event).toEqual({
      kind: 'win_status_changed',
      from: 'pending',
      to: 'played',
    })
    expect(first.value.targetId).toBe(42)
  })

  it('orders entries newest-first (with id as tiebreaker)', async () => {
    await writeAuditEvent(db, {
      event: { kind: 'win_created', source: 'scrape' },
      targetType: 'win',
      targetId: 7,
    })
    await writeAuditEvent(db, {
      event: { kind: 'win_status_changed', from: 'pending', to: 'kicked' },
      targetType: 'win',
      targetId: 7,
    })
    const entries = await listAuditEntriesForTarget(db, 'win', 7, 10)
    expect(entries).toHaveLength(2)
    const [first, second] = entries
    if (!first?.ok || !second?.ok) throw new Error('parse failed')
    expect(first.value.event.kind).toBe('win_status_changed')
    expect(second.value.event.kind).toBe('win_created')
  })

  it('filters by target', async () => {
    await writeAuditEvent(db, {
      event: { kind: 'win_created', source: 'scrape' },
      targetType: 'win',
      targetId: 1,
    })
    await writeAuditEvent(db, {
      event: { kind: 'win_created', source: 'scrape' },
      targetType: 'win',
      targetId: 2,
    })
    const entries = await listAuditEntriesForTarget(db, 'win', 1, 10)
    expect(entries).toHaveLength(1)
  })
})
