import type { UserRole } from '#/db/schema'
import { USER_ROLES } from '#/db/schema'

export const ROLE_PILL: Readonly<Record<UserRole, string>> = {
  user: 'bg-neutral-100 text-neutral-700',
  moderator: 'bg-amber-100 text-amber-800',
  admin: 'bg-rose-100 text-rose-800',
}

export const formatRoleError = (kind: string): string => {
  switch (kind) {
    case 'self_change_forbidden':
      return "You can't change your own role."
    case 'admin_change_requires_env_admin':
      return 'Only an admin listed in ADMIN_STEAM_IDS can promote to or demote from admin.'
    case 'user_not_found':
      return 'User not found.'
    case 'no_op':
      return 'Already in that role.'
    default:
      return 'Unknown error.'
  }
}

// Roles a viewer is allowed to set on a target. Env admins can do anything
// (except the self-change check, enforced server-side). Regular admins
// can't promote-to or demote-from `admin`. Viewer's own row gets no
// options regardless. Returns the list ready for rendering.
export const allowedTransitions = (params: {
  readonly viewerId: number
  readonly viewerIsEnvAdmin: boolean
  readonly target: { readonly id: number; readonly role: UserRole }
}): ReadonlyArray<UserRole> => {
  if (params.target.id === params.viewerId) return []
  return USER_ROLES.filter((r) => {
    if (r === params.target.role) return false
    if (!params.viewerIsEnvAdmin && (r === 'admin' || params.target.role === 'admin')) {
      return false
    }
    return true
  })
}
