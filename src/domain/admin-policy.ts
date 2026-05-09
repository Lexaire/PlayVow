import type { UserRole } from '#/db/schema'

// The two policy gates an admin's role-change attempt has to pass before it
// reaches the DB. Pure function — server fn (`setUserRoleFn`) and any future
// caller route through this so the rules live in one place.
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
  // Touching the admin role at all (promote-to or demote-from) requires the
  // actor to be on the env-admin list. Non-env admins are limited to the
  // user ↔ moderator axis.
  if ((params.target.role === 'admin' || params.newRole === 'admin') && !params.isActorEnvAdmin) {
    return { ok: false, error: 'admin_change_requires_env_admin' }
  }
  return { ok: true }
}
