import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { db, dbWrite } from '#/db/client'
import type {
  SteamAppId,
  SteamGiftsGiveawayCode,
  SteamGiftsUsername,
  SteamId,
  SteamSubId,
} from '#/db/schema'
import { isAdmin } from '#/domain/roles'
import { listGroupIdsModeratedByUser } from '#/repos/groupModerators'
import { createTtlCache } from '#/lib/ttl-cache'
import { findUserBySteamId } from '#/repos/users'
import { getCurrentUser } from '#/server/auth'
import {
  DEFAULT_PAGE_SIZE,
  getGamePageData,
  getGiveawayPageData,
  getGiveawayPageDataById,
  getGroupOverviewPage,
  getSubPageData,
  getUserPageDataByUsername,
  listGroupSummaries,
  type GamePageData,
  type GiveawayPageData,
  type GroupOverviewPageData,
  type SubPageData,
  type UserPageData,
} from '#/server/queries'

// Public read paths change at most once per daily scrape, so a short in-memory
// TTL collapses bot/preload chatter without affecting freshness in practice.
const PUBLIC_TTL_MS = 120_000
const PositivePage = z.coerce.number().int().min(1)

// Per-status page numbers for the user page. Each status is independently
// paginated (see u.$username route). All optional — missing means page 1.
const StatusPagesSchema = z.object({
  pending: PositivePage.optional(),
  played: PositivePage.optional(),
  kicked: PositivePage.optional(),
  not_in_group: PositivePage.optional(),
  exempt: PositivePage.optional(),
})

const UserPageSchema = z.object({
  username: z.string().min(1).max(64),
  winsPages: StatusPagesSchema.default({}),
  createdWinsPages: StatusPagesSchema.default({}),
  noWinnersPage: PositivePage.default(1),
  pageSize: z.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
})
const SteamIdSchema = z.object({ steamId: z.string().regex(/^\d{17}$/) })
const GiveawaySchema = z.object({
  slug: z.string().min(1).max(64),
  code: z.string().min(1).max(16),
})
export const fetchGroupSummaries = createServerFn({ method: 'GET' }).handler(async () =>
  listGroupSummaries(db()),
)

const groupOverviewCache = createTtlCache<string, GroupOverviewPageData | null>(PUBLIC_TTL_MS)

const GroupOverviewSchema = z.object({
  slug: z.string().min(1).max(64),
  inProgressPage: z.number().int().min(1).default(1),
  feedPage: z.number().int().min(1).default(1),
})

export const fetchGroupOverviewPage = createServerFn({ method: 'GET' })
  .inputValidator((input: { slug: string; inProgressPage?: number; feedPage?: number }) =>
    GroupOverviewSchema.parse(input),
  )
  .handler(async ({ data }) =>
    groupOverviewCache.get(
      `${data.slug}:${String(data.inProgressPage)}:${String(data.feedPage)}`,
      () => getGroupOverviewPage(db(), data.slug, data.inProgressPage, data.feedPage, new Date()),
    ),
  )

const userPageCache = createTtlCache<string, UserPageData | null>(PUBLIC_TTL_MS)

type StatusPagesInput = {
  pending?: number | undefined
  played?: number | undefined
  kicked?: number | undefined
  not_in_group?: number | undefined
  exempt?: number | undefined
}

export const fetchUserPageByUsername = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      username: string
      winsPages?: StatusPagesInput
      createdWinsPages?: StatusPagesInput
      noWinnersPage?: number | undefined
      pageSize?: number | undefined
    }) => UserPageSchema.parse(input),
  )
  .handler(async ({ data }) => {
    // Mods need fresh status (their own changes are visible immediately, and
    // they coordinate with each other), so bypass the public TTL cache and
    // the read-replica when the viewer is admin OR moderates any group.
    // Public viewers stay on the cached/replica path.
    const viewer = await getCurrentUser()
    const viewerIsMod =
      viewer !== null &&
      (isAdmin(viewer) || (await listGroupIdsModeratedByUser(db(), viewer.id)).size > 0)
    const fetch = () =>
      getUserPageDataByUsername(
        viewerIsMod ? dbWrite() : db(),
        data.username as SteamGiftsUsername,
        data.winsPages,
        data.createdWinsPages,
        data.noWinnersPage,
        data.pageSize,
        new Date(),
      )
    if (viewerIsMod) return fetch()
    // Lowercase username so case variants share a cache slot — getUserPageData
    // already does a case-insensitive lookup, so this is purely keying.
    const key = [
      data.username.toLowerCase(),
      data.pageSize,
      data.winsPages.pending ?? 1,
      data.winsPages.played ?? 1,
      data.winsPages.kicked ?? 1,
      data.winsPages.not_in_group ?? 1,
      data.winsPages.exempt ?? 1,
      data.createdWinsPages.pending ?? 1,
      data.createdWinsPages.played ?? 1,
      data.createdWinsPages.kicked ?? 1,
      data.createdWinsPages.not_in_group ?? 1,
      data.createdWinsPages.exempt ?? 1,
      data.noWinnersPage,
    ].join(':')
    return userPageCache.get(key, fetch)
  })

