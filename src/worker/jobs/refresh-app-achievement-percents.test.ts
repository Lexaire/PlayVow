import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import type { SteamAppId } from '#/db/schema'
import { steamApps, steamAchievements } from '#/db/schema'
import type { GlobalAchievementPercent, SteamApiClient, SteamApiError } from '#/external/steam-api'
import { createLogger } from '#/lib/logger'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { createTestDb } from '#/repos/__test__/db'
import { refreshAppAchievementPercentsJob } from '#/worker/jobs/refresh-app-achievement-percents'

const APP_A = 11111 as SteamAppId
const APP_B = 22222 as SteamAppId

const NOW = new Date('2026-05-09T12:00:00Z')
const fixedNow = (): Date => NOW

// Default tests run with the production 90-day staleness floor; targeted
// tests pass a smaller value to exercise the cutoff explicitly.
const DEFAULT_INTERVAL_DAYS = 90

const seed = async (db: Db): Promise<void> => {
  await db.insert(steamApps).values([
    { appId: APP_A, name: 'Game A' },
    { appId: APP_B, name: 'Game B' },
  ])
  await db.insert(steamAchievements).values([
    { appId: APP_A, apiname: 'A_FIRST', displayName: 'First A', description: null },
    { appId: APP_A, apiname: 'A_SECOND', displayName: 'Second A', description: null },
    { appId: APP_B, apiname: 'B_FIRST', displayName: 'First B', description: null },
  ])
}

type CallRecord = { readonly appId: SteamAppId }

const recordingSteam = (
  responsesByApp: Readonly<
    Record<string, Result<ReadonlyArray<GlobalAchievementPercent>, SteamApiError>>
  >,
): { client: SteamApiClient; calls: ReadonlyArray<CallRecord> } => {
  const calls: CallRecord[] = []
  const client: SteamApiClient = {
    getGlobalAchievementPercents: (appId) => {
      calls.push({ appId })
      const r = responsesByApp[String(appId)]
      if (r === undefined) {
        throw new Error(`unexpected getGlobalAchievementPercents(${String(appId)})`)
      }
      return Promise.resolve(r)
    },
    getOwnedGames: () => {
      throw new Error('getOwnedGames not used in this test')
    },
    getPlayerAchievements: () => {
      throw new Error('getPlayerAchievements not used in this test')
    },
    getStoreItems: () => {
      throw new Error('getStoreItems not used in this test')
    },
    resolveVanityUrl: () => {
      throw new Error('resolveVanityUrl not used in this test')
    },
  }
  return { client, calls }
}

const silentLogger = createLogger({ write: () => {} })

const findAchievement = async (db: Db, appId: SteamAppId, apiname: string) => {
  const [row] = await db
    .select()
    .from(steamAchievements)
    .where(eq(steamAchievements.apiname, apiname))
    .limit(1)
  if (!row || row.appId !== appId) throw new Error('not found')
  return row
}

