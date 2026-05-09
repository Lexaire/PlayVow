import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { groups, steamGroupMemberships } from '#/db/schema'
import type { SteamGroupId, SteamGiftsGroupCode, SteamId } from '#/db/schema'
import {
  applyMembershipDiff,
  findOpenMembershipsByGroup,
  reopenMembership,
  setMembershipSticky,
} from '#/repos/groupMemberships'
import { createTestDb } from '#/repos/__test__/db'

const GID = '103582791400000001' as SteamGroupId
const CODE = 'test1' as SteamGiftsGroupCode
const STEAM_A = '76561198000000001' as SteamId
const STEAM_B = '76561198000000002' as SteamId
const STEAM_C = '76561198000000003' as SteamId

const seedGroup = async (db: Db): Promise<number> => {
  await db.insert(groups).values({
    slug: 'test-group',
    name: 'Test Group',
    playWindowDays: 90,
    steamgiftsGroupCode: CODE,
    steamGroupId: GID,
    steamGroupSlug: 'testgroup',
  })
  const [row] = await db.select({ id: groups.id }).from(groups).limit(1)
  if (!row) throw new Error('seed failed')
  return row.id
}

describe('groupMemberships', () => {
  let db: Db
  let close: () => void
  let groupId: number

  beforeEach(async () => {
    const t = await createTestDb()
    db = t.db
    close = t.close
    groupId = await seedGroup(db)
  })
  afterEach(() => close())

  it('inserts new members on first diff (no existing rows)', async () => {
    const ranAt = new Date('2026-01-01T00:00:00Z')
    const result = await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A, STEAM_B]),
      ranAt,
    })
    expect(result).toEqual({ joined: 2, stillPresent: 0, left: 0, stickyUntouched: 0 })

    const open = await findOpenMembershipsByGroup(db, groupId)
    expect(open.length).toBe(2)
    expect(open.map((m) => m.steamId).sort()).toEqual([STEAM_A, STEAM_B])
    for (const m of open) {
      expect(m.joinedAt.getTime()).toBe(ranAt.getTime())
      expect(m.leftAt).toBeNull()
    }
  })

  it('updates lastSeenAt for still-present members and closes absent ones', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z')
    await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A, STEAM_B]),
      ranAt: t0,
    })

    const t1 = new Date('2026-01-02T00:00:00Z')
    const result = await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A]),
      ranAt: t1,
    })
    expect(result).toEqual({ joined: 0, stillPresent: 1, left: 1, stickyUntouched: 0 })

    const open = await findOpenMembershipsByGroup(db, groupId)
    expect(open.length).toBe(1)
    expect(open[0]!.steamId).toBe(STEAM_A)
    expect(open[0]!.lastSeenAt.getTime()).toBe(t1.getTime())
  })

  it('does not close sticky members when absent', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z')
    await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A]),
      ranAt: t0,
    })

    const open0 = await findOpenMembershipsByGroup(db, groupId)
    const membership = open0[0]
    if (!membership) throw new Error('no membership')
    await setMembershipSticky(db, membership.id, true)

    const t1 = new Date('2026-01-02T00:00:00Z')
    const result = await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set(),
      ranAt: t1,
    })
    expect(result).toEqual({ joined: 0, stillPresent: 0, left: 0, stickyUntouched: 1 })

    const open = await findOpenMembershipsByGroup(db, groupId)
    expect(open.length).toBe(1)
    expect(open[0]!.isSticky).toBe(true)
    expect(open[0]!.leftAt).toBeNull()
  })

  it('creates a new row on rejoin (old row stays closed)', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z')
    await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A]),
      ranAt: t0,
    })

    const t1 = new Date('2026-01-02T00:00:00Z')
    await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set(),
      ranAt: t1,
    })

    const t2 = new Date('2026-01-03T00:00:00Z')
    const result = await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A]),
      ranAt: t2,
    })
    expect(result).toEqual({ joined: 1, stillPresent: 0, left: 0, stickyUntouched: 0 })

    const open = await findOpenMembershipsByGroup(db, groupId)
    expect(open.length).toBe(1)
    expect(open[0]!.joinedAt.getTime()).toBe(t2.getTime())
  })

  it('reopenMembership sets leftAt to null and isSticky to true', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z')
    await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A]),
      ranAt: t0,
    })
    const t1 = new Date('2026-01-02T00:00:00Z')
    await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set(),
      ranAt: t1,
    })

    const allRows = await db.select().from(steamGroupMemberships)
    const closed = allRows.find((r) => r.leftAt !== null)
    if (!closed) throw new Error('no closed row')
    await reopenMembership(db, closed.id)

    const open = await findOpenMembershipsByGroup(db, groupId)
    expect(open.length).toBe(1)
    expect(open[0]!.isSticky).toBe(true)
    expect(open[0]!.leftAt).toBeNull()
  })

  it('handles mixed joins, stays, and leaves in a single diff', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z')
    await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A, STEAM_B]),
      ranAt: t0,
    })

    const t1 = new Date('2026-01-02T00:00:00Z')
    const result = await applyMembershipDiff(db, {
      groupId,
      currentRoster: new Set([STEAM_A, STEAM_C]),
      ranAt: t1,
    })
    expect(result).toEqual({ joined: 1, stillPresent: 1, left: 1, stickyUntouched: 0 })

    const open = await findOpenMembershipsByGroup(db, groupId)
    const steamIds = open.map((m) => m.steamId).sort()
    expect(steamIds).toEqual([STEAM_A, STEAM_C])
  })
})
