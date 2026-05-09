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
import { upsertGiveaway } from '#/repos/giveaways'
import { upsertSteamApp } from '#/repos/steamApps'
import { createTestDb } from '#/repos/__test__/db'
import { upsertUserBySgUsername } from '#/repos/users'
import { insertWinIfAbsent } from '#/repos/wins'
import { getGroupOverviewPage } from '#/server/queries'

const APP_A = 12345 as SteamAppId
const APP_B = 67890 as SteamAppId
const CODE_A = 'aaaaa' as SteamGiftsGiveawayCode
const CODE_B = 'bbbbb' as SteamGiftsGiveawayCode
const CODE_C = 'ccccc' as SteamGiftsGiveawayCode
const CODE_D = 'ddddd' as SteamGiftsGiveawayCode

type SeedGroupInput = {
  readonly slug: string
  readonly steamgiftsGroupCode: SteamGiftsGroupCode
  readonly steamGroupId: SteamGroupId
}

const seedGroup = async (db: Db, input: SeedGroupInput): Promise<number> => {
  const [row] = await db
    .insert(groups)
    .values({
      slug: input.slug,
      name: input.slug,
      playWindowDays: 90,
      steamgiftsGroupCode: input.steamgiftsGroupCode,
      steamGroupId: input.steamGroupId,
      steamGroupSlug: input.slug,
      description: null,
    })
    .returning({ id: groups.id })
  if (!row) throw new Error('seed: no group row returned')
  return row.id
}

