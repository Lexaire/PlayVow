import { and, count, desc, eq, sql } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { AuditAction, AuditTargetType, SteamGiftsUsername, SteamId } from '#/db/schema'
import { auditLog, users } from '#/db/schema'
import type { AuditEvent, AuditParseError } from '#/domain/audit'
import { parseAuditEvent, serializeAuditEvent } from '#/domain/audit'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

export type AuditActor = {
  readonly id: number
  readonly steamgiftsUsername: SteamGiftsUsername | null
  readonly steamId: SteamId | null
}

export type AuditEntry = {
  readonly id: number
  readonly actor: AuditActor | null
  readonly targetType: AuditTargetType
  readonly targetId: number
  readonly event: AuditEvent
  readonly createdAt: Date
}

export type WriteAuditInput = {
  readonly event: AuditEvent
  readonly targetType: AuditTargetType
  readonly targetId: number
  readonly actorUserId?: number | null
}

export type AuditEntryReadError = {
  readonly id: number
  readonly cause: AuditParseError
}

export const writeAuditEvent = async (db: DbOrTx, input: WriteAuditInput): Promise<void> => {
  const { action, payload } = serializeAuditEvent(input.event)
  await db.insert(auditLog).values({
    actorUserId: input.actorUserId ?? null,
    action,
    targetType: input.targetType,
    targetId: input.targetId,
    payload,
  })
}

export type AuditEntryRead = Result<AuditEntry, AuditEntryReadError>

export type ListAuditEntriesInput = {
  readonly page: number
  readonly pageSize: number
  readonly action?: AuditAction
  readonly targetType?: AuditTargetType
  readonly actorQuery?: string
}

export type ListAuditEntriesResult = {
  readonly rows: ReadonlyArray<AuditEntryRead>
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

const buildAuditFilters = (input: ListAuditEntriesInput) => {
  const conditions = []
  if (input.action) conditions.push(eq(auditLog.action, input.action))
  if (input.targetType) conditions.push(eq(auditLog.targetType, input.targetType))
  if (input.actorQuery && input.actorQuery.length > 0) {
    const pattern = `%${escapeLike(input.actorQuery).toLowerCase()}%`
    conditions.push(sql`lower(${users.steamgiftsUsername}) like ${pattern} escape '\\'`)
  }
  return conditions.length === 0 ? undefined : and(...conditions)
}

export const listAuditEntries = async (
  db: DbOrTx,
  input: ListAuditEntriesInput,
): Promise<ListAuditEntriesResult> => {
  const where = buildAuditFilters(input)
  const offset = Math.max(0, (input.page - 1) * input.pageSize)

  const [totalRow] = await db
    .select({ n: count() })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(where ?? sql`1=1`)

  const rows = await db
    .select({
      entry: auditLog,
      actorId: users.id,
      actorUsername: users.steamgiftsUsername,
      actorSteamId: users.steamId,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(where ?? sql`1=1`)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(input.pageSize)
    .offset(offset)

  return {
    rows: rows.map(toAuditEntryRead),
    total: totalRow?.n ?? 0,
    page: input.page,
    pageSize: input.pageSize,
  }
}

const toAuditEntryRead = ({
  entry,
  actorId,
  actorUsername,
  actorSteamId,
}: {
  entry: typeof auditLog.$inferSelect
  actorId: number | null
  actorUsername: SteamGiftsUsername | null
  actorSteamId: SteamId | null
}): AuditEntryRead => {
  const parsed = parseAuditEvent(entry.action, entry.payload)
  if (!parsed.ok) return err({ id: entry.id, cause: parsed.error })
  const actor: AuditActor | null =
    actorId !== null
      ? { id: actorId, steamgiftsUsername: actorUsername, steamId: actorSteamId }
      : null
  return ok({
    id: entry.id,
    actor,
    targetType: entry.targetType,
    targetId: entry.targetId,
    event: parsed.value,
    createdAt: entry.createdAt,
  })
}

export const listAuditEntriesForTarget = async (
  db: DbOrTx,
  targetType: AuditTargetType,
  targetId: number,
  limit: number,
): Promise<ReadonlyArray<Result<AuditEntry, AuditEntryReadError>>> => {
  const rows = await db
    .select({
      entry: auditLog,
      actorId: users.id,
      actorUsername: users.steamgiftsUsername,
      actorSteamId: users.steamId,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.targetType, targetType), eq(auditLog.targetId, targetId)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit)

  return rows.map(toAuditEntryRead)
}
