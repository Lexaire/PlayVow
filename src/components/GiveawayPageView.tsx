import { Link, getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'

import { DeleteManualGiveawayButton } from '#/components/admin/DeleteManualGiveawayButton'
import { EditManualGiveawayDatesButton } from '#/components/admin/EditManualGiveawayDatesButton'
import { SteamGiftsIcon, SteamIcon } from '#/components/BrandIcons'
import { CreatorLink } from '#/components/giveaway-row'
import { LocalDate } from '#/components/LocalDate'
import { WinsTable } from '#/components/WinsTable'
import { isAdmin, isModForGroup } from '#/domain/roles'
import { steamAssetUrl } from '#/lib/steam-assets'
import type { GiveawayPageData } from '#/server/queries'

const rootApi = getRouteApi('__root__')

export function GiveawayPageView({ data }: { readonly data: GiveawayPageData }) {
  const { group, giveaway, wins, commonByWinId } = data
  const commonMap = new Map(commonByWinId)
  const { currentUser, moderatedGroupIds } = rootApi.useLoaderData()
  const moderatedSet = new Set(moderatedGroupIds)
  // Per-row mod-link predicate (admin → always; otherwise only this
  // viewer's moderated groups). The view is single-group so we can
  // pre-bind the groupId.
  const canModerateThisGroup = isModForGroup(currentUser, group.id, moderatedSet)
  const canViewModWin = (_groupId: number) => canModerateThisGroup
  // Soft delete is admin-only and only meaningful for manual giveaways
  // (SG-scraped ones would just come back on the next scrape).
  const canDelete = isAdmin(currentUser ?? null) && group.source === 'manual'
  // Date edits are scoped to group moderators on manual giveaways — same
  // gate as the create flow, so anyone who can record a manual giveaway
  // can also fix its dates afterward.
  const canEditDates = canModerateThisGroup && group.source === 'manual'
  const [capsuleFailed, setCapsuleFailed] = useState(false)
  const hasEnded = giveaway.endedAt.getTime() <= Date.now()
  // Manual giveaways have no SteamGifts presence, so the SG link is
  // suppressed entirely. The Steam Store + similar-giveaways links work the
  // same regardless of source.
  const sgUrl =
    giveaway.steamgiftsCode !== null
      ? `https://www.steamgifts.com/giveaway/${giveaway.steamgiftsCode}/`
      : null
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
        <div className="flex items-start justify-between gap-3">
          <Link
            to="/g/$slug"
            params={{ slug: group.slug }}
            className="text-sm text-blue-700 hover:underline"
          >
            ← {group.name}
          </Link>
          <div className="flex items-start gap-2">
            {canEditDates && (
              <EditManualGiveawayDatesButton
                giveawayId={giveaway.id}
                startedAt={giveaway.startedAt}
                endedAt={giveaway.endedAt}
              />
            )}
            {canDelete && (
              <DeleteManualGiveawayButton
                giveawayId={giveaway.id}
                groupSlug={group.slug}
                itemName={giveaway.target.name}
              />
            )}
          </div>
        </div>
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
        <div className="flex flex-wrap gap-3 text-sm">
          {sgUrl !== null && (
            <a
              href={sgUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-blue-700 hover:underline"
            >
              <SteamGiftsIcon />
              SteamGifts ↗
            </a>
          )}
          <a
            href={steamUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-blue-700 hover:underline"
          >
            <SteamIcon />
            Steam Store ↗
          </a>
          {giveaway.target.kind === 'app' ? (
            <Link
              to="/app/$appId"
              params={{ appId: String(giveaway.target.appId) }}
              className="text-blue-700 hover:underline"
            >
              Similar giveaways
            </Link>
          ) : (
            <Link
              to="/sub/$subId"
              params={{ subId: String(giveaway.target.subId) }}
              className="text-blue-700 hover:underline"
            >
              Similar giveaways
            </Link>
          )}
        </div>
      </header>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Winners</h2>
        {hasEnded ? (
          <WinsTable
            wins={wins}
            showGame={false}
            canViewModWin={canViewModWin}
            commonByWinId={commonMap}
          />
        ) : (
          <p className="text-sm text-neutral-600">
            Winners will be drawn when this giveaway ends on <LocalDate date={giveaway.endedAt} />.
          </p>
        )}
      </section>
    </div>
  )
}
