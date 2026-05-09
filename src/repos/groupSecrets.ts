import { eq } from 'drizzle-orm'

import type { Db, DbOrTx } from '#/db/client'
import { withTransaction } from '#/db/client'
import type { SgCookieTestResult, SteamGiftsUsername } from '#/db/schema'
import { groupSecrets, groups, users } from '#/db/schema'
import type { DecryptError } from '#/lib/encryption'
import { decrypt, encrypt } from '#/lib/encryption'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { writeAuditEvent } from '#/repos/auditLog'

export type GroupCookieStatus = {
  readonly groupId: number
  readonly groupSlug: string
  readonly groupName: string
  readonly isSet: boolean
  readonly updatedAt: Date | null
  readonly updatedBy: {
    readonly id: number
    readonly steamgiftsUsername: SteamGiftsUsername | null
  } | null
  readonly lastTestedAt: Date | null
  readonly lastTestResult: SgCookieTestResult | null
  readonly lastSuccessAt: Date | null
}

export const listGroupCookieStatuses = async (
  db: DbOrTx,
): Promise<ReadonlyArray<GroupCookieStatus>> => {
  const rows = await db
    .select({
      groupId: groups.id,
      groupSlug: groups.slug,
      groupName: groups.name,
      cookieEncrypted: groupSecrets.steamgiftsCookieEncrypted,
      updatedAt: groupSecrets.steamgiftsCookieUpdatedAt,
      updatedById: users.id,
      updatedByUsername: users.steamgiftsUsername,
      lastTestedAt: groupSecrets.steamgiftsCookieLastTestedAt,
      lastTestResult: groupSecrets.steamgiftsCookieLastTestResult,
      lastSuccessAt: groupSecrets.steamgiftsCookieLastSuccessAt,
    })
    .from(groups)
    .leftJoin(groupSecrets, eq(groupSecrets.groupId, groups.id))
    .leftJoin(users, eq(users.id, groupSecrets.steamgiftsCookieUpdatedByUserId))
    .orderBy(groups.name)

  return rows.map((r) => ({
    groupId: r.groupId,
    groupSlug: r.groupSlug,
    groupName: r.groupName,
    isSet: r.cookieEncrypted !== null && r.cookieEncrypted.length > 0,
    updatedAt: r.updatedAt,
    updatedBy:
      r.updatedById !== null
        ? { id: r.updatedById, steamgiftsUsername: r.updatedByUsername }
        : null,
    lastTestedAt: r.lastTestedAt,
    lastTestResult: r.lastTestResult,
    lastSuccessAt: r.lastSuccessAt,
  }))
}

export type GetCookieError =
  | { readonly kind: 'not_set' }
  | { readonly kind: 'decrypt_failed'; readonly cause: DecryptError }

export const getDecryptedCookie = async (
  db: DbOrTx,
  groupId: number,
): Promise<Result<string, GetCookieError>> => {
  const [row] = await db
    .select({ cookieEncrypted: groupSecrets.steamgiftsCookieEncrypted })
    .from(groupSecrets)
    .where(eq(groupSecrets.groupId, groupId))
    .limit(1)
  if (!row || !row.cookieEncrypted) return err({ kind: 'not_set' })
  const r = decrypt(row.cookieEncrypted)
  if (!r.ok) return err({ kind: 'decrypt_failed', cause: r.error })
  return ok(r.value)
}

export type SetCookieInput = {
  readonly groupId: number
  readonly plaintext: string
  readonly actorUserId: number
  readonly now?: Date
}

// `plaintext` is consumed once here and immediately encrypted; the value never
// crosses any other boundary.
export const setCookie = async (db: Db, input: SetCookieInput): Promise<void> => {
  const ciphertext = encrypt(input.plaintext)
  const now = input.now ?? new Date()
  await withTransaction(db, async (tx) => {
    await tx
      .insert(groupSecrets)
      .values({
        groupId: input.groupId,
        steamgiftsCookieEncrypted: ciphertext,
        steamgiftsCookieUpdatedAt: now,
        steamgiftsCookieUpdatedByUserId: input.actorUserId,
        // Reset test state so the UI doesn't show a stale "login_required"
        // pill against a freshly-pasted cookie.
        steamgiftsCookieLastTestedAt: null,
        steamgiftsCookieLastTestResult: null,
      })
      .onConflictDoUpdate({
        target: groupSecrets.groupId,
        set: {
          steamgiftsCookieEncrypted: ciphertext,
          steamgiftsCookieUpdatedAt: now,
          steamgiftsCookieUpdatedByUserId: input.actorUserId,
          steamgiftsCookieLastTestedAt: null,
          steamgiftsCookieLastTestResult: null,
        },
      })
    await writeAuditEvent(tx, {
      actorUserId: input.actorUserId,
      targetType: 'group',
      targetId: input.groupId,
      event: { kind: 'cookie_set' },
    })
  })
}

