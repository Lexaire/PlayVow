import { Link, createFileRoute, getRouteApi, notFound } from '@tanstack/react-router'
import { useState } from 'react'

import { SteamGiftsIcon, SteamIcon } from '#/components/BrandIcons'
import { CreatorLink } from '#/components/giveaway-row'
import { LocalDate } from '#/components/LocalDate'
import { WinsTable } from '#/components/WinsTable'
import { isMod } from '#/domain/roles'
import { steamAssetUrl } from '#/lib/steam-assets'
import { fetchGiveawayPage } from '#/server/publicFns'

const rootApi = getRouteApi('__root__')

export const Route = createFileRoute('/g/$slug/giveaways/$code')({
  loader: async ({ params }) => {
    const data = await fetchGiveawayPage({ data: { slug: params.slug, code: params.code } })
    if (!data) throw notFound()
    return data
  },
  component: GiveawayPage,
})

function GiveawayPage() {
  const { group, giveaway, wins } = Route.useLoaderData()
  const { currentUser } = rootApi.useLoaderData()
  const userIsMod = isMod(currentUser)
  const [capsuleFailed, setCapsuleFailed] = useState(false)
  const hasEnded = giveaway.endedAt.getTime() <= Date.now()
  const sgUrl = `https://www.steamgifts.com/giveaway/${giveaway.steamgiftsCode}/`
  const steamUrl =
    giveaway.target.kind === 'app'
      ? `https://store.steampowered.com/app/${String(giveaway.target.appId)}/`
      : `https://store.steampowered.com/sub/${String(giveaway.target.subId)}/`
  const capsuleUrl = steamAssetUrl(
    giveaway.target.assetUrlFormat,
    giveaway.target.assetMainCapsule,
    giveaway.target.kind === 'app'
      ? { kind: 'app', id: giveaway.target.appId, filename: 'capsule_616x353.jpg' }
      : { kind: 'sub', id: giveaway.target.subId, filename: 'capsule_616x353.jpg' },
  )
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          to="/g/$slug"
          params={{ slug: group.slug }}
          className="text-sm text-blue-700 hover:underline"
        >
          ← {group.name}
        </Link>
        {capsuleUrl && !capsuleFailed ? (
          <img
            src={capsuleUrl}
            alt={giveaway.target.name}
            width={616}
            height={353}
            onError={() => setCapsuleFailed(true)}
            className="h-auto w-full max-w-123 rounded"
          />
        ) : null}
        <h1 className="text-2xl font-bold">{giveaway.target.name}</h1>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-neutral-500">Quantity</dt>
          <dd>{giveaway.quantity}</dd>
          <dt className="text-neutral-500">Started</dt>
          <dd>
            <LocalDate date={giveaway.startedAt} />
          </dd>
          <dt className="text-neutral-500">{hasEnded ? 'Ended' : 'Ends'}</dt>
          <dd>
            <LocalDate date={giveaway.endedAt} />
          </dd>
          <dt className="text-neutral-500">Creator</dt>
          <dd>
            <CreatorLink creator={giveaway.creator} />
          </dd>
          <dt className="text-neutral-500">Winners</dt>
          <dd>{hasEnded ? wins.length : '—'}</dd>
        </dl>
        <div className="flex gap-3 text-sm">
          <a
            href={sgUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-blue-700 hover:underline"
          >
            <SteamGiftsIcon />
            SteamGifts ↗
          </a>
          <a
            href={steamUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-blue-700 hover:underline"
          >
            <SteamIcon />
            Steam Store ↗
          </a>
        </div>
      </header>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Winners</h2>
        {hasEnded ? (
          <WinsTable wins={wins} showGame={false} canViewModWin={userIsMod} />
        ) : (
          <p className="text-sm text-neutral-600">
            Winners will be drawn when this giveaway ends on <LocalDate date={giveaway.endedAt} />.
          </p>
        )}
      </section>
    </div>
  )
}