export const fetchUsernameBySteamId = createServerFn({ method: 'GET' })
  .inputValidator((input: { steamId: string }) => SteamIdSchema.parse(input))
  .handler(async ({ data }): Promise<SteamGiftsUsername | null> => {
    const user = await findUserBySteamId(db(), data.steamId as SteamId)
    return user?.steamgiftsUsername ?? null
  })

const giveawayPageCache = createTtlCache<string, GiveawayPageData | null>(PUBLIC_TTL_MS)

export const fetchGiveawayPage = createServerFn({ method: 'GET' })
  .inputValidator((input: { slug: string; code: string }) => GiveawaySchema.parse(input))
  .handler(async ({ data }) =>
    giveawayPageCache.get(`${data.slug}:${data.code}`, () =>
      getGiveawayPageData(db(), data.slug, data.code as SteamGiftsGiveawayCode),
    ),
  )

// Manual giveaways have no SteamGifts code, so they're addressed by their
// internal id. Same cache TTL semantics as the by-code path; key prefixed
// with `id:` to avoid collisions.
const GiveawayByIdSchema = z.object({
  slug: z.string().min(1).max(64),
  giveawayId: z.coerce.number().int().positive(),
})

export const fetchGiveawayPageById = createServerFn({ method: 'GET' })
  .inputValidator((input: { slug: string; giveawayId: number }) =>
    GiveawayByIdSchema.parse(input),
  )
  .handler(async ({ data }) =>
    giveawayPageCache.get(`${data.slug}:id:${String(data.giveawayId)}`, () =>
      getGiveawayPageDataById(db(), data.slug, data.giveawayId),
    ),
  )

// Game (Steam app) and sub bundle pages aggregate every win + every giveaway
// for that target across all groups. Both lists paginate independently
// (`winsPage` for the Wins tab, `giveawaysPage` for the Giveaways tab) so
// switching tabs preserves the other's page position.
const GamePageSchema = z.object({
  appId: z.number().int().positive(),
  winsPage: PositivePage.default(1),
  giveawaysPage: PositivePage.default(1),
  pageSize: z.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
})

const SubPageSchema = z.object({
  subId: z.number().int().positive(),
  winsPage: PositivePage.default(1),
  giveawaysPage: PositivePage.default(1),
  pageSize: z.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
})

const gamePageCache = createTtlCache<string, GamePageData | null>(PUBLIC_TTL_MS)
const subPageCache = createTtlCache<string, SubPageData | null>(PUBLIC_TTL_MS)

export const fetchGamePage = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      appId: number
      winsPage?: number | undefined
      giveawaysPage?: number | undefined
      pageSize?: number | undefined
    }) => GamePageSchema.parse(input),
  )
  .handler(async ({ data }) =>
    gamePageCache.get(
      `${String(data.appId)}:${String(data.winsPage)}:${String(data.giveawaysPage)}:${String(data.pageSize)}`,
      () =>
        getGamePageData(
          db(),
          data.appId as SteamAppId,
          data.winsPage,
          data.giveawaysPage,
          data.pageSize,
        ),
    ),
  )

export const fetchSubPage = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      subId: number
      winsPage?: number | undefined
      giveawaysPage?: number | undefined
      pageSize?: number | undefined
    }) => SubPageSchema.parse(input),
  )
  .handler(async ({ data }) =>
    subPageCache.get(
      `${String(data.subId)}:${String(data.winsPage)}:${String(data.giveawaysPage)}:${String(data.pageSize)}`,
      () =>
        getSubPageData(
          db(),
          data.subId as SteamSubId,
          data.winsPage,
          data.giveawaysPage,
          data.pageSize,
        ),
    ),
  )
