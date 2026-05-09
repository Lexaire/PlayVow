import { z } from 'zod'

import type { SteamAppId, SteamId, SteamSubId } from '#/db/schema'
import type { Fetcher, HttpError } from '#/external/http'
import { fetchText } from '#/external/http'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

const STEAM_API_BASE = 'https://api.steampowered.com'

const RawGameSchema = z.object({
  appid: z.number().int().nonnegative(),
  playtime_forever: z.number().int().nonnegative(),
  // Only present when the user has played in the last 2 weeks
  playtime_2weeks: z.number().int().nonnegative().optional(),
})

const OwnedGamesResponseSchema = z.object({
  response: z.union([
    z.object({
      game_count: z.number().int().nonnegative(),
      games: z.array(RawGameSchema).optional(),
    }),
    z.strictObject({}),
  ]),
})

// IStoreBrowseService/GetItems: Steam's batch endpoint for store-page metadata
// (capsule images, release date, reviews, etc). This is the same endpoint the
// official Steam store frontend uses on its backend — it lives on the Web API
// host (api.steampowered.com), NOT on the storefront host (store.steampowered.com)
// which has aggressive per-IP rate limits. Key is optional but we pass ours for
// parity with our other Web API calls.
//
// We use `passthrough()` on nested objects because Steam adds new fields over
// time and we don't want strict-shape errors when they do.
const RawStoreItemAssetsSchema = z.looseObject({
  asset_url_format: z.string().optional(),
  small_capsule: z.string().optional(),
  main_capsule: z.string().optional(),
  header: z.string().optional(),
  hero_capsule: z.string().optional(),
  library_capsule: z.string().optional(),
  library_hero: z.string().optional(),
  community_icon: z.string().optional(),
  page_background: z.string().optional(),
  package_header: z.string().optional(),
})

const RawReviewsSummarySchema = z.looseObject({
  review_count: z.number().int().nonnegative().optional(),
  percent_positive: z.number().int().min(0).max(100).optional(),
  review_score: z.number().int().min(0).max(9).optional(),
  review_score_label: z.string().optional(),
})

// Included apps inside a package response. We only need `type` (to pick the
// "main" game when a sub bundles multiple apps) and `assets` (so we can copy
// the parent's capsule into the sub when the sub itself has none — common for
// passthrough Deluxe/Complete edition packages).
const RawIncludedAppSchema = z.looseObject({
  id: z.number().int().nonnegative(),
  type: z.number().int().optional(),
  assets: RawStoreItemAssetsSchema.optional(),
})

const RawStoreItemSchema = z.looseObject({
  // `id` is the canonical identifier in the response — equals appid for apps
  // and packageid for subs.
  id: z.number().int().nonnegative(),
  // 0 = app, 1 = package, 2 = bundle. We only request 0 and 1; bundles are
  // included by Steam in `included_items` of bundled packages but never as a
  // top-level row when we ask by appid/packageid.
  item_type: z.number().int(),
  success: z.number().int(),
  name: z.string().optional(),
  type: z.number().int().optional(),
  // Top-level `appid` on apps is just `id`. On packages it's only present
  // when the sub has a canonical parent app (Deluxe/Complete editions of a
  // single base game). Multi-app bundles like Witcher 3 Complete omit it.
  // We use it to pick the right included_apps entry for asset fallback.
  appid: z.number().int().nonnegative().optional(),
  assets: RawStoreItemAssetsSchema.optional(),
  release: z.looseObject({ steam_release_date: z.number().int().optional() }).optional(),
  basic_info: z.looseObject({ short_description: z.string().optional() }).optional(),
  reviews: z.looseObject({ summary_unfiltered: RawReviewsSummarySchema.optional() }).optional(),
  included_items: z
    .looseObject({ included_apps: z.array(RawIncludedAppSchema).optional() })
    .optional(),
})

const StoreItemsResponseSchema = z.object({
  response: z.object({
    store_items: z.array(RawStoreItemSchema).optional(),
  }),
})

const RawAchievementSchema = z.object({
  apiname: z.string(),
  achieved: z.union([z.literal(0), z.literal(1)]),
  // 0 means "no time recorded" — Steam started tracking unlocktime around 2009-2010,
  // so legacy unlocks come back as achieved=1, unlocktime=0.
  unlocktime: z.number().int().nonnegative().optional(),
  // Display name + description — only present when we pass l=<lang>.
  name: z.string().optional(),
  description: z.string().optional(),
})

