import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { SteamAppId, SteamGroupId, SteamId } from '#/db/schema'
import type { Fetcher } from '#/external/http'
import {
  createSteamCommunityClient,
  parseGroupMembersPage,
  parseScreenshotCount,
} from '#/external/steam-community'

const fixture = (rel: string): string =>
  readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), 'utf8')

describe('parseScreenshotCount', () => {
  it('counts profile_media_item tiles on a public profile', () => {
    const r = parseScreenshotCount(fixture('steam/screenshots-public.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe(3)
  })

  it('returns profile_private for a locked profile', () => {
    const r = parseScreenshotCount(fixture('steam/screenshots-private.html'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('profile_private')
  })

  it('returns 0 for a public profile with no screenshots', () => {
    const r = parseScreenshotCount('<html><body></body></html>')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe(0)
  })
})

describe('parseGroupMembersPage', () => {
  it('extracts groupId64, pagination, and members from the TalePlay fixture', () => {
    const r = parseGroupMembersPage(fixture('steam/group-members-page.xml'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.groupId64).toBe('103582791400000001')
    expect(r.value.totalPages).toBe(1)
    expect(r.value.currentPage).toBe(1)
    expect(r.value.members).toEqual([
      '76561198000000021',
      '76561198000000022',
      '76561198000000023',
      '76561198000000024',
      '76561198000000025',
    ])
  })

  it('returns parse_failed when groupID64 is missing', () => {
    const r = parseGroupMembersPage('<memberList></memberList>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('parse_failed')
  })

  it('returns parse_failed when pagination fields are missing', () => {
    const r = parseGroupMembersPage('<memberList><groupID64>123</groupID64></memberList>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('parse_failed')
  })

  it('returns empty members array when no steamID64 elements', () => {
    const r = parseGroupMembersPage(
      '<memberList><groupID64>123</groupID64><totalPages>1</totalPages><currentPage>1</currentPage><members></members></memberList>',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.members).toEqual([])
  })
})

describe('createSteamCommunityClient', () => {
  it('hits the per-app screenshots URL on the profiles route', async () => {
    const seen: string[] = []
    const fetcher: Fetcher = (url) => {
      seen.push(url)
      return Promise.resolve(
        new Response(fixture('steam/screenshots-public.html'), {
          status: 200,
        }),
      )
    }
    const client = createSteamCommunityClient({ fetcher })
    const r = await client.getScreenshotCount('76561198000000010' as SteamId, 440 as SteamAppId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe(3)
    expect(seen[0]).toBe(
      'https://steamcommunity.com/profiles/76561198000000010/screenshots/?appid=440',
    )
  })

  it('hits the group members XML endpoint with the given gid64 and page', async () => {
    const seen: string[] = []
    const fetcher: Fetcher = (url) => {
      seen.push(url)
      return Promise.resolve(new Response(fixture('steam/group-members-page.xml'), { status: 200 }))
    }
    const client = createSteamCommunityClient({ fetcher })
    const r = await client.getGroupMembersPage('103582791400000001' as SteamGroupId, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.members.length).toBe(5)
    expect(seen[0]).toBe(
      'https://steamcommunity.com/gid/103582791400000001/memberslistxml/?xml=1&p=1',
    )
  })
})
