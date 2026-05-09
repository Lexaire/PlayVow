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
import { listAuditEntriesForTarget } from '#/repos/auditLog'
import { upsertGiveaway } from '#/repos/giveaways'
import { applyWinNotesUpdate, applyWinStatusChange } from '#/repos/modActions'
import { upsertSteamApp } from '#/repos/steamApps'
import { createTestDb } from '#/repos/__test__/db'
import { upsertUserBySgUsername } from '#/repos/users'
import { findWinById, insertWinIfAbsent } from '#/repos/wins'

const APP = 12345 as SteamAppId
const STEAM = '76561197960000001' as SteamId

const seedWin = async (db: Db): Promise<{ winId: number; modUserId: number }> => {
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
  await upsertSteamApp(db, { appId: APP, name: 'Game' })
  const creator = await upsertUserBySgUsername(db, {
    steamgiftsUsername: 'mod' as SteamGiftsUsername,
  })
  const giveaway = await upsertGiveaway(db, {
    groupId: groupRow.id,
    steamgiftsCode: 'g0001' as SteamGiftsGiveawayCode,
    target: { kind: 'app', appId: APP },
    creatorUserId: creator.id,
    quantity: 1,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: new Date('2026-01-08T00:00:00Z'),
    scrapedAt: new Date('2026-01-09T00:00:00Z'),
  })
  const user = await upsertUserBySgUsername(db, {
    steamgiftsUsername: 'winner' as SteamGiftsUsername,
    steamId: STEAM,
  })
  const win = await insertWinIfAbsent(db, {
    giveawayId: giveaway.id,
    userId: user.id,
    wonAt: new Date('2026-01-08T00:00:00Z'),
    playDeadline: new Date('2026-04-08T00:00:00Z'),
  })
  if (!win) throw new Error('seed: no win')
  return { winId: win.id, modUserId: creator.id }
}

describe('modActions', () => {
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

  describe('applyWinStatusChange', () => {
    it('updates status, sets resolvedAt, writes audit row', async () => {
      const { winId, modUserId } = await seedWin(db)
      const now = new Date('2026-04-15T00:00:00Z')

      const result = await applyWinStatusChange(db, winId, 'played', now, modUserId)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual({ winId, from: 'pending', to: 'played' })

      const win = await findWinById(db, winId)
      expect(win?.status).toBe('played')
      expect(win?.resolvedAt?.toISOString()).toBe(now.toISOString())

      const entries = await listAuditEntriesForTarget(db, 'win', winId, 10)
      expect(entries).toHaveLength(1)
      const [entry] = entries
      if (!entry?.ok) throw new Error('audit parse failed')
      expect(entry.value.event).toEqual({
        kind: 'win_status_changed',
        from: 'pending',
        to: 'played',
      })
    })

    it('clears resolvedAt when resetting to pending', async () => {
      const { winId, modUserId } = await seedWin(db)
      const t1 = new Date('2026-04-15T00:00:00Z')
      const t2 = new Date('2026-04-16T00:00:00Z')

      await applyWinStatusChange(db, winId, 'kicked', t1, modUserId)
      const reset = await applyWinStatusChange(db, winId, 'pending', t2, modUserId)
      expect(reset.ok).toBe(true)

      const win = await findWinById(db, winId)
      expect(win?.status).toBe('pending')
      expect(win?.resolvedAt).toBeNull()
    })

    it('returns no_op when status is unchanged', async () => {
      const { winId, modUserId } = await seedWin(db)
      const result = await applyWinStatusChange(db, winId, 'pending', new Date(), modUserId)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('no_op')

      const entries = await listAuditEntriesForTarget(db, 'win', winId, 10)
      expect(entries).toHaveLength(0)
    })

    it('returns win_not_found when win does not exist', async () => {
      const result = await applyWinStatusChange(db, 999, 'played', new Date(), 1)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toEqual({ kind: 'win_not_found', winId: 999 })
    })
  })

  describe('applyWinNotesUpdate', () => {
    it('sets notes and writes audit row', async () => {
      const { winId, modUserId } = await seedWin(db)
      const result = await applyWinNotesUpdate(db, winId, '  reminder sent  ', modUserId)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual({ winId, before: null, after: 'reminder sent' })

      const win = await findWinById(db, winId)
      expect(win?.modNotes).toBe('reminder sent')

      const entries = await listAuditEntriesForTarget(db, 'win', winId, 10)
      const [entry] = entries
      if (!entry?.ok) throw new Error('audit parse failed')
      expect(entry.value.event).toEqual({
        kind: 'win_notes_updated',
        before: null,
        after: 'reminder sent',
      })
    })

    it('treats empty string as null and skips when unchanged', async () => {
      const { winId, modUserId } = await seedWin(db)
      const result = await applyWinNotesUpdate(db, winId, '   ', modUserId)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('no_op')

      const entries = await listAuditEntriesForTarget(db, 'win', winId, 10)
      expect(entries).toHaveLength(0)
    })

    it('clears existing notes', async () => {
      const { winId, modUserId } = await seedWin(db)
      await applyWinNotesUpdate(db, winId, 'first note', modUserId)
      const cleared = await applyWinNotesUpdate(db, winId, null, modUserId)
      expect(cleared.ok).toBe(true)
      if (!cleared.ok) return
      expect(cleared.value).toEqual({ winId, before: 'first note', after: null })

      const win = await findWinById(db, winId)
      expect(win?.modNotes).toBeNull()
    })

    it('returns win_not_found when win does not exist', async () => {
      const result = await applyWinNotesUpdate(db, 999, 'note', 1)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toEqual({ kind: 'win_not_found', winId: 999 })
    })
  })
})
