import { eq } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import { groups } from '#/db/schema'

export type Group = typeof groups.$inferSelect

export const findGroupBySlug = async (db: DbOrTx, slug: string): Promise<Group | null> => {
  const [row] = await db.select().from(groups).where(eq(groups.slug, slug)).limit(1)
  return row ?? null
}

export const findGroupById = async (db: DbOrTx, id: number): Promise<Group | null> => {
  const [row] = await db.select().from(groups).where(eq(groups.id, id)).limit(1)
  return row ?? null
}

export const listGroups = async (db: DbOrTx): Promise<ReadonlyArray<Group>> =>
  db.select().from(groups).orderBy(groups.name)

export const updateGroupLastScrapedAt = async (
  db: DbOrTx,
  groupId: number,
  at: Date,
): Promise<void> => {
  await db.update(groups).set({ lastScrapedAt: at }).where(eq(groups.id, groupId))
}