export type ClearCookieInput = {
  readonly groupId: number
  readonly actorUserId: number
  readonly now?: Date
}

export const clearCookie = async (db: Db, input: ClearCookieInput): Promise<void> => {
  const now = input.now ?? new Date()
  await withTransaction(db, async (tx) => {
    // Keep the row so we retain who-cleared-when for diagnostics; just null
    // the secret + reset test state.
    await tx
      .insert(groupSecrets)
      .values({
        groupId: input.groupId,
        steamgiftsCookieEncrypted: null,
        steamgiftsCookieUpdatedAt: now,
        steamgiftsCookieUpdatedByUserId: input.actorUserId,
        steamgiftsCookieLastTestedAt: null,
        steamgiftsCookieLastTestResult: null,
        steamgiftsCookieLastSuccessAt: null,
      })
      .onConflictDoUpdate({
        target: groupSecrets.groupId,
        set: {
          steamgiftsCookieEncrypted: null,
          steamgiftsCookieUpdatedAt: now,
          steamgiftsCookieUpdatedByUserId: input.actorUserId,
          steamgiftsCookieLastTestedAt: null,
          steamgiftsCookieLastTestResult: null,
          steamgiftsCookieLastSuccessAt: null,
        },
      })
    await writeAuditEvent(tx, {
      actorUserId: input.actorUserId,
      targetType: 'group',
      targetId: input.groupId,
      event: { kind: 'cookie_cleared' },
    })
  })
}

export type RecordTestResultInput = {
  readonly groupId: number
  readonly result: SgCookieTestResult
  readonly actorUserId?: number | null
  readonly now?: Date
}

export const recordTestResult = async (db: Db, input: RecordTestResultInput): Promise<void> => {
  const now = input.now ?? new Date()
  await withTransaction(db, async (tx) => {
    await tx
      .update(groupSecrets)
      .set({
        steamgiftsCookieLastTestedAt: now,
        steamgiftsCookieLastTestResult: input.result,
        ...(input.result === 'ok' ? { steamgiftsCookieLastSuccessAt: now } : {}),
      })
      .where(eq(groupSecrets.groupId, input.groupId))
    await writeAuditEvent(tx, {
      actorUserId: input.actorUserId ?? null,
      targetType: 'group',
      targetId: input.groupId,
      event: { kind: 'cookie_tested', result: input.result },
    })
  })
}

// Worker hook — record a scrape's authentication outcome without emitting an
// audit event (scrapes are automated and would flood the audit log). Only
// updates last_test_* + last_success_at; never logs a result of `ok` unless
// the scrape really hit SG with this cookie.
export const recordScrapeOutcome = async (
  db: DbOrTx,
  input: { readonly groupId: number; readonly result: SgCookieTestResult; readonly now?: Date },
): Promise<void> => {
  const now = input.now ?? new Date()
  await db
    .update(groupSecrets)
    .set({
      steamgiftsCookieLastTestedAt: now,
      steamgiftsCookieLastTestResult: input.result,
      ...(input.result === 'ok' ? { steamgiftsCookieLastSuccessAt: now } : {}),
    })
    .where(eq(groupSecrets.groupId, input.groupId))
}

export const findGroupCookieStatus = async (
  db: DbOrTx,
  groupId: number,
): Promise<GroupCookieStatus | null> => {
  const [row] = await db
    .select({
      groupId: groups.id,
      groupSlug: groups.slug,
      groupName: groups.name,
      cookieEncrypted: groupSecrets.steamgiftsCookieEncrypted,
      updatedAt: groupSecrets.steamgiftsCookieUpdatedAt,
      updatedById: users.id,
      updatedByUsername: users.steamgiftsUsername,
      lastTestedAt: groupSecrets.steamgiftsCookieLastTestedAt,
      lastTestResult: groupSecrets.steamgiftsCookieLastTestResult,
      lastSuccessAt: groupSecrets.steamgiftsCookieLastSuccessAt,
    })
    .from(groups)
    .leftJoin(groupSecrets, eq(groupSecrets.groupId, groups.id))
    .leftJoin(users, eq(users.id, groupSecrets.steamgiftsCookieUpdatedByUserId))
    .where(eq(groups.id, groupId))
    .limit(1)
  if (!row) return null
  return {
    groupId: row.groupId,
    groupSlug: row.groupSlug,
    groupName: row.groupName,
    isSet: row.cookieEncrypted !== null && row.cookieEncrypted.length > 0,
    updatedAt: row.updatedAt,
    updatedBy:
      row.updatedById !== null
        ? { id: row.updatedById, steamgiftsUsername: row.updatedByUsername }
        : null,
    lastTestedAt: row.lastTestedAt,
    lastTestResult: row.lastTestResult,
    lastSuccessAt: row.lastSuccessAt,
  }
}
