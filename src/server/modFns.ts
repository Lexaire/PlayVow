import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { db, dbWrite } from '#/db/client'
import type {
  AuditAction,
  AuditTargetType,
  SteamGiftsUsername,
  SteamId,
  UserRole,
} from '#/db/schema'
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, WIN_STATUSES } from '#/db/schema'
import { listAuditEntries } from '#/repos/auditLog'
import type { ListAuditEntriesResult } from '#/repos/auditLog'
import { findGroupBySlug } from '#/repos/groups'
import { applyWinNotesUpdate, applyWinStatusChange } from '#/repos/modActions'
import type { ModWinError, NotesUpdateOutcome, StatusChangeOutcome } from '#/repos/modActions'
import { findGroupIdByWinId } from '#/repos/wins'
import type { Result } from '#/lib/result'
import { err } from '#/lib/result'
import {
  getCurrentUser,
  getModeratedGroupIds,
  requireAnyModerator,
  requireGroupModerator,
} from '#/server/auth'
import { DEFAULT_PAGE_SIZE, getModWinDetail, getModWinsPage } from '#/server/queries'
import type { ModWinDetailData, ModWinsFilter } from '#/server/queries'

// Most mod actions are scoped to a single group; they take a winId or slug
// and gate via `requireGroupModerator(groupId)` derived from the input. The
// only cross-group entry points are `fetchModSession` (which advertises
// what the viewer can mod) and `fetchAuditLogPage` (which is intentionally
// unfiltered — see review notes).

export type CurrentUserInfo = {
  readonly id: number
  readonly role: UserRole
  readonly steamgiftsUsername: SteamGiftsUsername | null
  readonly steamId: SteamId | null
  readonly avatarUrl: string | null
}

export type ModSessionInfo = {
  readonly user: CurrentUserInfo | null
  // Group ids the viewer can moderate directly (admin returns an empty set
  // here — they can mod everything; consumers special-case admin).
  readonly moderatedGroupIds: ReadonlyArray<number>
}

const toCurrentUserInfo = (user: {
  readonly id: number
  readonly role: UserRole
  readonly steamgiftsUsername: SteamGiftsUsername | null
  readonly steamId: SteamId | null
  readonly avatarUrl: string | null
}): CurrentUserInfo => ({
  id: user.id,
  role: user.role,
  steamgiftsUsername: user.steamgiftsUsername,
  steamId: user.steamId,
  avatarUrl: user.avatarUrl,
})

export const fetchModSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ModSessionInfo> => {
    const user = await getCurrentUser()
    const moderatedGroupIds = await getModeratedGroupIds(user)
    return {
      user: user ? toCurrentUserInfo(user) : null,
      moderatedGroupIds: Array.from(moderatedGroupIds),
    }
  },
)

const ModGroupPageSchema = z.object({
  slug: z.string().min(1).max(64),
  filter: z.enum(['all', 'pending']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
})

export const fetchModGroupPage = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: { slug: string; filter?: ModWinsFilter; page?: number; pageSize?: number }) =>
      ModGroupPageSchema.parse(input),
  )
  .handler(async ({ data }) => {
    const group = await findGroupBySlug(dbWrite(), data.slug)
    if (!group) return null
    await requireGroupModerator(group.id)
    return getModWinsPage(dbWrite(), data.slug, data.filter, data.page, data.pageSize)
  })

const WinIdSchema = z.object({ winId: z.number().int().positive() })

export const fetchModWinDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: { winId: number }) => WinIdSchema.parse(input))
  .handler(async ({ data }): Promise<ModWinDetailData | null> => {
    const groupId = await findGroupIdByWinId(dbWrite(), data.winId)
    if (groupId === null) return null
    await requireGroupModerator(groupId)
    return getModWinDetail(dbWrite(), data.winId)
  })

const StatusChangeSchema = z.object({
  winId: z.number().int().positive(),
  to: z.enum(WIN_STATUSES),
})

export const setWinStatus = createServerFn({ method: 'POST' })
  .inputValidator((input: { winId: number; to: (typeof WIN_STATUSES)[number] }) =>
    StatusChangeSchema.parse(input),
  )
  .handler(async ({ data }): Promise<Result<StatusChangeOutcome, ModWinError>> => {
    const groupId = await findGroupIdByWinId(dbWrite(), data.winId)
    if (groupId === null) return err({ kind: 'win_not_found', winId: data.winId })
    const mod = await requireGroupModerator(groupId)
    return applyWinStatusChange(dbWrite(), data.winId, data.to, new Date(), mod.id)
  })

