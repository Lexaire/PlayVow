import posthog from 'posthog-js'

import type { CurrentUserInfo } from '#/server/modFns'

const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY ?? ''
const apiHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST

const isBrowser = (): boolean => typeof window !== 'undefined'
const isEnabled = (): boolean => isBrowser() && apiKey.length > 0

let initialized = false

export const initPostHogClient = (): void => {
  if (initialized || !isEnabled()) return
  initialized = true

  posthog.init(apiKey, {
    ...(apiHost ? { api_host: apiHost } : {}),
    ui_host: 'https://us.posthog.com',
    capture_pageview: 'history_change',
    capture_performance: { web_vitals: true },
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-sensitive]',
    },
    persistence: 'localStorage+cookie',
    cross_subdomain_cookie: false,
  })
}

export const identifyPostHogUser = (user: CurrentUserInfo | null): void => {
  if (!initialized || !isEnabled()) return

  if (user === null || user.steamId === null) {
    posthog.reset()
    return
  }

  const properties: Record<string, unknown> = { role: user.role }
  if (user.steamgiftsUsername) {
    properties.$name = user.steamgiftsUsername
    properties.username = user.steamgiftsUsername
  }
  if (user.avatarUrl) {
    properties.avatar = user.avatarUrl
  }

  posthog.identify(user.steamId, properties)
}
