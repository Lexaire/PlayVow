import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { groups } from '#/db/schema'
import type {
  SteamAppId,
  SteamGiftsGiveawayCode,
  SteamGiftsGroupCode,
  SteamGiftsUsername,
  SteamGroupId,
} from '#/db/schema'
import { createTestDb } from '#/repos/__test__/db'
import {
  findGiveawayByGroupAndCode,
  listRecentGiveawaysByGroup,
  upsertGiveaway,
} from '#/repos/giveaways'
import { upsertSteamApp } from '#/repos/steamApps'
import { upsertUserBySgUsername } from '#/repos/users'

const APP_A = 12345 as SteamAppId
const CODE_A = 'aaaaa' as SteamGiftsGiveawayCode
const CODE_B = 'bbbbb' as SteamGiftsGiveawayCode

const seedGroup = async (db: Db): Promise<number> => {
  const [row] = await db
    .insert(groups)
    .values({
      slug: 'taleplay',
      name: 'TalePlay',
      playWindowDays: 90,
      steamgiftsGroupCode: 'xBp7E' as SteamGiftsGroupCode,
      steamGroupId: '1' as SteamGroupId,
      steamGroupSlug: 'taleplay',
      description: null,
    })
    .returning({ id: groups.id })
  if (!row) throw new Error('seed: no row returned')
  return row.id
}

describe('giveawaysRepo', () => {
  let db: Db
  let close: () => void
  beforeEach(async () => {
    const t = await createTestDb()
    db = t.db
    close = t.close
    await upsertSteamApp(db, { appId: APP_A, name: 'Game A' })
  })
  afterEach(() => {
    close()
  })

  it('upsertGiveaway inserts then updates the same (group, code) row', async () => {
    const groupId = await seedGroup(db)
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    const first = await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_A,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-08T00:00:00Z'),
      scrapedAt: new Date('2026-01-09T00:00:00Z'),
    })
    const second = await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_A,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 3,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-08T00:00:00Z'),
      scrapedAt: new Date('2026-01-10T00:00:00Z'),
    })
    expect(second.id).toBe(first.id)
    expect(second.quantity).toBe(3)
    expect(second.scrapedAt.toISOString()).toBe('2026-01-10T00:00:00.000Z')
  })

  it('findGiveawayByGroupAndCode locates the row', async () => {
    const groupId = await seedGroup(db)
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_A,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-08T00:00:00Z'),
      scrapedAt: new Date('2026-01-09T00:00:00Z'),
    })
    const found = await findGiveawayByGroupAndCode(db, groupId, CODE_A)
    expect(found?.steamgiftsCode).toBe(CODE_A)
    expect(await findGiveawayByGroupAndCode(db, groupId, CODE_B)).toBeNull()
  })

  it('listRecentGiveawaysByGroup orders by endedAt descending', async () => {
    const groupId = await seedGroup(db)
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_A,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-08T00:00:00Z'),
      scrapedAt: new Date('2026-01-09T00:00:00Z'),
    })
    await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_B,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-02-01T00:00:00Z'),
      endedAt: new Date('2026-02-08T00:00:00Z'),
      scrapedAt: new Date('2026-02-09T00:00:00Z'),
    })
    const list = await listRecentGiveawaysByGroup(db, groupId, 10)
    expect(list.map((g) => g.steamgiftsCode)).toEqual([CODE_B, CODE_A])
  })
})
