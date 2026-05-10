import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { env } from '#/config/env'
import { db, dbWrite, withTransaction } from '#/db/client'
import type { ProfileVisibility, SteamAppId, SteamId, SteamSubId } from '#/db/schema'
import { parseSteamInput } from '#/domain/steamInput'
import { computePlayDeadline } from '#/domain/wins'
import type { SteamApiError } from '#/external/steam-api'
import { createSteamApiClient } from '#/external/steam-api'
import type { ProfileXmlError } from '#/external/steam-community'
import { createSteamCommunityClient } from '#/external/steam-community'
import { writeAuditEvent } from '#/repos/auditLog'
import type { Giveaway } from '#/repos/giveaways'
import {
  createManualGiveaway,
  findGiveawayById,
  softDeleteManualGiveawayTx,
  updateManualGiveawayDatesTx,
} from '#/repos/giveaways'
import { findGroupById } from '#/repos/groups'
import { upsertSteamApp } from '#/repos/steamApps'
import { upsertSteamSub } from '#/repos/steamSubs'
import { upsertUserBySteamId } from '#/repos/users'
import type { Win } from '#/repos/wins'
import { insertWinIfAbsent } from '#/repos/wins'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { requireAdmin, requireGroupModerator } from '#/server/auth'

// Server-side Steam clients — built lazily because admin/mod actions are
// rare compared to worker-driven calls. No rate limiting wrapper: each
// manual action makes at most a handful of Steam calls (store item + one
// profile XML per user), well below any per-key throttle.
let steamClient: ReturnType<typeof createSteamApiClient> | undefined
let steamCommunityClient: ReturnType<typeof createSteamCommunityClient> | undefined

const getSteamClient = (): ReturnType<typeof createSteamApiClient> => {
  if (!steamClient) {
    steamClient = createSteamApiClient({ apiKey: env.STEAM_WEB_API_KEY })
  }
  return steamClient
}

const getSteamCommunityClient = (): ReturnType<typeof createSteamCommunityClient> => {
  if (!steamCommunityClient) {
    steamCommunityClient = createSteamCommunityClient()
  }
  return steamCommunityClient
}

const ItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app'), id: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('sub'), id: z.number().int().nonnegative() }),
])

const SteamUserInputSchema = z.string().trim().min(1).max(200)

// Manual giveaways always have quantity 1 — there's exactly one winner the
// mod is recording. If we ever need multi-copy manual giveaways, expose
// quantity in the form and add it back here.
const MANUAL_GIVEAWAY_QUANTITY = 1

const AddGiveawaySchema = z.object({
  groupId: z.number().int().positive(),
  item: ItemSchema,
  creator: SteamUserInputSchema,
  winner: SteamUserInputSchema,
  // Optional explicit lifecycle dates. When omitted, the giveaway uses
  // "now" for both — the legacy behavior. The server enforces start <= end
  // and accepts either Date instances (server fn payload) or ISO strings
  // (form-submitted JSON) via z.coerce.date().
  startedAt: z.coerce.date().optional(),
  endedAt: z.coerce.date().optional(),
})

// "field" tags which input — creator vs. winner — failed resolution, so the
// form can render the message next to the offending input instead of a
// generic top-line error.
export type SteamUserResolveError =
  | {
      readonly kind: 'profile_lookup_failed'
      readonly field: 'creator' | 'winner'
      readonly cause: ProfileXmlError
    }
  | { readonly kind: 'invalid_input'; readonly field: 'creator' | 'winner' }

export type ItemResolveError =
  | { readonly kind: 'item_not_found' }
  | { readonly kind: 'steam_api_failed'; readonly cause: SteamApiError }

export type AddManualGiveawayError =
  | { readonly kind: 'group_not_found' }
  | { readonly kind: 'group_not_manual' }
  | { readonly kind: 'invalid_date_range' }
  | ItemResolveError
  | SteamUserResolveError

