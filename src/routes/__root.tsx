import { HeadContent, Outlet, Scripts, createRootRoute, useParams } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import { AppLayout } from '#/components/Layout'
import { PostHogTracker } from '#/components/PostHogTracker'
import { themeBootstrapScript } from '#/lib/theme'
import { fetchGroupSummaries } from '#/server/publicFns'
import { fetchModSession } from '#/server/modFns'
import appCss from '#/styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'PlayVow' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/logo32.png' },
      { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/logo192.png' },
      { rel: 'apple-touch-icon', href: '/logo192.png' },
    ],
  }),
  loader: async () => {
    const [groups, session] = await Promise.all([fetchGroupSummaries(), fetchModSession()])
    return {
      groups,
      currentUser: session.user,
      // Group ids the viewer can moderate (admins return an empty array
      // here — they can mod everything, consumers special-case role).
      // Made available to every route via rootApi.useLoaderData() so
      // table components can decide per-row whether to show mod links.
      moderatedGroupIds: session.moderatedGroupIds,
    }
  },
  component: RootComponent,
  shellComponent: RootDocument,
})

function RootComponent() {
  const { groups, currentUser, moderatedGroupIds } = Route.useLoaderData()
  const params = useParams({ strict: false }) as { slug?: string }
  return (
    <>
      <PostHogTracker currentUser={currentUser} />
      <AppLayout
        groups={groups}
        activeSlug={params.slug ?? null}
        currentUser={currentUser}
        moderatedGroupIds={moderatedGroupIds}
      >
        <Outlet />
      </AppLayout>
    </>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        {import.meta.env.DEV && (
          <TanStackDevtools
            config={{ position: 'bottom-right' }}
            plugins={[
              {
                name: 'Tanstack Router',
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        )}
        <Scripts />
      </body>
    </html>
  )
}
