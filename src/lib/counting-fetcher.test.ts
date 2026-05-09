import { describe, expect, it } from 'vitest'

import type { Fetcher } from '#/external/http'
import { createCountingFetcher } from '#/lib/counting-fetcher'

const stubFetcher =
  (status = 200): Fetcher =>
  () =>
    Promise.resolve(new Response('', { status }))

describe('createCountingFetcher', () => {
  it('starts at zero and increments per call', async () => {
    const f = createCountingFetcher(stubFetcher())
    expect(f.getCount()).toBe(0)
    await f('https://example.test/a')
    await f('https://example.test/b')
    expect(f.getCount()).toBe(2)
  })

  it('counts failed responses too (429 still counts toward the budget)', async () => {
    const f = createCountingFetcher(stubFetcher(429))
    await f('https://example.test/x')
    await f('https://example.test/y')
    expect(f.getCount()).toBe(2)
  })

  it('resetCount returns the previous count and zeroes the counter', async () => {
    const f = createCountingFetcher(stubFetcher())
    await f('https://example.test/a')
    await f('https://example.test/b')
    await f('https://example.test/c')
    expect(f.resetCount()).toBe(3)
    expect(f.getCount()).toBe(0)
    await f('https://example.test/d')
    expect(f.getCount()).toBe(1)
  })

  it('counts even when the inner fetcher throws (call attempt happened)', async () => {
    const throwing: Fetcher = () => Promise.reject(new Error('network down'))
    const f = createCountingFetcher(throwing)
    await expect(f('https://example.test')).rejects.toThrow('network down')
    expect(f.getCount()).toBe(1)
  })
})
