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
import type { AchievementDetail, OwnedGame, OwnedGames, SteamApiClient } from '#/external/steam-api'
import type {
  Screenshot,
  ScreenshotsError,
  SteamCommunityClient,
} from '#/external/steam-community'
import { createLogger } from '#/lib/logger'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { createTestDb } from '#/repos/__test__/db'
import { upsertGiveaway } from '#/repos/giveaways'
import { upsertSteamApp } from '#/repos/steamApps'
import { upsertUserBySgUsername } from '#/repos/users'
import { findWinByGiveawayAndUser, insertWinIfAbsent } from '#/repos/wins'
import { pollPlaytime } from '#/worker/jobs/poll-playtime'

const APP_A = 12345 as SteamAppId
const STEAM_A = '76561197960000001' as SteamId
const STEAM_B = '76561197960000002' as SteamId

type Fixture = {
  readonly winFreshId: number
  readonly winFreshUserId: number
  readonly winFreshGiveawayId: number
  readonly winStaleId: number
}

const seed = async (db: Db): Promise<Fixture> => {
  const [groupRow] = await db
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
  if (!groupRow) throw new Error('seed: no group')

  await upsertSteamApp(db, { appId: APP_A, name: 'Game A' })
  const creator = await upsertUserBySgUsername(db, {
    steamgiftsUsername: 'mod' as SteamGiftsUsername,
  })
  const giveaway = await upsertGiveaway(db, {
    groupId: groupRow.id,
    steamgiftsCode: 'gA001' as SteamGiftsGiveawayCode,
    target: { kind: 'app', appId: APP_A },
    creatorUserId: creator.id,
    quantity: 1,
    startedAt: new Date('2026-04-01T00:00:00Z'),
    endedAt: new Date('2026-04-08T00:00:00Z'),
    scrapedAt: new Date('2026-04-09T00:00:00Z'),
  })
  const userA = await upsertUserBySgUsername(db, {
    steamgiftsUsername: 'a' as SteamGiftsUsername,
    steamId: STEAM_A,
  })
  const userB = await upsertUserBySgUsername(db, {
    steamgiftsUsername: 'b' as SteamGiftsUsername,
    steamId: STEAM_B,
  })

  const fresh = await insertWinIfAbsent(db, {
    giveawayId: giveaway.id,
    userId: userA.id,
    wonAt: new Date('2026-04-08T00:00:00Z'),
    playDeadline: new Date('2026-07-08T00:00:00Z'),
  })
  const stale = await insertWinIfAbsent(db, {
    giveawayId: giveaway.id,
    userId: userB.id,
    wonAt: new Date('2025-04-08T00:00:00Z'),
    playDeadline: new Date('2025-07-08T00:00:00Z'),
  })
  if (!fresh || !stale) throw new Error('seed: insert win failed')

  return {
    winFreshId: fresh.id,
    winFreshUserId: userA.id,
    winFreshGiveawayId: giveaway.id,
    winStaleId: stale.id,
  }
}

const NOW = new Date('2026-04-25T00:00:00Z')
const fixedNow = (): Date => NOW

const game = (
  overrides: Pick<OwnedGame, 'appId' | 'playtimeMinutes'> & Partial<OwnedGame>,
): OwnedGame => ({
  playtime2WeeksMinutes: null,
  ...overrides,
})

const stubSteam = (
  byId: Readonly<Record<SteamId, OwnedGames>>,
  achievementsByApp: Readonly<Record<string, AchievementDetail[]>> = {},
): SteamApiClient => ({
  getOwnedGames: (id) => {
    const games = byId[id]
    if (!games) throw new Error(`unexpected getOwnedGames(${id})`)
    return Promise.resolve(ok(games))
  },
  getPlayerAchievements: (_steamId, appId) => {
    const list = achievementsByApp[String(appId)]
    if (list === undefined) return Promise.resolve(ok({ kind: 'no_stats' as const }))
    return Promise.resolve(ok({ kind: 'public' as const, achievements: list }))
  },
  getStoreItems: () => {
    throw new Error('getStoreItems not used in this test')
  },
  getGlobalAchievementPercents: () => {
    throw new Error('getGlobalAchievementPercents not used in this test')
  },
  resolveVanityUrl: () => {
    throw new Error('resolveVanityUrl not used in this test')
  },
})

