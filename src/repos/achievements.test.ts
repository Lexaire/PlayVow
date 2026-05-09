import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { groups, steamAchievements } from '#/db/schema'
import type {
  SteamAppId,
  SteamGiftsGiveawayCode,
  SteamGiftsGroupCode,
  SteamGiftsUsername,
  SteamGroupId,
  SteamId,
} from '#/db/schema'
import {
  findLatestAchievementEvent,
  getCommonAchievementProgress,
  getCommonAchievementProgressBatch,
  listAchievementEventsByWin,
  recordAchievementStateIfChanged,
  upsertSteamAchievement,
} from '#/repos/achievements'
import { createTestDb } from '#/repos/__test__/db'
import { upsertGiveaway } from '#/repos/giveaways'
import { upsertSteamApp } from '#/repos/steamApps'
import { upsertUserBySgUsername } from '#/repos/users'
import { insertWinIfAbsent } from '#/repos/wins'

const APP_A = 12345 as SteamAppId

const NOW = new Date('2026-04-27T00:00:00Z')

type Fixture = {
  readonly userId: number
  readonly winId: number
  readonly achievementId: number
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
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: new Date('2026-01-08T00:00:00Z'),
    scrapedAt: new Date('2026-01-09T00:00:00Z'),
  })
  const winner = await upsertUserBySgUsername(db, {
    steamgiftsUsername: 'winner' as SteamGiftsUsername,
    steamId: '76561197960000001' as SteamId,
  })
  const win = await insertWinIfAbsent(db, {
    giveawayId: giveaway.id,
    userId: winner.id,
    wonAt: new Date('2026-01-08T00:00:00Z'),
    playDeadline: new Date('2026-04-08T00:00:00Z'),
  })
  if (!win) throw new Error('seed: insert win failed')
  const achievement = await upsertSteamAchievement(db, {
    appId: APP_A,
    apiname: 'ACH_1',
    displayName: null,
    description: null,
    lastSyncedAt: NOW,
  })
  return { userId: winner.id, winId: win.id, achievementId: achievement.id }
}

describe('upsertSteamAchievement', () => {
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

  it('inserts then updates the same row, coalescing nulls', async () => {
    await upsertSteamApp(db, { appId: APP_A, name: 'Game A' })
    const first = await upsertSteamAchievement(db, {
      appId: APP_A,
      apiname: 'ACH_1',
      displayName: 'Boom Headshot',
      description: 'Get a kill with a headshot',
      lastSyncedAt: NOW,
    })
    expect(first.displayName).toBe('Boom Headshot')

    // A later poll arrives with no display name (rare; older Steam cache).
    // Coalesce should preserve the existing value.
    const second = await upsertSteamAchievement(db, {
      appId: APP_A,
      apiname: 'ACH_1',
      displayName: null,
      description: null,
      lastSyncedAt: new Date(NOW.getTime() + 1000),
    })
    expect(second.displayName).toBe('Boom Headshot')
    expect(second.description).toBe('Get a kill with a headshot')
    expect(second.lastSyncedAt?.getTime()).toBe(NOW.getTime() + 1000)
  })
})

