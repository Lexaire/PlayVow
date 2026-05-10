import type { UserRole } from '#/db/schema'

// The two policy gates an admin's role-change attempt has to pass before it
// reaches the DB. Pure function — server fn (`setUserRoleFn`) and any future
// caller route through this so the rules live in one place.
//
// Post-per-group-mods, the only role transition is user ↔ admin: the
// "moderator" role is gone, and per-group moderation lives in the
// group_moderators table (granted via groupAdminFns, not setUserRoleFn).
export type RoleChangeError = 'self_change_forbidden' | 'admin_change_requires_env_admin'

export type RoleChangeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: RoleChangeError }

export const checkRoleChange = (params: {
  readonly actorId: number
  readonly target: { readonly id: number; readonly role: UserRole }
  readonly newRole: UserRole
  readonly isActorEnvAdmin: boolean
}): RoleChangeCheck => {
  if (params.actorId === params.target.id) {
    return { ok: false, error: 'self_change_forbidden' }
  }
  // Promoting to or demoting from admin is restricted to env-admins (those
  // listed in ADMIN_STEAM_IDS). Non-env admins can't grant admin to anyone
  // — they only exist to delegate operational work, not to widen the
  // super-admin set.
  if ((params.target.role === 'admin' || params.newRole === 'admin') && !params.isActorEnvAdmin) {
    return { ok: false, error: 'admin_change_requires_env_admin' }
  }
  return { ok: true }
}
