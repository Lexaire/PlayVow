import { createFileRoute, redirect } from '@tanstack/react-router'

// Old route. Wins now live in the merged activity feed at /g/$slug.
export const Route = createFileRoute('/g/$slug/wins')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/g/$slug', params: { slug: params.slug }, search: {} })
  },
})
