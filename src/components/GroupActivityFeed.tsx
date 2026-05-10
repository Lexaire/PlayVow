import { Link } from '@tanstack/react-router'

import { GameCapsule, TargetBadge } from '#/components/giveaway-row'
import { LocalDate } from '#/components/LocalDate'
import {
  StatusBadge as WinStatusBadge,
  UserLink,
  renderAchievements,
  renderPlaytime,
} from '#/components/WinsTable'
import type { ActivityFeedRow, GiveawayView, WinView } from '#/server/queries'

export function GroupActivityFeed({
  rows,
  groupSlug,
}: {
  readonly rows: ReadonlyArray<ActivityFeedRow>
  readonly groupSlug: string
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-neutral-600">No activity yet.</p>
  }
  return (
    <>
      <ul className="space-y-2 sm:hidden">
        {rows.map((row) =>
          row.kind === 'win' ? (
            <WinCard key={`w-${String(row.win.id)}`} win={row.win} />
          ) : (
            <NoWinnerCard
              key={`g-${String(row.giveaway.id)}`}
              giveaway={row.giveaway}
              groupSlug={groupSlug}
              effectiveAt={row.effectiveAt}
            />
          ),
        )}
      </ul>
      <div className="hidden overflow-x-auto rounded border border-neutral-200 bg-surface sm:block">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
            <tr>
              <th className="w-28 px-3 py-0">Status</th>
              <th className="px-3 py-0">Game</th>
              <th className="px-3 py-0">Winner</th>
              <th className="whitespace-nowrap px-3 py-0">Date</th>
              <th className="whitespace-nowrap px-3 py-0">Deadline</th>
              <th className="px-3 py-0">Playtime</th>
              <th className="whitespace-nowrap px-3 py-0">Ach.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {rows.map((row) =>
              row.kind === 'win' ? (
                <WinRow key={`w-${String(row.win.id)}`} win={row.win} />
              ) : (
                <NoWinnerRow
                  key={`g-${String(row.giveaway.id)}`}
                  giveaway={row.giveaway}
                  groupSlug={groupSlug}
                  effectiveAt={row.effectiveAt}
                />
              ),
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ---- Mobile cards ---- */

function WinCard({ win }: { readonly win: WinView }) {
  const showDeadline = win.status === 'pending'
  return (
    <li className="rounded border border-neutral-200 bg-surface p-3">
      <div className="flex items-center gap-2">
        <GameCapsule target={win.giveaway.target} />
        <div className="-mt-0.5 min-w-0 flex-1">
          {win.giveaway.steamgiftsCode !== null ? (
            <Link
              to="/g/$slug/giveaways/$code"
              params={{ slug: win.giveaway.groupSlug, code: win.giveaway.steamgiftsCode }}
              className="line-clamp-2 text-blue-700 hover:underline"
            >
              {win.giveaway.target.name}
            </Link>
          ) : (
            <Link
              to="/g/$slug/giveaways/by-id/$giveawayId"
              params={{
                slug: win.giveaway.groupSlug,
                giveawayId: String(win.giveaway.id),
              }}
              className="line-clamp-2 text-blue-700 hover:underline"
            >
              {win.giveaway.target.name}
            </Link>
          )}
          <TargetBadge kind={win.giveaway.target.kind} />
        </div>
        <WinStatusBadge status={win.status} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-neutral-500">
          <UserLink user={win.user} />
        </span>
        <span className="text-xs text-neutral-500">
          <LocalDate date={win.wonAt} />
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {renderPlaytime(win)}
        {' · '}
        {renderAchievements(win)}
        {showDeadline && (
          <>
            {' · '}
            deadline <LocalDate date={win.playDeadline} />
          </>
        )}
      </p>
    </li>
  )
}

function NoWinnerCard({
  giveaway,
  groupSlug,
  effectiveAt,
}: {
  readonly giveaway: GiveawayView
  readonly groupSlug: string
  readonly effectiveAt: Date
}) {
  return (
    <li className="rounded border border-neutral-200 bg-surface p-3">
      <div className="flex items-center gap-2">
        <GameCapsule target={giveaway.target} />
        <div className="-mt-0.5 min-w-0 flex-1">
          {giveaway.steamgiftsCode !== null ? (
            <Link
              to="/g/$slug/giveaways/$code"
              params={{ slug: groupSlug, code: giveaway.steamgiftsCode }}
              className="line-clamp-2 text-blue-700 hover:underline"
            >
              {giveaway.target.name}
            </Link>
          ) : (
            <Link
              to="/g/$slug/giveaways/by-id/$giveawayId"
              params={{ slug: groupSlug, giveawayId: String(giveaway.id) }}
              className="line-clamp-2 text-blue-700 hover:underline"
            >
              {giveaway.target.name}
            </Link>
          )}
          <TargetBadge kind={giveaway.target.kind} />
        </div>
        <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700">
          no winners
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-neutral-500">
          <LocalDate date={effectiveAt} />
        </span>
        <span className="text-xs text-neutral-500">
          <LocalDate date={effectiveAt} />
        </span>
      </div>
    </li>
  )
}

/* ---- Desktop table rows ---- */

function WinRow({ win }: { readonly win: WinView }) {
  return (
    <tr>
      <td className="w-28 px-3 py-0">
        <WinStatusBadge status={win.status} />
      </td>
      <td className="px-3 py-0">
        <GameCell
          target={win.giveaway.target}
          slug={win.giveaway.groupSlug}
          code={win.giveaway.steamgiftsCode}
          giveawayId={win.giveaway.id}
        />
      </td>
      <td className="px-3 py-0">
        <UserLink user={win.user} />
      </td>
      <td className="whitespace-nowrap px-3 py-0 text-neutral-700">
        <LocalDate date={win.wonAt} />
      </td>
      <td className="whitespace-nowrap px-3 py-0 text-neutral-700">
        <LocalDate date={win.playDeadline} />
      </td>
      <td className="px-3 py-0 text-neutral-700">{renderPlaytime(win)}</td>
      <td className="whitespace-nowrap px-3 py-0 text-neutral-700">{renderAchievements(win)}</td>
    </tr>
  )
}

function NoWinnerRow({
  giveaway,
  groupSlug,
  effectiveAt,
}: {
  readonly giveaway: GiveawayView
  readonly groupSlug: string
  readonly effectiveAt: Date
}) {
  return (
    <tr>
      <td className="w-28 px-3 py-0">
        <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700">
          no winners
        </span>
      </td>
      <td className="px-3 py-0">
        <GameCell
          target={giveaway.target}
          slug={groupSlug}
          code={giveaway.steamgiftsCode}
          giveawayId={giveaway.id}
        />
      </td>
      <td className="px-3 py-0 text-neutral-400">—</td>
      <td className="whitespace-nowrap px-3 py-0 text-neutral-700">
        <LocalDate date={effectiveAt} />
      </td>
      <td className="whitespace-nowrap px-3 py-0 text-neutral-400">—</td>
      <td className="px-3 py-0 text-neutral-400">—</td>
      <td className="whitespace-nowrap px-3 py-0 text-neutral-400">—</td>
    </tr>
  )
}

function GameCell({
  target,
  slug,
  code,
  giveawayId,
}: {
  readonly target: WinView['giveaway']['target']
  readonly slug: string
  readonly code: string | null
  readonly giveawayId: number
}) {
  return (
    <div className="flex items-center gap-2">
      <GameCapsule target={target} />
      <div>
        {code !== null ? (
          <Link
            to="/g/$slug/giveaways/$code"
            params={{ slug, code }}
            className="text-blue-700 hover:underline"
          >
            {target.name}
          </Link>
        ) : (
          <Link
            to="/g/$slug/giveaways/by-id/$giveawayId"
            params={{ slug, giveawayId: String(giveawayId) }}
            className="text-blue-700 hover:underline"
          >
            {target.name}
          </Link>
        )}
        <TargetBadge kind={target.kind} />
      </div>
    </div>
  )
}
