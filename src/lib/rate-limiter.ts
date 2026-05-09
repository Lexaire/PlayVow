import type { Fetcher } from '#/external/http'

export type RateLimitedFetcherConfig = {
  readonly fetcher: Fetcher
  readonly minIntervalMs: number
  readonly jitterMs: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const RETRYABLE_STATUSES = new Set([429, 503])

const parseRetryAfterMs = (header: string | null, now: number): number | null => {
  if (header === null) return null
  const trimmed = header.trim()
  if (trimmed.length === 0) return null
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now)
  return null
}

export const createRateLimitedFetcher = (cfg: RateLimitedFetcherConfig): Fetcher => {
  const now = cfg.now ?? (() => Date.now())
  const sleep = cfg.sleep ?? defaultSleep
  const random = cfg.random ?? Math.random

  let nextAvailableAt = 0
  let chain: Promise<void> = Promise.resolve()

  const jitteredInterval = (): number => cfg.minIntervalMs + random() * cfg.jitterMs

  return (url, init) => {
    const result = chain.then(async () => {
      const wait = nextAvailableAt - now()
      if (wait > 0) await sleep(wait)
      const response = await cfg.fetcher(url, init)
      let extra = 0
      if (RETRYABLE_STATUSES.has(response.status)) {
        const retryAfter = parseRetryAfterMs(response.headers.get('Retry-After'), now())
        if (retryAfter !== null) extra = retryAfter
      }
      nextAvailableAt = now() + extra + jitteredInterval()
      return response
    })
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
