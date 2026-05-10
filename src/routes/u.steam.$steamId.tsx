import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

import { WinsTable } from '#/components/WinsTable'
import { fetchSteamUserPage, fetchUsernameBySteamId } from '#/server/publicFns'

export const Route = createFileRoute('/u/steam/$steamId')({
  loader: async ({ params }) => {
    // SG-linked users have a richer page at /u/$username — keep the steam
    // URL as a stable shareable handle that bounces to the canonical one.
    const username = await fetchUsernameBySteamId({ data: { steamId: params.steamId } })
    if (username) {
      throw redirect({ to: '/u/$username', params: { username } })
    }
    // Steam-only users (manual-giveaway winners, admin-synced users) live
    // here with a simpler page — no created-giveaways tab since they can't
    // create giveaways without an SG account.
    const data = await fetchSteamUserPage({ data: { steamId: params.steamId } })
    if (!data) throw notFound()
    return data
  },
  component: SteamUserPage,
})

function SteamUserPage() {
  const { user, wins, groupMemberships, commonByWinId } = Route.useLoaderData()
  const commonMap = new Map(commonByWinId)
  // user.personaName is what the Steam Community profile reports as the
  // live display name; fall back to a synthesized stub if a sync hasn't
  // populated it yet (legacy rows from before persona_name existed).
  const displayName = user.personaName ?? `Steam ${user.steamId?.slice(-6) ?? '?'}`

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="h-12 w-12 rounded border border-neutral-200"
          />
        ) : null}
        <div className="flex-1 space-y-1">
          <h1 className="text-2xl font-bold">{displayName}</h1>
          <p className="text-xs text-neutral-500">
            Steam ID {user.steamId ?? '—'} · {wins.length}{' '}
            {wins.length === 1 ? 'win' : 'wins'}
          </p>
          {groupMemberships.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
              {groupMemberships.map((m) => (
                <span key={m.groupSlug}>{m.groupName}</span>
              ))}
            </div>
          ) : null}
          <div className="flex gap-3 text-sm">
            {user.steamId ? (
              <a
                href={`https://steamcommunity.com/profiles/${user.steamId}`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 hover:underline"
              >
                Steam ↗
              </a>
            ) : null}
          </div>
        </div>
      </header>
      {wins.length === 0 ? (
        <p className="text-sm text-neutral-600">No wins yet.</p>
      ) : (
        <WinsTable wins={wins} showWinner={false} commonByWinId={commonMap} />
      )}
    </div>
  )
}
