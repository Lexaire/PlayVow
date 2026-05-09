import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'

import { env } from '#/config/env'
import type {
  SteamAppId,
  SteamGiftsGiveawayCode,
  SteamGiftsGroupCode,
  SteamGiftsUsername,
  SteamId,
} from '#/db/schema'
import type { Fetcher, HttpError } from '#/external/http'
import { fetchText } from '#/external/http'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

// Base URL for SG. When env.SG_PROXY_BASE is set, requests go through that
// origin instead of www.steamgifts.com directly — used to route around
// Cloudflare WAF challenges on VPS IPs by hopping through a CF Worker.
const STEAMGIFTS_BASE = env.SG_PROXY_BASE ?? 'https://www.steamgifts.com'
const DEFAULT_USER_AGENT = 'playvow/0.1 (+https://playvow.com)'

export type SgSteamRef =
  | { readonly kind: 'app'; readonly appId: SteamAppId }
  | { readonly kind: 'sub'; readonly subId: number }

export type SgGiveawayRow = {
  readonly giveawayCode: SteamGiftsGiveawayCode
  readonly giveawaySlug: string
  readonly title: string
  readonly steamRef: SgSteamRef
  readonly quantity: number
  readonly creatorUsername: SteamGiftsUsername
  readonly startedAt: Date
  readonly endedAt: Date
  readonly winners: ReadonlyArray<SteamGiftsUsername>
  readonly noWinners: boolean
}

export type SgProfile = {
  readonly steamgiftsUsername: SteamGiftsUsername
  readonly steamId: SteamId
  readonly avatarUrl: string | null
  readonly personaName: string | null
}

export type SgError =
  | HttpError
  | { readonly kind: 'login_required' }
  | { readonly kind: 'parse_failed'; readonly message: string }