export type AddManualGiveawayResult = {
  readonly giveaway: Giveaway
  readonly itemName: string
  readonly win: Win
}

// Resolved Steam profile ready for upsertUserBySteamId. We use the
// /profiles/<id>?xml=1 (or /id/<vanity>?xml=1) endpoint for both ID and
// vanity inputs because it returns SteamID + persona name + avatar +
// visibility in one shot — so a mod entering "lext" gets all four fields
// recorded against the upserted user, no second call needed.
type ResolvedSteamUser = {
  readonly steamId: SteamId
  readonly personaName: string
  readonly avatarUrl: string | null
  readonly profileVisibility: ProfileVisibility
}

const resolveSteamIdFromInput = async (
  input: string,
  field: 'creator' | 'winner',
): Promise<Result<ResolvedSteamUser, SteamUserResolveError>> => {
  const parsed = parseSteamInput(input)
  if (!parsed.ok) return err({ kind: 'invalid_input', field })
  const r = await getSteamCommunityClient().getProfileXml(parsed.value)
  if (!r.ok) return err({ kind: 'profile_lookup_failed', field, cause: r.error })
  return ok({
    steamId: r.value.steamId,
    personaName: r.value.personaName,
    avatarUrl: r.value.avatarUrl,
    profileVisibility: r.value.profileVisibility,
  })
}

type ResolvedItem =
  | { readonly kind: 'app'; readonly appId: SteamAppId; readonly name: string }
  | { readonly kind: 'sub'; readonly subId: SteamSubId; readonly name: string }

const resolveItem = async (
  item: { kind: 'app' | 'sub'; id: number },
): Promise<Result<ResolvedItem, ItemResolveError>> => {
  const request =
    item.kind === 'app'
      ? { kind: 'app' as const, appId: item.id as SteamAppId }
      : { kind: 'sub' as const, subId: item.id as SteamSubId }
  const r = await getSteamClient().getStoreItems([request])
  if (!r.ok) return err({ kind: 'steam_api_failed', cause: r.error })
  const entry = r.value[0]
  if (!entry || entry.item === null) return err({ kind: 'item_not_found' })
  if (entry.kind === 'app' && entry.item.kind === 'app') {
    return ok({ kind: 'app', appId: entry.appId, name: entry.item.name })
  }
  if (entry.kind === 'sub' && entry.item.kind === 'sub') {
    return ok({ kind: 'sub', subId: entry.subId, name: entry.item.name })
  }
  return err({ kind: 'item_not_found' })
}