type CallRecord = {
  readonly steamId: SteamId
  readonly appIds: ReadonlyArray<SteamAppId>
}

// Variant of stubSteam that records every getOwnedGames call so tests can
// assert how many times it fired and which appIds were batched together.
const recordingSteam = (
  byId: Readonly<Record<SteamId, OwnedGames>>,
  achievementsByApp: Readonly<Record<string, AchievementDetail[]>> = {},
): { client: SteamApiClient; calls: ReadonlyArray<CallRecord> } => {
  const calls: CallRecord[] = []
  const client: SteamApiClient = {
    getOwnedGames: (id, appIds) => {
      calls.push({ steamId: id, appIds })
      const games = byId[id]
      if (!games) throw new Error(`unexpected getOwnedGames(${id})`)
      return Promise.resolve(ok(games))
    },
    getPlayerAchievements: (_steamId, appId) => {
      const list = achievementsByApp[String(appId)]
      if (list === undefined) return Promise.resolve(ok({ kind: 'no_stats' as const }))
      return Promise.resolve(ok({ kind: 'public' as const, achievements: list }))
    },
    getStoreItems: () => {
      throw new Error('getStoreItems not used in this test')
    },
    getGlobalAchievementPercents: () => {
      throw new Error('getGlobalAchievementPercents not used in this test')
    },
    resolveVanityUrl: () => {
      throw new Error('resolveVanityUrl not used in this test')
    },
  }
  return { client, calls }
}

// Default stub: every screenshot lookup returns an empty list (public
// profile, no shots). Tests that care about screenshots pass a custom
// screenshotsBy map.
const stubSteamCommunity = (
  screenshotsBy: Readonly<
    Record<string, Result<ReadonlyArray<Screenshot>, ScreenshotsError>>
  > = {},
): SteamCommunityClient => ({
  getScreenshots: (steamId, appId) => {
    const key = `${steamId}:${String(appId)}`
    return Promise.resolve(screenshotsBy[key] ?? ok([]))
  },
  getGroupMembersPage: () => {
    throw new Error('getGroupMembersPage not used in this test')
  },
})

// Helper: build N placeholder Screenshot rows for tests that only care about
// the count flowing through. Real fileId/thumbUrl values aren't relevant here
// — the parser tests in steam-community.test.ts cover that shape.
const fakeScreenshots = (n: number): ReadonlyArray<Screenshot> =>
  Array.from({ length: n }, (_, i) => ({
    fileId: `${String(1000 + i)}`,
    thumbUrl: `https://images.steamusercontent.com/ugc/${String(i)}/THUMB/`,
    caption: null,
  }))

const silentLogger = createLogger({ write: () => {} })

