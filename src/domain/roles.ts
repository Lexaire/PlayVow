import type { UserRole } from '#/db/schema'

// Single source of truth for the role hierarchy. Anywhere a comparison or a
// role-aware predicate is needed, route through here so adding a 4th role is
// a one-line change.
const ROLE_RANK: Readonly<Record<UserRole, number>> = {
  user: 0,
  moderator: 1,
  admin: 2,
}

export const meetsRole = (have: UserRole, need: UserRole): boolean =>
  ROLE_RANK[have] >= ROLE_RANK[need]

export const compareRoles = (a: UserRole, b: UserRole): number => ROLE_RANK[a] - ROLE_RANK[b]

export const isMod = (user: { readonly role: UserRole } | null): boolean =>
  user !== null && meetsRole(user.role, 'moderator')

export const isAdmin = (user: { readonly role: UserRole } | null): boolean =>
  user !== null && meetsRole(user.role, 'admin')
