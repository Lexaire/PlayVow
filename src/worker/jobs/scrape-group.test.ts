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
import type { SgClient, SgGiveawayRow, SgProfile } from '#/external/steamgifts'
import { createLogger } from '#/lib/logger'
import { ok } from '#/lib/result'
import { createTestDb } from '#/repos/__test__/db'
import { findGiveawayByGroupAndCode } from '#/repos/giveaways'
import type { Group } from '#/repos/groups'
import { findGroupBySlug } from '#/repos/groups'
import { findUserBySteamgiftsUsername } from '#/repos/users'
import { findWinByGiveawayAndUser } from '#/repos/wins'
import { scrapeGroup } from '#/worker/jobs/scrape-group'

const APP_A = 12345 as SteamAppId
const APP_B = 67890 as SteamAppId
const STEAM_A = '76561197960000001' as SteamId
const STEAM_B = '76561197960000002' as SteamId
const STEAM_MOD = '76561197960000099' as SteamId
const CODE_A = 'gA001' as SteamGiftsGiveawayCode
const CODE_B = 'gB002' as SteamGiftsGiveawayCode
const u = (s: string): SteamGiftsUsername => s as SteamGiftsUsername

const seedTaleplay = async (db: Db): Promise<Group> => {
  await db.insert(groups).values({
    slug: 'taleplay',
    name: 'TalePlay',
    playWindowDays: 90,
    steamgiftsGroupCode: 'xBp7E' as SteamGiftsGroupCode,
    steamGroupId: '1' as SteamGroupId,
    steamGroupSlug: 'taleplay',
    description: null,
  })
  const g = await findGroupBySlug(db, 'taleplay')
  if (!g) throw new Error('seed: no group')
  return g
}

const giveawayRow = (overrides: Partial<SgGiveawayRow>): SgGiveawayRow => ({
  giveawayCode: CODE_A,
  giveawaySlug: 'game-a',
  title: 'Game A',
  steamRef: { kind: 'app', appId: APP_A },
  quantity: 1,
  creatorUsername: u('mod'),
  startedAt: new Date('2026-01-01T00:00:00Z'),
  endedAt: new Date('2026-01-08T00:00:00Z'),
  winners: [u('robin')],
  noWinners: false,
  ...overrides,
})

const profile = (sgUsername: string, steamId: SteamId): SgProfile => ({
  steamgiftsUsername: u(sgUsername),
  steamId,
  avatarUrl: `https://avatar/${sgUsername}.jpg`,
  personaName: sgUsername,
})

const stubSg = (
  pageRows: ReadonlyArray<SgGiveawayRow>,
  profiles: Readonly<Record<string, SgProfile>>,
): SgClient => ({
  hasCookie: true,
  getGroupGiveaways: () =>
    Promise.resolve(ok({ rows: pageRows, hasNextPage: false, signedOut: false })),
  getGiveawayWinners: () => Promise.resolve(ok({ activated: [], awaitingCount: 0 })),
  getProfile: (username) => {
    const p = profiles[username]
    if (!p) throw new Error(`unexpected getProfile(${username})`)
    return Promise.resolve(ok(p))
  },
})

const silentLogger = createLogger({ write: () => {} })