const GIVEAWAY_HREF_RE = /^\/giveaway\/([A-Za-z0-9]{5})\/([^/?#]+)/
const USER_HREF_RE = /^\/user\/([^/?#]+)/
const STEAM_REF_HREF_RE = /store\.steampowered\.com\/(app|sub)\/(\d+)/i
const STEAM_PROFILE_HREF_RE = /steamcommunity\.com\/profiles\/(\d{17})/i
const COPIES_RE = /\((\d+)\s+Copies?\)/i

const isNotAuthenticated = ($: CheerioAPI): boolean => $('.nav__sits').length > 0

const toUnixSeconds = (raw: string | undefined): number | null => {
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export type SgGroupGiveawaysPage = {
  readonly rows: ReadonlyArray<SgGiveawayRow>
  readonly hasNextPage: boolean
  // SG's nav rendered the sign-in-through-Steam button. Listings are public,
  // so this isn't an error — but the caller can log a warning if rows are
  // empty AND signedOut is true (would indicate SG started gating listings,
  // which is the only failure mode that needs attention).
  readonly signedOut: boolean
}

export const parseGroupGiveawaysHtml = (html: string): Result<SgGroupGiveawaysPage, SgError> => {
  const $ = cheerio.load(html)
  const signedOut = isNotAuthenticated($)

  const rows: SgGiveawayRow[] = []
  $('.giveaway__row-outer-wrap').each((_, el) => {
    const $row = $(el)

    const $heading = $row.find('a.giveaway__heading__name').first()
    const giveawayHref = $heading.attr('href') ?? ''
    const giveawayMatch = GIVEAWAY_HREF_RE.exec(giveawayHref)
    if (!giveawayMatch) return
    const giveawayCode = giveawayMatch[1]
    const giveawaySlug = giveawayMatch[2]
    if (!giveawayCode || !giveawaySlug) return
    const title = $heading.text().trim()
    if (title.length === 0) return

    const steamHref =
      $row.find('a.giveaway__icon[href*="store.steampowered.com/"]').first().attr('href') ?? ''
    const steamMatch = STEAM_REF_HREF_RE.exec(steamHref)
    if (!steamMatch) return
    const steamKind = steamMatch[1]?.toLowerCase()
    const steamRefId = Number(steamMatch[2])
    if (!Number.isInteger(steamRefId)) return
    const steamRef: SgSteamRef =
      steamKind === 'sub'
        ? { kind: 'sub', subId: steamRefId }
        : { kind: 'app', appId: steamRefId as SteamAppId }

    const userHref = $row.find('a.giveaway__username').first().attr('href') ?? ''
    const userMatch = USER_HREF_RE.exec(userHref)
    if (!userMatch) return
    const creatorUsername = userMatch[1]
    if (!creatorUsername) return

    const stamps = $row.find('.giveaway__columns [data-timestamp]')
    const endsAt = toUnixSeconds(stamps.eq(0).attr('data-timestamp'))
    const postedAt = toUnixSeconds(
      $row.find('.giveaway__column--width-fill [data-timestamp]').first().attr('data-timestamp') ??
        stamps.eq(1).attr('data-timestamp'),
    )
    if (endsAt === null || postedAt === null) return

    let quantity = 1
    $row.find('.giveaway__heading__thin').each((__, span) => {
      const m = COPIES_RE.exec($(span).text())
      if (m && m[1]) quantity = Number(m[1])
    })

    const winners: SteamGiftsUsername[] = []
    $row.find('.giveaway__column--positive a[href^="/user/"]').each((__, link) => {
      const m = USER_HREF_RE.exec($(link).attr('href') ?? '')
      if (m && m[1]) winners.push(m[1] as SteamGiftsUsername)
    })

    const noWinners = $row.find('.fa-ban').length > 0

    rows.push({
      giveawayCode: giveawayCode as SteamGiftsGiveawayCode,
      giveawaySlug,
      title,
      steamRef,
      quantity,
      creatorUsername: creatorUsername as SteamGiftsUsername,
      startedAt: new Date(postedAt * 1000),
      endedAt: new Date(endsAt * 1000),
      winners,
      noWinners,
    })
  })

  const hasNextPage = $('.pagination__navigation .fa-angle-right').length > 0

  return ok({ rows, hasNextPage, signedOut })
}

export type SgWinnersPage = {
  readonly activated: ReadonlyArray<SteamGiftsUsername>
  readonly awaitingCount: number
}

export const parseGiveawayWinnersHtml = (html: string): Result<SgWinnersPage, SgError> => {
  const $ = cheerio.load(html)
  // Group-only multi-copy giveaways gate the dedicated winners page on
  // membership. SG renders the sign-in nav for unauthenticated visitors and
  // suppresses the winners table — without this short-circuit we'd return
  // empty winners and incorrectly mark partial multi-copy giveaways as
  // settled. This is THE auth-gated path; the listing parser intentionally
  // doesn't have this check anymore.
  if (isNotAuthenticated($)) return err({ kind: 'login_required' })
  const activated: SteamGiftsUsername[] = []
  let awaitingCount = 0
  $('.table__rows .table__row-outer-wrap').each((_, el) => {
    const $row = $(el)
    const href =
      $row.find('.table__column--width-fill a[href^="/user/"]').first().attr('href') ?? ''
    const m = USER_HREF_RE.exec(href)
    if (m && m[1]) {
      activated.push(m[1] as SteamGiftsUsername)
      return
    }
    if ($row.find('.fa-question-circle').length > 0) {
      awaitingCount += 1
    }
  })
  return ok({ activated, awaitingCount })
}

type SgProfileJsonLd = {
  readonly '@type'?: string
  readonly mainEntity?: {
    readonly '@type'?: string
    readonly name?: string
    readonly image?: string
  }
}

const findProfileJsonLd = ($: CheerioAPI): SgProfileJsonLd | null => {
  const blocks = $('script[type="application/ld+json"]')
  for (let i = 0; i < blocks.length; i++) {
    const raw = blocks.eq(i).text().trim()
    if (raw.length === 0) continue
    try {
      const parsed = JSON.parse(raw) as SgProfileJsonLd
      if (parsed['@type'] === 'ProfilePage' && parsed.mainEntity?.['@type'] === 'Person') {
        return parsed
      }
    } catch {
      continue
    }
  }
  return null
}

export const parseSgProfile = (
  sgUsername: SteamGiftsUsername,
  html: string,
): Result<SgProfile, SgError> => {
  const $ = cheerio.load(html)

  let steamId: SteamId | null = null
  const links = $('a[href*="steamcommunity.com/profiles/"]')
  for (let i = 0; i < links.length && steamId === null; i++) {
    const href = links.eq(i).attr('href') ?? ''
    const m = STEAM_PROFILE_HREF_RE.exec(href)
    if (m && m[1]) steamId = m[1] as SteamId
  }
  if (steamId === null) {
    return err({ kind: 'parse_failed', message: 'no steam profile link found' })
  }

  const ld = findProfileJsonLd($)
  const personaName = ld?.mainEntity?.name?.trim() ?? null
  const avatarUrl = ld?.mainEntity?.image?.trim() ?? null

  return ok({ steamgiftsUsername: sgUsername, steamId, avatarUrl, personaName })
}

export type SgClient = {
  // Whether this client was built with an authentication cookie. The scrape
  // job uses this to decide whether to update cookie health based on
  // winners-page outcomes — anonymous clients legitimately can't reach
  // group-only winners pages, and that shouldn't count against any cookie
  // status.
  readonly hasCookie: boolean
  readonly getGroupGiveaways: (
    groupCode: SteamGiftsGroupCode,
    groupSlug: string,
    page?: number,
  ) => Promise<Result<SgGroupGiveawaysPage, SgError>>
  readonly getGiveawayWinners: (
    giveawayCode: SteamGiftsGiveawayCode,
    giveawaySlug: string,
  ) => Promise<Result<SgWinnersPage, SgError>>
  readonly getProfile: (sgUsername: SteamGiftsUsername) => Promise<Result<SgProfile, SgError>>
}

export type SgClientConfig = {
  // Optional. When omitted, the client runs anonymously — sufficient for
  // listings, profiles, and 1–2 copy giveaway winners (which all render in
  // the listing). A cookie is only needed for the dedicated winners page on
  // group-only multi-copy giveaways with 3+ copies.
  readonly cookie?: string
  readonly fetcher?: Fetcher
  readonly userAgent?: string
}

const defaultFetcher: Fetcher = (u, i) => fetch(u, i)

// Honest self-identifying bot UA + minimal Accept. Through the SG_PROXY_BASE
// (CF Worker), Cloudflare doesn't apply IP-based WAF to us, so we can stay
// transparent rather than spoof a browser. The proxy itself rejects requests
// without the matching X-Proxy-Auth header.
const buildHeaders = (cfg: SgClientConfig): Record<string, string> => ({
  ...(cfg.cookie !== undefined && cfg.cookie.length > 0 ? { Cookie: cfg.cookie } : {}),
  'User-Agent': cfg.userAgent ?? DEFAULT_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml',
  ...(env.SG_PROXY_AUTH.length > 0 ? { 'X-Proxy-Auth': env.SG_PROXY_AUTH } : {}),
})

export const createSgClient = (cfg: SgClientConfig): SgClient => {
  const fetcher = cfg.fetcher ?? defaultFetcher
  const headers = buildHeaders(cfg)
  const hasCookie = cfg.cookie !== undefined && cfg.cookie.length > 0

  return {
    hasCookie,
    getGroupGiveaways: async (groupCode, groupSlug, page = 1) => {
      const slug = encodeURIComponent(groupSlug)
      const url = `${STEAMGIFTS_BASE}/group/${groupCode}/${slug}/search?page=${page}`
      const r = await fetchText(fetcher, url, { headers })
      if (!r.ok) return r
      return parseGroupGiveawaysHtml(r.value)
    },
    getGiveawayWinners: async (giveawayCode, giveawaySlug) => {
      const slug = encodeURIComponent(giveawaySlug)
      const url = `${STEAMGIFTS_BASE}/giveaway/${giveawayCode}/${slug}/winners`
      const r = await fetchText(fetcher, url, { headers })
      if (!r.ok) return r
      return parseGiveawayWinnersHtml(r.value)
    },
    getProfile: async (sgUsername) => {
      const url = `${STEAMGIFTS_BASE}/user/${encodeURIComponent(sgUsername)}`
      const r = await fetchText(fetcher, url, { headers })
      if (!r.ok) return r
      return parseSgProfile(sgUsername, r.value)
    },
  }
}
