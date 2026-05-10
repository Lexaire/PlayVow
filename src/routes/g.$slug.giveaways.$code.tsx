import { createFileRoute, notFound } from '@tanstack/react-router'

import { GiveawayPageView } from '#/components/GiveawayPageView'
import { fetchGiveawayPage } from '#/server/publicFns'

export const Route = createFileRoute('/g/$slug/giveaways/$code')({
  loader: async ({ params }) => {
    const data = await fetchGiveawayPage({ data: { slug: params.slug, code: params.code } })
    if (!data) throw notFound()
    return data
  },
  component: GiveawayPage,
})

function GiveawayPage() {
  return <GiveawayPageView data={Route.useLoaderData()} />
}
