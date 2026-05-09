import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { groups } from '#/db/schema'
import type {
  SteamAppId,
  SteamGiftsGiveawayCode,
  SteamGiftsGroupCode,
  SteamGiftsUsername,
  SteamGroupId,
  SteamId,
} from '#/db/schema'
import { createTestDb } from '#/repos/__test__/db'
import { listAuditEntriesForTarget } from '#/repos/auditLog'
import { recordScrapedGiveaway, recordScrapedWin } from '#/repos/scrapeWrite'

const APP_A = 12345 as SteamAppId
const STEAM_A = '76561197960000001' as SteamId
const STEAM_B = '76561197960000002' as SteamId
const CODE_A = 'gA001' as SteamGiftsGiveawayCode

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
  if (!row) throw new Error('seed: no group')
  return row.id
}

const baseInput = (groupId: number) =>
  ({
    groupId,
    playWindowDays: 90,
    target: { kind: 'app', appId: APP_A, name: 'Game A' },
    giveaway: {
      steamgiftsCode: CODE_A,
      slug: 'game-a',
      quantity: 1,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-08T00:00:00Z'),
      winnersScrapedAt: null,
    },
    creator: { steamgiftsUsername: 'mod' as SteamGiftsUsername, steamId: STEAM_B },
    winner: { steamgiftsUsername: 'robin' as SteamGiftsUsername, steamId: STEAM_A },
    wonAt: new Date('2026-01-08T00:00:00Z'),
    scrapedAt: new Date('2026-01-09T00:00:00Z'),
  }) as const

describe('recordScrapedGiveaway', () => {
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

  it('inserts steam_app, creator user, and giveaway with no win', async () => {
    const groupId = await seedGroup(db)
    const input = baseInput(groupId)
    const result = await recordScrapedGiveaway(db, {
      groupId: input.groupId,
      target: input.target,
      giveaway: input.giveaway,
      creator: input.creator,
      scrapedAt: input.scrapedAt,
    })
    expect(result.creator.steamgiftsUsername).toBe('mod')
    expect(result.giveaway.creatorUserId).toBe(result.creator.id)
    expect(result.giveaway.steamAppId).toBe(APP_A)
  })

  it('is safe to call with the same giveaway twice (no winner ever)', async () => {
    const groupId = await seedGroup(db)
    const input = baseInput(groupId)
    const first = await recordScrapedGiveaway(db, {
      groupId: input.groupId,
      target: input.target,
      giveaway: input.giveaway,
      creator: input.creator,
      scrapedAt: input.scrapedAt,
    })
    const second = await recordScrapedGiveaway(db, {
      groupId: input.groupId,
      target: input.target,
      giveaway: { ...input.giveaway, quantity: 7 },
      creator: input.creator,
      scrapedAt: new Date('2026-01-12T00:00:00Z'),
    })
    expect(second.giveaway.id).toBe(first.giveaway.id)
    expect(second.giveaway.quantity).toBe(7)
  })
})

describe('recordScrapedWin', () => {
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

  it('inserts steam_app, giveaway, creator, winner, and win — and writes no audit row', async () => {
    const groupId = await seedGroup(db)
    const input = baseInput(groupId)
    const result = await recordScrapedWin(db, input)
    expect(result.created).toBe(true)
    expect(result.win.status).toBe('pending')
    expect(result.win.playDeadline.getTime()).toBe(input.wonAt.getTime() + 90 * 24 * 60 * 60 * 1000)
    expect(result.giveaway.creatorUserId).toBe(result.creator.id)
    expect(result.creator.id).not.toBe(result.winner.id)
    const audits = await listAuditEntriesForTarget(db, 'win', result.win.id, 10)
    expect(audits).toHaveLength(0)
  })

  it('is idempotent: a second scrape of the same win is a no-op', async () => {
    const groupId = await seedGroup(db)
    const input = baseInput(groupId)
    const first = await recordScrapedWin(db, input)
    const second = await recordScrapedWin(db, input)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.win.id).toBe(first.win.id)
  })

  it('updates the giveaway scrape metadata on a re-scrape', async () => {
    const groupId = await seedGroup(db)
    const input = baseInput(groupId)
    const first = await recordScrapedWin(db, input)
    const second = await recordScrapedWin(db, {
      ...input,
      giveaway: { ...input.giveaway, quantity: 5 },
      scrapedAt: new Date('2026-01-12T00:00:00Z'),
    })
    expect(second.giveaway.id).toBe(first.giveaway.id)
    expect(second.giveaway.quantity).toBe(5)
    expect(second.giveaway.scrapedAt.toISOString()).toBe('2026-01-12T00:00:00.000Z')
  })
})
