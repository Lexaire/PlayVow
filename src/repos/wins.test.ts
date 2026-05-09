import { eq } from 'drizzle-orm'
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
import { upsertGiveaway } from '#/repos/giveaways'
import { upsertSteamApp } from '#/repos/steamApps'
import { upsertUserBySgUsername } from '#/repos/users'
import {
  findWinByGiveawayAndUser,
  insertWinIfAbsent,
  listPendingForPlaytimePoll,
  listPendingPastDeadlineByGroup,
  listRecentWinsByGroup,
  listWinObservations,
  recordWinPlaytimeBaseline,
  recordWinPlaytimeProgress,
  updateWinNotes,
  updateWinStatus,
} from '#/repos/wins'

const APP_A = 12345 as SteamAppId
const STEAM_A = '76561197960000001' as SteamId
const STEAM_B = '76561197960000002' as SteamId

const PLAYTIME_DETAIL_NULLS = {
  playtime2WeeksMinutes: null,
} as const

type Fixture = {
  readonly groupId: number
  readonly giveawayIdA: number
  readonly userIdA: number
  readonly userIdB: number
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
  const userA = await upsertUserBySgUsername(db, {
    steamgiftsUsername: 'a' as SteamGiftsUsername,
    steamId: STEAM_A,
  })
  const userB = await upsertUserBySgUsername(db, {
    steamgiftsUsername: 'b' as SteamGiftsUsername,
    steamId: STEAM_B,
  })
  return {
    groupId: groupRow.id,
    giveawayIdA: giveaway.id,
    userIdA: userA.id,
    userIdB: userB.id,
  }
}

