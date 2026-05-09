import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { SteamAppId, SteamGroupId, SteamId } from '#/db/schema'
import type { Fetcher } from '#/external/http'
import {
  createSteamCommunityClient,
  parseGroupMembersPage,
  parseScreenshots,
} from '#/external/steam-community'

const fixture = (rel: string): string =>
  readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), 'utf8')

describe('parseScreenshots', () => {
  it('extracts fileId, thumbUrl, and caption for each screenshot on a public profile', () => {
    // Real (sanitized) Steam screenshots page with 4 screenshots — also
    // contains the inline JS that mentions `profile_media_item` an extra
    // 2 times, which would falsely inflate a naive class-name count.
    const r = parseScreenshots(fixture('steam/screenshots-public.html'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(4)
    const first = r.value[0]
    expect(first?.fileId).toBe('1001')
    expect(first?.thumbUrl).toMatch(/^https:\/\/images\.steamusercontent\.com\/ugc\//)
    expect(first?.caption).toBe('Sample caption 1')
    // The remaining 3 had no caption in the source; the sanitizer left them
    // empty, so they should parse as null.
    expect(r.value[1]?.caption).toBeNull()
    expect(r.value[2]?.caption).toBeNull()
    expect(r.value[3]?.caption).toBeNull()
    // fileIds are unique per screenshot and increase monotonically in the fixture.
    expect(r.value.map((s) => s.fileId)).toEqual(['1001', '1002', '1003', '1004'])
  })

  it('returns profile_private for a locked profile', () => {
    const r = parseScreenshots(fixture('steam/screenshots-private.html'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('profile_private')
  })

  it('returns an empty list for a public profile with no screenshots', () => {
    const r = parseScreenshots('<html><body></body></html>')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual([])
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
    const r = await client.getScreenshots('76561198000000010' as SteamId, 440 as SteamAppId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(4)
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
