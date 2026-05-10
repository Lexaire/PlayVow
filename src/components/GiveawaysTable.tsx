import { Link } from '@tanstack/react-router'

import {
  CreatorLink,
  GameCapsule,
  giveawayState,
  StatusBadge,
  TargetBadge,
} from '#/components/giveaway-row'
import { LocalDate } from '#/components/LocalDate'
import type { GiveawayView } from '#/server/queries'

export function GiveawaysTable({
  giveaways,
  groupSlug,
}: {
  readonly giveaways: ReadonlyArray<GiveawayView>
  readonly groupSlug: string
}) {
  if (giveaways.length === 0) {
    return <p className="text-sm text-neutral-600">No giveaways yet.</p>
  }
  const now = new Date()
  return (
    <>
      <ul className="space-y-2 sm:hidden">
        {giveaways.map((g) => (
          <GiveawayCard key={g.id} giveaway={g} groupSlug={groupSlug} now={now} />
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded border border-neutral-200 bg-surface sm:block">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
            <tr>
              <th className="px-3 py-0">Game</th>
              <th className="px-3 py-0">Creator</th>
              <th className="px-3 py-0">Qty</th>
              <th className="px-3 py-0">Posted</th>
              <th className="px-3 py-0">Ends</th>
              <th className="px-3 py-0">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {giveaways.map((g) => (
              <tr key={g.id}>
                <td className="px-3 py-0">
                  <div className="flex items-center gap-2">
                    <GameCapsule target={g.target} />
                    <div>
                      {g.steamgiftsCode !== null ? (
                        <Link
                          to="/g/$slug/giveaways/$code"
                          params={{ slug: groupSlug, code: g.steamgiftsCode }}
                          className="text-blue-700 hover:underline"
                        >
                          {g.target.name}
                        </Link>
                      ) : (
                        <Link
                          to="/g/$slug/giveaways/by-id/$giveawayId"
                          params={{ slug: groupSlug, giveawayId: String(g.id) }}
                          className="text-blue-700 hover:underline"
                        >
                          {g.target.name}
                        </Link>
                      )}
                      <TargetBadge kind={g.target.kind} />
                    </div>
                  </div>
                </td>
                <td className="px-3 py-0">
                  <CreatorLink creator={g.creator} />
                </td>
                <td className="px-3 py-0 text-neutral-700">{String(g.quantity)}</td>
                <td className="px-3 py-0 text-neutral-700">
                  <LocalDate date={g.startedAt} />
                </td>
                <td className="px-3 py-0 text-neutral-700">
                  <LocalDate date={g.endedAt} />
                </td>
                <td className="px-3 py-0">
                  <StatusBadge state={giveawayState(g, now)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function GiveawayCard({
  giveaway,
  groupSlug,
  now,
}: {
  readonly giveaway: GiveawayView
  readonly groupSlug: string
  readonly now: Date
}) {
  const g = giveaway
  return (
    <li className="rounded border border-neutral-200 bg-surface p-3">
      <div className="flex items-center gap-2">
        <GameCapsule target={g.target} />
        <div className="-mt-0.5 min-w-0 flex-1">
          {g.steamgiftsCode !== null ? (
            <Link
              to="/g/$slug/giveaways/$code"
              params={{ slug: groupSlug, code: g.steamgiftsCode }}
              className="line-clamp-2 text-blue-700 hover:underline"
            >
              {g.target.name}
            </Link>
          ) : (
            <Link
              to="/g/$slug/giveaways/by-id/$giveawayId"
              params={{ slug: groupSlug, giveawayId: String(g.id) }}
              className="line-clamp-2 text-blue-700 hover:underline"
            >
              {g.target.name}
            </Link>
          )}
          <TargetBadge kind={g.target.kind} />
        </div>
        <StatusBadge state={giveawayState(g, now)} />
      </div>
      <p className="mt-1.5 text-xs text-neutral-500">
        by <CreatorLink creator={g.creator} /> on <LocalDate date={g.startedAt} />
        {g.quantity > 1 && (
          <>
            {' '}
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-700">
              &times;{String(g.quantity)}
            </span>
          </>
        )}{' '}
        <span className="whitespace-nowrap">
          ends <LocalDate date={g.endedAt} />
        </span>
      </p>
    </li>
  )
}
