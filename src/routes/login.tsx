import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

import { fetchModSession } from '#/server/modFns'

const SearchSchema = z.object({
  error: z.string().optional(),
})

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => SearchSchema.parse(search),
  beforeLoad: async () => {
    const { user } = await fetchModSession()
    if (user !== null) throw redirect({ to: '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const search = Route.useSearch()
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-2xl font-bold">Sign in</h1>
      {search.error ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Steam sign-in failed: {search.error}
        </p>
      ) : null}
      <a
        href="/auth/steam/start"
        className="flex w-full items-center justify-center gap-2 rounded bg-[#171a21] px-4 py-2 text-sm font-medium text-white hover:bg-[#2a3540] dark:bg-[#2a3540] dark:hover:bg-[#3d4d5c]"
      >
        Sign in through Steam
      </a>
    </div>
  )
}
