import { createFileRoute } from '@tanstack/react-router'

import { completeSteamLogin } from '#/server/authFns'

// Coerce every search-param value to string and pass through whatever Steam
// sent. We don't enumerate openid.* keys here because Steam's
// check_authentication step requires forwarding every signed field
// byte-for-byte — if Steam ever adds a new openid.* param, dropping it would
// silently break verification.
const toStringRecord = (search: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(search)) {
    if (v == null) continue
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

export const Route = createFileRoute('/auth/steam/callback')({
  // The route's typed search is only used for our own `state` param; Steam's
  // openid.* keys round-trip through loaderDeps as a raw record.
  validateSearch: (search: Record<string, unknown>) => ({
    state: typeof search['state'] === 'string' ? search['state'] : undefined,
  }),
  loaderDeps: ({ search: _search }) => ({}),
  loader: async ({ location }) => {
    const all = toStringRecord(location.search as Record<string, unknown>)
    const state = all['state']
    // Strip our own state param before forwarding — only openid.* keys are
    // signed by Steam and belong in check_authentication.
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('openid.')) params[k] = v
    }
    await completeSteamLogin({
      data: { params, ...(state !== undefined ? { state } : {}) },
    })
  },
  component: () => null,
})