const PlayerAchievementsResponseSchema = z.object({
  playerstats: z.union([
    z.object({
      success: z.literal(true),
      achievements: z.array(RawAchievementSchema).optional(),
    }),
    z.object({
      success: z.literal(false),
      error: z.string().optional(),
    }),
  ]),
})

// `percent` comes back from Steam as a stringified float (e.g. "50.0", "3.2").
// Coerce at the schema boundary so callers see a number.
const RawGlobalAchievementSchema = z.object({
  name: z.string(),
  percent: z.coerce.number(),
})

// `achievementpercentages.achievements` is also optional and absent for some
// games — treat the missing key as "no achievements" (same as empty array).
const GlobalAchievementPercentsResponseSchema = z.object({
  achievementpercentages: z.object({
    achievements: z.array(RawGlobalAchievementSchema).optional(),
  }),
})

export type GlobalAchievementPercent = {
  readonly apiname: string
  readonly percent: number
}

export type OwnedGame = {
  readonly appId: SteamAppId
  readonly playtimeMinutes: number
  readonly playtime2WeeksMinutes: number | null
}

export type OwnedGames =
  | { readonly visibility: 'public'; readonly games: ReadonlyArray<OwnedGame> }
  | { readonly visibility: 'private' }

export type AchievementDetail = {
  readonly apiname: string
  readonly achieved: boolean
  // null when achieved=false; also null for legacy unlocks (achieved=1, unlocktime=0).
  readonly unlockedAt: Date | null
  readonly displayName: string | null
  readonly description: string | null
}

export type AchievementsResult =
  | { readonly kind: 'public'; readonly achievements: ReadonlyArray<AchievementDetail> }
  | { readonly kind: 'no_stats' }
  | { readonly kind: 'private' }

// IStoreBrowseService/GetItems is symmetrical for apps and packages — same
// endpoint, same response shape — but the request key differs (`appid` vs
// `packageid`) and apps carry extra fields subs lack (library_*, community_icon,
// type) while subs have one app-absent field (package_header).
export type StoreItemRequest =
  | { readonly kind: 'app'; readonly appId: SteamAppId }
  | { readonly kind: 'sub'; readonly subId: SteamSubId }

export type StoreItemAppData = {
  readonly kind: 'app'
  readonly appId: SteamAppId
  readonly name: string
  readonly assetSmallCapsule: string | null
  readonly assetMainCapsule: string | null
  readonly assetHeader: string | null
  readonly assetHeroCapsule: string | null
  readonly assetLibraryCapsule: string | null
  readonly assetLibraryHero: string | null
  readonly assetCommunityIcon: string | null
  readonly assetPageBackground: string | null
  readonly assetUrlFormat: string | null
  readonly releaseDate: Date | null
  readonly shortDescription: string | null
  readonly appType: number | null
  readonly reviewScore: number | null
  readonly reviewScoreLabel: string | null
  readonly reviewPercentPositive: number | null
  readonly reviewCount: number | null
}

export type StoreItemSubData = {
  readonly kind: 'sub'
  readonly subId: SteamSubId
  readonly name: string
  readonly assetSmallCapsule: string | null
  readonly assetMainCapsule: string | null
  readonly assetHeader: string | null
  readonly assetHeroCapsule: string | null
  readonly assetPackageHeader: string | null
  readonly assetPageBackground: string | null
  readonly assetUrlFormat: string | null
  readonly releaseDate: Date | null
  readonly shortDescription: string | null
  readonly reviewScore: number | null
  readonly reviewScoreLabel: string | null
  readonly reviewPercentPositive: number | null
  readonly reviewCount: number | null
}

// `item: null` means Steam returned the row but with success != 1
// (delisted/region-locked/invalid). The caller should mark the row attempted
// so we don't poll it forever.
export type StoreItemEntry =
  | {
      readonly kind: 'app'
      readonly appId: SteamAppId
      readonly item: StoreItemAppData | null
    }
  | {
      readonly kind: 'sub'
      readonly subId: SteamSubId
      readonly item: StoreItemSubData | null
    }

export type SteamApiError =
  | HttpError
  | { readonly kind: 'invalid_json'; readonly message: string }
  | { readonly kind: 'invalid_shape'; readonly issues: ReadonlyArray<string> }

