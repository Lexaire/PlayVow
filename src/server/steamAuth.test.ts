import { describe, expect, it, vi } from 'vitest'

import { buildSteamLoginUrl, verifySteamCallback } from '#/server/steamAuth'

describe('buildSteamLoginUrl', () => {
  it('produces a checkid_setup URL with realm and return_to', () => {
    const url = buildSteamLoginUrl({
      realm: 'https://playvow.example',
      returnTo: 'https://playvow.example/auth/steam/callback',
    })
    const parsed = new URL(url)
    expect(parsed.host).toBe('steamcommunity.com')
    expect(parsed.searchParams.get('openid.mode')).toBe('checkid_setup')
    expect(parsed.searchParams.get('openid.realm')).toBe('https://playvow.example')
    expect(parsed.searchParams.get('openid.return_to')).toBe(
      'https://playvow.example/auth/steam/callback',
    )
    expect(parsed.searchParams.get('openid.identity')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    )
  })
})

const validParams = (): URLSearchParams => {
  const p = new URLSearchParams()
  p.set('openid.mode', 'id_res')
  p.set('openid.claimed_id', 'https://steamcommunity.com/openid/id/76561198000000010')
  p.set('openid.identity', 'https://steamcommunity.com/openid/id/76561198000000010')
  p.set('openid.return_to', 'https://playvow.example/auth/steam/callback')
  p.set('openid.assoc_handle', 'abc')
  p.set('openid.signed', 'signed,fields')
  p.set('openid.sig', 'signature')
  return p
}

describe('verifySteamCallback', () => {
  it('returns the steamId on a valid callback', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n', { status: 200 }),
      )
    const r = await verifySteamCallback(validParams(), fetchMock)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe('76561198000000010')
  })

  it('forwards check_authentication to Steam', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('is_valid:true\n', { status: 200 }))
    await verifySteamCallback(validParams(), fetchMock)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://steamcommunity.com/openid/login')
    expect(init?.method).toBe('POST')
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('openid.mode')).toBe('check_authentication')
    expect(body.get('openid.claimed_id')).toBe(
      'https://steamcommunity.com/openid/id/76561198000000010',
    )
  })

  it('rejects when Steam reports is_valid:false', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('is_valid:false\n', { status: 200 }))
    const r = await verifySteamCallback(validParams(), fetchMock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('verify_failed')
  })

  it('rejects when claimed_id does not match the Steam OpenID URL', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const p = validParams()
    p.set('openid.claimed_id', 'https://example.com/spoof/123')
    const r = await verifySteamCallback(p, fetchMock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('invalid_callback')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects when mode is not id_res', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const p = validParams()
    p.set('openid.mode', 'cancel')
    const r = await verifySteamCallback(p, fetchMock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('invalid_callback')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports fetch_failed on network error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('econnrefused'))
    const r = await verifySteamCallback(validParams(), fetchMock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('fetch_failed')
  })
})
