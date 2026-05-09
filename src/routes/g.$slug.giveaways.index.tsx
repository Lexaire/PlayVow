import { createFileRoute, redirect } from '@tanstack/react-router'

// Old route. The giveaways and wins lists were merged into a single
// chronological view at /g/$slug; both legacy URLs land users there.
export const Route = createFileRoute('/g/$slug/giveaways/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/g/$slug', params: { slug: params.slug }, search: {} })
  },
})