const safeJsonParse = (text: string): Result<unknown, SteamApiError> => {
  try {
    return ok(JSON.parse(text) as unknown)
  } catch (e) {
    return err({
      kind: 'invalid_json',
      message: e instanceof Error ? e.message : String(e),
    })
  }
}

const zodIssues = (e: z.ZodError): ReadonlyArray<string> =>
  e.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)

export const parsePlayerAchievements = (
  raw: unknown,
): Result<AchievementsResult, SteamApiError> => {
  const parsed = PlayerAchievementsResponseSchema.safeParse(raw)
  if (!parsed.success) {
    return err({ kind: 'invalid_shape', issues: zodIssues(parsed.error) })
  }
  const ps = parsed.data.playerstats
  if (!ps.success) {
    const message = ps.error?.toLowerCase() ?? ''
    if (message.includes('not public')) return ok({ kind: 'private' })
    return ok({ kind: 'no_stats' })
  }
  const achievements: ReadonlyArray<AchievementDetail> = (ps.achievements ?? []).map((a) => ({
    apiname: a.apiname,
    achieved: a.achieved === 1,
    unlockedAt:
      a.achieved === 1 && a.unlocktime !== undefined && a.unlocktime > 0
        ? new Date(a.unlocktime * 1000)
        : null,
    displayName: a.name ?? null,
    description: a.description ?? null,
  }))
  return ok({ kind: 'public', achievements })
}

export const parseGlobalAchievementPercents = (
  raw: unknown,
): Result<ReadonlyArray<GlobalAchievementPercent>, SteamApiError> => {
  const parsed = GlobalAchievementPercentsResponseSchema.safeParse(raw)
  if (!parsed.success) {
    return err({ kind: 'invalid_shape', issues: zodIssues(parsed.error) })
  }
  const list = parsed.data.achievementpercentages.achievements ?? []
  return ok(list.map((a) => ({ apiname: a.name, percent: a.percent })))
}

const ITEM_TYPE_APP = 0
const ITEM_TYPE_SUB = 1
const ITEM_SUBTYPE_GAME = 0

type RawStoreItem = z.infer<typeof RawStoreItemSchema>
type RawStoreItemAssets = z.infer<typeof RawStoreItemAssetsSchema>

// Choose the included app whose assets best represent a passthrough sub.
// Priority: (1) match the sub's top-level `appid` — Steam sets this only
// when there's a canonical parent (Deluxe/Complete editions); (2) sole
// included app; (3) first type=0 (game); (4) first entry.
const pickIncludedAppAssets = (r: RawStoreItem): RawStoreItemAssets | undefined => {
  const apps = r.included_items?.included_apps
  if (!apps || apps.length === 0) return undefined
  if (r.appid !== undefined) {
    const match = apps.find((app) => app.id === r.appid)
    if (match?.assets) return match.assets
  }
  if (apps.length === 1) return apps[0]?.assets
  const game = apps.find((app) => app.type === ITEM_SUBTYPE_GAME)
  return (game ?? apps[0])?.assets
}