describe('winsRepo', () => {
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

  it('insertWinIfAbsent inserts on first call, returns null on conflict', async () => {
    const f = await seed(db)
    const first = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    expect(first?.status).toBe('pending')
    const dup = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    expect(dup).toBeNull()
  })

  it('findWinByGiveawayAndUser finds the inserted win', async () => {
    const f = await seed(db)
    const inserted = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    const found = await findWinByGiveawayAndUser(db, f.giveawayIdA, f.userIdA)
    expect(found?.id).toBe(inserted?.id)
  })

  it('updateWinStatus sets status and resolvedAt', async () => {
    const f = await seed(db)
    const inserted = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    if (!inserted) throw new Error('insert failed')
    const resolvedAt = new Date('2026-02-01T00:00:00Z')
    const updated = await updateWinStatus(db, inserted.id, 'played', resolvedAt)
    expect(updated.status).toBe('played')
    expect(updated.resolvedAt?.toISOString()).toBe(resolvedAt.toISOString())
  })

  it('updateWinNotes updates and clears notes', async () => {
    const f = await seed(db)
    const inserted = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    if (!inserted) throw new Error('insert failed')
    const set = await updateWinNotes(db, inserted.id, 'reminder sent')
    expect(set.modNotes).toBe('reminder sent')
    const cleared = await updateWinNotes(db, inserted.id, null)
    expect(cleared.modNotes).toBeNull()
  })

  it('recordWinPlaytimeBaseline writes baseline + current + checkedAt', async () => {
    const f = await seed(db)
    const inserted = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    if (!inserted) throw new Error('insert failed')
    const checkedAt = new Date('2026-01-09T00:00:00Z')
    const r = await recordWinPlaytimeBaseline(db, inserted.id, {
      playtimeAtWinMinutes: 120,
      currentPlaytimeMinutes: 120,
      ...PLAYTIME_DETAIL_NULLS,
      hasReview: false,
      screenshotCount: 0,
      achievementsUnlocked: null,
      achievementsTotal: null,
      checkedAt,
    })
    expect(r.win.playtimeAtWinMinutes).toBe(120)
    expect(r.win.currentPlaytimeMinutes).toBe(120)
    expect(r.win.lastCheckedAt?.toISOString()).toBe(checkedAt.toISOString())
    expect(r.observationWritten).toBe(true)
  })

  it('recordWinPlaytimeProgress does not overwrite the baseline', async () => {
    const f = await seed(db)
    const inserted = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    if (!inserted) throw new Error('insert failed')
    await recordWinPlaytimeBaseline(db, inserted.id, {
      playtimeAtWinMinutes: 120,
      currentPlaytimeMinutes: 120,
      ...PLAYTIME_DETAIL_NULLS,
      hasReview: false,
      screenshotCount: 0,
      achievementsUnlocked: null,
      achievementsTotal: null,
      checkedAt: new Date('2026-01-09T00:00:00Z'),
    })
    const progressed = await recordWinPlaytimeProgress(db, inserted.id, {
      currentPlaytimeMinutes: 240,
      ...PLAYTIME_DETAIL_NULLS,
      hasReview: true,
      screenshotCount: 3,
      achievementsUnlocked: null,
      achievementsTotal: null,
      checkedAt: new Date('2026-01-15T00:00:00Z'),
    })
    expect(progressed.changed).toBe(true)
    expect(progressed.win.playtimeAtWinMinutes).toBe(120)
    expect(progressed.win.currentPlaytimeMinutes).toBe(240)
    expect(progressed.win.hasReview).toBe(true)
  })

  it('recordWinPlaytimeBaseline always inserts one observation row', async () => {
    const f = await seed(db)
    const inserted = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    if (!inserted) throw new Error('insert failed')
    const checkedAt = new Date('2026-01-09T00:00:00Z')
    await recordWinPlaytimeBaseline(db, inserted.id, {
      playtimeAtWinMinutes: 60,
      currentPlaytimeMinutes: 60,
      ...PLAYTIME_DETAIL_NULLS,
      hasReview: null,
      screenshotCount: null,
      achievementsUnlocked: 2,
      achievementsTotal: 10,
      checkedAt,
    })
    const obs = await listWinObservations(db, inserted.id)
    expect(obs).toHaveLength(1)
    expect(obs[0]?.currentPlaytimeMinutes).toBe(60)
    expect(obs[0]?.achievementsUnlocked).toBe(2)
    expect(obs[0]?.observedAt).toEqual(checkedAt)
  })

  it('recordWinPlaytimeProgress inserts an observation only when something changes', async () => {
    const f = await seed(db)
    const inserted = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    if (!inserted) throw new Error('insert failed')
    await recordWinPlaytimeBaseline(db, inserted.id, {
      playtimeAtWinMinutes: 100,
      currentPlaytimeMinutes: 100,
      ...PLAYTIME_DETAIL_NULLS,
      hasReview: null,
      screenshotCount: null,
      achievementsUnlocked: null,
      achievementsTotal: null,
      checkedAt: new Date('2026-01-09T00:00:00Z'),
    })
    // baseline inserted one observation
    expect(await listWinObservations(db, inserted.id)).toHaveLength(1)

    // no-change poll: no observation inserted, but lastCheckedAt still updates
    const noChange = await recordWinPlaytimeProgress(db, inserted.id, {
      currentPlaytimeMinutes: 100,
      ...PLAYTIME_DETAIL_NULLS,
      hasReview: null,
      screenshotCount: null,
      achievementsUnlocked: null,
      achievementsTotal: null,
      checkedAt: new Date('2026-01-10T00:00:00Z'),
    })
    expect(noChange.changed).toBe(false)
    expect(noChange.win.lastCheckedAt).toEqual(new Date('2026-01-10T00:00:00Z'))
    expect(await listWinObservations(db, inserted.id)).toHaveLength(1)

    // playtime change: observation inserted
    const playtimeBump = await recordWinPlaytimeProgress(db, inserted.id, {
      currentPlaytimeMinutes: 180,
      ...PLAYTIME_DETAIL_NULLS,
      hasReview: null,
      screenshotCount: null,
      achievementsUnlocked: null,
      achievementsTotal: null,
      checkedAt: new Date('2026-01-11T00:00:00Z'),
    })
    expect(playtimeBump.changed).toBe(true)
    const obs2 = await listWinObservations(db, inserted.id)
    expect(obs2).toHaveLength(2)
    expect(obs2[1]?.currentPlaytimeMinutes).toBe(180)

    // achievements change (null → number): observation inserted
    const achBump = await recordWinPlaytimeProgress(db, inserted.id, {
      currentPlaytimeMinutes: 180,
      ...PLAYTIME_DETAIL_NULLS,
      hasReview: null,
      screenshotCount: null,
      achievementsUnlocked: 3,
      achievementsTotal: 25,
      checkedAt: new Date('2026-01-12T00:00:00Z'),
    })
    expect(achBump.changed).toBe(true)
    const obs3 = await listWinObservations(db, inserted.id)
    expect(obs3).toHaveLength(3)
    expect(obs3[2]?.achievementsUnlocked).toBe(3)
    expect(obs3[2]?.achievementsTotal).toBe(25)
  })

  it('listRecentWinsByGroup returns wins for the given group only', async () => {
    const f = await seed(db)
    await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdB,
      wonAt: new Date('2026-01-09T00:00:00Z'),
      playDeadline: new Date('2026-04-09T00:00:00Z'),
    })
    const list = await listRecentWinsByGroup(db, f.groupId, 10)
    expect(list).toHaveLength(2)
    expect(list[0]?.wonAt.getTime()).toBeGreaterThan(list[1]?.wonAt.getTime() ?? 0)
  })

  it('listPendingForPlaytimePoll skips wins past the deadline cutoff and resolved wins', async () => {
    const f = await seed(db)
    const fresh = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-12-31T00:00:00Z'),
    })
    const stale = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdB,
      wonAt: new Date('2025-01-08T00:00:00Z'),
      playDeadline: new Date('2025-04-08T00:00:00Z'),
    })
    if (!fresh || !stale) throw new Error('insert failed')

    const cutoff = new Date('2026-01-01T00:00:00Z')
    const list = await listPendingForPlaytimePoll(db, cutoff)
    expect(list.map((w) => w.id)).toEqual([fresh.id])

    await updateWinStatus(db, fresh.id, 'played', new Date('2026-02-01T00:00:00Z'))
    const after = await listPendingForPlaytimePoll(db, cutoff)
    expect(after).toHaveLength(0)
  })

  const readGroupCounters = async (
    db: Db,
    groupId: number,
  ): Promise<{ totalWins: number; pendingWins: number }> => {
    const [row] = await db
      .select({ totalWins: groups.totalWins, pendingWins: groups.pendingWins })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1)
    if (!row) throw new Error('group missing')
    return row
  }

  it('insertWinIfAbsent bumps total + pending counters; duplicate insert is a no-op', async () => {
    const f = await seed(db)
    expect(await readGroupCounters(db, f.groupId)).toEqual({ totalWins: 0, pendingWins: 0 })

    await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    expect(await readGroupCounters(db, f.groupId)).toEqual({ totalWins: 1, pendingWins: 1 })

    await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdB,
      wonAt: new Date('2026-01-09T00:00:00Z'),
      playDeadline: new Date('2026-04-09T00:00:00Z'),
    })
    expect(await readGroupCounters(db, f.groupId)).toEqual({ totalWins: 2, pendingWins: 2 })

    // Duplicate insert (same giveaway + user) returns null and must NOT bump.
    const dup = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    expect(dup).toBeNull()
    expect(await readGroupCounters(db, f.groupId)).toEqual({ totalWins: 2, pendingWins: 2 })
  })

  it('updateWinStatus adjusts pendingWins only on pending boundary crossings', async () => {
    const f = await seed(db)
    const win = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-04-08T00:00:00Z'),
    })
    if (!win) throw new Error('insert failed')
    expect(await readGroupCounters(db, f.groupId)).toEqual({ totalWins: 1, pendingWins: 1 })

    // pending → played: pending decrements, total stays.
    await updateWinStatus(db, win.id, 'played', new Date('2026-02-01T00:00:00Z'))
    expect(await readGroupCounters(db, f.groupId)).toEqual({ totalWins: 1, pendingWins: 0 })

    // played → kicked: neither side touches pending, counter unchanged.
    await updateWinStatus(db, win.id, 'kicked', new Date('2026-02-02T00:00:00Z'))
    expect(await readGroupCounters(db, f.groupId)).toEqual({ totalWins: 1, pendingWins: 0 })

    // kicked → pending: pending re-increments.
    await updateWinStatus(db, win.id, 'pending', null)
    expect(await readGroupCounters(db, f.groupId)).toEqual({ totalWins: 1, pendingWins: 1 })
  })

  it('listPendingPastDeadlineByGroup returns only pending past-deadline wins', async () => {
    const f = await seed(db)
    const a = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdA,
      wonAt: new Date('2026-01-08T00:00:00Z'),
      playDeadline: new Date('2026-02-08T00:00:00Z'),
    })
    const b = await insertWinIfAbsent(db, {
      giveawayId: f.giveawayIdA,
      userId: f.userIdB,
      wonAt: new Date('2026-01-09T00:00:00Z'),
      playDeadline: new Date('2026-12-09T00:00:00Z'),
    })
    if (!a || !b) throw new Error('insert failed')
    await updateWinStatus(db, b.id, 'played', new Date('2026-02-15T00:00:00Z'))
    const expired = await listPendingPastDeadlineByGroup(
      db,
      f.groupId,
      new Date('2026-04-01T00:00:00Z'),
    )
    expect(expired.map((w) => w.id)).toEqual([a.id])
  })
})
