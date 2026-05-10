import { z } from 'zod'

import type {
  AuditAction,
  SgCookieTestResult,
  SteamAppId,
  SteamSubId,
  UserRole,
  WinStatus,
} from '#/db/schema'
import { AUDIT_ACTIONS, SG_COOKIE_TEST_RESULTS, USER_ROLES, WIN_STATUSES } from '#/db/schema'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

const WinStatusSchema = z.enum(WIN_STATUSES)
const UserRoleSchema = z.enum(USER_ROLES)
const SgCookieTestResultSchema = z.enum(SG_COOKIE_TEST_RESULTS)

const RoleChangedSchema = z.object({
  before: UserRoleSchema,
  after: UserRoleSchema,
  reason: z.string().max(200).optional(),
})

const CookieSetSchema = z.object({})
const CookieClearedSchema = z.object({})
const CookieTestedSchema = z.object({ result: SgCookieTestResultSchema })

export const WIN_SOURCES = ['scrape', 'manual'] as const
const WinSourceSchema = z.enum(WIN_SOURCES)
export type WinSource = (typeof WIN_SOURCES)[number]

const WinCreatedSchema = z.object({
  source: WinSourceSchema,
})

const WinStatusChangedSchema = z.object({
  from: WinStatusSchema,
  to: WinStatusSchema,
})

const WinNotesUpdatedSchema = z.object({
  before: z.string().nullable(),
  after: z.string().nullable(),
})

const GroupSnapshotSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  playWindowDays: z.number().int().positive(),
  description: z.string().nullable(),
})

const GroupCreatedSchema = GroupSnapshotSchema

const GroupUpdatedSchema = z.object({
  before: GroupSnapshotSchema,
  after: GroupSnapshotSchema,
})

export type GroupSnapshot = z.infer<typeof GroupSnapshotSchema>

// Currently only emitted by the manual-giveaway flow (server/manualGroupFns.ts).
// SG-scraped giveaways intentionally don't audit per-giveaway creates — a
// daily scrape can land hundreds of rows and would flood the log without
// adding signal. The `source` field exists for forward-compatibility if we
// ever want to opt SG creates back in.
const GiveawayCreatedSchema = z.object({
  source: WinSourceSchema,
  groupId: z.number().int().positive(),
  appId: z.number().int().nonnegative().nullable(),
  subId: z.number().int().nonnegative().nullable(),
})

// Manual-only soft-delete; SG-scraped giveaways never reach this path. We
// record the win count + group at the time of deletion so the audit log
// stays readable even if the giveaway/win rows are later hard-deleted from
// the DB for storage reasons.
const GiveawayDeletedSchema = z.object({
  groupId: z.number().int().positive(),
  appId: z.number().int().nonnegative().nullable(),
  subId: z.number().int().nonnegative().nullable(),
  winCount: z.number().int().nonnegative(),
})

export type AuditEvent =
  | { readonly kind: 'win_created'; readonly source: WinSource }
  | { readonly kind: 'win_status_changed'; readonly from: WinStatus; readonly to: WinStatus }
  | {
      readonly kind: 'win_notes_updated'
      readonly before: string | null
      readonly after: string | null
    }
  | ({ readonly kind: 'group_created' } & GroupSnapshot)
  | {
      readonly kind: 'group_updated'
      readonly before: GroupSnapshot
      readonly after: GroupSnapshot
    }
  | {
      readonly kind: 'giveaway_created'
      readonly source: WinSource
      readonly groupId: number
      readonly appId: SteamAppId | null
      readonly subId: SteamSubId | null
    }
  | {
      readonly kind: 'giveaway_deleted'
      readonly groupId: number
      readonly appId: SteamAppId | null
      readonly subId: SteamSubId | null
      readonly winCount: number
    }
  | {
      readonly kind: 'role_granted'
      readonly before: UserRole
      readonly after: UserRole
      readonly reason?: string
    }
  | {
      readonly kind: 'role_revoked'
      readonly before: UserRole
      readonly after: UserRole
      readonly reason?: string
    }
  | { readonly kind: 'cookie_set' }
  | { readonly kind: 'cookie_cleared' }
  | { readonly kind: 'cookie_tested'; readonly result: SgCookieTestResult }

export type AuditParseError =
  | { readonly kind: 'unknown_action'; readonly action: string }
  | {
      readonly kind: 'invalid_payload'
      readonly action: AuditAction
      readonly issues: ReadonlyArray<string>
    }