export const parseStoreItems = (
  raw: unknown,
): Result<ReadonlyArray<StoreItemEntry>, SteamApiError> => {
  const parsed = StoreItemsResponseSchema.safeParse(raw)
  if (!parsed.success) {
    return err({ kind: 'invalid_shape', issues: zodIssues(parsed.error) })
  }
  const rows = parsed.data.response.store_items ?? []
  const out: StoreItemEntry[] = []
  for (const r of rows) {
    const a = r.assets
    const reviews = r.reviews?.summary_unfiltered
    const releaseUnix = r.release?.steam_release_date
    const releaseDate =
      releaseUnix !== undefined && releaseUnix > 0 ? new Date(releaseUnix * 1000) : null
    // success=1 means visible/found; anything else (15=not visible, 42=invalid)
    // means we got a placeholder row back. Mark item null in that case.
    const found = r.success === 1 && r.name !== undefined
    if (r.item_type === ITEM_TYPE_APP) {
      const appId = r.id as SteamAppId
      if (!found) {
        out.push({ kind: 'app', appId, item: null })
        continue
      }
      out.push({
        kind: 'app',
        appId,
        item: {
          kind: 'app',
          appId,
          name: r.name as string,
          assetSmallCapsule: a?.small_capsule ?? null,
          assetMainCapsule: a?.main_capsule ?? null,
          assetHeader: a?.header ?? null,
          assetHeroCapsule: a?.hero_capsule ?? null,
          assetLibraryCapsule: a?.library_capsule ?? null,
          assetLibraryHero: a?.library_hero ?? null,
          assetCommunityIcon: a?.community_icon ?? null,
          assetPageBackground: a?.page_background ?? null,
          assetUrlFormat: a?.asset_url_format ?? null,
          releaseDate,
          shortDescription: r.basic_info?.short_description ?? null,
          appType: r.type ?? null,
          reviewScore: reviews?.review_score ?? null,
          reviewScoreLabel: reviews?.review_score_label ?? null,
          reviewPercentPositive: reviews?.percent_positive ?? null,
          reviewCount: reviews?.review_count ?? null,
        },
      })
    } else if (r.item_type === ITEM_TYPE_SUB) {
      const subId = r.id as SteamSubId
      if (!found) {
        out.push({ kind: 'sub', subId, item: null })
        continue
      }
      // For passthrough subs (Deluxe/Complete editions), Steam returns no
      // own assets. Fall back to a chosen included_app's assets. Pick rule:
      // only-one wins, else first type=0 (game), else first.
      const sa = a?.small_capsule !== undefined ? a : (pickIncludedAppAssets(r) ?? a)
      out.push({
        kind: 'sub',
        subId,
        item: {
          kind: 'sub',
          subId,
          name: r.name as string,
          assetSmallCapsule: sa?.small_capsule ?? null,
          assetMainCapsule: sa?.main_capsule ?? null,
          assetHeader: sa?.header ?? null,
          assetHeroCapsule: sa?.hero_capsule ?? null,
          assetPackageHeader: sa?.package_header ?? null,
          assetPageBackground: sa?.page_background ?? null,
          assetUrlFormat: sa?.asset_url_format ?? null,
          releaseDate,
          shortDescription: r.basic_info?.short_description ?? null,
          reviewScore: reviews?.review_score ?? null,
          reviewScoreLabel: reviews?.review_score_label ?? null,
          reviewPercentPositive: reviews?.percent_positive ?? null,
          reviewCount: reviews?.review_count ?? null,
        },
      })
    }
    // Skip bundles (item_type=2) — we never request them at the top level.
  }
  return ok(out)
}

export const parseOwnedGames = (raw: unknown): Result<OwnedGames, SteamApiError> => {
  const parsed = OwnedGamesResponseSchema.safeParse(raw)
  if (!parsed.success) {
    return err({ kind: 'invalid_shape', issues: zodIssues(parsed.error) })
  }
  const inner = parsed.data.response
  if (!('game_count' in inner)) {
    return ok({ visibility: 'private' })
  }
  return ok({
    visibility: 'public',
    games: (inner.games ?? []).map((g) => ({
      appId: g.appid as SteamAppId,
      playtimeMinutes: g.playtime_forever,
      playtime2WeeksMinutes: g.playtime_2weeks ?? null,
    })),
  })
}

