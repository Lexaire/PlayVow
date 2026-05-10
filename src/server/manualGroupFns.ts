import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { env } from '#/config/env'
import { db, dbWrite, withTransaction } from '#/db/client'
import type { SteamAppId, SteamId, SteamSubId } from '#/db/schema'
import { computePlayDeadline } from '#/domain/wins'
import type { ResolveVanityError, SteamApiError } from '#/external/steam-api'
import { createSteamApiClient, extractVanityHandle } from '#/external/steam-api'
import { writeAuditEvent } from '#/repos/auditLog'
import type { Giveaway } from '#/repos/giveaways'
import {
  createManualGiveaway,
  softDeleteManualGiveawayTx,
} from '#/repos/giveaways'
import { findGroupById } from '#/repos/groups'
import { upsertSteamApp } from '#/repos/steamApps'
import { upsertSteamSub } from '#/repos/steamSubs'
import { upsertUserBySteamId } from '#/repos/users'
import type { Win } from '#/repos/wins'
import { insertWinIfAbsent } from '#/repos/wins'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import { requireAdmin, requireModerator } from '#/server/auth'

// Server-side Steam client — built lazily because admin/mod actions are rare
// compared to worker-driven calls. No rate limiting wrapper: each manual
// action makes at most two Steam calls (store item + vanity), which is far
// below any per-key throttle.
let steamClient: ReturnType<typeof createSteamApiClient> | undefined

const getSteamClient = (): ReturnType<typeof createSteamApiClient> => {
  if (!steamClient) {
    steamClient = createSteamApiClient({ apiKey: env.STEAM_WEB_API_KEY })
  }
  return steamClient
}

// 17-digit SteamID64s start with 7656 (the upper bits of the SteamID
// "individual" account type). Steam community profiles URLs use the same
// number under /profiles/. Anything else is treated as a vanity.
const STEAM_ID_PATTERN = /^7656\d{13}$/
const PROFILES_URL_PATTERN = /steamcommunity\.com\/profiles\/(7656\d{13})/i

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
})

// "field" tags which input — creator vs. winner — failed resolution, so the
// form can render the message next to the offending input instead of a
// generic top-line error.
export type SteamUserResolveError =
  | { readonly kind: 'vanity_failed'; readonly field: 'creator' | 'winner'; readonly cause: ResolveVanityError }
  | { readonly kind: 'invalid_input'; readonly field: 'creator' | 'winner' }

export type ItemResolveError =
  | { readonly kind: 'item_not_found' }
  | { readonly kind: 'steam_api_failed'; readonly cause: SteamApiError }

export type AddManualGiveawayError =
  | { readonly kind: 'group_not_found' }
  | { readonly kind: 'group_not_manual' }
  | ItemResolveError
  | SteamUserResolveError

export type AddManualGiveawayResult = {
  readonly giveaway: Giveaway
  readonly itemName: string
  readonly win: Win
}

const resolveSteamIdFromInput = async (
  input: string,
  field: 'creator' | 'winner',
): Promise<Result<SteamId, SteamUserResolveError>> => {
  const trimmed = input.trim()
  if (trimmed.length === 0) return err({ kind: 'invalid_input', field })
  if (STEAM_ID_PATTERN.test(trimmed)) return ok(trimmed as SteamId)
  const profilesMatch = PROFILES_URL_PATTERN.exec(trimmed)
  if (profilesMatch?.[1]) return ok(profilesMatch[1] as SteamId)
  if (extractVanityHandle(trimmed) === null) return err({ kind: 'invalid_input', field })
  const r = await getSteamClient().resolveVanityUrl(trimmed)
  if (!r.ok) return err({ kind: 'vanity_failed', field, cause: r.error })
  return ok(r.value)
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
    const mod = await requireModerator()
    const group = await findGroupById(db(), data.groupId)
    if (!group) return err({ kind: 'group_not_found' })
    if (group.source !== 'manual') return err({ kind: 'group_not_manual' })

    const itemR = await resolveItem(data.item)
    if (!itemR.ok) return err(itemR.error)
    const item = itemR.value

    // Resolve creator + winner before opening the write tx — Steam Web API
    // calls can take a beat, and dragging them into the transaction would
    // hold a write lock. Both happen sequentially for clarity; the manual
    // flow is rare enough that parallelizing isn't worth the code.
    const creatorR = await resolveSteamIdFromInput(data.creator, 'creator')
    if (!creatorR.ok) return err(creatorR.error)
    const creatorSteamId = creatorR.value

    const winnerR = await resolveSteamIdFromInput(data.winner, 'winner')
    if (!winnerR.ok) return err(winnerR.error)
    const winnerSteamId = winnerR.value

    const now = new Date()
    const playDeadline = computePlayDeadline(now, group.playWindowDays)

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
      // on the audit row's actorUserId below.
      const creatorUser = await upsertUserBySteamId(tx, {
        steamId: creatorSteamId,
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
        },
      })

      const winnerUser = await upsertUserBySteamId(tx, {
        steamId: winnerSteamId,
        lastSyncedAt: now,
      })
      // Fresh giveaway just inserted, so insertWinIfAbsent can't collide.
      // null here would be an invariant violation, not a user-facing error.
      const win = await insertWinIfAbsent(tx, {
        giveawayId: giveaway.id,
        userId: winnerUser.id,
        wonAt: now,
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
