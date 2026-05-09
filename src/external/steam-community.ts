import * as cheerio from 'cheerio'

import type { SteamAppId, SteamGroupId, SteamId } from '#/db/schema'
import type { Fetcher, HttpError } from '#/external/http'
import { fetchText } from '#/external/http'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

const STEAM_COMMUNITY_BASE = 'https://steamcommunity.com'

export type ScreenshotsError = HttpError | { readonly kind: 'profile_private' }

export type Screenshot = {
  readonly fileId: string
  readonly thumbUrl: string
  readonly caption: string | null
}

const extractIdFromHref = (href: string): string | null => {
  const m = /[?&]id=(\d+)/.exec(href)
  return m?.[1] ?? null
}

// Steam paints thumbnails two ways within the same screenshots page:
// auto-height anchors have a child <img src=...>; the rest carry the URL
// in an inline `background-image: url('...')` on a child div. We try the
// <img> first and fall back to the style attribute.
const extractThumbUrlFromBackground = (style: string): string | null => {
  const m = /background-image:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(style)
  return m?.[1] ?? null
}

export type GroupMembersPage = {
  readonly groupId64: string
  readonly totalPages: number
  readonly currentPage: number
  readonly members: ReadonlyArray<SteamId>
}

export type GroupMembersError =
  | HttpError
  | { readonly kind: 'parse_failed'; readonly message: string }

export const parseScreenshots = (
  html: string,
): Result<ReadonlyArray<Screenshot>, ScreenshotsError> => {
  const $ = cheerio.load(html)
  const isPrivate = $('.profile_private_info').length > 0 || $('.error_ctn').length > 0
  if (isPrivate) return err({ kind: 'profile_private' })
  // The class string `profile_media_item` also appears inside Steam's inline
  // auto-sizing JS (twice), so a bare `.profile_media_item` selector
  // overcounts. Anchors with a /sharedfiles/filedetails/?id= href are
  // exactly one per real screenshot.
  const items: Screenshot[] = []
  $('a[href*="/sharedfiles/filedetails/?id="]').each((_i, el) => {
    const $el = $(el)
    const fileId = $el.attr('data-publishedfileid') ?? extractIdFromHref($el.attr('href') ?? '')
    if (fileId === null) return
    const imgSrc = $el.find('img').first().attr('src')
    const bgStyle = $el.find('[style*="background-image"]').first().attr('style') ?? ''
    const thumbUrl = imgSrc ?? extractThumbUrlFromBackground(bgStyle)
    if (thumbUrl === null || thumbUrl.length === 0) return
    const captionText = $el.find('q.ellipsis').first().text().trim()
    items.push({
      fileId,
      thumbUrl,
      caption: captionText.length > 0 ? captionText : null,
    })
  })
  return ok(items)
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
  readonly getScreenshots: (
    steamId: SteamId,
    appId: SteamAppId,
  ) => Promise<Result<ReadonlyArray<Screenshot>, ScreenshotsError>>
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
    getScreenshots: async (steamId, appId) => {
      const url = `${STEAM_COMMUNITY_BASE}/profiles/${encodeURIComponent(
        steamId,
      )}/screenshots/?appid=${appId}`
      const text = await fetchText(fetcher, url)
      if (!text.ok) return text
      return parseScreenshots(text.value)
    },
    getGroupMembersPage: async (gid64, page) => {
      const url = `${STEAM_COMMUNITY_BASE}/gid/${encodeURIComponent(gid64)}/memberslistxml/?xml=1&p=${page}`
      const text = await fetchText(fetcher, url)
      if (!text.ok) return text
      return parseGroupMembersPage(text.value)
    },
  }
}