const buildUrl = (path: string, params: Readonly<Record<string, string>>): string => {
  const url = new URL(`${STEAM_API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

export type SteamApiClient = {
  /**
   * Returns playtime for the specified appIds only — uses Steam's
   * `appids_filter` so we don't pull the user's entire library every time.
   */
  readonly getOwnedGames: (
    steamId: SteamId,
    appIds: ReadonlyArray<SteamAppId>,
  ) => Promise<Result<OwnedGames, SteamApiError>>
  readonly getPlayerAchievements: (
    steamId: SteamId,
    appId: SteamAppId,
  ) => Promise<Result<AchievementsResult, SteamApiError>>
  /**
   * Community completion percentages for a single app. Public endpoint —
   * no API key required by Steam, but we pass the same key for consistency.
   * Steam returns HTTP 403 with `{}` for apps that have no achievements
   * (or aren't visible); we surface that as ok([]) to match the empty-list
   * case rather than treating it as a hard error.
   */
  readonly getGlobalAchievementPercents: (
    appId: SteamAppId,
  ) => Promise<Result<ReadonlyArray<GlobalAchievementPercent>, SteamApiError>>
  /**
   * Batch-fetches store metadata (capsules, release date, reviews, …) for the
   * given mix of apps and packages (subs). One HTTP call regardless of input
   * size, so callers should chunk inputs if they want to bound payloads.
   * Returns one entry per request present in the response; entries with
   * `item: null` were recognized by Steam but flagged unsuccessful
   * (delisted/region-locked/invalid id).
   */
  readonly getStoreItems: (
    requests: ReadonlyArray<StoreItemRequest>,
  ) => Promise<Result<ReadonlyArray<StoreItemEntry>, SteamApiError>>
}

export type SteamApiClientConfig = {
  readonly apiKey: string
  readonly fetcher?: Fetcher
}

const defaultFetcher: Fetcher = (u, i) => fetch(u, i)

export const createSteamApiClient = (cfg: SteamApiClientConfig): SteamApiClient => {
  const fetcher = cfg.fetcher ?? defaultFetcher

  return {
    getOwnedGames: async (steamId, appIds) => {
      // Steam's GET surface takes array params via `input_json` (a JSON
      // blob in a single query parameter). The flat `appids_filter[0]=`
      // form is unreliable across IPlayerService endpoints, so we use
      // the documented input_json shape.
      const inputJson = JSON.stringify({
        steamid: steamId,
        include_played_free_games: true,
        appids_filter: appIds,
      })
      const url = buildUrl('/IPlayerService/GetOwnedGames/v0001/', {
        key: cfg.apiKey,
        format: 'json',
        input_json: inputJson,
      })
      const text = await fetchText(fetcher, url)
      if (!text.ok) return text
      const json = safeJsonParse(text.value)
      if (!json.ok) return json
      return parseOwnedGames(json.value)
    },
    getPlayerAchievements: async (steamId, appId) => {
      const url = buildUrl('/ISteamUserStats/GetPlayerAchievements/v0001/', {
        key: cfg.apiKey,
        steamid: steamId,
        appid: String(appId),
        format: 'json',
        // Returns achievement display name + description in the response,
        // populating fields we'd otherwise need a separate GetSchemaForGame
        // call to fetch.
        l: 'english',
      })
      let res: Response
      try {
        res = await fetcher(url)
      } catch (e) {
        return err({ kind: 'network', message: e instanceof Error ? e.message : String(e) })
      }
      const body = await res.text()
      // Steam returns 400 with a JSON body for both "Profile is not public"
      // and "Requested app has no stats". Try to parse it before giving up.
      if (res.status === 400 || (res.status >= 200 && res.status < 300)) {
        const json = safeJsonParse(body)
        if (json.ok) return parsePlayerAchievements(json.value)
        if (res.status === 400) return err({ kind: 'http_status', status: 400, body })
        return json
      }
      return err({ kind: 'http_status', status: res.status, body })
    },
    getGlobalAchievementPercents: async (appId) => {
      const url = buildUrl('/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/', {
        gameid: String(appId),
        format: 'json',
      })
      let res: Response
      try {
        res = await fetcher(url)
      } catch (e) {
        return err({ kind: 'network', message: e instanceof Error ? e.message : String(e) })
      }
      const body = await res.text()
      // Steam returns 403 + `{}` for apps with no achievements (or hidden
      // ones). Treat as a successful "no data" result rather than an error
      // so the refresh job doesn't keep retrying these every cycle.
      if (res.status === 403) return ok([])
      if (res.status < 200 || res.status >= 300) {
        return err({ kind: 'http_status', status: res.status, body })
      }
      const json = safeJsonParse(body)
      if (!json.ok) return json
      return parseGlobalAchievementPercents(json.value)
    },
    getStoreItems: async (requests) => {
      if (requests.length === 0) return ok([])
      const inputJson = JSON.stringify({
        ids: requests.map((r) => (r.kind === 'app' ? { appid: r.appId } : { packageid: r.subId })),
        // steam_realm 1 = global; 2 = China. Use global.
        context: { language: 'english', country_code: 'US', steam_realm: 1 },
        data_request: {
          include_assets: true,
          include_release: true,
          include_basic_info: true,
          include_reviews: true,
          // Pulls included_apps for packages so we can fall back to the
          // parent app's capsule for "passthrough" subs (Deluxe/Complete
          // editions whose own assets field is empty). The nested
          // included_item_data_request is required — without it, Steam
          // returns included_apps as bare {id, name, type} with no assets.
          include_included_items: true,
          included_item_data_request: { include_assets: true },
        },
      })
      const url = buildUrl('/IStoreBrowseService/GetItems/v1/', {
        key: cfg.apiKey,
        format: 'json',
        input_json: inputJson,
      })
      const text = await fetchText(fetcher, url)
      if (!text.ok) return text
      const json = safeJsonParse(text.value)
      if (!json.ok) return json
      return parseStoreItems(json.value)
    },
  }
}
