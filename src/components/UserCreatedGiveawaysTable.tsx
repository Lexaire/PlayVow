import { Link } from '@tanstack/react-router'

import { GameCapsule, giveawayState, StatusBadge, TargetBadge } from '#/components/giveaway-row'
import { LocalDate } from '#/components/LocalDate'
import type { UserCreatedGiveawayView } from '#/server/queries'

export function UserCreatedGiveawaysTable({
  giveaways,
}: {
  readonly giveaways: ReadonlyArray<UserCreatedGiveawayView>
}) {
  if (giveaways.length === 0) return null
  const now = new Date()
  return (
    <>
      <ul className="space-y-2 sm:hidden">
        {giveaways.map((g) => (
          <CreatedGiveawayCard key={g.id} giveaway={g} now={now} />
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded border border-neutral-200 bg-surface sm:block">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
            <tr>
              <th className="px-3 pt-0 pb-0.5">Game</th>
              <th className="px-3 pt-0 pb-0.5">Group</th>
              <th className="px-3 pt-0 pb-0.5">Qty</th>
              <th className="px-3 pt-0 pb-0.5">Posted</th>
              <th className="px-3 pt-0 pb-0.5">Ends</th>
              <th className="px-3 pt-0 pb-0.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 [&>tr:first-child>td]:pt-0.5 [&>tr:last-child>td]:pb-0.5">
            {giveaways.map((g) => (
              <tr key={g.id}>
                <td className="px-3 py-0">
                  <div className="flex items-center gap-2">
                    <GameCapsule target={g.target} />
                    <div>
                      <Link
                        to="/g/$slug/giveaways/$code"
                        params={{ slug: g.group.slug, code: g.steamgiftsCode }}
                        className="text-blue-700 hover:underline"
                      >
                        {g.target.name}
                      </Link>
                      <TargetBadge kind={g.target.kind} />
                    </div>
                  </div>
                </td>
                <td className="px-3 py-0">
                  <Link
                    to="/g/$slug/giveaways"
                    params={{ slug: g.group.slug }}
                    className="text-blue-700 hover:underline"
                  >
                    {g.group.name}
                  </Link>
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

function CreatedGiveawayCard({
  giveaway,
  now,
}: {
  readonly giveaway: UserCreatedGiveawayView
  readonly now: Date
}) {
  const g = giveaway
  return (
    <li className="rounded border border-neutral-200 bg-surface p-3">
      <div className="flex items-center gap-2">
        <GameCapsule target={g.target} />
        <div className="-mt-0.5 min-w-0 flex-1">
          <Link
            to="/g/$slug/giveaways/$code"
            params={{ slug: g.group.slug, code: g.steamgiftsCode }}
            className="line-clamp-2 text-blue-700 hover:underline"
          >
            {g.target.name}
          </Link>
          <TargetBadge kind={g.target.kind} />
        </div>
        <StatusBadge state={giveawayState(g, now)} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        {g.quantity > 1 && (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700">
            &times;{String(g.quantity)}
          </span>
        )}
        <span className="text-neutral-500">
          ends <LocalDate date={g.endedAt} />
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        <Link
          to="/g/$slug/giveaways"
          params={{ slug: g.group.slug }}
          className="text-blue-700 hover:underline"
        >
          {g.group.name}
        </Link>
        {' · '}
        posted <LocalDate date={g.startedAt} />
      </p>
    </li>
  )
}
