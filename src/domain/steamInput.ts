import type { SteamId } from '#/db/schema'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

// Parses an admin/mod-supplied Steam user reference into a tagged lookup the
// Steam Community profile-XML endpoint can consume directly. Accepts:
//   76561197968806363                        → steamid64
//   https://steamcommunity.com/profiles/76561197968806363  → steamid64
//   https://steamcommunity.com/id/lext       → vanity ("lext")
//   steamcommunity.com/id/lext/              → vanity ("lext")
//   lext                                     → vanity ("lext")
//
// Inputs containing "/" that aren't a recognized Steam Community URL are
// rejected — almost always a paste of an unrelated link, and silently treating
// them as vanities would produce confusing "vanity not found" errors later.

// 17-digit IDs starting with 7656 are the SteamID64 individual range. Every
// real user account falls in this band; the broader 765* range also contains
// group/clan IDs we don't want to accept here.
const STEAM_ID_RE = /^7656\d{13}$/
const PROFILES_URL_RE = /steamcommunity\.com\/profiles\/(7656\d{13})/i
const ID_URL_RE = /steamcommunity\.com\/id\/([^/?#]+)/i

// Steam vanities are alphanumeric + underscores + dashes, 3–32 chars (Steam's
// own form imposes 3–32). Anything outside that almost certainly isn't a real
// vanity, and rejecting it up-front saves a doomed Steam call.
const VANITY_RE = /^[A-Za-z0-9_-]{3,32}$/

export type SteamInputLookup =
  | { readonly kind: 'steamid64'; readonly steamId: SteamId }
  | { readonly kind: 'vanity'; readonly handle: string }

export type SteamInputParseError = { readonly kind: 'invalid_input' }

export const parseSteamInput = (
  raw: string,
): Result<SteamInputLookup, SteamInputParseError> => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return err({ kind: 'invalid_input' })

  if (STEAM_ID_RE.test(trimmed)) {
    return ok({ kind: 'steamid64', steamId: trimmed as SteamId })
  }

  const profilesMatch = PROFILES_URL_RE.exec(trimmed)
  if (profilesMatch?.[1]) {
    return ok({ kind: 'steamid64', steamId: profilesMatch[1] as SteamId })
  }

  const idMatch = ID_URL_RE.exec(trimmed)
  if (idMatch?.[1] && VANITY_RE.test(idMatch[1])) {
    return ok({ kind: 'vanity', handle: idMatch[1] })
  }

  // No URL match. A bare token is fine if it looks like a vanity; anything
  // containing "/" is rejected as an unrelated URL.
  if (trimmed.includes('/')) return err({ kind: 'invalid_input' })
  if (VANITY_RE.test(trimmed)) return ok({ kind: 'vanity', handle: trimmed })

  return err({ kind: 'invalid_input' })
}
