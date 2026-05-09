import type { SgCookieTestResult } from '#/db/schema'
import type { GroupCookieStatus } from '#/repos/groupSecrets'

// Cookie health combines "is a cookie set" with "did it work last time it was
// exercised." Anonymous mode is a valid first-class state, NOT an error —
// most SG scraping works without a cookie; one is only needed for multi-copy
// (3+) winners-page reconciliation.
export type CookieHealth = 'anonymous' | 'working' | 'untested' | 'failing'

export const cookieHealth = (row: GroupCookieStatus): CookieHealth => {
  if (!row.isSet) return 'anonymous'
  if (row.lastTestResult === 'ok') return 'working'
  if (row.lastTestResult === null) return 'untested'
  return 'failing'
}

export const HEALTH_PILL: Readonly<Record<CookieHealth, string>> = {
  // Neutral — anonymous mode keeps listings + 1–2 copy winners flowing.
  anonymous: 'bg-neutral-100 text-neutral-700',
  working: 'bg-emerald-100 text-emerald-800',
  untested: 'bg-amber-100 text-amber-800',
  failing: 'bg-rose-100 text-rose-800',
}

export const HEALTH_LABEL: Readonly<Record<CookieHealth, string>> = {
  anonymous: 'Anonymous',
  working: 'Working',
  untested: 'Untested',
  failing: 'Failing',
}

export const HEALTH_HINT: Readonly<Record<CookieHealth, string>> = {
  anonymous: 'No cookie set — public scraping only. Multi-copy 3+ winners stay unsettled.',
  working: 'Last scrape or test confirmed the cookie authenticates with SteamGifts.',
  untested: 'Cookie is stored but has not been exercised yet. Click Test to verify.',
  failing: 'SteamGifts rejected the cookie on the last try. Replace it.',
}

export const TEST_RESULT_PILL: Readonly<Record<SgCookieTestResult, string>> = {
  ok: 'bg-emerald-100 text-emerald-800',
  login_required: 'bg-rose-100 text-rose-800',
  http_error: 'bg-amber-100 text-amber-800',
  network_error: 'bg-amber-100 text-amber-800',
}

export const formatTestResult = (
  result: SgCookieTestResult,
  httpStatus?: number | null,
): string => {
  switch (result) {
    case 'ok':
      return 'Authenticated successfully.'
    case 'login_required':
      return 'SteamGifts returned the login page. The cookie probably expired.'
    case 'http_error':
      return httpStatus
        ? `SteamGifts rejected the request (HTTP ${httpStatus}).`
        : 'SteamGifts rejected the request.'
    case 'network_error':
      return 'SteamGifts did not respond. This may be temporary.'
  }
}

export const formatRelativeTime = (date: Date | null, now: Date = new Date()): string => {
  if (!date) return 'never'
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.round(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  return `${diffDay}d ago`
}

export const formatSetCookieError = (kind: string): string => {
  switch (kind) {
    case 'group_not_found':
      return 'That group no longer exists.'
    case 'not_set':
      return 'No cookie is set for this group.'
    case 'decrypt_failed':
      return 'Stored cookie could not be decrypted. Paste a fresh one.'
    default:
      return 'Unknown error.'
  }
}
