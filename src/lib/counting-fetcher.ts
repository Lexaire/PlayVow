import type { Fetcher } from '#/external/http'

// Wraps a Fetcher with a per-process call counter. Used by the worker to
// surface API usage in job-completed analytics events without forcing every
// downstream client to thread a counter through its own code.
//
// Every invocation increments — including failures, since rate-limit-relevant
// behavior (a 429 still counts toward the budget) and external billing both
// consider the request, not the response.
export type CountingFetcher = Fetcher & {
  readonly getCount: () => number
  readonly resetCount: () => number
}

export const createCountingFetcher = (inner: Fetcher): CountingFetcher => {
  let count = 0
  const fn: Fetcher = (url, init) => {
    count += 1
    return inner(url, init)
  }
  return Object.assign(fn, {
    getCount: (): number => count,
    resetCount: (): number => {
      const previous = count
      count = 0
      return previous
    },
  })
}
