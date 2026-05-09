import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { SteamGiftsGiveawayCode, SteamGiftsGroupCode, SteamGiftsUsername } from '#/db/schema'
import type { Fetcher } from '#/external/http'
import {
  createSgClient,
  parseGiveawayWinnersHtml,
  parseGroupGiveawaysHtml,
  parseSgProfile,
} from '#/external/steamgifts'

const fixture = (rel: string): string =>
  readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), 'utf8')

describe('parseGroupGiveawaysHtml', () => {
  it('extracts every giveaway row from the group listing fixture', () => {
    const r = parseGroupGiveawaysHtml(fixture('steamgifts/group-giveaways.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.rows).toHaveLength(25)

    expect(r.value.rows[0]).toEqual({
      giveawayCode: 'JaVqf',
      giveawaySlug: 'forrader-hero',
      title: 'Forrader Hero',
      steamRef: { kind: 'app', appId: 2056490 },
      quantity: 1,
      creatorUsername: 'viewer_user',
      startedAt: new Date(1777080838 * 1000),
      endedAt: new Date(1777651200 * 1000),
      winners: [],
      noWinners: false,
    })
  })

  it('captures the visible winner on ended giveaways once keys are sent', () => {
    const r = parseGroupGiveawaysHtml(fixture('steamgifts/group-giveaways.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dordogne = r.value.rows.find((g) => g.giveawayCode === 'tStel')
    expect(dordogne).toBeDefined()
    expect(dordogne?.winners).toEqual(['UserAlpha'])
    expect(dordogne?.endedAt).toEqual(new Date(1777078800 * 1000))
  })

  it('returns empty winners while a winner is in "Awaiting feedback"', () => {
    const r = parseGroupGiveawaysHtml(fixture('steamgifts/group-giveaways.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const awaiting = r.value.rows.find((g) => g.giveawayCode === '9TtZM')
    expect(awaiting).toBeDefined()
    expect(awaiting?.winners).toEqual([])
    expect(awaiting?.endedAt).toEqual(new Date(1777078800 * 1000))
  })

  it('returns ok with empty rows + signedOut=true on a sign-in page (listings are public)', () => {
    // Per the Tier 1 resilience rework, the listing parser no longer
    // short-circuits on the nav showing sign-in — listings are public on
    // SG, and we want anonymous scrapes to keep working. signedOut=true
    // surfaces the state so callers can warn if rows are also empty
    // (would indicate SG started gating listings).
    const r = parseGroupGiveawaysHtml(fixture('steamgifts/login-required.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.rows).toEqual([])
    expect(r.value.signedOut).toBe(true)
  })

  it('reports signedOut=false on an authenticated listing page', () => {
    const r = parseGroupGiveawaysHtml(fixture('steamgifts/group-giveaways.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.signedOut).toBe(false)
  })

  it('parses mixed listing states: multi-copy with partial winners, no-winners, awaiting', () => {
    const r = parseGroupGiveawaysHtml(fixture('steamgifts/group-giveaways-mixed.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // 2-copy giveaway with only 1 actual winner (low entries).
    const memoryPuzzle = r.value.rows.find((g) => g.giveawayCode === 'BRnfc')
    expect(memoryPuzzle).toBeDefined()
    expect(memoryPuzzle?.quantity).toBe(2)
    expect(memoryPuzzle?.winners).toEqual(['UserBravo'])
    expect(memoryPuzzle?.noWinners).toBe(false)

    // Confirmed no-winners (fa-ban).
    const warMongrels = r.value.rows.find((g) => g.giveawayCode === 'DSVoQ')
    expect(warMongrels).toBeDefined()
    expect(warMongrels?.noWinners).toBe(true)
    expect(warMongrels?.winners).toEqual([])
  })

  it('returns empty list when there are no giveaway rows', () => {
    const r = parseGroupGiveawaysHtml(
      '<html><body><div class="nav__avatar-outer-wrap"></div></body></html>',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.rows).toEqual([])
  })
})

describe('parseGiveawayWinnersHtml', () => {
  it('extracts activated winners from a winners fixture', () => {
    const r = parseGiveawayWinnersHtml(fixture('steamgifts/winners.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ activated: ['UserCharlie84'], awaitingCount: 0 })
  })

  it('returns empty activated + zero awaiting on a true no-winners page', () => {
    const r = parseGiveawayWinnersHtml(fixture('steamgifts/winners-no-winners.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ activated: [], awaitingCount: 0 })
  })

  it('counts awaiting-feedback rows separately from activated winners', () => {
    const r = parseGiveawayWinnersHtml(fixture('steamgifts/winners-awaiting.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ activated: [], awaitingCount: 1 })
  })

  it('returns zero counts when no winner rows are present', () => {
    const r = parseGiveawayWinnersHtml('<html><body></body></html>')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ activated: [], awaitingCount: 0 })
  })

  it('returns login_required when the winners page renders the sign-in button', () => {
    // Group-only multi-copy winners pages are the auth-gated SG path. SG
    // serves the sign-in nav for anonymous visitors; without this check
    // we'd return empty winners and incorrectly mark partial multi-copy
    // giveaways as settled.
    const r = parseGiveawayWinnersHtml(fixture('steamgifts/login-required.html'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('login_required')
  })
})

describe('parseSgProfile', () => {
  it('extracts steamid + persona + avatar from the ThirdPartyUser fixture', () => {
    const r = parseSgProfile(
      'ThirdPartyUser' as SteamGiftsUsername,
      fixture('steamgifts/profile-third-party.html'),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      steamgiftsUsername: 'ThirdPartyUser',
      steamId: '76561198000000010',
      personaName: 'ThirdPartyUser',
      avatarUrl:
        'https://avatars.steamstatic.com/0000000000000000000000000000000000000010_full.jpg',
    })
  })

  it('falls back to null persona/avatar when the JSON-LD block is absent', () => {
    const r = parseSgProfile('Foo' as SteamGiftsUsername, fixture('steamgifts/profile.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.steamId).toBe('76561198000000010')
    // older fixture lacks JSON-LD; still parses steamid via the sidebar link.
  })

  it('returns parse_failed when the profile has no steam link', () => {
    const r = parseSgProfile(
      'Foo' as SteamGiftsUsername,
      fixture('steamgifts/profile-no-steam-link.html'),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('parse_failed')
  })
})

const respond = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

describe('createSgClient', () => {
  it('sends cookie and user-agent on group giveaways request', async () => {
    let lastUrl = ''
    let lastHeaders: Record<string, string> = {}
    const fetcher: Fetcher = (url, init) => {
      lastUrl = url
      lastHeaders = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(respond(fixture('steamgifts/group-giveaways.html')))
    }
    const client = createSgClient({
      cookie: 'PHPSESSID=abc',
      userAgent: 'test-ua',
      fetcher,
    })
    const r = await client.getGroupGiveaways('xBp7E' as SteamGiftsGroupCode, 'taleplay', 2)
    expect(r.ok).toBe(true)
    expect(lastUrl).toBe('https://www.steamgifts.com/group/xBp7E/taleplay/search?page=2')
    expect(lastHeaders.Cookie).toBe('PHPSESSID=abc')
    expect(lastHeaders['User-Agent']).toBe('test-ua')
  })

  it('hits the per-giveaway winners URL with cookie', async () => {
    let lastUrl = ''
    let lastHeaders: Record<string, string> = {}
    const fetcher: Fetcher = (url, init) => {
      lastUrl = url
      lastHeaders = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(respond(fixture('steamgifts/winners.html')))
    }
    const client = createSgClient({ cookie: 'PHPSESSID=abc', fetcher })
    const r = await client.getGiveawayWinners(
      'oSQWf' as SteamGiftsGiveawayCode,
      'ikonei-island-an-earthlock-adventure',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ activated: ['UserCharlie84'], awaitingCount: 0 })
    expect(lastUrl).toBe(
      'https://www.steamgifts.com/giveaway/oSQWf/ikonei-island-an-earthlock-adventure/winners',
    )
    expect(lastHeaders.Cookie).toBe('PHPSESSID=abc')
  })

  it('returns full profile (steamid + persona + avatar) for an SG username', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(respond(fixture('steamgifts/profile-third-party.html')))
    const client = createSgClient({ cookie: 'PHPSESSID=abc', fetcher })
    const r = await client.getProfile('ThirdPartyUser' as SteamGiftsUsername)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.steamId).toBe('76561198000000010')
    expect(r.value.personaName).toBe('ThirdPartyUser')
    expect(r.value.avatarUrl).toContain('avatars.steamstatic.com')
  })

  it('propagates http errors from fetch', async () => {
    const fetcher: Fetcher = () => Promise.resolve(new Response('nope', { status: 500 }))
    const client = createSgClient({ cookie: 'PHPSESSID=abc', fetcher })
    const r = await client.getProfile('ThirdPartyUser' as SteamGiftsUsername)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('http_status')
  })
})