describe('scrapeGroup', () => {
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

  it('writes a new win for each winner across multiple giveaways and records creators', async () => {
    const group = await seedTaleplay(db)
    const sg = stubSg(
      [
        giveawayRow({}),
        giveawayRow({
          giveawayCode: CODE_B,
          giveawaySlug: 'game-b',
          title: 'Game B',
          steamRef: { kind: 'app', appId: APP_B },
          winners: [u('kira')],
        }),
      ],
      {
        mod: profile('mod', STEAM_MOD),
        robin: profile('robin', STEAM_A),
        kira: profile('kira', STEAM_B),
      },
    )

    const result = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(result.giveawaysSeen).toBe(2)
    expect(result.giveawaysCreatedOrUpdated).toBe(2)
    expect(result.winsCreated).toBe(2)
    expect(result.winsExisting).toBe(0)
    expect(result.winnerErrors).toBe(0)
    expect(result.creatorErrors).toBe(0)

    const robin = await findUserBySteamgiftsUsername(db, u('robin'))
    expect(robin?.steamId).toBe(STEAM_A)
    expect(robin?.avatarUrl).toBe('https://avatar/robin.jpg')

    const giveawayA = await findGiveawayByGroupAndCode(db, group.id, CODE_A)
    const mod = await findUserBySteamgiftsUsername(db, u('mod'))
    expect(giveawayA?.creatorUserId).toBe(mod?.id)
  })

  it('records giveaways with no winners (in-progress or empty draws) without inserting wins', async () => {
    const group = await seedTaleplay(db)
    const sg = stubSg(
      [giveawayRow({ winners: [] }), giveawayRow({ giveawayCode: CODE_B, winners: [u('robin')] })],
      {
        mod: profile('mod', STEAM_MOD),
        robin: profile('robin', STEAM_A),
      },
    )

    const result = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(result.giveawaysSeen).toBe(2)
    expect(result.giveawaysCreatedOrUpdated).toBe(2)
    expect(result.winnersSeen).toBe(1)
    expect(result.winsCreated).toBe(1)

    const empty = await findGiveawayByGroupAndCode(db, group.id, CODE_A)
    expect(empty).not.toBeNull()
    if (!empty) return
    const mod = await findUserBySteamgiftsUsername(db, u('mod'))
    expect(empty.creatorUserId).toBe(mod?.id)
  })

  it('records sub-style giveaways and their winners (no playtime polling though)', async () => {
    const group = await seedTaleplay(db)
    const sg = stubSg(
      [giveawayRow({ steamRef: { kind: 'sub', subId: 999 }, winners: [u('robin')] })],
      {
        mod: profile('mod', STEAM_MOD),
        robin: profile('robin', STEAM_A),
      },
    )
    const result = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(result.giveawaysCreatedOrUpdated).toBe(1)
    expect(result.winnersSeen).toBe(1)
    expect(result.winsCreated).toBe(1)

    const giveaway = await findGiveawayByGroupAndCode(db, group.id, CODE_A)
    expect(giveaway?.steamAppId).toBeNull()
    expect(giveaway?.steamSubId).toBe(999)
  })

  it('fetches the dedicated winners page when listing shows fewer winners than copies', async () => {
    const group = await seedTaleplay(db)
    let getWinnersCalls = 0
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(
          ok({
            rows: [giveawayRow({ quantity: 3, winners: [u('robin')] })],
            hasNextPage: false,
            signedOut: false,
          }),
        ),
      getGiveawayWinners: () => {
        getWinnersCalls += 1
        return Promise.resolve(
          ok({ activated: [u('robin'), u('kira'), u('alice')], awaitingCount: 0 }),
        )
      },
      getProfile: (username) => {
        const profiles: Record<string, SgProfile> = {
          mod: profile('mod', STEAM_MOD),
          robin: profile('robin', STEAM_A),
          kira: profile('kira', STEAM_B),
          alice: profile('alice', '76561197960000003' as SteamId),
        }
        const p = profiles[username]
        if (!p) throw new Error(`unexpected getProfile(${username})`)
        return Promise.resolve(ok(p))
      },
    }

    const result = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(getWinnersCalls).toBe(1)
    expect(result.winnersSeen).toBe(3)
    expect(result.winsCreated).toBe(3)

    const giveaway = await findGiveawayByGroupAndCode(db, group.id, CODE_A)
    expect(giveaway?.winnersScrapedAt).not.toBeNull()
  })

  it('does not re-fire inline winners fetch on subsequent scrapes once settled', async () => {
    // Listing always shows ≤2 winners regardless of quantity, so a settled
    // 5-copy giveaway with all 5 winners revealed will still appear partial
    // on every future scrape — without short-circuiting we'd burn a request.
    const group = await seedTaleplay(db)
    let getWinnersCalls = 0
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(
          ok({
            rows: [
              giveawayRow({
                quantity: 5,
                winners: [u('robin'), u('kira')],
              }),
            ],
            hasNextPage: false,
            signedOut: false,
          }),
        ),
      getGiveawayWinners: () => {
        getWinnersCalls += 1
        return Promise.resolve(
          ok({
            activated: [u('robin'), u('kira'), u('alice')],
            awaitingCount: 0,
          }),
        )
      },
      getProfile: (username) => {
        const profiles: Record<string, SgProfile> = {
          mod: profile('mod', STEAM_MOD),
          robin: profile('robin', STEAM_A),
          kira: profile('kira', STEAM_B),
          alice: profile('alice', '76561197960000003' as SteamId),
        }
        const p = profiles[username]
        if (!p) throw new Error(`unexpected getProfile(${username})`)
        return Promise.resolve(ok(p))
      },
    }

    const first = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(getWinnersCalls).toBe(1)
    expect(first.giveawaysCreatedOrUpdated).toBe(1)
    expect(first.giveawaysSkipped).toBe(0)

    const second = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(getWinnersCalls).toBe(1) // unchanged — short-circuit prevented re-fetch
    expect(second.giveawaysCreatedOrUpdated).toBe(0)
    expect(second.giveawaysSkipped).toBe(1)
  })

  it('settles a multi-copy giveaway with fewer actual winners than quantity', async () => {
    // 2-copy giveaway, only 1 entry → 1 actual winner forever, no awaiting.
    const group = await seedTaleplay(db)
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(
          ok({
            rows: [giveawayRow({ quantity: 2, winners: [u('robin')] })],
            hasNextPage: false,
            signedOut: false,
          }),
        ),
      getGiveawayWinners: () => Promise.resolve(ok({ activated: [u('robin')], awaitingCount: 0 })),
      getProfile: (username) => {
        const sid = username === 'mod' ? STEAM_MOD : STEAM_A
        return Promise.resolve(ok(profile(username, sid)))
      },
    }
    await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    const giveaway = await findGiveawayByGroupAndCode(db, group.id, CODE_A)
    expect(giveaway?.winnersScrapedAt).not.toBeNull()
  })

  it('leaves giveaway unsettled when dedicated page reports awaiting feedback', async () => {
    const group = await seedTaleplay(db)
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(
          ok({
            rows: [giveawayRow({ quantity: 3, winners: [u('robin')] })],
            hasNextPage: false,
            signedOut: false,
          }),
        ),
      getGiveawayWinners: () => Promise.resolve(ok({ activated: [u('robin')], awaitingCount: 2 })),
      getProfile: (username) => {
        const sid = username === 'mod' ? STEAM_MOD : STEAM_A
        return Promise.resolve(ok(profile(username, sid)))
      },
    }
    await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    const giveaway = await findGiveawayByGroupAndCode(db, group.id, CODE_A)
    expect(giveaway?.winnersScrapedAt).toBeNull()
  })

  it('does not fetch dedicated winners page when listing winners match quantity', async () => {
    const group = await seedTaleplay(db)
    let getWinnersCalls = 0
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(
          ok({
            rows: [giveawayRow({ quantity: 1, winners: [u('robin')] })],
            hasNextPage: false,
            signedOut: false,
          }),
        ),
      getGiveawayWinners: () => {
        getWinnersCalls += 1
        return Promise.resolve(ok({ activated: [], awaitingCount: 0 }))
      },
      getProfile: (username) => {
        const sid = username === 'mod' ? STEAM_MOD : STEAM_A
        return Promise.resolve(ok(profile(username, sid)))
      },
    }
    await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(getWinnersCalls).toBe(0)
  })

  it('reuses cached SG profile for already-known users without calling getProfile', async () => {
    const group = await seedTaleplay(db)
    let getProfileCalls = 0
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(ok({ rows: [giveawayRow({})], hasNextPage: false, signedOut: false })),
      getGiveawayWinners: () => Promise.resolve(ok({ activated: [], awaitingCount: 0 })),
      getProfile: (username) => {
        getProfileCalls += 1
        const sid = username === 'mod' ? STEAM_MOD : STEAM_A
        return Promise.resolve(ok(profile(username, sid)))
      },
    }

    const first = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    const second = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(first.winsCreated).toBe(1)
    // Second scrape short-circuits via winnersScrapedAt — no re-ingestion.
    expect(second.giveawaysSkipped).toBe(1)
    expect(second.winsCreated).toBe(0)
    expect(second.winsExisting).toBe(0)
    // 2 unique users (mod + robin) fetched on first scrape; cached for second
    // (which doesn't even reach profile lookup thanks to the short-circuit).
    expect(getProfileCalls).toBe(2)
  })

  it('returns an empty summary when SG returns an empty signed-out listing', async () => {
    // Listings used to short-circuit with login_required when the nav showed
    // sign-in. Per the resilience rework, listings are now treated as public
    // (they are, in fact, public on SG); an empty + signed-out response just
    // means no rows + a warning log. Cookie health is not affected.
    const group = await seedTaleplay(db)
    const sg: SgClient = {
      hasCookie: false,
      getGroupGiveaways: () =>
        Promise.resolve(ok({ rows: [], hasNextPage: false, signedOut: true })),
      getGiveawayWinners: () => Promise.resolve(ok({ activated: [], awaitingCount: 0 })),
      getProfile: () => Promise.resolve(ok(profile('mod', STEAM_MOD))),
    }
    const result = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(result.giveawaysSeen).toBe(0)
    expect(result.giveawaysCreatedOrUpdated).toBe(0)
    expect(result.winsCreated).toBe(0)
  })

  it('records the giveaway with a stub creator when the SG profile is permanently gone', async () => {
    const group = await seedTaleplay(db)
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(
          ok({
            rows: [giveawayRow({ creatorUsername: u('ghost'), winners: [] })],
            hasNextPage: false,
            signedOut: false,
          }),
        ),
      getGiveawayWinners: () => Promise.resolve(ok({ activated: [], awaitingCount: 0 })),
      getProfile: (u) => {
        if (u === 'ghost') {
          return Promise.resolve({
            ok: false,
            error: { kind: 'parse_failed', message: 'no link' } as const,
          })
        }
        return Promise.resolve(ok(profile(u, STEAM_A)))
      },
    }
    const result = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(result.giveawaysCreatedOrUpdated).toBe(1)
    expect(result.creatorErrors).toBe(0)

    const ghost = await findUserBySteamgiftsUsername(db, u('ghost'))
    expect(ghost).not.toBeNull()
    expect(ghost?.steamId).toBeNull()
    expect(ghost?.avatarUrl).toBeNull()

    const giveaway = await findGiveawayByGroupAndCode(db, group.id, CODE_A)
    expect(giveaway).not.toBeNull()
  })

  it('skips a giveaway when the creator profile fails with a transient error', async () => {
    const group = await seedTaleplay(db)
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(
          ok({
            rows: [giveawayRow({ creatorUsername: u('ghost') })],
            hasNextPage: false,
            signedOut: false,
          }),
        ),
      getGiveawayWinners: () => Promise.resolve(ok({ activated: [], awaitingCount: 0 })),
      getProfile: (u) => {
        if (u === 'ghost') {
          return Promise.resolve({
            ok: false,
            error: { kind: 'network', message: 'ECONNRESET' } as const,
          })
        }
        return Promise.resolve(ok(profile(u, STEAM_A)))
      },
    }
    const result = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(result.giveawaysCreatedOrUpdated).toBe(0)
    expect(result.creatorErrors).toBe(1)
    expect(result.winsCreated).toBe(0)
  })

  it('records a stub winner when their profile is permanently gone, alongside resolved winners', async () => {
    const group = await seedTaleplay(db)
    const sg: SgClient = {
      hasCookie: true,
      getGroupGiveaways: () =>
        Promise.resolve(
          ok({
            rows: [giveawayRow({ winners: [u('ghost'), u('kira')] })],
            hasNextPage: false,
            signedOut: false,
          }),
        ),
      getGiveawayWinners: () => Promise.resolve(ok({ activated: [], awaitingCount: 0 })),
      getProfile: (u) => {
        if (u === 'ghost') {
          return Promise.resolve({
            ok: false,
            error: { kind: 'parse_failed', message: 'no link' } as const,
          })
        }
        const sid = u === 'mod' ? STEAM_MOD : STEAM_B
        return Promise.resolve(ok(profile(u, sid)))
      },
    }

    const result = await scrapeGroup({ db, dbWrite: db, sg, logger: silentLogger }, group)
    expect(result.winnersSeen).toBe(2)
    expect(result.winnerErrors).toBe(0)
    expect(result.winsCreated).toBe(2)

    const giveaway = await findGiveawayByGroupAndCode(db, group.id, CODE_A)
    expect(giveaway).not.toBeNull()
    if (!giveaway) return

    const ghost = await findUserBySteamgiftsUsername(db, u('ghost'))
    expect(ghost).not.toBeNull()
    expect(ghost?.steamId).toBeNull()
    if (!ghost) return
    const ghostWin = await findWinByGiveawayAndUser(db, giveaway.id, ghost.id)
    expect(ghostWin).not.toBeNull()

    const kira = await findUserBySteamgiftsUsername(db, u('kira'))
    expect(kira).not.toBeNull()
    if (!kira) return
    const kiraWin = await findWinByGiveawayAndUser(db, giveaway.id, kira.id)
    expect(kiraWin).not.toBeNull()
  })
})
