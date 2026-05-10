import { redirect } from '@tanstack/react-router'

import { db } from '#/db/client'
import {
  listGroupIdsModeratedByUser,
  userCanModerateGroup,
} from '#/repos/groupModerators'
import { findUserById } from '#/repos/users'
import type { User } from '#/repos/users'
import { clearSession, getSessionUserId, rotateSessionTo } from '#/server/session'

// Hot path: every authenticated request reads the user row to get role. In
// DB_MODE=replica this is a local SQLite read against the embedded replica
// (microseconds, no network). In remote mode it's one Turso RTT — still fine
// for a single per-request read.
export const getCurrentUser = async (): Promise<User | null> => {
  const userId = await getSessionUserId()
  if (userId === null) return null
  const user = await findUserById(db(), userId)
  if (!user) {
    // Session points at a deleted user — clear it so the next request is clean.
    await clearSession()
    return null
  }
  return user
}

export const requireUser = async (): Promise<User> => {
  const user = await getCurrentUser()
  if (!user) throw redirect({ to: '/login' })
  return user
}

export const requireAdmin = async (): Promise<User> => {
  const user = await requireUser()
  if (user.role !== 'admin') throw redirect({ to: '/' })
  return user
}

// Group-scoped mod gate. Admins satisfy it for every group; regular users
// must have a row in group_moderators for this specific group. Use this on
// every server fn whose behavior is bound to a single group (mod page,
// status changes, manual giveaway add).
export const requireGroupModerator = async (groupId: number): Promise<User> => {
  const user = await requireUser()
  const ok = await userCanModerateGroup(db(), user, groupId)
  if (!ok) throw redirect({ to: '/' })
  return user
}

// "Is this user any kind of mod?" — admin OR moderates at least one group.
// Used for cross-group entry points (the /mod landing page, /mod/audit)
// where there's no single groupId to gate on. Returns the user (when ok)
// + the precomputed set of moderated group ids so the caller can re-use
// them without a second query.
export type AnyModeratorContext = {
  readonly user: User
  readonly moderatedGroupIds: ReadonlySet<number>
}

export const requireAnyModerator = async (): Promise<AnyModeratorContext> => {
  const user = await requireUser()
  if (user.role === 'admin') {
    return { user, moderatedGroupIds: new Set() }
  }
  const moderatedGroupIds = await listGroupIdsModeratedByUser(db(), user.id)
  if (moderatedGroupIds.size === 0) throw redirect({ to: '/' })
  return { user, moderatedGroupIds }
}

// Lighter variant: returns the set without redirecting. Components that
// render "show me the groups I mod" use this to populate the landing page
// for non-admins; admins skip the lookup entirely (they see all groups).
export const getModeratedGroupIds = async (
  user: { readonly id: number; readonly role: User['role'] } | null,
): Promise<ReadonlySet<number>> => {
  if (user === null || user.role === 'admin') return new Set()
  return listGroupIdsModeratedByUser(db(), user.id)
}

export const setSession = rotateSessionTo
export const signOut = clearSession
