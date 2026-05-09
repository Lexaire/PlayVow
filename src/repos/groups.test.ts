import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '#/db/client'
import { groups } from '#/db/schema'
import type { SteamGiftsGroupCode, SteamGroupId } from '#/db/schema'
import { createTestDb } from '#/repos/__test__/db'
import { findGroupById, findGroupBySlug, listGroups } from '#/repos/groups'

const seedGroup = async (
  db: Db,
  overrides: { readonly slug: string; readonly name: string },
): Promise<number> => {
  const [row] = await db
    .insert(groups)
    .values({
      slug: overrides.slug,
      name: overrides.name,
      playWindowDays: 30,
      steamgiftsGroupCode: 'abcde' as SteamGiftsGroupCode,
      steamGroupId: '103582791000000001' as SteamGroupId,
      steamGroupSlug: overrides.slug,
      description: null,
    })
    .returning({ id: groups.id })
  if (!row) throw new Error('seed: no row returned')
  return row.id
}

describe('groupsRepo', () => {
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

  it('findGroupBySlug returns null when missing', async () => {
    expect(await findGroupBySlug(db, 'missing')).toBeNull()
  })

  it('findGroupBySlug returns the row when present', async () => {
    await seedGroup(db, { slug: 'taleplay', name: 'TalePlay' })
    const row = await findGroupBySlug(db, 'taleplay')
    expect(row?.name).toBe('TalePlay')
  })

  it('findGroupById returns the row when present', async () => {
    const id = await seedGroup(db, { slug: 'taleplay', name: 'TalePlay' })
    const row = await findGroupById(db, id)
    expect(row?.slug).toBe('taleplay')
  })

  it('listGroups returns all groups sorted by name', async () => {
    await seedGroup(db, { slug: 'pa', name: 'Playing Appreciated' })
    await seedGroup(db, { slug: 'taleplay', name: 'TalePlay' })
    const all = await listGroups(db)
    expect(all.map((g) => g.slug)).toEqual(['pa', 'taleplay'])
  })
})
