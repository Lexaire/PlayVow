import '#/lib/server-only'

import { z } from 'zod'

const EnvSchema = z.object({
  TURSO_DATABASE_URL: z.string().min(1),
  TURSO_AUTH_TOKEN: z.string().default(''),
  LOCAL_DB_PATH: z.string().min(1).default('file:local.db'),
  // Required. How to connect to the database:
  //   - 'local'   — file-only (uses TURSO_DATABASE_URL if file:, else LOCAL_DB_PATH)
  //   - 'remote'  — direct Turso connection (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
  //   - 'replica' — embedded replica syncing from remote into LOCAL_DB_PATH
  DB_MODE: z.enum(['local', 'remote', 'replica']),
  ENCRYPTION_KEY: z.string().min(32),
  STEAM_WEB_API_KEY: z.string().default(''),
  STEAM_OPENID_REALM: z.string().url(),
  ADMIN_STEAM_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  // SteamGifts is behind Cloudflare and certain VPS IP ranges get a JS
  // challenge ("Just a moment...") instead of the page. SG_PROXY_BASE points
  // at a Cloudflare Worker (or any proxy) that re-issues the request from a
  // non-blocked origin. Worker code lives in infra/cf-sg-proxy/. When set,
  // SG_PROXY_AUTH must match the worker's PROXY_SHARED_SECRET so the worker
  // doesn't serve as an open SG proxy.
  SG_PROXY_BASE: z
    .string()
    .url()
    .optional()
    .transform((v) => (v ? v.replace(/\/$/, '') : v)),
  SG_PROXY_AUTH: z.string().default(''),

  // PostHog observability — optional. When unset, analytics are no-ops so dev
  // and ad-hoc CLI runs don't fail or leak events. Set to a project API key
  // (starts with `phc_`) in production. POSTHOG_HOST defaults to PostHog's US
  // ingest if unset; set explicitly for EU.
  POSTHOG_API_KEY: z.string().default(''),
  POSTHOG_HOST: z.string().url().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

type RawEnv = Readonly<z.infer<typeof EnvSchema>>

export type DbConfig =
  | { readonly mode: 'local'; readonly url: string }
  | { readonly mode: 'remote'; readonly url: string; readonly authToken: string }
  | {
      readonly mode: 'replica'
      readonly url: string
      readonly syncUrl: string
      readonly authToken: string
    }

const isRemoteUrl = (url: string): boolean =>
  url.startsWith('libsql://') ||
  url.startsWith('https://') ||
  url.startsWith('http://') ||
  url.startsWith('wss://') ||
  url.startsWith('ws://')

const deriveDbConfig = (raw: RawEnv): DbConfig => {
  const remoteAvailable = isRemoteUrl(raw.TURSO_DATABASE_URL) && raw.TURSO_AUTH_TOKEN.length > 0

  switch (raw.DB_MODE) {
    case 'remote':
      if (!remoteAvailable) {
        throw new Error(
          'DB_MODE=remote requires a libsql/https TURSO_DATABASE_URL and TURSO_AUTH_TOKEN',
        )
      }
      return { mode: 'remote', url: raw.TURSO_DATABASE_URL, authToken: raw.TURSO_AUTH_TOKEN }
    case 'replica':
      if (!remoteAvailable) {
        throw new Error(
          'DB_MODE=replica requires a libsql/https TURSO_DATABASE_URL and TURSO_AUTH_TOKEN',
        )
      }
      return {
        mode: 'replica',
        url: raw.LOCAL_DB_PATH,
        syncUrl: raw.TURSO_DATABASE_URL,
        authToken: raw.TURSO_AUTH_TOKEN,
      }
    case 'local':
      return {
        mode: 'local',
        url: raw.TURSO_DATABASE_URL.startsWith('file:')
          ? raw.TURSO_DATABASE_URL
          : raw.LOCAL_DB_PATH,
      }
  }
}

export type Env = Readonly<RawEnv & { readonly db: DbConfig }>

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(z.prettifyError(parsed.error))
  process.exit(1)
}

export const env: Env = Object.freeze({
  ...parsed.data,
  db: deriveDbConfig(parsed.data),
})