describe('refreshAppAchievementPercentsJob', () => {
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

  it('populates global_percent + percent_refreshed_at on first run', async () => {
    await seed(db)
    const { client, calls } = recordingSteam({
      [APP_A]: ok([
        { apiname: 'A_FIRST', percent: 75.5 },
        { apiname: 'A_SECOND', percent: 12.3 },
      ]),
      [APP_B]: ok([{ apiname: 'B_FIRST', percent: 60.0 }]),
    })

    const summary = await refreshAppAchievementPercentsJob({
      db,
      dbWrite: db,
      steam: client,
      logger: silentLogger,
      now: fixedNow,
    })

    // Both apps were polled exactly once.
    expect(calls).toHaveLength(2)
    expect(summary.appsExamined).toBe(2)
    expect(summary.appsRefreshed).toBe(2)
    expect(summary.rowsUpdated).toBe(3)

    const a1 = await findAchievement(db, APP_A, 'A_FIRST')
    expect(a1.globalPercent).toBe(75.5)
    expect(a1.percentRefreshedAt?.toISOString()).toBe(NOW.toISOString())

    const a2 = await findAchievement(db, APP_A, 'A_SECOND')
    expect(a2.globalPercent).toBe(12.3)
  })

  it('is a no-op within the 90-day staleness window', async () => {
    await seed(db)
    // First run populates everything.
    const first = recordingSteam({
      [APP_A]: ok([
        { apiname: 'A_FIRST', percent: 75.5 },
        { apiname: 'A_SECOND', percent: 12.3 },
      ]),
      [APP_B]: ok([{ apiname: 'B_FIRST', percent: 60.0 }]),
    })
    await refreshAppAchievementPercentsJob({
      db,
      dbWrite: db,
      steam: first.client,
      logger: silentLogger,
      now: fixedNow,
    })

    // Second run a day later: nothing should be re-polled or re-written.
    const oneDayLater = new Date(NOW.getTime() + 24 * 60 * 60 * 1000)
    const second = recordingSteam({}) // no responses configured = throw if asked
    const summary = await refreshAppAchievementPercentsJob({
      db,
      dbWrite: db,
      steam: second.client,
      logger: silentLogger,
      now: () => oneDayLater,
      refreshIntervalDays: DEFAULT_INTERVAL_DAYS,
    })

    expect(second.calls).toHaveLength(0)
    expect(summary.appsExamined).toBe(0)
    expect(summary.appsRefreshed).toBe(0)
  })

  it('refreshes again once the staleness floor is crossed', async () => {
    await seed(db)
    const first = recordingSteam({
      [APP_A]: ok([
        { apiname: 'A_FIRST', percent: 50.0 },
        { apiname: 'A_SECOND', percent: 5.0 },
      ]),
      [APP_B]: ok([{ apiname: 'B_FIRST', percent: 30.0 }]),
    })
    await refreshAppAchievementPercentsJob({
      db,
      dbWrite: db,
      steam: first.client,
      logger: silentLogger,
      now: fixedNow,
    })

    // 100 days later — past the 90-day floor.
    const future = new Date(NOW.getTime() + 100 * 24 * 60 * 60 * 1000)
    const second = recordingSteam({
      [APP_A]: ok([
        { apiname: 'A_FIRST', percent: 55.0 },
        { apiname: 'A_SECOND', percent: 6.0 },
      ]),
      [APP_B]: ok([{ apiname: 'B_FIRST', percent: 32.0 }]),
    })
    const summary = await refreshAppAchievementPercentsJob({
      db,
      dbWrite: db,
      steam: second.client,
      logger: silentLogger,
      now: () => future,
      refreshIntervalDays: DEFAULT_INTERVAL_DAYS,
    })

    expect(summary.appsExamined).toBe(2)
    expect(summary.appsRefreshed).toBe(2)
    const updated = await findAchievement(db, APP_A, 'A_FIRST')
    expect(updated.globalPercent).toBe(55.0)
    expect(updated.percentRefreshedAt?.toISOString()).toBe(future.toISOString())
  })

  it('continues past one app erroring; reports the count', async () => {
    await seed(db)
    const { client } = recordingSteam({
      [APP_A]: err({ kind: 'network', message: 'down' }),
      [APP_B]: ok([{ apiname: 'B_FIRST', percent: 60.0 }]),
    })
    const summary = await refreshAppAchievementPercentsJob({
      db,
      dbWrite: db,
      steam: client,
      logger: silentLogger,
      now: fixedNow,
    })

    expect(summary.appsErrored).toBe(1)
    expect(summary.appsRefreshed).toBe(1)
    expect(summary.rowsUpdated).toBe(1)

    // App A: nothing written, still null on next run candidate list.
    const aRow = await findAchievement(db, APP_A, 'A_FIRST')
    expect(aRow.globalPercent).toBeNull()
    expect(aRow.percentRefreshedAt).toBeNull()

    // App B: written.
    const bRow = await findAchievement(db, APP_B, 'B_FIRST')
    expect(bRow.globalPercent).toBe(60.0)
  })

  it('treats an empty response (Steam 403) as no_data: bumps timestamp, leaves percent null', async () => {
    await seed(db)
    const { client } = recordingSteam({
      [APP_A]: ok([]),
      [APP_B]: ok([{ apiname: 'B_FIRST', percent: 60.0 }]),
    })
    const summary = await refreshAppAchievementPercentsJob({
      db,
      dbWrite: db,
      steam: client,
      logger: silentLogger,
      now: fixedNow,
    })

    expect(summary.appsNoData).toBe(1)
    expect(summary.appsRefreshed).toBe(1)

    // App A's rows: percent stayed null but timestamp was bumped, so the
    // row falls out of the next refresh candidate list.
    const aRow = await findAchievement(db, APP_A, 'A_FIRST')
    expect(aRow.globalPercent).toBeNull()
    expect(aRow.percentRefreshedAt?.toISOString()).toBe(NOW.toISOString())
  })

  it('respects maxAppsPerTick and rolls remaining work to next tick', async () => {
    await seed(db)
    const { client, calls } = recordingSteam({
      [APP_A]: ok([{ apiname: 'A_FIRST', percent: 50.0 }]),
      [APP_B]: ok([{ apiname: 'B_FIRST', percent: 60.0 }]),
    })
    const summary = await refreshAppAchievementPercentsJob({
      db,
      dbWrite: db,
      steam: client,
      logger: silentLogger,
      now: fixedNow,
      maxAppsPerTick: 1,
    })
    expect(calls).toHaveLength(1)
    expect(summary.appsExamined).toBe(1)
  })
})
