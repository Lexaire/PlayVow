import { redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import { env } from '#/config/env'
import { db, dbWrite } from '#/db/client'
import type { SteamGiftsUsername, SteamId, UserRole } from '#/db/schema'
import { USER_ROLES, users } from '#/db/schema'
import { checkRoleChange } from '#/domain/admin-policy'
import { listAuditEntriesForTarget } from '#/repos/auditLog'
import type { AuditEntry, AuditEntryReadError } from '#/repos/auditLog'
import { findUserById, setUserRole } from '#/repos/users'
import type { Result } from '#/lib/result'
import { err } from '#/lib/result'
import { requireAdmin } from '#/server/auth'

// "Env admin" = an admin whose Steam ID is listed in ADMIN_STEAM_IDS. Only
// they can promote-to or demote-from the admin role; non-env admins can only
// shuffle users between `user` and `moderator`. This keeps the env file as
// the source of truth for super-admin membership.
const isEnvAdmin = (user: { readonly steamId: SteamId | null }): boolean =>
  user.steamId !== null && env.ADMIN_STEAM_IDS.includes(user.steamId)

const USER_AUDIT_LIMIT = 100
const DEFAULT_USER_PAGE_SIZE = 50

export type AdminUserRow = {
  readonly id: number
  readonly role: UserRole
  readonly steamgiftsUsername: SteamGiftsUsername | null
  readonly steamId: SteamId | null
  readonly avatarUrl: string | null
  readonly createdAt: Date
}

export type AdminUsersPage = {
  readonly rows: ReadonlyArray<AdminUserRow>
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly viewerId: number
  readonly viewerIsEnvAdmin: boolean
}

const ListUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(DEFAULT_USER_PAGE_SIZE),
  role: z.enum(USER_ROLES).optional(),
  search: z.string().trim().min(1).max(64).optional(),
})

export const listUsersForAdmin = createServerFn({ method: 'GET' })
  .inputValidator((input: { page?: number; pageSize?: number; role?: UserRole; search?: string }) =>
    ListUsersSchema.parse(input),
  )
  .handler(async ({ data }): Promise<AdminUsersPage> => {
    const admin = await requireAdmin()
    const dbR = db()
    const offset = Math.max(0, (data.page - 1) * data.pageSize)

    const conditions = []
    if (data.role) conditions.push(eq(users.role, data.role))
    if (data.search) {
      // Escape LIKE wildcards so a literal "_" or "%" in the search input
      // doesn't behave as a wildcard. Backslash is the ESCAPE char below.
      const escaped = data.search.replace(/[\\%_]/g, (c) => `\\${c}`)
      const pattern = `%${escaped}%`
      conditions.push(
        or(
          sql`lower(${users.steamgiftsUsername}) like ${pattern.toLowerCase()} escape '\\'`,
          sql`${users.steamId} like ${pattern} escape '\\'`,
        ),
      )
    }
    const where = conditions.length === 0 ? undefined : and(...conditions)

    const [totalRow] = await dbR
      .select({ n: count() })
      .from(users)
      .where(where ?? sql`1=1`)

    const rows = await dbR
      .select({
        id: users.id,
        role: users.role,
        steamgiftsUsername: users.steamgiftsUsername,
        steamId: users.steamId,
        avatarUrl: users.avatarUrl,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(where ?? sql`1=1`)
      .orderBy(desc(users.createdAt))
      .limit(data.pageSize)
      .offset(offset)

    return {
      rows,
      total: totalRow?.n ?? 0,
      page: data.page,
      pageSize: data.pageSize,
      viewerId: admin.id,
      viewerIsEnvAdmin: isEnvAdmin(admin),
    }
  })

const SetRoleSchema = z.object({
  userId: z.number().int().positive(),
  newRole: z.enum(USER_ROLES),
  reason: z.string().max(200).optional(),
})

export type SetRoleError =
  | { readonly kind: 'self_change_forbidden' }
  | { readonly kind: 'admin_change_requires_env_admin' }
  | { readonly kind: 'user_not_found' }
  | { readonly kind: 'no_op' }

export const setUserRoleFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { userId: number; newRole: UserRole; reason?: string }) =>
    SetRoleSchema.parse(input),
  )
  .handler(
    async ({ data }): Promise<Result<{ before: UserRole; after: UserRole }, SetRoleError>> => {
      const admin = await requireAdmin()

      // Read the target's current role from the local replica — avoid the
      // remote RTT just to check eligibility. Replica lag is a non-issue
      // here: the worst case is we let through a request that setUserRole
      // then no-ops because the role already changed remotely.
      const target = await findUserById(db(), data.userId)
      if (!target) return err({ kind: 'user_not_found' })

      const gate = checkRoleChange({
        actorId: admin.id,
        target: { id: target.id, role: target.role },
        newRole: data.newRole,
        isActorEnvAdmin: isEnvAdmin(admin),
      })
      if (!gate.ok) return err({ kind: gate.error })

      const result = await setUserRole(dbWrite(), {
        userId: data.userId,
        newRole: data.newRole,
        actorUserId: admin.id,
        ...(data.reason !== undefined ? { reason: data.reason } : {}),
      })
      return result
    },
  )

const UserIdSchema = z.object({ userId: z.number().int().positive() })

export type AdminUserDetail = {
  readonly user: AdminUserRow
  readonly audit: ReadonlyArray<Result<AuditEntry, AuditEntryReadError>>
  readonly viewerId: number
  readonly viewerIsEnvAdmin: boolean
}

export const fetchAdminUserDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: { userId: number }) => UserIdSchema.parse(input))
  .handler(async ({ data }): Promise<AdminUserDetail> => {
    const admin = await requireAdmin()
    const dbR = db()
    const u = await findUserById(dbR, data.userId)
    if (!u) throw redirect({ to: '/admin/users' })
    const audit = await listAuditEntriesForTarget(dbR, 'user', data.userId, USER_AUDIT_LIMIT)
    return {
      user: {
        id: u.id,
        role: u.role,
        steamgiftsUsername: u.steamgiftsUsername,
        steamId: u.steamId,
        avatarUrl: u.avatarUrl,
        createdAt: u.createdAt,
      },
      audit,
      viewerId: admin.id,
      viewerIsEnvAdmin: isEnvAdmin(admin),
    }
  })
