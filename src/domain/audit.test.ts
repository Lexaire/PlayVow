import { describe, expect, it } from 'vitest'

import { type AuditEvent, parseAuditEvent, serializeAuditEvent } from '#/domain/audit'

describe('parseAuditEvent — win_created', () => {
  it('parses a scrape-source payload', () => {
    const r = parseAuditEvent('win_created', { source: 'scrape' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'win_created', source: 'scrape' })
  })

  it('rejects an unknown source', () => {
    const r = parseAuditEvent('win_created', { source: 'magic' })
    expect(r.ok).toBe(false)
  })
})

describe('parseAuditEvent — win_status_changed', () => {
  it('parses a valid status transition payload', () => {
    const r = parseAuditEvent('win_status_changed', { from: 'pending', to: 'played' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'win_status_changed', from: 'pending', to: 'played' })
  })

  it('rejects an unknown status value', () => {
    const r = parseAuditEvent('win_status_changed', { from: 'pending', to: 'banished' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('invalid_payload')
    if (r.error.kind !== 'invalid_payload') return
    expect(r.error.action).toBe('win_status_changed')
    expect(r.error.issues.length).toBeGreaterThan(0)
  })

  it('rejects a missing field', () => {
    const r = parseAuditEvent('win_status_changed', { from: 'pending' })
    expect(r.ok).toBe(false)
  })
})

describe('parseAuditEvent — win_notes_updated', () => {
  it('parses null before/after', () => {
    const r = parseAuditEvent('win_notes_updated', { before: null, after: 'gave a warning' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      kind: 'win_notes_updated',
      before: null,
      after: 'gave a warning',
    })
  })

  it('rejects non-string non-null fields', () => {
    const r = parseAuditEvent('win_notes_updated', { before: 7, after: null })
    expect(r.ok).toBe(false)
  })
})

describe('parseAuditEvent — group_created', () => {
  it('parses a complete group snapshot', () => {
    const r = parseAuditEvent('group_created', {
      slug: 'taleplay',
      name: 'TalePlay',
      playWindowDays: 90,
      description: null,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      kind: 'group_created',
      slug: 'taleplay',
      name: 'TalePlay',
      playWindowDays: 90,
      description: null,
    })
  })

  it('rejects a non-positive play window', () => {
    const r = parseAuditEvent('group_created', {
      slug: 'taleplay',
      name: 'TalePlay',
      playWindowDays: 0,
      description: null,
    })
    expect(r.ok).toBe(false)
  })
})

describe('parseAuditEvent — group_updated', () => {
  it('parses before/after group snapshots', () => {
    const before = {
      slug: 'taleplay',
      name: 'TalePlay',
      playWindowDays: 90,
      description: null,
    }
    const after = { ...before, playWindowDays: 60 }
    const r = parseAuditEvent('group_updated', { before, after })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'group_updated', before, after })
  })
})

describe('parseAuditEvent — unknown action', () => {
  it('reports unknown_action for actions outside the enum', () => {
    const r = parseAuditEvent('something_made_up', {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toEqual({ kind: 'unknown_action', action: 'something_made_up' })
  })
})

describe('serializeAuditEvent', () => {
  it('round-trips win_created', () => {
    const event: AuditEvent = { kind: 'win_created', source: 'scrape' }
    const { action, payload } = serializeAuditEvent(event)
    expect(action).toBe('win_created')
    const reparsed = parseAuditEvent(action, payload)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.value).toEqual(event)
  })

  it('round-trips win_status_changed', () => {
    const event: AuditEvent = { kind: 'win_status_changed', from: 'pending', to: 'kicked' }
    const { action, payload } = serializeAuditEvent(event)
    expect(action).toBe('win_status_changed')
    const reparsed = parseAuditEvent(action, payload)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.value).toEqual(event)
  })

  it('round-trips win_notes_updated with nulls', () => {
    const event: AuditEvent = { kind: 'win_notes_updated', before: null, after: null }
    const { action, payload } = serializeAuditEvent(event)
    const reparsed = parseAuditEvent(action, payload)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.value).toEqual(event)
  })

  it('round-trips group_created', () => {
    const event: AuditEvent = {
      kind: 'group_created',
      slug: 'pa',
      name: 'Playing Appreciated',
      playWindowDays: 30,
      description: 'short window',
    }
    const { action, payload } = serializeAuditEvent(event)
    expect(action).toBe('group_created')
    const reparsed = parseAuditEvent(action, payload)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.value).toEqual(event)
  })

  it('round-trips group_updated', () => {
    const before = {
      slug: 'taleplay',
      name: 'TalePlay',
      playWindowDays: 90,
      description: null,
    }
    const event: AuditEvent = {
      kind: 'group_updated',
      before,
      after: { ...before, name: 'TalePlay (renamed)' },
    }
    const { action, payload } = serializeAuditEvent(event)
    const reparsed = parseAuditEvent(action, payload)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.value).toEqual(event)
  })

  it('round-trips role_granted with reason', () => {
    const event: AuditEvent = {
      kind: 'role_granted',
      before: 'user',
      after: 'moderator',
      reason: 'promoted by admin',
    }
    const { action, payload } = serializeAuditEvent(event)
    expect(action).toBe('role_granted')
    const reparsed = parseAuditEvent(action, payload)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.value).toEqual(event)
  })

  it('round-trips role_revoked without reason', () => {
    const event: AuditEvent = {
      kind: 'role_revoked',
      before: 'admin',
      after: 'moderator',
    }
    const { action, payload } = serializeAuditEvent(event)
    expect(action).toBe('role_revoked')
    const reparsed = parseAuditEvent(action, payload)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.value).toEqual(event)
  })

  it('rejects role_granted with invalid role', () => {
    const r = parseAuditEvent('role_granted', { before: 'user', after: 'tsar' })
    expect(r.ok).toBe(false)
  })
})
