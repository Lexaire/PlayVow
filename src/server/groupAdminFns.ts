import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { db, dbWrite, withTransaction } from '#/db/client'
import type {
  GroupSource,
  SteamGiftsGroupCode,
  SteamGroupId,
} from '#/db/schema'
import { GROUP_SOURCES } from '#/db/schema'
import { writeAuditEvent } from '#/repos/auditLog'
import type { Group } from '#/repos/groups'
import {
  createGroup,
  findGroupById,
  findGroupBySlug,
  listGroups,
  updateGroup,
} from '#/repos/groups'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { requireAdmin } from '#/server/auth'

// SG slugs are always alphanumeric + hyphens; same constraint suits our
// internal slugs since they show up as path segments under /g/.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SLUG_PATTERN, 'Slug must be alphanumeric with optional hyphens')

const optionalNonEmpty = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null)

const CreateGroupSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(120),
    source: z.enum(GROUP_SOURCES),
    playWindowDays: z.number().int().min(1).max(3650),
    description: optionalNonEmpty(2000),
    steamgiftsGroupCode: optionalNonEmpty(32),
    steamGroupId: optionalNonEmpty(32),
    steamGroupSlug: optionalNonEmpty(64),
  })
  // Steam Gifts source needs both the SG group code and the Steam group slug
  // — the daily scrape builds its listing URL from both. The Steam group
  // fields (id + slug) come together — either both or neither. Manual
  // groups can omit everything but may opt into Steam group linkage for
  // roster tracking.
  .refine(
    (v) => v.source !== 'steamgifts' || v.steamgiftsGroupCode !== null,
    { path: ['steamgiftsGroupCode'], message: 'Required for Steam Gifts groups' },
  )
  .refine(
    (v) => v.source !== 'steamgifts' || v.steamGroupSlug !== null,
    { path: ['steamGroupSlug'], message: 'Required for Steam Gifts groups' },
  )
  .refine(
    (v) => (v.steamGroupId === null) === (v.steamGroupSlug === null),
    { path: ['steamGroupSlug'], message: 'Steam group ID and slug must be set together' },
  )

const UpdateGroupSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    playWindowDays: z.number().int().min(1).max(3650),
    description: optionalNonEmpty(2000),
    steamgiftsGroupCode: optionalNonEmpty(32),
    steamGroupId: optionalNonEmpty(32),
    steamGroupSlug: optionalNonEmpty(64),
  })
  .refine(
    (v) => (v.steamGroupId === null) === (v.steamGroupSlug === null),
    { path: ['steamGroupSlug'], message: 'Steam group ID and slug must be set together' },
  )

export type CreateGroupError =
  | { readonly kind: 'slug_taken' }
  | { readonly kind: 'sg_code_required' }

export type UpdateGroupError =
  | { readonly kind: 'group_not_found' }
  | { readonly kind: 'sg_fields_required' }

export type AdminGroupRow = {
  readonly id: number
  readonly slug: string
  readonly name: string
  readonly source: GroupSource
  readonly playWindowDays: number
  readonly description: string | null
  readonly steamgiftsGroupCode: SteamGiftsGroupCode | null
  readonly steamGroupId: SteamGroupId | null
  readonly steamGroupSlug: string | null
  readonly totalWins: number
  readonly pendingWins: number
  readonly lastScrapedAt: Date | null
  readonly createdAt: Date
}

const toAdminGroupRow = (g: Group): AdminGroupRow => ({
  id: g.id,
  slug: g.slug,
  name: g.name,
  source: g.source,
  playWindowDays: g.playWindowDays,
  description: g.description,
  steamgiftsGroupCode: g.steamgiftsGroupCode,
  steamGroupId: g.steamGroupId,
  steamGroupSlug: g.steamGroupSlug,
  totalWins: g.totalWins,
  pendingWins: g.pendingWins,
  lastScrapedAt: g.lastScrapedAt,
  createdAt: g.createdAt,
})

export const listGroupsForAdmin = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ReadonlyArray<AdminGroupRow>> => {
    await requireAdmin()
    const rows = await listGroups(db())
    return rows.map(toAdminGroupRow)
  },
)

type CreateGroupInput = z.infer<typeof CreateGroupSchema>
type UpdateGroupInput = z.infer<typeof UpdateGroupSchema>

export const createGroupFn = createServerFn({ method: 'POST' })
  .inputValidator((input: CreateGroupInput) => CreateGroupSchema.parse(input))
  .handler(async ({ data }): Promise<Result<AdminGroupRow, CreateGroupError>> => {
    const admin = await requireAdmin()
    const existing = await findGroupBySlug(db(), data.slug)
    if (existing) return err({ kind: 'slug_taken' })

    const created = await withTransaction(dbWrite(), async (tx) => {
      const row = await createGroup(tx, {
        slug: data.slug,
        name: data.name,
        source: data.source,
        playWindowDays: data.playWindowDays,
        description: data.description,
        steamgiftsGroupCode: data.steamgiftsGroupCode as SteamGiftsGroupCode | null,
        steamGroupId: data.steamGroupId as SteamGroupId | null,
        steamGroupSlug: data.steamGroupSlug,
      })
      await writeAuditEvent(tx, {
        actorUserId: admin.id,
        targetType: 'group',
        targetId: row.id,
        event: {
          kind: 'group_created',
          slug: row.slug,
          name: row.name,
          playWindowDays: row.playWindowDays,
          description: row.description,
        },
      })
      return row
    })
    return ok(toAdminGroupRow(created))
  })

export const updateGroupFn = createServerFn({ method: 'POST' })
  .inputValidator((input: UpdateGroupInput) => UpdateGroupSchema.parse(input))
  .handler(async ({ data }): Promise<Result<AdminGroupRow, UpdateGroupError>> => {
    const admin = await requireAdmin()
    const existing = await findGroupById(db(), data.id)
    if (!existing) return err({ kind: 'group_not_found' })
    // SG scrape needs the SG group code + the Steam group slug to build the
    // listing URL (worker/jobs/scrape-group.ts) — clearing either via edit
    // would silently knock the group out of the daily scrape rotation.
    if (
      existing.source === 'steamgifts' &&
      (data.steamgiftsGroupCode === null || data.steamGroupSlug === null)
    ) {
      return err({ kind: 'sg_fields_required' })
    }

    const updated = await withTransaction(dbWrite(), async (tx) => {
      const row = await updateGroup(tx, data.id, {
        name: data.name,
        playWindowDays: data.playWindowDays,
        description: data.description,
        steamgiftsGroupCode: data.steamgiftsGroupCode as SteamGiftsGroupCode | null,
        steamGroupId: data.steamGroupId as SteamGroupId | null,
        steamGroupSlug: data.steamGroupSlug,
      })
      await writeAuditEvent(tx, {
        actorUserId: admin.id,
        targetType: 'group',
        targetId: row.id,
        event: {
          kind: 'group_updated',
          before: {
            slug: existing.slug,
            name: existing.name,
            playWindowDays: existing.playWindowDays,
            description: existing.description,
          },
          after: {
            slug: row.slug,
            name: row.name,
            playWindowDays: row.playWindowDays,
            description: row.description,
          },
        },
      })
      return row
    })
    return ok(toAdminGroupRow(updated))
  })
