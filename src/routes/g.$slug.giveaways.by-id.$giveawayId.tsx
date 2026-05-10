import { createFileRoute, notFound } from '@tanstack/react-router'

import { GiveawayPageView } from '#/components/GiveawayPageView'
import { fetchGiveawayPageById } from '#/server/publicFns'

// Manual giveaways have no SteamGifts code, so this route addresses them by
// internal id. SG-scraped giveaways still use /g/$slug/giveaways/$code; both
// routes render the same view via GiveawayPageView.
export const Route = createFileRoute('/g/$slug/giveaways/by-id/$giveawayId')({
  loader: async ({ params }) => {
    const data = await fetchGiveawayPageById({
      data: { slug: params.slug, giveawayId: Number(params.giveawayId) },
    })
    if (!data) throw notFound()
    return data
  },
  component: GiveawayPage,
})

function GiveawayPage() {
  return <GiveawayPageView data={Route.useLoaderData()} />
}
