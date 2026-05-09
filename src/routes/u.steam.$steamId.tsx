import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

import { fetchUsernameBySteamId } from '#/server/publicFns'

export const Route = createFileRoute('/u/steam/$steamId')({
  loader: async ({ params }) => {
    const username = await fetchUsernameBySteamId({ data: { steamId: params.steamId } })
    if (!username) throw notFound()
    throw redirect({ to: '/u/$username', params: { username } })
  },
})
