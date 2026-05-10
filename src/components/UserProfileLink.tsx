import { Link } from '@tanstack/react-router'

import type { SteamGiftsUsername, SteamId } from '#/db/schema'

export type LinkableUser = {
  readonly steamgiftsUsername: SteamGiftsUsername | null
  readonly steamId: SteamId | null
  // Optional. Steam-only users (no SG link) get their persona name from
  // the Steam Community profile XML; we prefer it over the synthetic
  // "Steam <last6>" stub when present. Callers without persona data may
  // omit this field — the chain falls through to the stub.
  readonly personaName?: string | null
}

// Renders a "?" stub label when both identifiers are missing — should be
// vanishingly rare (the user row always has at least one of {sg, steam} set
// in practice), but the type system permits it so we render something
// visible rather than crashing.
const fallbackLabel = (steamId: SteamId | null): string =>
  steamId !== null ? `Steam ${steamId.slice(-6)}` : '?'

export function userDisplayName(user: LinkableUser): string {
  return user.steamgiftsUsername ?? user.personaName ?? fallbackLabel(user.steamId)
}

// Centralized "link to a user profile." SG-username path is the original
// /u/$username; users who never went through SG (manual-giveaway winners
// resolved by SteamID, mods who only signed in via Steam) fall back to
// /u/steam/$steamId. If neither is present we render the label as plain
// text — there's nowhere meaningful to point.
export function UserProfileLink({
  user,
  className,
  title,
  children,
}: {
  readonly user: LinkableUser
  readonly className?: string
  readonly title?: string
  readonly children?: React.ReactNode
}) {
  const label = children ?? userDisplayName(user)
  if (user.steamgiftsUsername !== null) {
    return (
      <Link
        to="/u/$username"
        params={{ username: user.steamgiftsUsername }}
        className={className}
        title={title}
      >
        {label}
      </Link>
    )
  }
  if (user.steamId !== null) {
    return (
      <Link
        to="/u/steam/$steamId"
        params={{ steamId: user.steamId }}
        className={className}
        title={title}
      >
        {label}
      </Link>
    )
  }
  return (
    <span className={className} title={title}>
      {label}
    </span>
  )
}
