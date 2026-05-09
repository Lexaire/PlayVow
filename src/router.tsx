import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

function DefaultErrorComponent() {
  return (
    <div className="mx-auto max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Please try again. If this keeps happening, let us know.
      </p>
    </div>
  )
}

function DefaultNotFoundComponent() {
  return (
    <div className="mx-auto max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
    </div>
  )
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Reuse loader data for 30s after a hover-preload fires so subsequent
    // navigations / re-hovers don't re-hit server fns.
    defaultPreloadStaleTime: 30_000,
    // Caught by every route lacking its own errorComponent. Without this, a
    // child loader failure renders TanStack's default UI which exposes the
    // raw Error.message via a "Show Error" button.
    defaultErrorComponent: DefaultErrorComponent,
    defaultNotFoundComponent: DefaultNotFoundComponent,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
