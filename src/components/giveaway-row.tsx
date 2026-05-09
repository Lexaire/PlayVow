import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { smallCapsuleSmallSize, steamAssetUrl } from '#/lib/steam-assets'
import type { GiveawayCreatorSummary, GiveawayView } from '#/server/queries'

export type GiveawayState =
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'ended_pending' }
  | { readonly kind: 'no_winner' }
  | { readonly kind: 'has_winners'; readonly count: number }

export const giveawayState = (g: GiveawayView, now: Date): GiveawayState => {
  if (g.endedAt.getTime() > now.getTime()) return { kind: 'in_progress' }
  if (g.winnersScrapedAt === null) return { kind: 'ended_pending' }
  if (g.winnerCount === 0) return { kind: 'no_winner' }
  return { kind: 'has_winners', count: g.winnerCount }
}

export const STATE_STYLES: Readonly<Record<GiveawayState['kind'], string>> = {
  in_progress: 'bg-amber-100 text-amber-900',
  ended_pending: 'bg-amber-100 text-amber-900',
  no_winner: 'bg-neutral-200 text-neutral-700',
  has_winners: 'bg-emerald-100 text-emerald-900',
}

const stateLabel = (s: GiveawayState): string => {
  switch (s.kind) {
    case 'in_progress':
      return 'in progress'
    case 'ended_pending':
      return 'ended'
    case 'no_winner':
      return 'no winner'
    case 'has_winners':
      return s.count === 1 ? '1 winner' : `${String(s.count)} winners`
  }
}

export function StatusBadge({ state }: { readonly state: GiveawayState }) {
  return (
    <span
      className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATE_STYLES[state.kind]}`}
    >
      {stateLabel(state)}
    </span>
  )
}

export const TargetBadge = ({ kind }: { readonly kind: 'app' | 'sub' }) =>
  kind === 'sub' ? (
    <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-900">
      sub
    </span>
  ) : null

export const GameCapsule = ({ target }: { readonly target: GiveawayView['target'] }) => {
  const [failed, setFailed] = useState(false)
  const src = steamAssetUrl(
    target.assetUrlFormat,
    smallCapsuleSmallSize(target.assetSmallCapsule),
    target.kind === 'app'
      ? { kind: 'app', id: target.appId, filename: 'capsule_184x69.jpg' }
      : { kind: 'sub', id: target.subId, filename: 'capsule_184x69.jpg' },
  )
  if (src === null || failed) {
    return <div aria-hidden className="h-10 w-26.5 flex-none" />
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => {
        setFailed(true)
      }}
      className="h-10 w-26.5 flex-none rounded object-cover"
    />
  )
}

export const CreatorLink = ({ creator }: { readonly creator: GiveawayCreatorSummary }) => (
  <Link
    to="/u/$username"
    params={{ username: creator.steamgiftsUsername }}
    className="text-blue-700 hover:underline"
  >
    {creator.steamgiftsUsername}
  </Link>
)
