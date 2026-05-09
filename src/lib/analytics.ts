import '#/lib/server-only'

import { PostHog } from 'posthog-node'

// Thin Analytics interface so calling code doesn't depend on PostHog directly.
// Tests pass a no-op; missing/empty API key in env also yields a no-op so dev
// runs and ad-hoc scripts don't fail or accidentally leak events.
export type AnalyticsEvent = {
  readonly name: string
  readonly distinctId: string
  readonly properties?: Record<string, unknown>
}

export type Analytics = {
  readonly capture: (event: AnalyticsEvent) => void
  readonly shutdown: () => Promise<void>
}

const noopAnalytics: Analytics = {
  capture: () => {},
  shutdown: () => Promise.resolve(),
}

export type CreatePostHogAnalyticsConfig = {
  readonly apiKey: string | null
  readonly host?: string | undefined
}

// Returns a no-op analytics when apiKey is null/empty so the worker still runs
// in dev/test/ad-hoc shells without observability config. Otherwise wraps the
// PostHog node SDK; events are batched in-process and flushed on shutdown().
export const createPostHogAnalytics = (cfg: CreatePostHogAnalyticsConfig): Analytics => {
  if (cfg.apiKey === null || cfg.apiKey.length === 0) return noopAnalytics

  const client = new PostHog(cfg.apiKey, cfg.host ? { host: cfg.host } : {})

  return {
    capture: (event) => {
      client.capture({
        distinctId: event.distinctId,
        event: event.name,
        ...(event.properties ? { properties: event.properties } : {}),
      })
    },
    shutdown: () => client.shutdown(),
  }
}

export const noopAnalyticsForTests = (): Analytics => noopAnalytics
