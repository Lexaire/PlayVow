// NOT marked server-only: TanStack Start bundles createStart() into the
// client too (it needs the middleware metadata). The .server() callback below
// only runs on the server, and the logger/error logic inside it is never
// executed in the browser.
import { isNotFound, isRedirect } from '@tanstack/react-router'
import { createMiddleware, createStart } from '@tanstack/react-start'

import { createLogger } from '#/lib/logger'

const log = createLogger({ bindings: { service: 'server-fn' } })

// Catches every error thrown out of a server fn, logs the real cause server-side,
// and re-throws a generic error so drizzle/libsql/etc. messages never reach the
// wire. redirect() and notFound() are intentional control-flow throws — pass them
// through unchanged.
const errorSanitizer = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  try {
    return await next()
  } catch (e) {
    if (isRedirect(e) || isNotFound(e)) throw e
    log.error('server_fn_failed', {
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    })
    throw new Error('Internal server error')
  }
})

export const startInstance = createStart(() => ({
  functionMiddleware: [errorSanitizer],
}))