describe('getGroupOverviewPage', () => {
  let db: Db
  let close: () => void
  beforeEach(async () => {
    const t = await createTestDb()
    db = t.db
    close = t.close
    await upsertSteamApp(db, { appId: APP_A, name: 'Game A' })
    await upsertSteamApp(db, { appId: APP_B, name: 'Game B' })
  })
  afterEach(() => {
    close()
  })

  it('returns null for an unknown slug', async () => {
    expect(await getGroupOverviewPage(db, 'nope', 1, 1, new Date())).toBeNull()
  })

  it('separates in-progress giveaways from the feed and orders them by endedAt asc', async () => {
    const groupId = await seedGroup(db, {
      slug: 'taleplay',
      steamgiftsGroupCode: 'xBp7E' as SteamGiftsGroupCode,
      steamGroupId: '1' as SteamGroupId,
    })
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    const now = new Date('2026-04-01T00:00:00Z')
    // Two in-progress giveaways (endedAt > now). Seed in reverse order to
    // assert the query sorts by endedAt asc.
    await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_A,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-03-25T00:00:00Z'),
      endedAt: new Date('2026-04-15T00:00:00Z'), // later
      scrapedAt: now,
    })
    await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_B,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-03-25T00:00:00Z'),
      endedAt: new Date('2026-04-05T00:00:00Z'), // sooner
      scrapedAt: now,
    })

    const result = await getGroupOverviewPage(db, 'taleplay', 1, 1, now)
    expect(result).not.toBeNull()
    expect(result!.inProgress.rows.map((g) => g.steamgiftsCode)).toEqual([CODE_B, CODE_A])
    expect(result!.inProgress.total).toBe(2)
    // In-progress giveaways are NOT in the feed.
    expect(result!.feed.rows).toEqual([])
    expect(result!.feed.total).toBe(0)
  })

  it('interleaves wins and no-winner giveaways in the feed by date desc', async () => {
    const groupId = await seedGroup(db, {
      slug: 'taleplay',
      steamgiftsGroupCode: 'xBp7E' as SteamGiftsGroupCode,
      steamGroupId: '1' as SteamGroupId,
    })
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    const winner = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'w1' as SteamGiftsUsername,
    })
    const now = new Date('2026-05-01T00:00:00Z')

    // Ended giveaway with a winner — should appear as a `win` row keyed by wonAt.
    const gWithWin = await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_A,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-04-01T00:00:00Z'),
      endedAt: new Date('2026-04-08T00:00:00Z'),
      scrapedAt: new Date('2026-04-09T00:00:00Z'),
    })
    await insertWinIfAbsent(db, {
      giveawayId: gWithWin.id,
      userId: winner.id,
      wonAt: new Date('2026-04-08T00:00:00Z'),
      playDeadline: new Date('2026-07-08T00:00:00Z'),
    })

    // Ended giveaway with NO winners — should appear as a `no_winner_giveaway`
    // row keyed by endedAt. Choose endedAt later than the win above so it
    // sorts first.
    await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_B,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-04-15T00:00:00Z'),
      endedAt: new Date('2026-04-20T00:00:00Z'),
      scrapedAt: new Date('2026-04-21T00:00:00Z'),
    })

    const result = await getGroupOverviewPage(db, 'taleplay', 1, 1, now)
    expect(result!.feed.total).toBe(2)
    expect(result!.feed.rows.map((r) => r.kind)).toEqual(['no_winner_giveaway', 'win'])
    expect(
      result!.feed.rows[0]?.kind === 'no_winner_giveaway' &&
        result!.feed.rows[0].giveaway.steamgiftsCode,
    ).toBe(CODE_B)
    expect(
      result!.feed.rows[1]?.kind === 'win' && result!.feed.rows[1].win.giveaway.steamgiftsCode,
    ).toBe(CODE_A)
  })

  it('emits one feed row per winner for multi-key giveaways and no separate giveaway row', async () => {
    const groupId = await seedGroup(db, {
      slug: 'taleplay',
      steamgiftsGroupCode: 'xBp7E' as SteamGiftsGroupCode,
      steamGroupId: '1' as SteamGroupId,
    })
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    const w1 = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'w1' as SteamGiftsUsername,
    })
    const w2 = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'w2' as SteamGiftsUsername,
    })
    const now = new Date('2026-05-01T00:00:00Z')

    const g = await upsertGiveaway(db, {
      groupId,
      steamgiftsCode: CODE_A,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 2,
      startedAt: new Date('2026-04-01T00:00:00Z'),
      endedAt: new Date('2026-04-08T00:00:00Z'),
      scrapedAt: new Date('2026-04-09T00:00:00Z'),
    })
    await insertWinIfAbsent(db, {
      giveawayId: g.id,
      userId: w1.id,
      wonAt: new Date('2026-04-08T00:00:00Z'),
      playDeadline: new Date('2026-07-08T00:00:00Z'),
    })
    await insertWinIfAbsent(db, {
      giveawayId: g.id,
      userId: w2.id,
      wonAt: new Date('2026-04-08T00:00:00Z'),
      playDeadline: new Date('2026-07-08T00:00:00Z'),
    })

    const result = await getGroupOverviewPage(db, 'taleplay', 1, 1, now)
    expect(result!.feed.total).toBe(2)
    expect(result!.feed.rows.every((r) => r.kind === 'win')).toBe(true)
    expect(result!.feed.rows.length).toBe(2)
  })

  it('paginates feed rows with deterministic ordering across pages', async () => {
    const groupId = await seedGroup(db, {
      slug: 'taleplay',
      steamgiftsGroupCode: 'xBp7E' as SteamGiftsGroupCode,
      steamGroupId: '1' as SteamGroupId,
    })
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    const now = new Date('2026-12-31T00:00:00Z')
    // 27 no-winner giveaways → spans 2 pages of FEED_PAGE_SIZE=25.
    const total = 27
    for (let i = 0; i < total; i += 1) {
      await upsertGiveaway(db, {
        groupId,
        steamgiftsCode: `g${i.toString().padStart(4, '0')}` as SteamGiftsGiveawayCode,
        target: { kind: 'app', appId: APP_A },
        creatorUserId: creator.id,
        quantity: 1,
        startedAt: new Date(Date.UTC(2026, 0, 1 + i)),
        endedAt: new Date(Date.UTC(2026, 0, 8 + i)),
        scrapedAt: new Date(Date.UTC(2026, 0, 9 + i)),
      })
    }

    const pageOne = await getGroupOverviewPage(db, 'taleplay', 1, 1, now)
    const pageTwo = await getGroupOverviewPage(db, 'taleplay', 1, 2, now)

    expect(pageOne!.feed.total).toBe(total)
    expect(pageOne!.feed.rows.length).toBe(25)
    expect(pageTwo!.feed.rows.length).toBe(2)
    // Newest first (g0026, g0025, …) on page 1; oldest two (g0001, g0000) on page 2.
    const pageOneCodes = pageOne!.feed.rows.flatMap((r) =>
      r.kind === 'no_winner_giveaway' ? [r.giveaway.steamgiftsCode as string] : [],
    )
    const pageTwoCodes = pageTwo!.feed.rows.flatMap((r) =>
      r.kind === 'no_winner_giveaway' ? [r.giveaway.steamgiftsCode as string] : [],
    )
    expect(pageOneCodes[0]).toBe('g0026')
    expect(pageTwoCodes).toEqual(['g0001', 'g0000'])
  })

  it('isolates results between groups', async () => {
    const groupAId = await seedGroup(db, {
      slug: 'group-a',
      steamgiftsGroupCode: 'aaaaa' as SteamGiftsGroupCode,
      steamGroupId: '1' as SteamGroupId,
    })
    const groupBId = await seedGroup(db, {
      slug: 'group-b',
      steamgiftsGroupCode: 'bbbbb' as SteamGiftsGroupCode,
      steamGroupId: '2' as SteamGroupId,
    })
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    const now = new Date('2026-05-01T00:00:00Z')
    await upsertGiveaway(db, {
      groupId: groupAId,
      steamgiftsCode: CODE_C,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-04-01T00:00:00Z'),
      endedAt: new Date('2026-04-08T00:00:00Z'),
      scrapedAt: new Date('2026-04-09T00:00:00Z'),
    })
    await upsertGiveaway(db, {
      groupId: groupBId,
      steamgiftsCode: CODE_D,
      target: { kind: 'app', appId: APP_B },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-04-01T00:00:00Z'),
      endedAt: new Date('2026-04-08T00:00:00Z'),
      scrapedAt: new Date('2026-04-09T00:00:00Z'),
    })

    const a = await getGroupOverviewPage(db, 'group-a', 1, 1, now)
    const b = await getGroupOverviewPage(db, 'group-b', 1, 1, now)
    expect(
      a!.feed.rows.flatMap((r) =>
        r.kind === 'no_winner_giveaway' ? [r.giveaway.steamgiftsCode] : [],
      ),
    ).toEqual([CODE_C])
    expect(
      b!.feed.rows.flatMap((r) =>
        r.kind === 'no_winner_giveaway' ? [r.giveaway.steamgiftsCode] : [],
      ),
    ).toEqual([CODE_D])
  })
})
