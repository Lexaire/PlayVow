import { Link, createFileRoute, notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'

import { SteamIcon } from '#/components/BrandIcons'
import { StatusPillEditor } from '#/components/StatusPillEditor'

const CameraIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
)
import { Pagination } from '#/components/Pagination'
import { renderAchievements } from '#/components/WinsTable'
import { formatPlaytimeCompact, formatPlaytimePrecise } from '#/lib/playtime'
import { isMod } from '#/domain/roles'
import { fetchModGroupPage, fetchModSession } from '#/server/modFns'

// Mod views pin to UTC for moderator consistency. Listing cells stay
// label-free for visual density; the per-win detail page shows the TZ.
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
})

// Filter and page in the URL so links are bookmarkable and "page 2 of pending"
// is a real shareable state (not lost client-side state).
const SearchSchema = z.object({
  filter: z.enum(['all', 'pending']).optional(),
  page: z.coerce.number().int().min(1).optional(),
})

export const Route = createFileRoute('/mod/g/$slug')({
  validateSearch: SearchSchema,
  beforeLoad: async () => {
    const { user } = await fetchModSession()
    if (!isMod(user)) throw redirect({ to: '/login' })
  },
  loaderDeps: ({ search }) => ({
    filter: search.filter ?? 'all',
    page: search.page ?? 1,
  }),
  loader: async ({ params, deps }) => {
    const data = await fetchModGroupPage({
      data: { slug: params.slug, filter: deps.filter, page: deps.page },
    })
    if (!data) throw notFound()
    return data
  },
  component: ModGroupPage,
})

