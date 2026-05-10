import { eq } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type {
  GroupSource,
  SteamGiftsGroupCode,
  SteamGroupId,
} from '#/db/schema'
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

export type ListGroupsOptions = {
  readonly source?: GroupSource
}

export const listGroups = async (
  db: DbOrTx,
  options?: ListGroupsOptions,
): Promise<ReadonlyArray<Group>> => {
  const base = db.select().from(groups).$dynamic()
  const filtered = options?.source ? base.where(eq(groups.source, options.source)) : base
  return filtered.orderBy(groups.name)
}

export type CreateGroupInput = {
  readonly slug: string
  readonly name: string
  readonly source: GroupSource
  readonly playWindowDays: number
  readonly description: string | null
  readonly steamgiftsGroupCode: SteamGiftsGroupCode | null
  readonly steamGroupId: SteamGroupId | null
  readonly steamGroupSlug: string | null
}

export const createGroup = async (db: DbOrTx, input: CreateGroupInput): Promise<Group> => {
  const [row] = await db
    .insert(groups)
    .values({
      slug: input.slug,
      name: input.name,
      source: input.source,
      playWindowDays: input.playWindowDays,
      description: input.description,
      steamgiftsGroupCode: input.steamgiftsGroupCode,
      steamGroupId: input.steamGroupId,
      steamGroupSlug: input.steamGroupSlug,
    })
    .returning()
  if (!row) throw new Error(`createGroup returned no row for slug=${input.slug}`)
  return row
}

export type UpdateGroupPatch = {
  readonly name?: string
  readonly playWindowDays?: number
  readonly description?: string | null
  readonly steamgiftsGroupCode?: SteamGiftsGroupCode | null
  readonly steamGroupId?: SteamGroupId | null
  readonly steamGroupSlug?: string | null
}

export const updateGroup = async (
  db: DbOrTx,
  groupId: number,
  patch: UpdateGroupPatch,
): Promise<Group> => {
  const [row] = await db.update(groups).set(patch).where(eq(groups.id, groupId)).returning()
  if (!row) throw new Error(`updateGroup: group ${String(groupId)} not found`)
  return row
}

export const updateGroupLastScrapedAt = async (
  db: DbOrTx,
  groupId: number,
  at: Date,
): Promise<void> => {
  await db.update(groups).set({ lastScrapedAt: at }).where(eq(groups.id, groupId))
}
