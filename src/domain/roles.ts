import type { UserRole } from '#/db/schema'

// Two global roles: regular user and admin. Per-group moderation lives in
// the group_moderators table — `isModForGroup` below checks role + that
// table's membership. There's no "is this user a mod globally?" question
// post-the-per-group refactor; the closest analogue is "are they an admin
// or do they moderate any group" (`isAnyMod`), used to gate the cross-group
// /mod landing and audit pages.
const ROLE_RANK: Readonly<Record<UserRole, number>> = {
  user: 0,
  admin: 1,
}

export const meetsRole = (have: UserRole, need: UserRole): boolean =>
  ROLE_RANK[have] >= ROLE_RANK[need]

export const compareRoles = (a: UserRole, b: UserRole): number => ROLE_RANK[a] - ROLE_RANK[b]

export const isAdmin = (user: { readonly role: UserRole } | null): boolean =>
  user !== null && user.role === 'admin'

// Admin OR has a row in group_moderators for this specific group. Callers
// pass a precomputed Set of moderated group ids (loaded once per request)
// so this stays a synchronous check usable inside render functions.
export const isModForGroup = (
  user: { readonly role: UserRole } | null,
  groupId: number,
  moderatedGroupIds: ReadonlySet<number>,
): boolean => {
  if (user === null) return false
  if (user.role === 'admin') return true
  return moderatedGroupIds.has(groupId)
}

// Admin OR moderates at least one group. Used for cross-group entry points
// (the /mod landing page, the audit log) where we don't have a single
// groupId to gate on.
export const isAnyMod = (
  user: { readonly role: UserRole } | null,
  moderatedGroupIds: ReadonlySet<number>,
): boolean => {
  if (user === null) return false
  if (user.role === 'admin') return true
  return moderatedGroupIds.size > 0
}
