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
  readonly personaName?: string | null
  readonly avatarUrl?: string | null
  readonly profileVisibility?: ProfileVisibility | null
  readonly lastSyncedAt?: Date | null
}

export type UpsertUserBySteamIdInput = {
  readonly steamId: SteamId
  readonly personaName?: string | null
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

// SG-keyed upsert. steam_id is the stable identity: a SteamGifts user can
// rename on SG but keeps the same Steam account. So whenever a row already
// exists for this steamId, claim it — refreshing its SG username and fields —
// rather than inserting a duplicate that would violate the steam_id unique
// constraint. This covers two cases that both carry a steamId:
//   - a Steam-only row (null sg username) created by Steam Sign-In before any
//     scrape ran, and
//   - an SG rename, where the row still holds the user's previous username.
export const upsertUserBySgUsername = async (
  db: DbOrTx,
  input: UpsertUserBySgUsernameInput,
): Promise<User> => {
  if (input.steamId) {
    const existingBySteam = await findUserBySteamId(db, input.steamId)
    if (existingBySteam) {
      // Set/refresh the SG username on the canonical steamId row. Only check
      // for a clash when the name would actually change (the steady-state
      // re-scrape keeps the same name): renaming to a username a *different*
      // row already holds would itself break the steamgifts_username unique
      // constraint. The scrape resolves a username to its own row before
      // reaching here, so that clash isn't reachable from the scrape path —
      // but guard it anyway and just refresh the other fields instead of
      // crashing. (SG usernames compare case-insensitively.)
      const currentName = existingBySteam.steamgiftsUsername
      const needsRename =
        currentName === null ||
        currentName.toLowerCase() !== input.steamgiftsUsername.toLowerCase()
      let canRename = false
      if (needsRename) {
        const holder = await findUserBySteamgiftsUsername(db, input.steamgiftsUsername)
        canRename = holder === null || holder.id === existingBySteam.id
      }
      const [row] = await db
        .update(users)
        .set({
          ...(canRename ? { steamgiftsUsername: input.steamgiftsUsername } : {}),
          personaName: input.personaName ?? existingBySteam.personaName,
          avatarUrl: input.avatarUrl ?? existingBySteam.avatarUrl,
          profileVisibility: input.profileVisibility ?? existingBySteam.profileVisibility,
          lastSyncedAt: input.lastSyncedAt ?? existingBySteam.lastSyncedAt,
        })
        .where(eq(users.id, existingBySteam.id))
        .returning()
      if (!row) throw new Error(`failed to claim steamId row for sg=${input.steamgiftsUsername}`)
      return row
    }
  }

  const [row] = await db
    .insert(users)
    .values({
      steamgiftsUsername: input.steamgiftsUsername,
      steamId: input.steamId ?? null,
      personaName: input.personaName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      profileVisibility: input.profileVisibility ?? null,
      lastSyncedAt: input.lastSyncedAt ?? null,
    })
    .onConflictDoUpdate({
      target: users.steamgiftsUsername,
      set: {
        steamId: sql`coalesce(excluded.steam_id, ${users.steamId})`,
        personaName: sql`coalesce(excluded.persona_name, ${users.personaName})`,
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
      personaName: input.personaName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      profileVisibility: input.profileVisibility ?? null,
      lastSyncedAt: input.lastSyncedAt ?? null,
    })
    .onConflictDoUpdate({
      target: users.steamId,
      set: {
        personaName: sql`coalesce(excluded.persona_name, ${users.personaName})`,
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