function ModGroupPage() {
  const { group, wins, filter, inGroupSteamIds } = Route.useLoaderData()
  const inGroupSet = new Set(inGroupSteamIds)
  const now = Date.now()
  const emptyMessage = filter === 'pending' ? 'No pending wins.' : 'No wins.'

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link to="/mod" className="text-sm text-blue-700 hover:underline">
          &larr; All groups
        </Link>
        <h1 className="text-2xl font-bold">{group.name}</h1>
        <div className="flex items-center gap-3">
          <p className="text-sm text-neutral-600">All wins for this group</p>
          <Link
            to="/mod/g/$slug"
            params={{ slug: group.slug }}
            search={filter === 'all' ? { filter: 'pending' } : {}}
            className="rounded border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-100"
          >
            {filter === 'all' ? 'Show pending only' : 'Show all'}
          </Link>
        </div>
      </header>
      {wins.rows.length === 0 ? (
        <p className="text-sm text-neutral-600">{emptyMessage}</p>
      ) : (
        <>
          <ul className="space-y-2 sm:hidden">
            {wins.rows.map((w) => (
              <ModWinCard key={w.id} w={w} now={now} inGroupSteamIds={inGroupSet} />
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded border border-neutral-200 bg-surface sm:block">
            <table className="min-w-full divide-y divide-neutral-200 text-sm">
              <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
                <tr>
                  <th className="px-3 py-2">Winner</th>
                  <th className="px-3 py-2">Game</th>
                  <th className="whitespace-nowrap px-3 py-2">Deadline</th>
                  <th className="px-3 py-2">Playtime</th>
                  <th className="w-28 whitespace-nowrap px-3 py-2">Status</th>
                  <th className="w-8 px-2 py-2" title="Screenshots">
                    <span className="inline-flex" aria-label="Screenshots">
                      <CameraIcon />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {wins.rows.map((w) => (
                  <ModWinRow key={w.id} w={w} now={now} inGroupSteamIds={inGroupSet} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Pagination
        page={wins.page}
        pageSize={wins.pageSize}
        total={wins.total}
        hrefForPage={(p) =>
          ({
            to: '/mod/g/$slug',
            params: { slug: group.slug },
            search: {
              ...(filter === 'pending' ? { filter: 'pending' as const } : {}),
              ...(p === 1 ? {} : { page: p }),
            },
          }) as const
        }
      />
    </div>
  )
}

type ModWinRow =
  ReturnType<typeof fetchModGroupPage> extends Promise<infer T>
    ? T extends { wins: { rows: ReadonlyArray<infer R> } }
      ? R
      : never
    : never

function ModWinCard({
  w,
  now,
  inGroupSteamIds,
}: {
  readonly w: ModWinRow
  readonly now: number
  readonly inGroupSteamIds: ReadonlySet<string>
}) {
  const daysLeft = Math.floor((w.playDeadline.getTime() - now) / (1000 * 60 * 60 * 24))
  const isOverdue = daysLeft < 0
  const showDeadline = w.status === 'pending'
  return (
    <li className="rounded border border-neutral-200 bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <Link
          to="/mod/wins/$winId"
          params={{ winId: String(w.id) }}
          className="text-blue-700 hover:underline"
        >
          {w.giveaway.target.name}
        </Link>
        <StatusPillEditor winId={w.id} status={w.status} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
        <Link
          to="/u/$username"
          params={{ username: w.user.steamgiftsUsername }}
          className="text-blue-700 hover:underline"
        >
          {w.user.steamgiftsUsername}
        </Link>
        <MembershipDot steamId={w.user.steamId} inGroupSteamIds={inGroupSteamIds} />
        {w.user.steamId ? (
          <a
            href={`https://steamcommunity.com/profiles/${w.user.steamId}/groupscommon/`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Groups in common with ${w.user.steamgiftsUsername}`}
            title="Groups in common"
            className="text-neutral-500 hover:text-neutral-800"
          >
            <SteamIcon />
          </a>
        ) : null}
        <span className="text-neutral-400">won {dateFormat.format(w.wonAt)}</span>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        by{' '}
        <Link
          to="/u/$username"
          params={{ username: w.giveaway.creator.steamgiftsUsername }}
          className="hover:text-blue-700 hover:underline"
        >
          {w.giveaway.creator.steamgiftsUsername}
        </Link>
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
        {showDeadline && (
          <span>
            deadline {dateFormat.format(w.playDeadline)}
            <span className={`ml-1 ${isOverdue ? 'text-rose-700' : 'text-neutral-500'}`}>
              ({isOverdue ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`})
            </span>
          </span>
        )}
        {w.currentPlaytimeMinutes !== null ? (
          <span title={formatPlaytimePrecise(w.currentPlaytimeMinutes)}>
            {formatPlaytimeCompact(w.currentPlaytimeMinutes)}
          </span>
        ) : (
          <span>—</span>
        )}
        {renderAchievements(w, { showAltLinks: true })}
        {w.user.steamId && w.giveaway.target.kind === 'app' ? (
          <a
            href={`https://steamcommunity.com/profiles/${w.user.steamId}/screenshots/?appid=${w.giveaway.target.appId}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`${w.user.steamgiftsUsername}'s screenshots for ${w.giveaway.target.name}`}
            title="Steam screenshots"
            className="text-neutral-500 hover:text-neutral-800"
          >
            <CameraIcon />
          </a>
        ) : null}
      </div>
    </li>
  )
}

function ModWinRow({
  w,
  now,
  inGroupSteamIds,
}: {
  readonly w: ModWinRow
  readonly now: number
  readonly inGroupSteamIds: ReadonlySet<string>
}) {
  const daysLeft = Math.floor((w.playDeadline.getTime() - now) / (1000 * 60 * 60 * 24))
  const isOverdue = daysLeft < 0
  return (
    <tr>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Link
            to="/u/$username"
            params={{ username: w.user.steamgiftsUsername }}
            className="text-blue-700 hover:underline"
          >
            {w.user.steamgiftsUsername}
          </Link>
          <MembershipDot steamId={w.user.steamId} inGroupSteamIds={inGroupSteamIds} />
          {w.user.steamId ? (
            <a
              href={`https://steamcommunity.com/profiles/${w.user.steamId}/groupscommon/`}
              target="_blank"
              rel="noreferrer"
              aria-label={`Groups in common with ${w.user.steamgiftsUsername}`}
              title="Groups in common"
              className="text-neutral-500 hover:text-neutral-800"
            >
              <SteamIcon />
            </a>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="leading-tight">
          <div>
            <Link
              to="/mod/wins/$winId"
              params={{ winId: String(w.id) }}
              className="text-blue-700 hover:underline"
            >
              {w.giveaway.target.name}
            </Link>
          </div>
          <div className="text-xs text-neutral-500">
            by{' '}
            <Link
              to="/u/$username"
              params={{ username: w.giveaway.creator.steamgiftsUsername }}
              title={w.giveaway.creator.steamgiftsUsername}
              className="hover:text-blue-700 hover:underline"
            >
              {w.giveaway.creator.steamgiftsUsername}
            </Link>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-neutral-700">
        <div className="leading-tight">
          <div>
            {dateFormat.format(w.playDeadline)}
            {w.status === 'pending' ? (
              <span
                className={`ml-1.5 text-xs ${isOverdue ? 'text-rose-700' : 'text-neutral-500'}`}
              >
                ({isOverdue ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`})
              </span>
            ) : null}
          </div>
          <div className="text-xs text-neutral-500">won {dateFormat.format(w.wonAt)}</div>
        </div>
      </td>
      <td className="px-3 py-2 text-neutral-700">
        <div className="leading-tight">
          <div>
            {w.currentPlaytimeMinutes !== null ? (
              <span title={formatPlaytimePrecise(w.currentPlaytimeMinutes)}>
                {formatPlaytimeCompact(w.currentPlaytimeMinutes)}
              </span>
            ) : (
              '—'
            )}
          </div>
          <div className="text-xs">{renderAchievements(w, { showAltLinks: true })}</div>
        </div>
      </td>
      <td className="w-28 whitespace-nowrap px-3 py-2">
        <StatusPillEditor winId={w.id} status={w.status} />
      </td>
      <td className="w-8 px-2 py-2">
        {w.user.steamId && w.giveaway.target.kind === 'app' ? (
          <a
            href={`https://steamcommunity.com/profiles/${w.user.steamId}/screenshots/?appid=${w.giveaway.target.appId}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`${w.user.steamgiftsUsername}'s screenshots for ${w.giveaway.target.name}`}
            title="Steam screenshots"
            className="text-neutral-500 hover:text-neutral-800"
          >
            <SteamIcon />
          </a>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </td>
    </tr>
  )
}

function MembershipDot({
  steamId,
  inGroupSteamIds,
}: {
  readonly steamId: string | null
  readonly inGroupSteamIds: ReadonlySet<string>
}) {
  if (!steamId) return null
  const inGroup = inGroupSteamIds.has(steamId)
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${inGroup ? 'bg-emerald-500' : 'bg-rose-500'}`}
      title={inGroup ? 'In group' : 'Not in group'}
      aria-label={inGroup ? 'In group' : 'Not in group'}
    />
  )
}
