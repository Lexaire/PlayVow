import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { SteamAppId, SteamId } from '#/db/schema'
import type { Fetcher } from '#/external/http'
import {
  createSteamApiClient,
  parseOwnedGames,
  parsePlayerAchievements,
} from '#/external/steam-api'

const fixture = (rel: string): string =>
  readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), 'utf8')

const fixtureJson = (rel: string): unknown => JSON.parse(fixture(rel)) as unknown

describe('parseOwnedGames', () => {
  it('parses a public profile with games', () => {
    const r = parseOwnedGames(fixtureJson('steam/owned-games-public.json'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.visibility).toBe('public')
    if (r.value.visibility !== 'public') return
    expect(r.value.games).toHaveLength(3)
    expect(r.value.games[0]).toEqual({
      appId: 440,
      playtimeMinutes: 5000,
      playtime2WeeksMinutes: 30,
    })
    // Game with no extended fields gets nulls / never-played stays null
    expect(r.value.games[2]).toEqual({
      appId: 220,
      playtimeMinutes: 240,
      playtime2WeeksMinutes: null,
    })
  })

  it('reports private when response is empty', () => {
    const r = parseOwnedGames(fixtureJson('steam/owned-games-private.json'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.visibility).toBe('private')
  })
})

describe('parsePlayerAchievements', () => {
  it('returns per-achievement detail from a successful response', () => {
    const r = parsePlayerAchievements({
      playerstats: {
        success: true,
        achievements: [
          {
            apiname: 'A',
            achieved: 1,
            unlocktime: 1700000000,
            name: 'A name',
            description: 'A desc',
          },
          { apiname: 'B', achieved: 0, unlocktime: 0 },
          { apiname: 'C', achieved: 1, unlocktime: 0 }, // legacy unlock: pre-2010
        ],
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.kind).toBe('public')
    if (r.value.kind !== 'public') return
    expect(r.value.achievements).toEqual([
      {
        apiname: 'A',
        achieved: true,
        unlockedAt: new Date(1700000000 * 1000),
        displayName: 'A name',
        description: 'A desc',
      },
      {
        apiname: 'B',
        achieved: false,
        unlockedAt: null,
        displayName: null,
        description: null,
      },
      {
        apiname: 'C',
        achieved: true,
        unlockedAt: null, // legacy unlock with unlocktime=0
        displayName: null,
        description: null,
      },
    ])
  })

  it('returns private when error mentions "not public"', () => {
    const r = parsePlayerAchievements({
      playerstats: { success: false, error: 'Profile is not public' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'private' })
  })

  it('returns no_stats for any other unsuccessful response', () => {
    const r = parsePlayerAchievements({
      playerstats: { success: false, error: 'Requested app has no stats' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'no_stats' })
  })
})

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

describe('createSteamApiClient', () => {
  it('uses input_json with appids_filter so we never pull the whole library', async () => {
    const seen: string[] = []
    const fetcher: Fetcher = (url) => {
      seen.push(url)
      return Promise.resolve(okJson({ response: { game_count: 0, games: [] } }))
    }
    const client = createSteamApiClient({ apiKey: 'KEY', fetcher })
    const r = await client.getOwnedGames('76561198000000010' as SteamId, [440 as SteamAppId])
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('GetOwnedGames')
    expect(seen[0]).toContain('key=KEY')
    expect(seen[0]).toContain('input_json=')
    expect(seen[0]).toContain('appids_filter')
    expect(seen[0]).toContain('440')
    // Sanity: no include_appinfo (we have the name from SG already).
    expect(seen[0]).not.toContain('include_appinfo')
  })

  it('returns http_status error on non-2xx', async () => {
    const fetcher: Fetcher = () => Promise.resolve(new Response('forbidden', { status: 403 }))
    const client = createSteamApiClient({ apiKey: 'KEY', fetcher })
    const r = await client.getOwnedGames('76561198000000010' as SteamId, [440 as SteamAppId])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('http_status')
    if (r.error.kind !== 'http_status') return
    expect(r.error.status).toBe(403)
  })

  it('returns invalid_json on non-json body', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(new Response('<html>oops</html>', { status: 200 }))
    const client = createSteamApiClient({ apiKey: 'KEY', fetcher })
    const r = await client.getOwnedGames('76561198000000010' as SteamId, [440 as SteamAppId])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('invalid_json')
  })

  it('returns network error when fetch throws', async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error('boom'))
    const client = createSteamApiClient({ apiKey: 'KEY', fetcher })
    const r = await client.getOwnedGames('76561198000000010' as SteamId, [440 as SteamAppId])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('network')
  })
})
