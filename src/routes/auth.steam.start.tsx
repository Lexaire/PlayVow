import { createFileRoute } from '@tanstack/react-router'

import { startSteamLogin } from '#/server/authFns'

export const Route = createFileRoute('/auth/steam/start')({
  loader: async () => {
    await startSteamLogin()
  },
  component: () => null,
})
