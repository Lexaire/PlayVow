import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { Fetcher } from '#/external/http'
import { testSgCookie } from '#/external/steamgifts-cookie-test'

const fixture = (rel: string): string =>
  readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), 'utf8')

const respond = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

const TEST_URL = 'https://www.steamgifts.com/group/xBp7E/taleplay/search'

describe('testSgCookie', () => {
  it('returns ok when the home page renders authenticated', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(respond(fixture('steamgifts/group-giveaways.html')))
    const r = await testSgCookie({ cookie: 'PHPSESSID=abc', testUrl: TEST_URL, fetcher })
    expect(r.kind).toBe('ok')
  })

  it('returns login_required when SG renders the sign-in button', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(respond(fixture('steamgifts/login-required.html')))
    const r = await testSgCookie({ cookie: 'PHPSESSID=expired', testUrl: TEST_URL, fetcher })
    expect(r.kind).toBe('login_required')
  })

  it('returns http_error on non-2xx', async () => {
    const fetcher: Fetcher = () => Promise.resolve(new Response('nope', { status: 503 }))
    const r = await testSgCookie({ cookie: 'PHPSESSID=abc', testUrl: TEST_URL, fetcher })
    expect(r.kind).toBe('http_error')
    if (r.kind !== 'http_error') return
    expect(r.status).toBe(503)
  })

  it('returns network_error when fetch throws', async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error('connection refused'))
    const r = await testSgCookie({ cookie: 'PHPSESSID=abc', testUrl: TEST_URL, fetcher })
    expect(r.kind).toBe('network_error')
    if (r.kind !== 'network_error') return
    expect(r.message).toBe('connection refused')
  })

  it('sends the cookie on the test request', async () => {
    let lastHeaders: Record<string, string> = {}
    const fetcher: Fetcher = (_url, init) => {
      lastHeaders = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(respond(fixture('steamgifts/group-giveaways.html')))
    }
    await testSgCookie({ cookie: 'PHPSESSID=abc', testUrl: TEST_URL, fetcher })
    expect(lastHeaders.Cookie).toBe('PHPSESSID=abc')
  })

  it('hits the provided testUrl', async () => {
    let lastUrl = ''
    const fetcher: Fetcher = (url) => {
      lastUrl = url
      return Promise.resolve(respond(fixture('steamgifts/group-giveaways.html')))
    }
    await testSgCookie({ cookie: 'PHPSESSID=abc', testUrl: TEST_URL, fetcher })
    expect(lastUrl).toBe(TEST_URL)
  })
})