describe('recordAchievementStateIfChanged', () => {
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

  it('skips first-ever observation when achieved=false (locked-by-default)', async () => {
    const f = await seed(db)
    const r = await recordAchievementStateIfChanged(db, {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
      observedAt: NOW,
      achieved: false,
      unlockedAt: null,
    })
    expect(r.inserted).toBe(false)
    expect(await listAchievementEventsByWin(db, f.winId)).toHaveLength(0)
  })

  it('inserts on first-ever unlock', async () => {
    const f = await seed(db)
    const unlockedAt = new Date(NOW.getTime() - 86400000)
    const r = await recordAchievementStateIfChanged(db, {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
      observedAt: NOW,
      achieved: true,
      unlockedAt,
    })
    expect(r.inserted).toBe(true)
    const events = await listAchievementEventsByWin(db, f.winId)
    expect(events).toHaveLength(1)
    expect(events[0]?.achieved).toBe(true)
    expect(events[0]?.unlockedAt?.toISOString()).toBe(unlockedAt.toISOString())
  })

  it('does not duplicate when state is unchanged across polls', async () => {
    const f = await seed(db)
    const unlockedAt = new Date(NOW.getTime() - 86400000)
    const baseInput = {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
    }
    await recordAchievementStateIfChanged(db, {
      ...baseInput,
      observedAt: NOW,
      achieved: true,
      unlockedAt,
    })
    const second = await recordAchievementStateIfChanged(db, {
      ...baseInput,
      observedAt: new Date(NOW.getTime() + 60000),
      achieved: true,
      unlockedAt,
    })
    expect(second.inserted).toBe(false)
    expect(await listAchievementEventsByWin(db, f.winId)).toHaveLength(1)
  })

  it('inserts a revocation event when achieved goes true → false', async () => {
    const f = await seed(db)
    const baseInput = {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
    }
    await recordAchievementStateIfChanged(db, {
      ...baseInput,
      observedAt: NOW,
      achieved: true,
      unlockedAt: new Date(NOW.getTime() - 86400000),
    })
    const revoke = await recordAchievementStateIfChanged(db, {
      ...baseInput,
      observedAt: new Date(NOW.getTime() + 60000),
      achieved: false,
      unlockedAt: null,
    })
    expect(revoke.inserted).toBe(true)
    const events = await listAchievementEventsByWin(db, f.winId)
    expect(events).toHaveLength(2)
    // listAchievementEventsByWin orders DESC, so [0] is the most recent.
    expect(events[0]?.achieved).toBe(false)
    expect(events[0]?.unlockedAt).toBeNull()
  })

  it('inserts a re-unlock event when achieved goes false → true', async () => {
    const f = await seed(db)
    const baseInput = {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
    }
    await recordAchievementStateIfChanged(db, {
      ...baseInput,
      observedAt: NOW,
      achieved: true,
      unlockedAt: new Date(NOW.getTime() - 86400000),
    })
    await recordAchievementStateIfChanged(db, {
      ...baseInput,
      observedAt: new Date(NOW.getTime() + 60000),
      achieved: false,
      unlockedAt: null,
    })
    const r = await recordAchievementStateIfChanged(db, {
      ...baseInput,
      observedAt: new Date(NOW.getTime() + 180000),
      achieved: true,
      unlockedAt: new Date(NOW.getTime() + 120000),
    })
    expect(r.inserted).toBe(true)
    expect(await listAchievementEventsByWin(db, f.winId)).toHaveLength(3)
  })

  it('preserves achieved=true when unlockedAt is null (legacy pre-2010 unlock)', async () => {
    const f = await seed(db)
    const r = await recordAchievementStateIfChanged(db, {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
      observedAt: NOW,
      achieved: true,
      unlockedAt: null,
    })
    expect(r.inserted).toBe(true)
    const latest = await findLatestAchievementEvent(db, {
      userId: f.userId,
      achievementId: f.achievementId,
    })
    expect(latest?.achieved).toBe(true)
    expect(latest?.unlockedAt).toBeNull()
  })
})

