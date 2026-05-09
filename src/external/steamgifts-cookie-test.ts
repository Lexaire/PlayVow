import { env } from '#/config/env'
import type { Fetcher } from '#/external/http'
import { fetchText } from '#/external/http'

// Standalone authentication probe. Lives in its own file (no cheerio import)
// so the web SSR bundle for /admin/cookies doesn't transitively pull in
// cheerio + undici. The real SG parsers stay in steamgifts.ts and are only
// used by the worker bundle.
//
// `.nav__sits` is the SG sign-in-through-Steam button rendered in the nav for
// anonymous visitors. A class-name regex is good enough — false positives
// would require SG to ship that exact class name in some other unauthenticated
// context, which doesn't happen on a real listing response.
//
// The caller passes an absolute URL already prefixed with SG_PROXY_BASE (when
// set), so the test exercises the exact same proxy + path the worker uses.

const DEFAULT_USER_AGENT = 'playvow/0.1 (+https://playvow.com)'
const SIGN_IN_BUTTON_RE = /class\s*=\s*["'][^"']*\bnav__sits\b/

export type SgCookieTestOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'login_required' }
  | { readonly kind: 'http_error'; readonly status: number }
  | { readonly kind: 'network_error'; readonly message: string }

export type SgCookieTestConfig = {
  readonly cookie: string
  readonly testUrl: string
  readonly fetcher?: Fetcher
  readonly userAgent?: string
}

const defaultFetcher: Fetcher = (u, i) => fetch(u, i)

export const testSgCookie = async (cfg: SgCookieTestConfig): Promise<SgCookieTestOutcome> => {
  const fetcher = cfg.fetcher ?? defaultFetcher
  const headers: Record<string, string> = {
    Cookie: cfg.cookie,
    'User-Agent': cfg.userAgent ?? DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    ...(env.SG_PROXY_AUTH.length > 0 ? { 'X-Proxy-Auth': env.SG_PROXY_AUTH } : {}),
  }
  const r = await fetchText(fetcher, cfg.testUrl, { headers })
  if (!r.ok) {
    if (r.error.kind === 'http_status') {
      // Surface a 500-byte snippet of the response so logs reveal whether
      // it's a Cloudflare challenge page, a generic block, or an actual SG
      // 403. Cloudflare-blocked responses usually contain "cf-ray" or "Just
      // a moment..." or "Attention Required". An SG-issued 403 looks like
      // the regular SG layout.
      console.error(
        'sg_cookie_test_http_error',
        JSON.stringify({
          url: cfg.testUrl,
          status: r.error.status,
          bodySnippet: r.error.body.slice(0, 500),
        }),
      )
      return { kind: 'http_error', status: r.error.status }
    }
    return { kind: 'network_error', message: r.error.message }
  }
  if (SIGN_IN_BUTTON_RE.test(r.value)) return { kind: 'login_required' }
  return { kind: 'ok' }
}
