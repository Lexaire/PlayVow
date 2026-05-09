import { redirect } from '@tanstack/react-router'

import { db } from '#/db/client'
import type { UserRole } from '#/db/schema'
import { meetsRole } from '#/domain/roles'
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

const requireRole = async (need: UserRole): Promise<User> => {
  const user = await getCurrentUser()
  if (!user) throw redirect({ to: '/login' })
  if (!meetsRole(user.role, need)) throw redirect({ to: '/' })
  return user
}

export const requireUser = async (): Promise<User> => requireRole('user')
export const requireModerator = async (): Promise<User> => requireRole('moderator')
export const requireAdmin = async (): Promise<User> => requireRole('admin')

export const setSession = rotateSessionTo
export const signOut = clearSession