describe('getCommonAchievementProgress', () => {
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

  it('returns no_achievements when the app has zero achievement rows', async () => {
    const f = await seed(db)
    // The seed creates ACH_1; remove it so the app is achievement-less.
    await db
      .delete(steamAchievements)
      .where(eq(steamAchievements.id, f.achievementId))
    const r = await getCommonAchievementProgress(db, { winId: f.winId, threshold: 50 })
    expect(r.status).toBe('no_achievements')
  })

  it('returns no_percent_data when achievements exist but none have been refreshed', async () => {
    const f = await seed(db)
    // Seed creates ACH_1 with percent_refreshed_at = null (default).
    const r = await getCommonAchievementProgress(db, { winId: f.winId, threshold: 50 })
    expect(r.status).toBe('no_percent_data')
  })

  it('counts only common achievements (>= threshold) and uses the latest event per achievement', async () => {
    const f = await seed(db)
    // Add two more achievements: one above threshold, one below.
    const aboveThreshold = await upsertSteamAchievement(db, {
      appId: APP_A,
      apiname: 'ACH_COMMON',
      displayName: null,
      description: null,
      lastSyncedAt: NOW,
    })
    const belowThreshold = await upsertSteamAchievement(db, {
      appId: APP_A,
      apiname: 'ACH_RARE',
      displayName: null,
      description: null,
      lastSyncedAt: NOW,
    })
    // Mark all three as refreshed; set percentages so two are common.
    await db
      .update(steamAchievements)
      .set({ globalPercent: 80, percentRefreshedAt: NOW })
      .where(eq(steamAchievements.id, f.achievementId))
    await db
      .update(steamAchievements)
      .set({ globalPercent: 65, percentRefreshedAt: NOW })
      .where(eq(steamAchievements.id, aboveThreshold.id))
    await db
      .update(steamAchievements)
      .set({ globalPercent: 12, percentRefreshedAt: NOW })
      .where(eq(steamAchievements.id, belowThreshold.id))

    // Unlock ACH_1 (common, 80%) and ACH_RARE (below threshold, ignored).
    await recordAchievementStateIfChanged(db, {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
      achieved: true,
      unlockedAt: NOW,
      observedAt: NOW,
    })
    await recordAchievementStateIfChanged(db, {
      userId: f.userId,
      achievementId: belowThreshold.id,
      winId: f.winId,
      achieved: true,
      unlockedAt: NOW,
      observedAt: NOW,
    })

    const r = await getCommonAchievementProgress(db, { winId: f.winId, threshold: 50 })
    expect(r.status).toBe('computed')
    if (r.status !== 'computed') return
    expect(r.threshold).toBe(50)
    expect(r.total).toBe(2) // ACH_1 + ACH_COMMON, ACH_RARE excluded
    expect(r.unlocked).toBe(1) // only ACH_1 was unlocked among the common ones
  })

  it('a revoked achievement does not count toward unlocked', async () => {
    const f = await seed(db)
    await db
      .update(steamAchievements)
      .set({ globalPercent: 90, percentRefreshedAt: NOW })
      .where(eq(steamAchievements.id, f.achievementId))

    // Unlock then revoke (Steam can revoke achievements; the latest event
    // wins).
    await recordAchievementStateIfChanged(db, {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
      achieved: true,
      unlockedAt: NOW,
      observedAt: NOW,
    })
    await recordAchievementStateIfChanged(db, {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
      achieved: false,
      unlockedAt: null,
      observedAt: new Date(NOW.getTime() + 60_000),
    })

    const r = await getCommonAchievementProgress(db, { winId: f.winId, threshold: 50 })
    expect(r.status).toBe('computed')
    if (r.status !== 'computed') return
    expect(r.total).toBe(1)
    expect(r.unlocked).toBe(0)
  })

  it('returns total=0 when no achievements meet the threshold (still computed)', async () => {
    const f = await seed(db)
    // Refreshed but below threshold.
    await db
      .update(steamAchievements)
      .set({ globalPercent: 10, percentRefreshedAt: NOW })
      .where(eq(steamAchievements.id, f.achievementId))
    const r = await getCommonAchievementProgress(db, { winId: f.winId, threshold: 50 })
    expect(r.status).toBe('computed')
    if (r.status !== 'computed') return
    expect(r.total).toBe(0)
    expect(r.unlocked).toBe(0)
  })
})

describe('getCommonAchievementProgressBatch', () => {
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

  it('returns an empty map when given no winIds', async () => {
    const r = await getCommonAchievementProgressBatch(db, { winIds: [], threshold: 50 })
    expect(r.size).toBe(0)
  })

  it('produces the same result per win as the single-win helper', async () => {
    const f = await seed(db)
    // Mark the seeded achievement as common and unlock it.
    await db
      .update(steamAchievements)
      .set({ globalPercent: 80, percentRefreshedAt: NOW })
      .where(eq(steamAchievements.id, f.achievementId))
    await recordAchievementStateIfChanged(db, {
      userId: f.userId,
      achievementId: f.achievementId,
      winId: f.winId,
      achieved: true,
      unlockedAt: NOW,
      observedAt: NOW,
    })

    const single = await getCommonAchievementProgress(db, {
      winId: f.winId,
      threshold: 50,
    })
    const batch = await getCommonAchievementProgressBatch(db, {
      winIds: [f.winId],
      threshold: 50,
    })
    // Same shape for the same input — batch is purely an optimization.
    expect(batch.get(f.winId)).toEqual(single)
  })
})
