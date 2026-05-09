import { eq, sql } from 'drizzle-orm'

import type { Db, DbOrTx } from '#/db/client'
import { withTransaction } from '#/db/client'
import type { ProfileVisibility, SteamGiftsUsername, SteamId, UserRole } from '#/db/schema'
import { users } from '#/db/schema'
import { compareRoles } from '#/domain/roles'
import { writeAuditEvent } from '#/repos/auditLog'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

export type User = typeof users.$inferSelect

export type UpsertUserBySgUsernameInput = {
  readonly steamgiftsUsername: SteamGiftsUsername
  readonly steamId?: SteamId | null
  readonly avatarUrl?: string | null
  readonly profileVisibility?: ProfileVisibility | null
  readonly lastSyncedAt?: Date | null
}

export type UpsertUserBySteamIdInput = {
  readonly steamId: SteamId
  readonly avatarUrl?: string | null
  readonly profileVisibility?: ProfileVisibility | null
  readonly lastSyncedAt?: Date | null
}

export const countAdmins = async (db: DbOrTx): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.role, 'admin'))
  return Number(row?.count ?? 0)
}

export const findUserBySteamId = async (db: DbOrTx, steamId: SteamId): Promise<User | null> => {
  const [row] = await db.select().from(users).where(eq(users.steamId, steamId)).limit(1)
  return row ?? null
}

export const findUserBySteamgiftsUsername = async (
  db: DbOrTx,
  username: SteamGiftsUsername,
): Promise<User | null> => {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.steamgiftsUsername}) = lower(${username})`)
    .limit(1)
  return row ?? null
}

export const findUserById = async (db: DbOrTx, id: number): Promise<User | null> => {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}

// SG-keyed upsert. When the SG scrape carries a steamId and there's already a
// Steam-only row with that steamId (created by Steam Sign-In before SG scrape
// ever ran), claim that row by setting its sg username — no duplicate.
export const upsertUserBySgUsername = async (
  db: DbOrTx,
  input: UpsertUserBySgUsernameInput,
): Promise<User> => {
  if (input.steamId) {
    const existingBySteam = await findUserBySteamId(db, input.steamId)
    if (existingBySteam && existingBySteam.steamgiftsUsername === null) {
      const [row] = await db
        .update(users)
        .set({
          steamgiftsUsername: input.steamgiftsUsername,
          avatarUrl: input.avatarUrl ?? existingBySteam.avatarUrl,
          profileVisibility: input.profileVisibility ?? existingBySteam.profileVisibility,
          lastSyncedAt: input.lastSyncedAt ?? existingBySteam.lastSyncedAt,
        })
        .where(eq(users.id, existingBySteam.id))
        .returning()
      if (!row) throw new Error(`failed to link sg=${input.steamgiftsUsername} to steamId row`)
      return row
    }
  }

  const [row] = await db
    .insert(users)
    .values({
      steamgiftsUsername: input.steamgiftsUsername,
      steamId: input.steamId ?? null,
      avatarUrl: input.avatarUrl ?? null,
      profileVisibility: input.profileVisibility ?? null,
      lastSyncedAt: input.lastSyncedAt ?? null,
    })
    .onConflictDoUpdate({
      target: users.steamgiftsUsername,
      set: {
        steamId: sql`coalesce(excluded.steam_id, ${users.steamId})`,
        avatarUrl: sql`coalesce(excluded.avatar_url, ${users.avatarUrl})`,
        profileVisibility: sql`coalesce(excluded.profile_visibility, ${users.profileVisibility})`,
        lastSyncedAt: sql`coalesce(excluded.last_synced_at, ${users.lastSyncedAt})`,
      },
    })
    .returning()
  if (!row) {
    throw new Error(`upsertUserBySgUsername returned no row for ${input.steamgiftsUsername}`)
  }
  return row
}

// Steam-keyed upsert. New rows have a NULL sg username — SG scraping links
// them later via the symmetric branch in upsertUserBySgUsername. Uses
// ON CONFLICT against users.steamId so two concurrent flows targeting the
// same SteamId (e.g. Steam login firing while an SG scrape that resolves
// the same SteamId is in flight) can't both insert — one wins and the
// other coalesces into an UPDATE. coalesce(excluded, current) preserves
// any field already set rather than wiping it with a null caller input.
export const upsertUserBySteamId = async (
  db: DbOrTx,
  input: UpsertUserBySteamIdInput,
): Promise<User> => {
  const [row] = await db
    .insert(users)
    .values({
      steamgiftsUsername: null,
      steamId: input.steamId,
      avatarUrl: input.avatarUrl ?? null,
      profileVisibility: input.profileVisibility ?? null,
      lastSyncedAt: input.lastSyncedAt ?? null,
    })
    .onConflictDoUpdate({
      target: users.steamId,
      set: {
        avatarUrl: sql`coalesce(excluded.avatar_url, ${users.avatarUrl})`,
        profileVisibility: sql`coalesce(excluded.profile_visibility, ${users.profileVisibility})`,
        lastSyncedAt: sql`coalesce(excluded.last_synced_at, ${users.lastSyncedAt})`,
      },
    })
    .returning()
  if (!row) {
    throw new Error(`upsertUserBySteamId returned no row for ${input.steamId}`)
  }
  return row
}

export type SetUserRoleError = { readonly kind: 'user_not_found' } | { readonly kind: 'no_op' }

export type SetUserRoleInput = {
  readonly userId: number
  readonly newRole: UserRole
  readonly actorUserId: number
  readonly reason?: string
}

export const setUserRole = async (
  db: Db,
  input: SetUserRoleInput,
): Promise<Result<{ readonly before: UserRole; readonly after: UserRole }, SetUserRoleError>> => {
  return withTransaction(db, async (tx) => {
    const existing = await findUserById(tx, input.userId)
    if (!existing) return err({ kind: 'user_not_found' })
    if (existing.role === input.newRole) return err({ kind: 'no_op' })

    await tx.update(users).set({ role: input.newRole }).where(eq(users.id, input.userId))

    const elevated = compareRoles(input.newRole, existing.role) > 0
    await writeAuditEvent(tx, {
      actorUserId: input.actorUserId,
      targetType: 'user',
      targetId: input.userId,
      event: {
        kind: elevated ? 'role_granted' : 'role_revoked',
        before: existing.role,
        after: input.newRole,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    })

    return ok({ before: existing.role, after: input.newRole })
  })
}