describe('pollPlaytime', () => {
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

  it('writes the baseline on first poll using the matching app playtime', async () => {
    const f = await seed(db)
    const steam = stubSteam({
      [STEAM_A]: {
        visibility: 'public',
        games: [
          game({ appId: APP_A, playtimeMinutes: 90 }),
          game({ appId: 999 as SteamAppId, playtimeMinutes: 7 }),
        ],
      },
    })

    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(summary.winsExamined).toBe(1)
    expect(summary.baselinesWritten).toBe(1)
    expect(summary.progressWritten).toBe(0)

    const win = await findWinByGiveawayAndUser(db, f.winFreshGiveawayId, f.winFreshUserId)
    expect(win?.playtimeAtWinMinutes).toBe(90)
    expect(win?.currentPlaytimeMinutes).toBe(90)
    expect(win?.lastCheckedAt?.toISOString()).toBe(NOW.toISOString())
  })

  it('writes null playtime (not zero) when the game is hidden from the library', async () => {
    const f = await seed(db)
    const steam = stubSteam({
      [STEAM_A]: { visibility: 'public', games: [] },
    })

    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(summary.baselinesWritten).toBe(1)
    expect(summary.missingGames).toBe(1)
    // No observation should be inserted when we have no playtime data.
    expect(summary.observationsWritten).toBe(0)
    const win = await findWinByGiveawayAndUser(db, f.winFreshGiveawayId, f.winFreshUserId)
    // Distinguishes "we couldn't see it" (null) from "owned, never played" (0).
    expect(win?.playtimeAtWinMinutes).toBeNull()
    expect(win?.currentPlaytimeMinutes).toBeNull()
  })

  it('updates only currentPlaytimeMinutes on subsequent polls (baseline preserved)', async () => {
    const f = await seed(db)
    const first = stubSteam({
      [STEAM_A]: {
        visibility: 'public',
        games: [game({ appId: APP_A, playtimeMinutes: 60 })],
      },
    })
    await pollPlaytime({
      db,
      dbWrite: db,
      steam: first,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })

    const second = stubSteam({
      [STEAM_A]: {
        visibility: 'public',
        games: [game({ appId: APP_A, playtimeMinutes: 240 })],
      },
    })
    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam: second,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: () => new Date('2026-04-26T00:00:00Z'),
    })
    expect(summary.baselinesWritten).toBe(0)
    expect(summary.progressWritten).toBe(1)

    const win = await findWinByGiveawayAndUser(db, f.winFreshGiveawayId, f.winFreshUserId)
    expect(win?.playtimeAtWinMinutes).toBe(60)
    expect(win?.currentPlaytimeMinutes).toBe(240)
  })

  it('skips wins past the poll-window cutoff after the deadline', async () => {
    await seed(db)
    const steam = stubSteam({
      [STEAM_A]: { visibility: 'public', games: [] },
    })
    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(summary.winsExamined).toBe(1)
  })

  it('counts private profiles separately and writes nothing', async () => {
    const f = await seed(db)
    const steam = stubSteam({ [STEAM_A]: { visibility: 'private' } })
    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(summary.privateProfiles).toBe(1)
    expect(summary.baselinesWritten).toBe(0)
    const win = await findWinByGiveawayAndUser(db, f.winFreshGiveawayId, f.winFreshUserId)
    expect(win?.playtimeAtWinMinutes).toBeNull()
  })

  it('continues past steam errors without crashing', async () => {
    const steam: SteamApiClient = {
      getOwnedGames: () =>
        Promise.resolve({ ok: false, error: { kind: 'network', message: 'down' } as const }),
      getPlayerAchievements: () => Promise.resolve(ok({ kind: 'no_stats' as const })),
      getStoreItems: () => {
        throw new Error('getStoreItems not used in this test')
      },
      getGlobalAchievementPercents: () => {
        throw new Error('getGlobalAchievementPercents not used in this test')
      },
      resolveVanityUrl: () => {
        throw new Error('resolveVanityUrl not used in this test')
      },
    }
    await seed(db)
    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(summary.steamErrors).toBe(1)
    expect(summary.baselinesWritten).toBe(0)
  })

  it('writes per-achievement events on first poll, no-ops on second', async () => {
    await seed(db)
    const ach: AchievementDetail[] = [
      {
        apiname: 'ACH_KILL',
        achieved: true,
        unlockedAt: new Date('2026-04-20T00:00:00Z'),
        displayName: 'First Blood',
        description: 'Get your first kill',
      },
      {
        apiname: 'ACH_LOCKED',
        achieved: false,
        unlockedAt: null,
        displayName: 'Untouched',
        description: 'Locked achievement',
      },
    ]
    const steam = stubSteam(
      {
        [STEAM_A]: { visibility: 'public', games: [game({ appId: APP_A, playtimeMinutes: 90 })] },
      },
      { [APP_A]: ach },
    )
    const first = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    // One unlocked → 1 event. Locked-by-default → 0 events. Both upserted to schema.
    expect(first.achievementEventsWritten).toBe(1)
    expect(first.achievementsUpserted).toBe(2)

    const second = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(second.achievementEventsWritten).toBe(0) // unchanged → no new rows
    // Cache hit: both achievements were already in the DB from the first
    // poll, so the metadata upsert is skipped entirely.
    expect(second.achievementsUpserted).toBe(0)
  })

  it('batches getOwnedGames into one call per user with all their pending appIds', async () => {
    // Seed two apps and two users; user A has wins for both apps, user B has
    // one win for app A. Expected calls: 1 for A (with [appA, appB]), 1 for B
    // (with [appA]).
    const APP_B = 22222 as SteamAppId
    const [groupRow] = await db
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
    if (!groupRow) throw new Error('seed: no group')
    await upsertSteamApp(db, { appId: APP_A, name: 'Game A' })
    await upsertSteamApp(db, { appId: APP_B, name: 'Game B' })
    const creator = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'mod' as SteamGiftsUsername,
    })
    const userA = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'a' as SteamGiftsUsername,
      steamId: STEAM_A,
    })
    const userB = await upsertUserBySgUsername(db, {
      steamgiftsUsername: 'b' as SteamGiftsUsername,
      steamId: STEAM_B,
    })
    const giveawayA = await upsertGiveaway(db, {
      groupId: groupRow.id,
      steamgiftsCode: 'gA001' as SteamGiftsGiveawayCode,
      target: { kind: 'app', appId: APP_A },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-04-01T00:00:00Z'),
      endedAt: new Date('2026-04-08T00:00:00Z'),
      scrapedAt: new Date('2026-04-09T00:00:00Z'),
    })
    const giveawayB = await upsertGiveaway(db, {
      groupId: groupRow.id,
      steamgiftsCode: 'gB001' as SteamGiftsGiveawayCode,
      target: { kind: 'app', appId: APP_B },
      creatorUserId: creator.id,
      quantity: 1,
      startedAt: new Date('2026-04-01T00:00:00Z'),
      endedAt: new Date('2026-04-08T00:00:00Z'),
      scrapedAt: new Date('2026-04-09T00:00:00Z'),
    })
    await insertWinIfAbsent(db, {
      giveawayId: giveawayA.id,
      userId: userA.id,
      wonAt: new Date('2026-04-08T00:00:00Z'),
      playDeadline: new Date('2026-07-08T00:00:00Z'),
    })
    await insertWinIfAbsent(db, {
      giveawayId: giveawayB.id,
      userId: userA.id,
      wonAt: new Date('2026-04-08T00:00:00Z'),
      playDeadline: new Date('2026-07-08T00:00:00Z'),
    })
    await insertWinIfAbsent(db, {
      giveawayId: giveawayA.id,
      userId: userB.id,
      wonAt: new Date('2026-04-08T00:00:00Z'),
      playDeadline: new Date('2026-07-08T00:00:00Z'),
    })

    const { client, calls } = recordingSteam({
      [STEAM_A]: {
        visibility: 'public',
        games: [
          game({ appId: APP_A, playtimeMinutes: 10 }),
          game({ appId: APP_B, playtimeMinutes: 20 }),
        ],
      },
      [STEAM_B]: {
        visibility: 'public',
        games: [game({ appId: APP_A, playtimeMinutes: 30 })],
      },
    })

    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam: client,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(summary.winsExamined).toBe(3)
    expect(summary.baselinesWritten).toBe(3)

    // Two unique users → exactly two getOwnedGames calls. User A's call
    // batches both appIds; user B's batches just the one.
    expect(calls).toHaveLength(2)
    const userACall = calls.find((c) => c.steamId === STEAM_A)
    const userBCall = calls.find((c) => c.steamId === STEAM_B)
    expect(userACall).toBeDefined()
    expect(userBCall).toBeDefined()
    expect([...(userACall?.appIds ?? [])].sort()).toEqual([APP_A, APP_B].sort())
    expect(userBCall?.appIds).toEqual([APP_A])
  })

  it('upserts only newly-seen achievements on subsequent polls', async () => {
    await seed(db)
    const initial: AchievementDetail[] = [
      {
        apiname: 'ACH_FIRST',
        achieved: true,
        unlockedAt: new Date('2026-04-20T00:00:00Z'),
        displayName: 'First',
        description: null,
      },
    ]
    const firstSteam = stubSteam(
      {
        [STEAM_A]: { visibility: 'public', games: [game({ appId: APP_A, playtimeMinutes: 30 })] },
      },
      { [APP_A]: initial },
    )
    const first = await pollPlaytime({
      db,
      dbWrite: db,
      steam: firstSteam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(first.achievementsUpserted).toBe(1)

    // Second poll: the existing achievement is cached (no write); a new
    // achievement appears (e.g. devs added one) and is upserted exactly once.
    const expanded: AchievementDetail[] = [
      ...initial,
      {
        apiname: 'ACH_NEW',
        achieved: false,
        unlockedAt: null,
        displayName: 'New',
        description: null,
      },
    ]
    const secondSteam = stubSteam(
      {
        [STEAM_A]: { visibility: 'public', games: [game({ appId: APP_A, playtimeMinutes: 30 })] },
      },
      { [APP_A]: expanded },
    )
    const second = await pollPlaytime({
      db,
      dbWrite: db,
      steam: secondSteam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })
    expect(second.achievementsUpserted).toBe(1)
  })

  it('records a revocation event when achieved goes true → false', async () => {
    await seed(db)
    const unlockedSteam = stubSteam(
      {
        [STEAM_A]: { visibility: 'public', games: [game({ appId: APP_A, playtimeMinutes: 90 })] },
      },
      {
        [APP_A]: [
          {
            apiname: 'ACH_KILL',
            achieved: true,
            unlockedAt: new Date('2026-04-20T00:00:00Z'),
            displayName: 'First Blood',
            description: null,
          },
        ],
      },
    )
    await pollPlaytime({
      db,
      dbWrite: db,
      steam: unlockedSteam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: fixedNow,
    })

    const revokedSteam = stubSteam(
      {
        [STEAM_A]: { visibility: 'public', games: [game({ appId: APP_A, playtimeMinutes: 90 })] },
      },
      {
        [APP_A]: [
          {
            apiname: 'ACH_KILL',
            achieved: false,
            unlockedAt: null,
            displayName: 'First Blood',
            description: null,
          },
        ],
      },
    )
    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam: revokedSteam,
      steamCommunity: stubSteamCommunity(),
      logger: silentLogger,
      now: () => new Date('2026-04-26T00:00:00Z'),
    })
    expect(summary.achievementEventsWritten).toBe(1) // the revocation
  })

  it('writes the screenshot count returned by the community scrape', async () => {
    const f = await seed(db)
    const steam = stubSteam({
      [STEAM_A]: { visibility: 'public', games: [game({ appId: APP_A, playtimeMinutes: 90 })] },
    })
    const steamCommunity = stubSteamCommunity({
      [`${STEAM_A}:${String(APP_A)}`]: ok(fakeScreenshots(4)),
    })
    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity,
      logger: silentLogger,
      now: fixedNow,
    })
    expect(summary.steamErrors).toBe(0)
    const win = await findWinByGiveawayAndUser(db, f.winFreshGiveawayId, f.winFreshUserId)
    expect(win?.screenshotCount).toBe(4)
  })

  it('writes null screenshot count and does not count an error when the per-game screenshot tab is private', async () => {
    const f = await seed(db)
    const steam = stubSteam({
      [STEAM_A]: { visibility: 'public', games: [game({ appId: APP_A, playtimeMinutes: 90 })] },
    })
    const steamCommunity = stubSteamCommunity({
      [`${STEAM_A}:${String(APP_A)}`]: err({ kind: 'profile_private' }),
    })
    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity,
      logger: silentLogger,
      now: fixedNow,
    })
    // Per-game privacy is expected, not an error condition.
    expect(summary.steamErrors).toBe(0)
    const win = await findWinByGiveawayAndUser(db, f.winFreshGiveawayId, f.winFreshUserId)
    expect(win?.screenshotCount).toBeNull()
  })

  it('counts a screenshot scrape http error in steamErrors and writes null', async () => {
    const f = await seed(db)
    const steam = stubSteam({
      [STEAM_A]: { visibility: 'public', games: [game({ appId: APP_A, playtimeMinutes: 90 })] },
    })
    const steamCommunity = stubSteamCommunity({
      [`${STEAM_A}:${String(APP_A)}`]: err({ kind: 'network', message: 'timeout' }),
    })
    const summary = await pollPlaytime({
      db,
      dbWrite: db,
      steam,
      steamCommunity,
      logger: silentLogger,
      now: fixedNow,
    })
    expect(summary.steamErrors).toBe(1)
    expect(summary.baselinesWritten).toBe(1) // the rest of the per-win pipeline still runs
    const win = await findWinByGiveawayAndUser(db, f.winFreshGiveawayId, f.winFreshUserId)
    expect(win?.screenshotCount).toBeNull()
  })
})
