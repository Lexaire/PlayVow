import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import type { SteamGiftsUsername, SteamId } from '#/db/schema'
import { createTestDb } from '#/repos/__test__/db'
import {
  findUserBySteamId,
  findUserBySteamgiftsUsername,
  setUserRole,
  upsertUserBySgUsername,
  upsertUserBySteamId,
} from '#/repos/users'

const STEAM_A = '76561198000000010' as SteamId
const STEAM_B = '76561197960435531' as SteamId
const ROBIN = 'robin' as SteamGiftsUsername
const SPARROW = 'sparrow' as SteamGiftsUsername
const GHOST = 'ghost' as SteamGiftsUsername

describe('usersRepo', () => {
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

  it('upsertUserBySgUsername inserts a new row keyed by SG username', async () => {
    const user = await upsertUserBySgUsername(db, {
      steamgiftsUsername: ROBIN,
      steamId: STEAM_A,
      avatarUrl: 'https://example.com/a.jpg',
      profileVisibility: 3,
    })
    expect(user.steamgiftsUsername).toBe(ROBIN)
    expect(user.steamId).toBe(STEAM_A)
    expect(user.profileVisibility).toBe(3)
  })

  it('preserves existing fields when caller supplies null', async () => {
    await upsertUserBySgUsername(db, {
      steamgiftsUsername: ROBIN,
      steamId: STEAM_A,
      avatarUrl: 'first.jpg',
      profileVisibility: 3,
    })
    const updated = await upsertUserBySgUsername(db, {
      steamgiftsUsername: ROBIN,
      avatarUrl: 'second.jpg',
    })
    expect(updated.steamId).toBe(STEAM_A)
    expect(updated.avatarUrl).toBe('second.jpg')
    expect(updated.profileVisibility).toBe(3)
  })

  it('can insert a user with no steamId yet, then fill it in later', async () => {
    const initial = await upsertUserBySgUsername(db, { steamgiftsUsername: ROBIN })
    expect(initial.steamId).toBeNull()

    const filled = await upsertUserBySgUsername(db, {
      steamgiftsUsername: ROBIN,
      steamId: STEAM_A,
    })
    expect(filled.id).toBe(initial.id)
    expect(filled.steamId).toBe(STEAM_A)
  })

  it('findUserBySteamId / findUserBySteamgiftsUsername round-trip', async () => {
    await upsertUserBySgUsername(db, {
      steamgiftsUsername: ROBIN,
      steamId: STEAM_A,
    })
    const byId = await findUserBySteamId(db, STEAM_A)
    const byName = await findUserBySteamgiftsUsername(db, ROBIN)
    expect(byId?.steamId).toBe(STEAM_A)
    expect(byName?.steamId).toBe(STEAM_A)
    expect(byId?.id).toBe(byName?.id)
  })

  it('returns null for unknown lookups', async () => {
    expect(await findUserBySteamId(db, '123' as SteamId)).toBeNull()
    expect(await findUserBySteamgiftsUsername(db, GHOST)).toBeNull()
  })

  it('upsertUserBySteamId inserts Steam-only users with null sg username', async () => {
    const user = await upsertUserBySteamId(db, { steamId: STEAM_A })
    expect(user.steamId).toBe(STEAM_A)
    expect(user.steamgiftsUsername).toBeNull()
    expect(user.role).toBe('user')
  })

  it('upsertUserBySteamId returns existing row on second call (no duplicate)', async () => {
    const a = await upsertUserBySteamId(db, { steamId: STEAM_A })
    const b = await upsertUserBySteamId(db, { steamId: STEAM_A, avatarUrl: 'avatar.jpg' })
    expect(b.id).toBe(a.id)
    expect(b.avatarUrl).toBe('avatar.jpg')
  })

  it('SG-scrape merges into a pre-existing Steam-only row when steamId matches', async () => {
    const steamOnly = await upsertUserBySteamId(db, { steamId: STEAM_A })
    expect(steamOnly.steamgiftsUsername).toBeNull()

    const merged = await upsertUserBySgUsername(db, {
      steamgiftsUsername: ROBIN,
      steamId: STEAM_A,
      avatarUrl: 'sg-avatar.jpg',
    })
    expect(merged.id).toBe(steamOnly.id)
    expect(merged.steamgiftsUsername).toBe(ROBIN)
    expect(merged.avatarUrl).toBe('sg-avatar.jpg')

    // No duplicate created.
    const all = await db.select().from(await import('#/db/schema').then((m) => m.users))
    expect(all.length).toBe(1)
  })

  it('SG-scrape without steamId still creates a fresh SG row when no Steam row exists', async () => {
    const u = await upsertUserBySgUsername(db, { steamgiftsUsername: SPARROW })
    expect(u.steamgiftsUsername).toBe(SPARROW)
    expect(u.steamId).toBeNull()
  })

  it('setUserRole grants role and writes role_granted audit', async () => {
    const target = await upsertUserBySteamId(db, { steamId: STEAM_A })
    const actor = await upsertUserBySteamId(db, { steamId: STEAM_B })

    const r = await setUserRole(db, {
      userId: target.id,
      newRole: 'admin',
      actorUserId: actor.id,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ before: 'user', after: 'admin' })

    const refreshed = await findUserBySteamId(db, STEAM_A)
    expect(refreshed?.role).toBe('admin')

    const { listAuditEntriesForTarget } = await import('#/repos/auditLog')
    const audit = await listAuditEntriesForTarget(db, 'user', target.id, 10)
    expect(audit.length).toBe(1)
    expect(audit[0]?.ok).toBe(true)
    if (!audit[0]?.ok) return
    expect(audit[0].value.event.kind).toBe('role_granted')
    expect(audit[0].value.actor?.id).toBe(actor.id)
  })

  it('setUserRole revoking emits role_revoked', async () => {
    const target = await upsertUserBySteamId(db, { steamId: STEAM_A })
    const actor = await upsertUserBySteamId(db, { steamId: STEAM_B })
    await setUserRole(db, { userId: target.id, newRole: 'admin', actorUserId: actor.id })
    const r = await setUserRole(db, {
      userId: target.id,
      newRole: 'user',
      actorUserId: actor.id,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ before: 'admin', after: 'user' })

    const { listAuditEntriesForTarget } = await import('#/repos/auditLog')
    const audit = await listAuditEntriesForTarget(db, 'user', target.id, 10)
    const kinds = audit.map((e) => (e.ok ? e.value.event.kind : null))
    expect(kinds).toEqual(['role_revoked', 'role_granted'])
  })

  it('setUserRole no-ops when role is already the target', async () => {
    const target = await upsertUserBySteamId(db, { steamId: STEAM_A })
    const r = await setUserRole(db, {
      userId: target.id,
      newRole: 'user',
      actorUserId: target.id,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('no_op')
  })
})