const BULK_STATUS_CHANGE_LIMIT = 200

const StatusChangeBulkSchema = z.object({
  winIds: z.array(z.number().int().positive()).min(1).max(BULK_STATUS_CHANGE_LIMIT),
  to: z.enum(WIN_STATUSES),
})

export type BulkStatusError =
  | { readonly kind: 'unauthorized'; readonly winIds: ReadonlyArray<number> }
  | ModWinError

export type BulkStatusOutcome = {
  readonly updated: ReadonlyArray<number>
  readonly errors: ReadonlyArray<{ readonly winId: number; readonly error: BulkStatusError }>
}

// Bulk path needs a per-win group check because a mod may be authorized for
// some wins in the request and not others. We require admin OR mod-on-each-
// distinct-group across the whole set; mismatches are returned per-win as
// `unauthorized` errors so the caller can show which rows didn't apply.
export const setWinStatusBulk = createServerFn({ method: 'POST' })
  .inputValidator((input: { winIds: number[]; to: (typeof WIN_STATUSES)[number] }) =>
    StatusChangeBulkSchema.parse(input),
  )
  .handler(async ({ data }): Promise<BulkStatusOutcome> => {
    const user = await getCurrentUser()
    if (!user) return { updated: [], errors: data.winIds.map((winId) => ({ winId, error: { kind: 'unauthorized', winIds: [winId] } })) }
    const moderatedGroupIds =
      user.role === 'admin' ? null : await getModeratedGroupIds(user)
    const now = new Date()
    const dbR = dbWrite()
    const uniqueIds = Array.from(new Set(data.winIds))
    const updated: number[] = []
    const errors: { winId: number; error: BulkStatusError }[] = []
    for (const winId of uniqueIds) {
      const groupId = await findGroupIdByWinId(dbR, winId)
      if (groupId === null) {
        errors.push({ winId, error: { kind: 'win_not_found', winId } })
        continue
      }
      const authorized =
        moderatedGroupIds === null || moderatedGroupIds.has(groupId)
      if (!authorized) {
        errors.push({ winId, error: { kind: 'unauthorized', winIds: [winId] } })
        continue
      }
      const result = await applyWinStatusChange(dbR, winId, data.to, now, user.id)
      if (result.ok) updated.push(winId)
      else errors.push({ winId, error: result.error })
    }
    return { updated, errors }
  })

const NotesSchema = z.object({
  winId: z.number().int().positive(),
  notes: z.string().max(2000).nullable(),
})

export const updateWinNotesFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { winId: number; notes: string | null }) => NotesSchema.parse(input))
  .handler(async ({ data }): Promise<Result<NotesUpdateOutcome, ModWinError>> => {
    const groupId = await findGroupIdByWinId(dbWrite(), data.winId)
    if (groupId === null) return err({ kind: 'win_not_found', winId: data.winId })
    const mod = await requireGroupModerator(groupId)
    return applyWinNotesUpdate(dbWrite(), data.winId, data.notes, mod.id)
  })

const AUDIT_LOG_PAGE_SIZE = 50

const AuditLogPageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  action: z.enum(AUDIT_ACTIONS).optional(),
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  actorQuery: z.string().trim().min(1).max(64).optional(),
})

// Cross-group view; we gate on "is admin OR moderates any group" but don't
// filter the rows. By design — the audit log is essentially public history
// for this project, and per-group filtering would complicate the query for
// negligible privacy benefit.
export const fetchAuditLogPage = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      page?: number
      action?: AuditAction
      targetType?: AuditTargetType
      actorQuery?: string
    }) => AuditLogPageSchema.parse(input),
  )
  .handler(async ({ data }): Promise<ListAuditEntriesResult> => {
    await requireAnyModerator()
    return listAuditEntries(db(), {
      page: data.page,
      pageSize: AUDIT_LOG_PAGE_SIZE,
      ...(data.action ? { action: data.action } : {}),
      ...(data.targetType ? { targetType: data.targetType } : {}),
      ...(data.actorQuery ? { actorQuery: data.actorQuery } : {}),
    })
  })
