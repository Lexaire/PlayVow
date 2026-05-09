import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { groups } from '#/db/schema'
import type { SteamGroupId, SteamGiftsGroupCode, SteamId } from '#/db/schema'
import type { GroupMembersPage, SteamCommunityClient } from '#/external/steam-community'
import { createLogger } from '#/lib/logger'
import { ok } from '#/lib/result'
import { findOpenMembershipsByGroup } from '#/repos/groupMemberships'
import { createTestDb } from '#/repos/__test__/db'
import { scrapeSteamGroupMembers } from '#/worker/jobs/scrape-steam-group-members'

const GID = '103582791400000001' as SteamGroupId
const CODE = 'test1' as SteamGiftsGroupCode
const STEAM_A = '76561198000000001' as SteamId
const STEAM_B = '76561198000000002' as SteamId

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

const stubSteam = (pages: ReadonlyArray<ReadonlyArray<SteamId>>): SteamCommunityClient => ({
  getScreenshots: () => {
    throw new Error('unexpected getScreenshots')
  },
  getGroupMembersPage: (_gid64, page) => {
    const idx = page - 1
    if (idx >= pages.length) {
      return Promise.resolve(
        ok({
          groupId64: GID,
          totalPages: pages.length,
          currentPage: pages.length,
          members: [],
        }),
      )
    }
    return Promise.resolve(
      ok({
        groupId64: GID,
        totalPages: pages.length,
        currentPage: page,
        members: pages[idx]!,
      } satisfies GroupMembersPage),
    )
  },
})

const silentLogger = createLogger({ write: () => {} })

describe('scrapeSteamGroupMembers', () => {
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

  it('inserts all roster members on first scrape', async () => {
    const steam = stubSteam([[STEAM_A, STEAM_B]])
    const ranAt = new Date('2026-01-01T00:00:00Z')
    const result = await scrapeSteamGroupMembers(
      { db, dbWrite: db, steam, logger: silentLogger, now: () => ranAt },
      { id: groupId, steamGroupId: GID, slug: 'test-group' } as any,
    )
    expect(result.membersSeen).toBe(2)
    expect(result.joined).toBe(2)
    expect(result.left).toBe(0)

    const open = await findOpenMembershipsByGroup(db, groupId)
    expect(open.length).toBe(2)
  })

  it('closes absent members on second scrape', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z')
    const steam0 = stubSteam([[STEAM_A, STEAM_B]])
    await scrapeSteamGroupMembers(
      { db, dbWrite: db, steam: steam0, logger: silentLogger, now: () => t0 },
      { id: groupId, steamGroupId: GID, slug: 'test-group' } as any,
    )

    const t1 = new Date('2026-01-02T00:00:00Z')
    const steam1 = stubSteam([[STEAM_A]])
    const result = await scrapeSteamGroupMembers(
      { db, dbWrite: db, steam: steam1, logger: silentLogger, now: () => t1 },
      { id: groupId, steamGroupId: GID, slug: 'test-group' } as any,
    )
    expect(result.joined).toBe(0)
    expect(result.stillPresent).toBe(1)
    expect(result.left).toBe(1)

    const open = await findOpenMembershipsByGroup(db, groupId)
    expect(open.length).toBe(1)
    expect(open[0]!.steamId).toBe(STEAM_A)
  })

  it('returns empty summary when fetch fails on first page', async () => {
    const steam: SteamCommunityClient = {
      getScreenshots: () => {
        throw new Error('unexpected')
      },
      getGroupMembersPage: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'http_status' as const, status: 500, body: '' },
        }),
    }
    const result = await scrapeSteamGroupMembers({ db, dbWrite: db, steam, logger: silentLogger }, {
      id: groupId,
      steamGroupId: GID,
      slug: 'test-group',
    } as any)
    expect(result.membersSeen).toBe(0)
    expect(result.joined).toBe(0)
    expect(result.left).toBe(0)
  })
})
