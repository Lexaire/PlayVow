import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { groups } from '#/db/schema'
import type { SteamGiftsGroupCode, SteamGroupId, SteamId } from '#/db/schema'
import { createTestDb } from '#/repos/__test__/db'
import { listAuditEntriesForTarget } from '#/repos/auditLog'
import {
  clearCookie,
  findGroupCookieStatus,
  getDecryptedCookie,
  listGroupCookieStatuses,
  recordScrapeOutcome,
  recordTestResult,
  setCookie,
} from '#/repos/groupSecrets'
import { upsertUserBySteamId } from '#/repos/users'

const seedGroup = async (db: Db, slug = 'taleplay'): Promise<number> => {
  const [row] = await db
    .insert(groups)
    .values({
      slug,
      name: slug,
      playWindowDays: 90,
      steamgiftsGroupCode: 'xBp7E' as SteamGiftsGroupCode,
      steamGroupId: '1' as SteamGroupId,
      steamGroupSlug: slug,
      description: null,
    })
    .returning({ id: groups.id })
  if (!row) throw new Error('seed: no group')
  return row.id
}

const seedAdmin = async (db: Db, suffix = '0'): Promise<number> => {
  const u = await upsertUserBySteamId(db, {
    steamId: `76561197960000${suffix.padStart(3, '0')}` as SteamId,
  })
  return u.id
}

describe('groupSecrets', () => {
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

  it('list returns one row per group with isSet=false when nothing is stored', async () => {
    await seedGroup(db, 'a')
    await seedGroup(db, 'b')
    const rows = await listGroupCookieStatuses(db)
    expect(rows.map((r) => r.groupSlug)).toEqual(['a', 'b'])
    expect(rows.every((r) => r.isSet === false)).toBe(true)
    expect(rows.every((r) => r.updatedBy === null)).toBe(true)
  })

  it('setCookie stores an encrypted value and emits cookie_set audit', async () => {
    const groupId = await seedGroup(db)
    const adminId = await seedAdmin(db)
    await setCookie(db, { groupId, plaintext: 'PHPSESSID=secret', actorUserId: adminId })

    const status = await findGroupCookieStatus(db, groupId)
    expect(status?.isSet).toBe(true)
    expect(status?.updatedBy?.id).toBe(adminId)
    expect(status?.updatedAt).toBeInstanceOf(Date)

    const audit = await listAuditEntriesForTarget(db, 'group', groupId, 10)
    expect(audit.length).toBe(1)
    expect(audit[0]?.ok).toBe(true)
    if (!audit[0]?.ok) return
    expect(audit[0].value.event.kind).toBe('cookie_set')
  })

  it('audit payload for cookie_set is empty (no cookie material)', async () => {
    const groupId = await seedGroup(db)
    const adminId = await seedAdmin(db)
    const SECRET = 'PHPSESSID=this-must-not-leak-into-audit-payload'
    await setCookie(db, { groupId, plaintext: SECRET, actorUserId: adminId })

    const audit = await listAuditEntriesForTarget(db, 'group', groupId, 10)
    expect(audit[0]?.ok).toBe(true)
    if (!audit[0]?.ok) return
    expect(JSON.stringify(audit[0].value.event)).not.toContain('this-must-not-leak')
    expect(JSON.stringify(audit[0].value.event)).not.toContain(SECRET)
  })

  it('getDecryptedCookie round-trips the plaintext for the worker', async () => {
    const groupId = await seedGroup(db)
    const adminId = await seedAdmin(db)
    const PLAIN = 'PHPSESSID=abc123; cf_clearance=zz'
    await setCookie(db, { groupId, plaintext: PLAIN, actorUserId: adminId })

    const r = await getDecryptedCookie(db, groupId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe(PLAIN)
  })

  it('getDecryptedCookie returns not_set when no row exists', async () => {
    const groupId = await seedGroup(db)
    const r = await getDecryptedCookie(db, groupId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('not_set')
  })

  it('clearCookie nulls the secret and emits cookie_cleared audit', async () => {
    const groupId = await seedGroup(db)
    const adminId = await seedAdmin(db)
    await setCookie(db, { groupId, plaintext: 'x', actorUserId: adminId })
    await clearCookie(db, { groupId, actorUserId: adminId })

    const status = await findGroupCookieStatus(db, groupId)
    expect(status?.isSet).toBe(false)
    const audit = await listAuditEntriesForTarget(db, 'group', groupId, 10)
    const kinds = audit.map((e) => (e.ok ? e.value.event.kind : null))
    expect(kinds).toEqual(['cookie_cleared', 'cookie_set'])
  })

  it('setCookie a second time overwrites the previous ciphertext', async () => {
    const groupId = await seedGroup(db)
    const adminId = await seedAdmin(db)
    await setCookie(db, { groupId, plaintext: 'first', actorUserId: adminId })
    await setCookie(db, { groupId, plaintext: 'second', actorUserId: adminId })
    const r = await getDecryptedCookie(db, groupId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe('second')
  })

  it('recordTestResult updates last_tested + writes cookie_tested audit', async () => {
    const groupId = await seedGroup(db)
    const adminId = await seedAdmin(db)
    await setCookie(db, { groupId, plaintext: 'x', actorUserId: adminId })
    await recordTestResult(db, { groupId, result: 'login_required', actorUserId: adminId })

    const status = await findGroupCookieStatus(db, groupId)
    expect(status?.lastTestResult).toBe('login_required')
    expect(status?.lastTestedAt).toBeInstanceOf(Date)
    expect(status?.lastSuccessAt).toBeNull()

    const audit = await listAuditEntriesForTarget(db, 'group', groupId, 10)
    const tested = audit.find((e) => e.ok && e.value.event.kind === 'cookie_tested')
    expect(tested?.ok).toBe(true)
    if (!tested?.ok || tested.value.event.kind !== 'cookie_tested') return
    expect(tested.value.event.result).toBe('login_required')
  })

  it('recordTestResult ok also updates last_success_at', async () => {
    const groupId = await seedGroup(db)
    const adminId = await seedAdmin(db)
    await setCookie(db, { groupId, plaintext: 'x', actorUserId: adminId })
    await recordTestResult(db, { groupId, result: 'ok', actorUserId: adminId })
    const status = await findGroupCookieStatus(db, groupId)
    expect(status?.lastSuccessAt).toBeInstanceOf(Date)
  })

  it('recordScrapeOutcome updates status without writing audit (worker hot path)', async () => {
    const groupId = await seedGroup(db)
    const adminId = await seedAdmin(db)
    await setCookie(db, { groupId, plaintext: 'x', actorUserId: adminId })
    await recordScrapeOutcome(db, { groupId, result: 'login_required' })

    const status = await findGroupCookieStatus(db, groupId)
    expect(status?.lastTestResult).toBe('login_required')
    const audit = await listAuditEntriesForTarget(db, 'group', groupId, 10)
    const kinds = audit.map((e) => (e.ok ? e.value.event.kind : null))
    expect(kinds).toEqual(['cookie_set'])
  })
})
