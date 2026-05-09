import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'

import {
  HowLongToBeatIcon,
  SteamGiftsIcon,
  SteamHuntersIcon,
  SteamIcon,
} from '#/components/BrandIcons'
import { LocalDate } from '#/components/LocalDate'
import { StatusPillEditor } from '#/components/StatusPillEditor'
import type { WinStatus } from '#/db/schema'
import { formatPlaytimeCompact, formatPlaytimePrecise } from '#/lib/playtime'
import { smallCapsuleSmallSize, steamAssetUrl } from '#/lib/steam-assets'
import type { GiveawayTargetView, WinUserSummary, WinView } from '#/server/queries'

const STATUS_STYLES: Readonly<Record<WinStatus, string>> = {
  pending: 'bg-amber-100 text-amber-900',
  played: 'bg-emerald-100 text-emerald-900',
  kicked: 'bg-rose-100 text-rose-900',
  not_in_group: 'bg-violet-100 text-violet-900',
  exempt: 'bg-sky-100 text-sky-900',
}

const STATUS_LABELS: Readonly<Record<WinStatus, string>> = {
  pending: 'pending',
  played: 'played',
  kicked: 'kicked',
  not_in_group: 'not in group',
  exempt: 'exempt',
}

export const renderAchievements = (
  win: WinView,
  { showAltLinks = false }: { readonly showAltLinks?: boolean } = {},
): ReactNode => {
  const total = win.achievementsTotal
  const unlocked = win.achievementsUnlocked
  if (total === null) return <span className="text-neutral-400">—</span>
  if (total === 0) return <span className="text-neutral-400">none</span>
  if (unlocked === null) return <span className="text-neutral-400">—</span>
  const allDone = unlocked === total
  const percent = Math.round((unlocked / total) * 100)
  const text = `${String(unlocked)}/${String(total)} (${String(percent)}%)`
  const canLink = win.user.steamId !== null && win.giveaway.target.kind === 'app'
  if (!canLink) {
    return <span className={allDone ? 'text-emerald-700' : ''}>{text}</span>
  }
  const appId = win.giveaway.target.kind === 'app' ? win.giveaway.target.appId : 0
  const steamHref = `https://steamcommunity.com/profiles/${win.user.steamId}/stats/${String(appId)}/achievements/`
  const steamLink = (
    <a
      href={steamHref}
      target="_blank"
      rel="noreferrer"
      className={`hover:underline ${allDone ? 'text-emerald-700' : 'text-blue-700'}`}
    >
      {text}
    </a>
  )
  if (!showAltLinks) return steamLink
  const gameName = win.giveaway.target.name
  const steamHuntersHref = `https://steamhunters.com/profiles/${win.user.steamId}/apps/${String(appId)}`
  const hltbHref = `https://howlongtobeat.com/?q=${encodeURIComponent(gameName)}`
  return (
    <span className="inline-flex items-center gap-1.5">
      {steamLink}
      <a
        href={steamHuntersHref}
        target="_blank"
        rel="noreferrer"
        title="Steam Hunters"
        aria-label={`Steam Hunters achievements for ${gameName}`}
        className="text-neutral-400 transition-colors hover:text-neutral-800"
      >
        <SteamHuntersIcon />
      </a>
      <a
        href={hltbHref}
        target="_blank"
        rel="noreferrer"
        title="How Long To Beat"
        aria-label={`How Long To Beat search for ${gameName}`}
        className="text-neutral-400 transition-colors hover:text-neutral-800"
      >
        <HowLongToBeatIcon />
      </a>
    </span>
  )
}

export const renderScreenshots = (win: WinView): ReactNode => {
  const count = win.screenshotCount
  if (count === null) return <span className="text-neutral-400">—</span>
  if (count === 0) return <span className="text-neutral-400">none</span>
  const text = `${String(count)}`
  const canLink = win.user.steamId !== null && win.giveaway.target.kind === 'app'
  if (!canLink) return <span>{text}</span>
  const appId = win.giveaway.target.kind === 'app' ? win.giveaway.target.appId : 0
  const href = `https://steamcommunity.com/profiles/${win.user.steamId}/screenshots/?appid=${String(appId)}`
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
      {text}
    </a>
  )
}

export const renderPlaytime = (win: WinView): ReactNode => {
  if (win.currentPlaytimeMinutes === null) return <span className="text-neutral-400">—</span>
  const totalPrecise = formatPlaytimePrecise(win.currentPlaytimeMinutes)
  const total = formatPlaytimeCompact(win.currentPlaytimeMinutes)
  const baseline = win.playtimeAtWinMinutes ?? 0
  const delta = win.currentPlaytimeMinutes - baseline
  if (delta <= 0) {
    return <span title={totalPrecise}>{total}</span>
  }
  return (
    <span>
      <span title={totalPrecise}>{total}</span>{' '}
      <span
        aria-label={`+${formatPlaytimeCompact(delta)} since first observed`}
        className="text-emerald-600"
        title={`+${formatPlaytimePrecise(delta)} since we first observed this win — not necessarily playtime since the actual win moment`}
      >
        ▴
      </span>
    </span>
  )
}

