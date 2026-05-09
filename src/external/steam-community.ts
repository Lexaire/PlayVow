import * as cheerio from 'cheerio'

import type { SteamAppId, SteamGroupId, SteamId } from '#/db/schema'
import type { Fetcher, HttpError } from '#/external/http'
import { fetchText } from '#/external/http'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

const STEAM_COMMUNITY_BASE = 'https://steamcommunity.com'

export type ScreenshotsError = HttpError | { readonly kind: 'profile_private' }

export type GroupMembersPage = {
  readonly groupId64: string
  readonly totalPages: number
  readonly currentPage: number
  readonly members: ReadonlyArray<SteamId>
}

export type GroupMembersError =
  | HttpError
  | { readonly kind: 'parse_failed'; readonly message: string }

export const parseScreenshotCount = (html: string): Result<number, ScreenshotsError> => {
  const $ = cheerio.load(html)
  const isPrivate = $('.profile_private_info').length > 0 || $('.error_ctn').length > 0
  if (isPrivate) return err({ kind: 'profile_private' })
  return ok($('.profile_media_item').length)
}

export const parseGroupMembersPage = (xml: string): Result<GroupMembersPage, GroupMembersError> => {
  const $ = cheerio.load(xml, { xmlMode: true })
  const groupId64 = $('memberList > groupID64').text()
  if (!groupId64) return err({ kind: 'parse_failed', message: 'missing groupID64' })
  const totalPages = parseInt($('memberList > totalPages').text(), 10)
  const currentPage = parseInt($('memberList > currentPage').text(), 10)
  if (!Number.isFinite(totalPages) || !Number.isFinite(currentPage)) {
    return err({ kind: 'parse_failed', message: 'missing totalPages or currentPage' })
  }
  const members: SteamId[] = []
  $('memberList > members > steamID64').each((_i, el) => {
    const text = $(el).text().trim()
    if (text) members.push(text as SteamId)
  })
  return ok({ groupId64, totalPages, currentPage, members })
}

export type SteamCommunityClient = {
  readonly getScreenshotCount: (
    steamId: SteamId,
    appId: SteamAppId,
  ) => Promise<Result<number, ScreenshotsError>>
  readonly getGroupMembersPage: (
    gid64: SteamGroupId,
    page: number,
  ) => Promise<Result<GroupMembersPage, GroupMembersError>>
}

export type SteamCommunityClientConfig = {
  readonly fetcher?: Fetcher
}

const defaultFetcher: Fetcher = (u, i) => fetch(u, i)

export const createSteamCommunityClient = (
  cfg: SteamCommunityClientConfig = {},
): SteamCommunityClient => {
  const fetcher = cfg.fetcher ?? defaultFetcher
  return {
    getScreenshotCount: async (steamId, appId) => {
      const url = `${STEAM_COMMUNITY_BASE}/profiles/${encodeURIComponent(
        steamId,
      )}/screenshots/?appid=${appId}`
      const text = await fetchText(fetcher, url)
      if (!text.ok) return text
      return parseScreenshotCount(text.value)
    },
    getGroupMembersPage: async (gid64, page) => {
      const url = `${STEAM_COMMUNITY_BASE}/gid/${encodeURIComponent(gid64)}/memberslistxml/?xml=1&p=${page}`
      const text = await fetchText(fetcher, url)
      if (!text.ok) return text
      return parseGroupMembersPage(text.value)
    },
  }
}