export const addManualGiveawayFn = createServerFn({ method: 'POST' })
  .inputValidator((input: z.infer<typeof AddGiveawaySchema>) => AddGiveawaySchema.parse(input))
  .handler(async ({ data }): Promise<Result<AddManualGiveawayResult, AddManualGiveawayError>> => {
    const group = await findGroupById(db(), data.groupId)
    if (!group) return err({ kind: 'group_not_found' })
    if (group.source !== 'manual') return err({ kind: 'group_not_manual' })
    // Group-scoped mod gate runs after the existence check so a non-mod
    // probing for a group's existence doesn't get a different shape than
    // a real moderator hitting a missing id.
    const mod = await requireGroupModerator(group.id)

    // Validate the optional date range up front. Both must be present or
    // both absent; partial input is rejected so the caller picks a clear
    // intent. If absent, the legacy "use now() for both" flow runs.
    if ((data.startedAt === undefined) !== (data.endedAt === undefined)) {
      return err({ kind: 'invalid_date_range' })
    }
    if (
      data.startedAt !== undefined &&
      data.endedAt !== undefined &&
      data.startedAt.getTime() > data.endedAt.getTime()
    ) {
      return err({ kind: 'invalid_date_range' })
    }

    const itemR = await resolveItem(data.item)
    if (!itemR.ok) return err(itemR.error)
    const item = itemR.value

    // Resolve creator + winner before opening the write tx — Steam Web API
    // calls can take a beat, and dragging them into the transaction would
    // hold a write lock. Both happen sequentially for clarity; the manual
    // flow is rare enough that parallelizing isn't worth the code.
    const creatorR = await resolveSteamIdFromInput(data.creator, 'creator')
    if (!creatorR.ok) return err(creatorR.error)
    const creatorProfile = creatorR.value

    const winnerR = await resolveSteamIdFromInput(data.winner, 'winner')
    if (!winnerR.ok) return err(winnerR.error)
    const winnerProfile = winnerR.value

    const now = new Date()
    const startedAt = data.startedAt ?? now
    const endedAt = data.endedAt ?? now
    // Play deadline is anchored on the giveaway's end date, not insertion
    // time — when a mod backdates a giveaway, "play within N days" should
    // run from when the win actually happened.
    const playDeadline = computePlayDeadline(endedAt, group.playWindowDays)

    const result = await withTransaction(dbWrite(), async (tx) => {
      // Upsert app/sub with name + lastSyncedAt so the row exists with usable
      // metadata immediately; the periodic sync_app_details job will fill in
      // the rest of the asset/review fields on its next run.
      if (item.kind === 'app') {
        await upsertSteamApp(tx, { appId: item.appId, name: item.name, lastSyncedAt: now })
      } else {
        await upsertSteamSub(tx, { subId: item.subId, name: item.name, lastSyncedAt: now })
      }

      // Creator is the actual gift-giver the mod entered, not the mod
      // themselves. The mod's identity for "who did this admin action" lives
      // on the audit row's actorUserId below. Persona/avatar/visibility came
      // back free with the resolution call so we record them here — saves the
      // periodic poll the work of filling them in later.
      const creatorUser = await upsertUserBySteamId(tx, {
        steamId: creatorProfile.steamId,
        personaName: creatorProfile.personaName,
        avatarUrl: creatorProfile.avatarUrl,
        profileVisibility: creatorProfile.profileVisibility,
        lastSyncedAt: now,
      })

      const giveaway = await createManualGiveaway(tx, {
        groupId: group.id,
        target:
          item.kind === 'app'
            ? { kind: 'app', appId: item.appId }
            : { kind: 'sub', subId: item.subId },
        creatorUserId: creatorUser.id,
        quantity: MANUAL_GIVEAWAY_QUANTITY,
        addedAt: now,
        startedAt,
        endedAt,
      })

      await writeAuditEvent(tx, {
        actorUserId: mod.id,
        targetType: 'giveaway',
        targetId: giveaway.id,
        event: {
          kind: 'giveaway_created',
          source: 'manual',
          groupId: group.id,
          appId: item.kind === 'app' ? item.appId : null,
          subId: item.kind === 'sub' ? item.subId : null,
          startedAt,
          endedAt,
        },
      })

      const winnerUser = await upsertUserBySteamId(tx, {
        steamId: winnerProfile.steamId,
        personaName: winnerProfile.personaName,
        avatarUrl: winnerProfile.avatarUrl,
        profileVisibility: winnerProfile.profileVisibility,
        lastSyncedAt: now,
      })
      // Fresh giveaway just inserted, so insertWinIfAbsent can't collide.
      // null here would be an invariant violation, not a user-facing error.
      const win = await insertWinIfAbsent(tx, {
        giveawayId: giveaway.id,
        userId: winnerUser.id,
        wonAt: endedAt,
        playDeadline,
      })
      if (!win) {
        throw new Error(
          `addManualGiveawayFn: insertWinIfAbsent returned null for fresh giveaway=${String(giveaway.id)}`,
        )
      }

      await writeAuditEvent(tx, {
        actorUserId: mod.id,
        targetType: 'win',
        targetId: win.id,
        event: { kind: 'win_created', source: 'manual' },
      })

      return { giveaway, itemName: item.name, win }
    })
    return ok(result)
  })

