import '#/lib/server-only'

import type { SteamId } from '#/db/schema'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login'
const OPENID_NS = 'http://specs.openid.net/auth/2.0'
const OPENID_IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select'
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/

export type SteamAuthError =
  | { readonly kind: 'invalid_callback'; readonly reason: string }
  | { readonly kind: 'verify_failed'; readonly reason: string }
  | { readonly kind: 'fetch_failed'; readonly cause: string }

export const buildSteamLoginUrl = (params: {
  readonly realm: string
  readonly returnTo: string
}): string => {
  const u = new URL(STEAM_OPENID_ENDPOINT)
  u.searchParams.set('openid.ns', OPENID_NS)
  u.searchParams.set('openid.mode', 'checkid_setup')
  u.searchParams.set('openid.return_to', params.returnTo)
  u.searchParams.set('openid.realm', params.realm)
  u.searchParams.set('openid.identity', OPENID_IDENTIFIER_SELECT)
  u.searchParams.set('openid.claimed_id', OPENID_IDENTIFIER_SELECT)
  return u.toString()
}

const extractSteamId = (claimedId: string | null): SteamId | null => {
  if (!claimedId) return null
  return (CLAIMED_ID_RE.exec(claimedId)?.[1] ?? null) as SteamId | null
}

// Re-POST every openid.* param to Steam with mode=check_authentication. Steam
// replies with a key:value text body containing `is_valid:true` on success.
// This is the standard OpenID 2.0 verification handshake — protects against a
// caller fabricating a callback URL with a steamId of their choosing.
export const verifySteamCallback = async (
  searchParams: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<SteamId, SteamAuthError>> => {
  if (searchParams.get('openid.mode') !== 'id_res') {
    return err({
      kind: 'invalid_callback',
      reason: `expected mode=id_res, got ${searchParams.get('openid.mode') ?? 'null'}`,
    })
  }
  const claimedId = searchParams.get('openid.claimed_id')
  const steamId = extractSteamId(claimedId)
  if (!steamId) {
    return err({ kind: 'invalid_callback', reason: `claimed_id mismatch: ${claimedId ?? 'null'}` })
  }

  const verifyBody = new URLSearchParams()
  for (const [k, v] of searchParams.entries()) {
    verifyBody.set(k, v)
  }
  verifyBody.set('openid.mode', 'check_authentication')

  let response: Response
  try {
    response = await fetchImpl(STEAM_OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: verifyBody.toString(),
    })
  } catch (e) {
    return err({ kind: 'fetch_failed', cause: e instanceof Error ? e.message : String(e) })
  }
  if (!response.ok) {
    return err({ kind: 'fetch_failed', cause: `http ${response.status}` })
  }

  const text = await response.text()
  const isValid = text
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === 'is_valid:true')
  if (!isValid) {
    return err({ kind: 'verify_failed', reason: text.slice(0, 200) })
  }

  return ok(steamId)
}
