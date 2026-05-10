import { and, asc, eq } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { SteamGiftsUsername, SteamId, UserRole } from '#/db/schema'
import { groupModerators, groups, users } from '#/db/schema'

export type GroupModeratorRow = typeof groupModerators.$inferSelect

// Admin OR has a row in group_moderators for this group. Admins moderate
// every group implicitly — the table only tracks regular users with mod
// access scoped to specific groups.
export const userCanModerateGroup = async (
  db: DbOrTx,
  user: { readonly id: number; readonly role: UserRole } | null,
  groupId: number,
): Promise<boolean> => {
  if (user === null) return false
  if (user.role === 'admin') return true
  const [row] = await db
    .select({ id: groupModerators.id })
    .from(groupModerators)
    .where(and(eq(groupModerators.userId, user.id), eq(groupModerators.groupId, groupId)))
    .limit(1)
  return row !== undefined
}

// Returns the set of group ids the user mods directly. Admins return an
// empty set even though they can moderate everything — callers special-case
// admin separately and shouldn't load this for them.
export const listGroupIdsModeratedByUser = async (
  db: DbOrTx,
  userId: number,
): Promise<ReadonlySet<number>> => {
  const rows = await db
    .select({ groupId: groupModerators.groupId })
    .from(groupModerators)
    .where(eq(groupModerators.userId, userId))
  return new Set(rows.map((r) => r.groupId))
}

export type GroupModeratorView = {
  readonly userId: number
  readonly steamgiftsUsername: SteamGiftsUsername | null
  readonly steamId: SteamId | null
  readonly avatarUrl: string | null
  readonly grantedAt: Date
  readonly grantedByUserId: number
}

export const listModeratorsOfGroup = async (
  db: DbOrTx,
  groupId: number,
): Promise<ReadonlyArray<GroupModeratorView>> => {
  const rows = await db
    .select({
      userId: users.id,
      steamgiftsUsername: users.steamgiftsUsername,
      steamId: users.steamId,
      avatarUrl: users.avatarUrl,
      grantedAt: groupModerators.grantedAt,
      grantedByUserId: groupModerators.grantedByUserId,
    })
    .from(groupModerators)
    .innerJoin(users, eq(users.id, groupModerators.userId))
    .where(eq(groupModerators.groupId, groupId))
    .orderBy(asc(groupModerators.grantedAt))
  return rows
}

export type ListGroupView = {
  readonly id: number
  readonly slug: string
  readonly name: string
}

// Used by the /mod landing page to show a non-admin user the groups they
// can moderate. Admins skip this and see every group directly.
export const listGroupsModeratedByUser = async (
  db: DbOrTx,
  userId: number,
): Promise<ReadonlyArray<ListGroupView>> => {
  const rows = await db
    .select({ id: groups.id, slug: groups.slug, name: groups.name })
    .from(groupModerators)
    .innerJoin(groups, eq(groups.id, groupModerators.groupId))
    .where(eq(groupModerators.userId, userId))
    .orderBy(asc(groups.name))
  return rows
}

export type AddGroupModeratorInput = {
  readonly groupId: number
  readonly userId: number
  readonly grantedByUserId: number
}

// Inserts the row; returns true if a new row was added, false if the user
// already moderated the group. Caller decides whether to audit (skip when
// no-op).
export const addGroupModerator = async (
  db: DbOrTx,
  input: AddGroupModeratorInput,
): Promise<boolean> => {
  const inserted = await db
    .insert(groupModerators)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: groupModerators.id })
  return inserted.length > 0
}

// Removes the row; returns true if a row was deleted, false if the user
// wasn't moderating the group. No-op-on-missing keeps the server fn shape
// simple (idempotent revoke).
export const removeGroupModerator = async (
  db: DbOrTx,
  groupId: number,
  userId: number,
): Promise<boolean> => {
  const deleted = await db
    .delete(groupModerators)
    .where(and(eq(groupModerators.groupId, groupId), eq(groupModerators.userId, userId)))
    .returning({ id: groupModerators.id })
  return deleted.length > 0
}
