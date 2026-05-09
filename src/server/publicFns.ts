import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { db, dbWrite } from '#/db/client'
import type { SteamGiftsGiveawayCode, SteamGiftsUsername, SteamId } from '#/db/schema'
import { isMod } from '#/domain/roles'
import { createTtlCache } from '#/lib/ttl-cache'
import { findUserBySteamId } from '#/repos/users'
import { getCurrentUser } from '#/server/auth'
import {
  DEFAULT_PAGE_SIZE,
  getGiveawayPageData,
  getGroupOverviewPage,
  getUserPageDataByUsername,
  listGroupSummaries,
  type GiveawayPageData,
  type GroupOverviewPageData,
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
    // they coordinate with each other), so bypass the public TTL cache and the
    // read-replica when the viewer is a moderator+. Public viewers stay on the
    // cached/replica path.
    const viewer = await getCurrentUser()
    const fetch = () =>
      getUserPageDataByUsername(
        isMod(viewer) ? dbWrite() : db(),
        data.username as SteamGiftsUsername,
        data.winsPages,
        data.createdWinsPages,
        data.noWinnersPage,
        data.pageSize,
        new Date(),
      )
    if (isMod(viewer)) return fetch()
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
