import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { SteamId } from '#/db/schema'
import { groups, steamGroupMemberships } from '#/db/schema'

export type SteamGroupMembership = typeof steamGroupMemberships.$inferSelect

export const findOpenMembershipsByGroup = async (
  db: DbOrTx,
  groupId: number,
): Promise<ReadonlyArray<SteamGroupMembership>> =>
  db
    .select()
    .from(steamGroupMemberships)
    .where(and(eq(steamGroupMemberships.groupId, groupId), isNull(steamGroupMemberships.leftAt)))

export const findOpenMembershipsBySteamId = async (
  db: DbOrTx,
  steamId: SteamId,
): Promise<ReadonlyArray<SteamGroupMembership>> =>
  db
    .select()
    .from(steamGroupMemberships)
    .where(and(eq(steamGroupMemberships.steamId, steamId), isNull(steamGroupMemberships.leftAt)))

export type ApplyMembershipDiffInput = {
  readonly groupId: number
  readonly currentRoster: ReadonlySet<SteamId>
  readonly ranAt: Date
}

export type ApplyMembershipDiffResult = {
  readonly joined: number
  readonly stillPresent: number
  readonly left: number
  readonly stickyUntouched: number
}

export const applyMembershipDiff = async (
  db: DbOrTx,
  input: ApplyMembershipDiffInput,
): Promise<ApplyMembershipDiffResult> => {
  const { groupId, currentRoster, ranAt } = input
  const existing = await findOpenMembershipsByGroup(db, groupId)

  const existingBySteamId = new Map<SteamId, SteamGroupMembership>()
  for (const m of existing) {
    existingBySteamId.set(m.steamId, m)
  }

  let joined = 0
  let stillPresent = 0

  // R \ M: new members — insert rows
  // R ∩ M: still present — update lastSeenAt
  for (const steamId of currentRoster) {
    const row = existingBySteamId.get(steamId)
    if (!row) {
      await db.insert(steamGroupMemberships).values({
        groupId,
        steamId,
        joinedAt: ranAt,
        lastSeenAt: ranAt,
      })
      joined += 1
    } else {
      await db
        .update(steamGroupMemberships)
        .set({ lastSeenAt: ranAt })
        .where(eq(steamGroupMemberships.id, row.id))
      stillPresent += 1
    }
  }

  // M \ R: absent — close rows (unless sticky)
  let left = 0
  let stickyUntouched = 0
  const toClose: number[] = []
  for (const [steamId, row] of existingBySteamId) {
    if (currentRoster.has(steamId)) continue
    if (row.isSticky) {
      stickyUntouched += 1
      continue
    }
    toClose.push(row.id)
    left += 1
  }

  if (toClose.length > 0) {
    await db
      .update(steamGroupMemberships)
      .set({ leftAt: ranAt })
      .where(inArray(steamGroupMemberships.id, toClose))
  }

  return { joined, stillPresent, left, stickyUntouched }
}

export const setMembershipSticky = async (
  db: DbOrTx,
  membershipId: number,
  isSticky: boolean,
): Promise<void> => {
  await db
    .update(steamGroupMemberships)
    .set({ isSticky })
    .where(eq(steamGroupMemberships.id, membershipId))
}

export const reopenMembership = async (db: DbOrTx, membershipId: number): Promise<void> => {
  await db
    .update(steamGroupMemberships)
    .set({ leftAt: null, isSticky: true })
    .where(eq(steamGroupMemberships.id, membershipId))
}

export type MembershipStatusView = {
  readonly inGroup: boolean
  readonly joinedAt: Date
  readonly lastSeenAt: Date
  readonly leftAt: Date | null
}

export const getLatestMembership = async (
  db: DbOrTx,
  groupId: number,
  steamId: SteamId,
): Promise<MembershipStatusView | null> => {
  const [row] = await db
    .select({
      joinedAt: steamGroupMemberships.joinedAt,
      lastSeenAt: steamGroupMemberships.lastSeenAt,
      leftAt: steamGroupMemberships.leftAt,
    })
    .from(steamGroupMemberships)
    .where(
      and(eq(steamGroupMemberships.groupId, groupId), eq(steamGroupMemberships.steamId, steamId)),
    )
    .orderBy(desc(steamGroupMemberships.joinedAt))
    .limit(1)
  if (!row) return null
  return {
    inGroup: row.leftAt === null,
    joinedAt: row.joinedAt,
    lastSeenAt: row.lastSeenAt,
    leftAt: row.leftAt,
  }
}

export type UserGroupMembershipView = {
  readonly groupSlug: string
  readonly groupName: string
  readonly joinedAt: Date
}

export const findUserGroupsWithOpenMembership = async (
  db: DbOrTx,
  steamId: SteamId,
): Promise<ReadonlyArray<UserGroupMembershipView>> => {
  const rows = await db
    .select({
      groupSlug: groups.slug,
      groupName: groups.name,
      joinedAt: steamGroupMemberships.joinedAt,
    })
    .from(steamGroupMemberships)
    .innerJoin(groups, eq(groups.id, steamGroupMemberships.groupId))
    .where(and(eq(steamGroupMemberships.steamId, steamId), isNull(steamGroupMemberships.leftAt)))
    .orderBy(steamGroupMemberships.joinedAt)
  return rows
}

export const batchGetOpenMembershipSteamIds = async (
  db: DbOrTx,
  groupId: number,
  steamIds: ReadonlyArray<SteamId>,
): Promise<ReadonlySet<SteamId>> => {
  if (steamIds.length === 0) return new Set()
  const rows = await db
    .select({ steamId: steamGroupMemberships.steamId })
    .from(steamGroupMemberships)
    .where(
      and(
        eq(steamGroupMemberships.groupId, groupId),
        inArray(steamGroupMemberships.steamId, steamIds),
        isNull(steamGroupMemberships.leftAt),
      ),
    )
  return new Set(rows.map((r) => r.steamId))
}