const DeleteGiveawaySchema = z.object({
  giveawayId: z.number().int().positive(),
})

export type DeleteManualGiveawayError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_manual' }
  | { readonly kind: 'already_deleted' }

export type DeleteManualGiveawayResult = {
  readonly giveawayId: number
  readonly winCount: number
}

// Admin-only soft-delete for manual giveaways. SG-scraped giveaways aren't
// eligible — the next scrape would just re-surface them, and silently
// re-suppressing them would be confusing. The repo helper handles counter
// math; this fn adds the auth gate, the audit event, and the result shape.
export const deleteManualGiveawayFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { giveawayId: number }) => DeleteGiveawaySchema.parse(input))
  .handler(
    async ({ data }): Promise<Result<DeleteManualGiveawayResult, DeleteManualGiveawayError>> => {
      const admin = await requireAdmin()
      const now = new Date()

      const result = await withTransaction(dbWrite(), async (tx) => {
        const r = await softDeleteManualGiveawayTx(tx, data.giveawayId, now)
        if (!r.ok) return r
        const { giveaway, winCount } = r.value
        await writeAuditEvent(tx, {
          actorUserId: admin.id,
          targetType: 'giveaway',
          targetId: giveaway.id,
          event: {
            kind: 'giveaway_deleted',
            groupId: giveaway.groupId,
            appId: giveaway.steamAppId,
            subId: giveaway.steamSubId,
            winCount,
          },
        })
        return { ok: true as const, value: { giveawayId: giveaway.id, winCount } }
      })

      if (!result.ok) return err(result.error)
      return ok(result.value)
    },
  )

const UpdateGiveawayDatesSchema = z.object({
  giveawayId: z.number().int().positive(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
})

export type UpdateManualGiveawayDatesError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_manual' }
  | { readonly kind: 'already_deleted' }
  | { readonly kind: 'invalid_range' }

export type UpdateManualGiveawayDatesResult = {
  readonly giveawayId: number
  readonly startedAt: Date
  readonly endedAt: Date
}

// Group-moderator gated edit of a manual giveaway's lifecycle dates.
// Mirrors the create gate (requireGroupModerator) — if a mod can record a
// manual giveaway they can also fix its dates afterwards. SG-scraped rows
// are refused at the repo layer; we additionally need the giveaway's
// groupId for the gate, so the load happens here before delegating.
export const updateManualGiveawayDatesFn = createServerFn({ method: 'POST' })
  .inputValidator((input: z.infer<typeof UpdateGiveawayDatesSchema>) =>
    UpdateGiveawayDatesSchema.parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<Result<UpdateManualGiveawayDatesResult, UpdateManualGiveawayDatesError>> => {
      const giveaway = await findGiveawayById(db(), data.giveawayId)
      if (!giveaway) return err({ kind: 'not_found' })
      if (giveaway.steamgiftsCode !== null) return err({ kind: 'not_manual' })
      const mod = await requireGroupModerator(giveaway.groupId)

      const result = await withTransaction(dbWrite(), async (tx) => {
        const r = await updateManualGiveawayDatesTx(tx, data.giveawayId, data.startedAt, data.endedAt)
        if (!r.ok) return r
        const { giveaway: updated, before } = r.value
        await writeAuditEvent(tx, {
          actorUserId: mod.id,
          targetType: 'giveaway',
          targetId: updated.id,
          event: {
            kind: 'giveaway_dates_updated',
            groupId: updated.groupId,
            before,
            after: { startedAt: updated.startedAt, endedAt: updated.endedAt },
          },
        })
        return {
          ok: true as const,
          value: {
            giveawayId: updated.id,
            startedAt: updated.startedAt,
            endedAt: updated.endedAt,
          },
        }
      })

      if (!result.ok) return err(result.error)
      return ok(result.value)
    },
  )
