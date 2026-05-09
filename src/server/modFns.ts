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
import { applyWinNotesUpdate, applyWinStatusChange } from '#/repos/modActions'
import type { ModWinError, NotesUpdateOutcome, StatusChangeOutcome } from '#/repos/modActions'
import type { Result } from '#/lib/result'
import { getCurrentUser, requireModerator } from '#/server/auth'
import { DEFAULT_PAGE_SIZE, getModWinDetail, getModWinsPage } from '#/server/queries'
import type { ModWinDetailData, ModWinsFilter } from '#/server/queries'

const requireMod = async (): Promise<number> => (await requireModerator()).id

export type CurrentUserInfo = {
  readonly id: number
  readonly role: UserRole
  readonly steamgiftsUsername: SteamGiftsUsername | null
  readonly steamId: SteamId | null
  readonly avatarUrl: string | null
}

export type ModSessionInfo = { readonly user: CurrentUserInfo | null }

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
    return { user: user ? toCurrentUserInfo(user) : null }
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
    await requireMod()
    return getModWinsPage(dbWrite(), data.slug, data.filter, data.page, data.pageSize)
  })

const WinIdSchema = z.object({ winId: z.number().int().positive() })

export const fetchModWinDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: { winId: number }) => WinIdSchema.parse(input))
  .handler(async ({ data }): Promise<ModWinDetailData | null> => {
    await requireMod()
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
    const modUserId = await requireMod()
    return applyWinStatusChange(dbWrite(), data.winId, data.to, new Date(), modUserId)
  })

const BULK_STATUS_CHANGE_LIMIT = 200

const StatusChangeBulkSchema = z.object({
  winIds: z.array(z.number().int().positive()).min(1).max(BULK_STATUS_CHANGE_LIMIT),
  to: z.enum(WIN_STATUSES),
})

export type BulkStatusOutcome = {
  readonly updated: ReadonlyArray<number>
  readonly errors: ReadonlyArray<{ readonly winId: number; readonly error: ModWinError }>
}

export const setWinStatusBulk = createServerFn({ method: 'POST' })
  .inputValidator((input: { winIds: number[]; to: (typeof WIN_STATUSES)[number] }) =>
    StatusChangeBulkSchema.parse(input),
  )
  .handler(async ({ data }): Promise<BulkStatusOutcome> => {
    const modUserId = await requireMod()
    const now = new Date()
    const db = dbWrite()
    const uniqueIds = Array.from(new Set(data.winIds))
    const updated: number[] = []
    const errors: { winId: number; error: ModWinError }[] = []
    for (const winId of uniqueIds) {
      const result = await applyWinStatusChange(db, winId, data.to, now, modUserId)
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
    const modUserId = await requireMod()
    return applyWinNotesUpdate(dbWrite(), data.winId, data.notes, modUserId)
  })

const AUDIT_LOG_PAGE_SIZE = 50

const AuditLogPageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  action: z.enum(AUDIT_ACTIONS).optional(),
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  actorQuery: z.string().trim().min(1).max(64).optional(),
})

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
    await requireMod()
    return listAuditEntries(db(), {
      page: data.page,
      pageSize: AUDIT_LOG_PAGE_SIZE,
      ...(data.action ? { action: data.action } : {}),
      ...(data.targetType ? { targetType: data.targetType } : {}),
      ...(data.actorQuery ? { actorQuery: data.actorQuery } : {}),
    })
  })
