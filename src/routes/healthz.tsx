import { createFileRoute } from '@tanstack/react-router'

// Liveness probe target for the systemd healthcheck timer. Pure liveness —
// no DB, no remote calls, no auth — so a slow Turso replica or upstream
// wobble doesn't trip a restart of the web process. Using a server handler
// returns a plain text response without rendering the SSR shell.
//
// If we ever want a *readiness* probe (DB freshness, worker heartbeat),
// expose that on a separate path so its failure modes don't restart web.
export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      ANY: () =>
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    },
  },
  component: () => 'ok',
})
