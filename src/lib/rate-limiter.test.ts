import { describe, expect, it } from 'vitest'

import type { Fetcher } from '#/external/http'
import { createRateLimitedFetcher } from '#/lib/rate-limiter'

type Clock = {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly advanced: () => ReadonlyArray<number>
}

const createTestClock = (): Clock => {
  let t = 1_000_000
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms)
      t += ms
      return Promise.resolve()
    },
    advanced: () => sleeps,
  }
}

const okResponse = (): Response => new Response('ok', { status: 200 })

const respondWith = (status: number, headers: Record<string, string> = {}): Response =>
  new Response('', { status, headers })

describe('createRateLimitedFetcher', () => {
  it('runs the first call without delay and paces later calls by minIntervalMs (random=0)', async () => {
    const clock = createTestClock()
    const fetcher: Fetcher = () => Promise.resolve(okResponse())
    const limited = createRateLimitedFetcher({
      fetcher,
      minIntervalMs: 1000,
      jitterMs: 250,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    })

    await limited('https://example.test/a')
    await limited('https://example.test/b')

    expect(clock.advanced()).toEqual([1000])
  })

  it('applies full jitter when random=1 (gap = minIntervalMs + jitterMs)', async () => {
    const clock = createTestClock()
    const fetcher: Fetcher = () => Promise.resolve(okResponse())
    const limited = createRateLimitedFetcher({
      fetcher,
      minIntervalMs: 1000,
      jitterMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 1,
    })

    await limited('https://example.test/a')
    await limited('https://example.test/b')

    expect(clock.advanced()).toEqual([1500])
  })

  it('maintains the floor across many sequential calls', async () => {
    const clock = createTestClock()
    const fetcher: Fetcher = () => Promise.resolve(okResponse())
    const limited = createRateLimitedFetcher({
      fetcher,
      minIntervalMs: 200,
      jitterMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    })

    for (let i = 0; i < 5; i++) {
      await limited('https://example.test/')
    }

    expect(clock.advanced()).toEqual([200, 200, 200, 200])
  })

  it('honors Retry-After (seconds) on 429 by extending the next gap', async () => {
    const clock = createTestClock()
    let calls = 0
    const fetcher: Fetcher = () => {
      calls += 1
      return Promise.resolve(calls === 1 ? respondWith(429, { 'Retry-After': '5' }) : okResponse())
    }
    const limited = createRateLimitedFetcher({
      fetcher,
      minIntervalMs: 1000,
      jitterMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    })

    await limited('https://example.test/a')
    await limited('https://example.test/b')

    expect(clock.advanced()).toEqual([6000])
  })

  it('honors Retry-After on 503', async () => {
    const clock = createTestClock()
    let calls = 0
    const fetcher: Fetcher = () => {
      calls += 1
      return Promise.resolve(calls === 1 ? respondWith(503, { 'Retry-After': '2' }) : okResponse())
    }
    const limited = createRateLimitedFetcher({
      fetcher,
      minIntervalMs: 500,
      jitterMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    })

    await limited('https://example.test/a')
    await limited('https://example.test/b')

    expect(clock.advanced()).toEqual([2500])
  })

  it('serializes concurrent callers (second sleeps, even if started immediately)', async () => {
    const clock = createTestClock()
    const fetcher: Fetcher = () => Promise.resolve(okResponse())
    const limited = createRateLimitedFetcher({
      fetcher,
      minIntervalMs: 800,
      jitterMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    })

    await Promise.all([limited('https://example.test/a'), limited('https://example.test/b')])

    expect(clock.advanced()).toEqual([800])
  })

  it('passes url and init through to the underlying fetcher and returns its response', async () => {
    const clock = createTestClock()
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const expected = new Response('hello', { status: 200 })
    const fetcher: Fetcher = (url, init) => {
      seen.push({ url, init })
      return Promise.resolve(expected)
    }
    const limited = createRateLimitedFetcher({
      fetcher,
      minIntervalMs: 100,
      jitterMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    })

    const init: RequestInit = { headers: { 'X-Test': '1' } }
    const response = await limited('https://example.test/path', init)

    expect(response).toBe(expected)
    expect(seen).toEqual([{ url: 'https://example.test/path', init }])
  })
})