const isKnownAction = (a: string): a is AuditAction =>
  (AUDIT_ACTIONS as ReadonlyArray<string>).includes(a)

const zodIssues = (e: z.ZodError): ReadonlyArray<string> =>
  e.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)

export const parseAuditEvent = (
  action: string,
  rawPayload: unknown,
): Result<AuditEvent, AuditParseError> => {
  if (!isKnownAction(action)) return err({ kind: 'unknown_action', action })

  switch (action) {
    case 'win_created': {
      const r = WinCreatedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({ kind: 'win_created', source: r.data.source })
    }
    case 'win_status_changed': {
      const r = WinStatusChangedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({ kind: 'win_status_changed', from: r.data.from, to: r.data.to })
    }
    case 'win_notes_updated': {
      const r = WinNotesUpdatedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({ kind: 'win_notes_updated', before: r.data.before, after: r.data.after })
    }
    case 'group_created': {
      const r = GroupCreatedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({ kind: 'group_created', ...r.data })
    }
    case 'group_updated': {
      const r = GroupUpdatedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({ kind: 'group_updated', before: r.data.before, after: r.data.after })
    }
    case 'giveaway_created': {
      const r = GiveawayCreatedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({
        kind: 'giveaway_created',
        source: r.data.source,
        groupId: r.data.groupId,
        appId: r.data.appId as SteamAppId | null,
        subId: r.data.subId as SteamSubId | null,
      })
    }
    case 'giveaway_deleted': {
      const r = GiveawayDeletedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({
        kind: 'giveaway_deleted',
        groupId: r.data.groupId,
        appId: r.data.appId as SteamAppId | null,
        subId: r.data.subId as SteamSubId | null,
        winCount: r.data.winCount,
      })
    }
    case 'role_granted': {
      const r = RoleChangedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({
        kind: 'role_granted',
        before: r.data.before,
        after: r.data.after,
        ...(r.data.reason !== undefined ? { reason: r.data.reason } : {}),
      })
    }
    case 'role_revoked': {
      const r = RoleChangedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({
        kind: 'role_revoked',
        before: r.data.before,
        after: r.data.after,
        ...(r.data.reason !== undefined ? { reason: r.data.reason } : {}),
      })
    }
    case 'cookie_set': {
      const r = CookieSetSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({ kind: 'cookie_set' })
    }
    case 'cookie_cleared': {
      const r = CookieClearedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({ kind: 'cookie_cleared' })
    }
    case 'cookie_tested': {
      const r = CookieTestedSchema.safeParse(rawPayload)
      if (!r.success) {
        return err({ kind: 'invalid_payload', action, issues: zodIssues(r.error) })
      }
      return ok({ kind: 'cookie_tested', result: r.data.result })
    }
  }
}

export const serializeAuditEvent = (
  event: AuditEvent,
): { readonly action: AuditAction; readonly payload: Record<string, unknown> } => {
  switch (event.kind) {
    case 'win_created':
      return { action: 'win_created', payload: { source: event.source } }
    case 'win_status_changed':
      return { action: 'win_status_changed', payload: { from: event.from, to: event.to } }
    case 'win_notes_updated':
      return { action: 'win_notes_updated', payload: { before: event.before, after: event.after } }
    case 'group_created': {
      const { kind: _kind, ...rest } = event
      return { action: 'group_created', payload: rest }
    }
    case 'group_updated':
      return {
        action: 'group_updated',
        payload: { before: event.before, after: event.after },
      }
    case 'giveaway_created':
      return {
        action: 'giveaway_created',
        payload: {
          source: event.source,
          groupId: event.groupId,
          appId: event.appId,
          subId: event.subId,
        },
      }
    case 'giveaway_deleted':
      return {
        action: 'giveaway_deleted',
        payload: {
          groupId: event.groupId,
          appId: event.appId,
          subId: event.subId,
          winCount: event.winCount,
        },
      }
    case 'role_granted':
      return {
        action: 'role_granted',
        payload: {
          before: event.before,
          after: event.after,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      }
    case 'role_revoked':
      return {
        action: 'role_revoked',
        payload: {
          before: event.before,
          after: event.after,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      }
    case 'cookie_set':
      return { action: 'cookie_set', payload: {} }
    case 'cookie_cleared':
      return { action: 'cookie_cleared', payload: {} }
    case 'cookie_tested':
      return { action: 'cookie_tested', payload: { result: event.result } }
  }
}