const TargetBadge = ({ kind }: { readonly kind: 'app' | 'sub' }) =>
  kind === 'sub' ? (
    <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-900">
      sub
    </span>
  ) : null

const GameCapsule = ({ target }: { readonly target: GiveawayTargetView }) => {
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

export const UserLink = ({ user }: { readonly user: WinUserSummary }) => (
  <span className="inline-flex items-center gap-1.5">
    <Link
      to="/u/$username"
      params={{ username: user.steamgiftsUsername }}
      className="text-blue-700 hover:underline"
    >
      {user.steamgiftsUsername}
    </Link>
    <a
      href={`https://www.steamgifts.com/user/${user.steamgiftsUsername}`}
      target="_blank"
      rel="noreferrer"
      title="SteamGifts profile"
      aria-label={`${user.steamgiftsUsername} on SteamGifts`}
      className="text-neutral-400 transition-colors hover:text-emerald-700"
    >
      <SteamGiftsIcon />
    </a>
    {user.steamId !== null ? (
      <a
        href={`https://steamcommunity.com/profiles/${user.steamId}`}
        target="_blank"
        rel="noreferrer"
        title="Steam profile"
        aria-label={`${user.steamgiftsUsername} on Steam`}
        className="text-neutral-400 transition-colors hover:text-blue-700"
      >
        <SteamIcon />
      </a>
    ) : null}
  </span>
)

export function StatusBadge({ status }: { readonly status: WinStatus }) {
  return (
    <span
      className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

export const winStatusLabel = (status: WinStatus): string => STATUS_LABELS[status]

export type WinsTableSelection = {
  readonly selectedIds: ReadonlySet<number>
  readonly onToggle: (winId: number) => void
  readonly onToggleAll: (winIds: ReadonlyArray<number>, select: boolean) => void
}

export function WinsTable({
  wins,
  showWinner = true,
  showGame = true,
  canEditStatus = false,
  canViewModWin = false,
  selection,
}: {
  readonly wins: ReadonlyArray<WinView>
  readonly showWinner?: boolean
  readonly showGame?: boolean
  readonly canEditStatus?: boolean
  readonly canViewModWin?: boolean
  readonly selection?: WinsTableSelection | undefined
}) {
  if (wins.length === 0) {
    return <p className="text-sm text-neutral-600">No wins.</p>
  }
  const visibleIds = wins.map((w) => w.id)
  const selectedHere = selection
    ? visibleIds.filter((id) => selection.selectedIds.has(id)).length
    : 0
  const allSelected = selection !== undefined && selectedHere === visibleIds.length
  const someSelected = selection !== undefined && selectedHere > 0 && !allSelected
  return (
    <>
      <ul className="space-y-2 sm:hidden">
        {selection ? (
          <li className="flex items-center gap-2 px-1 text-xs text-neutral-500">
            <input
              type="checkbox"
              aria-label={allSelected ? 'Deselect all on this page' : 'Select all on this page'}
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected
              }}
              onChange={(e) => {
                selection.onToggleAll(visibleIds, e.target.checked)
              }}
            />
            {allSelected ? 'Deselect all' : 'Select all'}
          </li>
        ) : null}
        {wins.map((w) => (
          <WinCard
            key={w.id}
            win={w}
            showGame={showGame}
            showWinner={showWinner}
            canEditStatus={canEditStatus}
            canViewModWin={canViewModWin}
            isSelected={selection?.selectedIds.has(w.id) ?? false}
            onToggle={selection?.onToggle}
          />
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded border border-neutral-200 bg-surface sm:block">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
            <tr>
              {selection ? (
                <th className="w-8 px-3 py-0">
                  <input
                    type="checkbox"
                    aria-label={
                      allSelected ? 'Deselect all on this page' : 'Select all on this page'
                    }
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected
                    }}
                    onChange={(e) => {
                      selection.onToggleAll(visibleIds, e.target.checked)
                    }}
                  />
                </th>
              ) : null}
              <th className="w-28 px-3 py-0">Status</th>
              {showGame ? <th className="px-3 py-0">Game</th> : null}
              {showWinner ? <th className="px-3 py-0">Winner</th> : null}
              <th className="whitespace-nowrap px-3 py-0">Won</th>
              <th className="whitespace-nowrap px-3 py-0">Deadline</th>
              <th className="px-3 py-0">Playtime</th>
              <th className="whitespace-nowrap px-3 py-0">Ach.</th>
              <th className="whitespace-nowrap px-3 py-0">Shots</th>
              {canViewModWin ? <th className="w-12 px-3 py-0">Mod</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {wins.map((w) => (
              <tr key={w.id} className={selection?.selectedIds.has(w.id) ? 'bg-blue-50' : ''}>
                {selection ? (
                  <td className="w-8 px-3 py-0">
                    <input
                      type="checkbox"
                      aria-label={`Select win ${String(w.id)}`}
                      checked={selection.selectedIds.has(w.id)}
                      onChange={() => {
                        selection.onToggle(w.id)
                      }}
                    />
                  </td>
                ) : null}
                <td className="w-28 px-3 py-0">
                  {canEditStatus ? (
                    <StatusPillEditor winId={w.id} status={w.status} />
                  ) : (
                    <StatusBadge status={w.status} />
                  )}
                </td>
                {showGame ? (
                  <td className="px-3 py-0">
                    <div className="flex items-center gap-2">
                      <GameCapsule target={w.giveaway.target} />
                      <div>
                        <Link
                          to="/g/$slug/giveaways/$code"
                          params={{ slug: w.giveaway.groupSlug, code: w.giveaway.steamgiftsCode }}
                          className="text-blue-700 hover:underline"
                        >
                          {w.giveaway.target.name}
                        </Link>
                        <TargetBadge kind={w.giveaway.target.kind} />
                      </div>
                    </div>
                  </td>
                ) : null}
                {showWinner ? (
                  <td className="px-3 py-0">
                    <UserLink user={w.user} />
                  </td>
                ) : null}
                <td className="whitespace-nowrap px-3 py-0 text-neutral-700">
                  <LocalDate date={w.wonAt} />
                </td>
                <td className="whitespace-nowrap px-3 py-0 text-neutral-700">
                  <LocalDate date={w.playDeadline} />
                </td>
                <td className="px-3 py-0 text-neutral-700">{renderPlaytime(w)}</td>
                <td className="whitespace-nowrap px-3 py-0 text-neutral-700">
                  {renderAchievements(w)}
                </td>
                <td className="whitespace-nowrap px-3 py-0 text-neutral-700">
                  {renderScreenshots(w)}
                </td>
                {canViewModWin ? (
                  <td className="w-12 whitespace-nowrap px-3 py-0">
                    <Link
                      to="/mod/wins/$winId"
                      params={{ winId: String(w.id) }}
                      className="text-blue-700 hover:underline"
                    >
                      view
                    </Link>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function WinCard({
  win,
  showGame,
  showWinner,
  canEditStatus,
  canViewModWin,
  isSelected,
  onToggle,
}: {
  readonly win: WinView
  readonly showGame: boolean
  readonly showWinner: boolean
  readonly canEditStatus: boolean
  readonly canViewModWin: boolean
  readonly isSelected: boolean
  readonly onToggle: ((winId: number) => void) | undefined
}) {
  const w = win
  return (
    <li
      className={`rounded border bg-surface p-3 ${isSelected ? 'border-blue-300 bg-blue-50' : 'border-neutral-200'}`}
    >
      <div className="flex items-center gap-2">
        {onToggle ? (
          <input
            type="checkbox"
            aria-label={`Select win ${String(w.id)}`}
            checked={isSelected}
            onChange={() => {
              onToggle(w.id)
            }}
          />
        ) : null}
        {showGame ? (
          <>
            <GameCapsule target={w.giveaway.target} />
            <div className="-mt-0.5 min-w-0 flex-1">
              <Link
                to="/g/$slug/giveaways/$code"
                params={{ slug: w.giveaway.groupSlug, code: w.giveaway.steamgiftsCode }}
                className="line-clamp-2 text-blue-700 hover:underline"
              >
                {w.giveaway.target.name}
              </Link>
              <TargetBadge kind={w.giveaway.target.kind} />
            </div>
          </>
        ) : null}
        <div className="flex-shrink-0">
          {canEditStatus ? (
            <StatusPillEditor winId={w.id} status={w.status} />
          ) : (
            <StatusBadge status={w.status} />
          )}
        </div>
      </div>
      <div
        className={`mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 ${onToggle ? 'ml-6' : ''}`}
      >
        {showWinner ? (
          <span className="text-xs">
            <UserLink user={w.user} />
          </span>
        ) : null}
        <span>
          won <LocalDate date={w.wonAt} />
        </span>
      </div>
      <div
        className={`mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 ${onToggle ? 'ml-6' : ''}`}
      >
        {w.status === 'pending' && (
          <span>
            deadline <LocalDate date={w.playDeadline} />
          </span>
        )}
        {renderPlaytime(w)}
        {renderAchievements(w)}
        {w.screenshotCount !== null && w.screenshotCount > 0 ? (
          <span>{renderScreenshots(w)} shots</span>
        ) : null}
        {canViewModWin ? (
          <Link
            to="/mod/wins/$winId"
            params={{ winId: String(w.id) }}
            className="text-blue-700 hover:underline"
          >
            view
          </Link>
        ) : null}
      </div>
    </li>
  )
}
