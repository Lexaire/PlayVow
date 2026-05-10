import { describe, expect, it } from 'vitest'

import { parseSteamInput } from '#/domain/steamInput'

describe('parseSteamInput', () => {
  it('accepts a bare 17-digit SteamID64', () => {
    const r = parseSteamInput('76561197968806363')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'steamid64', steamId: '76561197968806363' })
  })

  it('extracts SteamID64 from a /profiles/<id> URL', () => {
    const r = parseSteamInput('https://steamcommunity.com/profiles/76561197968806363')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'steamid64', steamId: '76561197968806363' })
  })

  it('extracts SteamID64 from a /profiles/<id>/ URL with trailing slash', () => {
    const r = parseSteamInput('https://steamcommunity.com/profiles/76561197968806363/')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'steamid64', steamId: '76561197968806363' })
  })

  it('extracts a vanity handle from an /id/<handle> URL', () => {
    const r = parseSteamInput('https://steamcommunity.com/id/lext/')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'vanity', handle: 'lext' })
  })

  it('extracts a vanity handle from a no-scheme /id/ URL', () => {
    const r = parseSteamInput('steamcommunity.com/id/lext')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'vanity', handle: 'lext' })
  })

  it('treats a bare alphanumeric token as a vanity', () => {
    const r = parseSteamInput('lext')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'vanity', handle: 'lext' })
  })

  it('trims surrounding whitespace', () => {
    const r = parseSteamInput('   76561197968806363  ')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.kind).toBe('steamid64')
  })

  it('rejects empty strings', () => {
    const r = parseSteamInput('')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('invalid_input')
  })

  it('rejects whitespace-only strings', () => {
    const r = parseSteamInput('   ')
    expect(r.ok).toBe(false)
  })

  it('rejects non-Steam URLs', () => {
    const r = parseSteamInput('https://example.com/id/lext')
    expect(r.ok).toBe(false)
  })

  it('rejects vanities under 3 characters', () => {
    const r = parseSteamInput('ab')
    expect(r.ok).toBe(false)
  })

  it('rejects vanities with disallowed characters', () => {
    const r = parseSteamInput('hello world')
    expect(r.ok).toBe(false)
  })

  it('treats a 17-digit non-SteamID64 as a vanity (Steam will reject if bogus)', () => {
    // Same length as a SteamID64 but wrong prefix. Steam vanities can be
    // all-digit; rather than guess, we let the input through and rely on
    // the profile XML lookup to surface "not_found" if it really is bogus.
    const r = parseSteamInput('12345678901234567')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.kind).toBe('vanity')
  })
})
