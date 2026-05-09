export type OperationalErrorCategory =
  | 'sg_cookie_expired'
  | 'sg_rate_limited'
  | 'sg_unavailable'
  | 'steam_unauthorized'
  | 'steam_rate_limited'
  | 'steam_unavailable'
  | 'db_busy'
  | 'db_unreachable'
  | 'network_timeout'
  | 'unknown'

export type OperationalErrorContext = {
  readonly jobName: string
}

export type OperationalError = {
  readonly category: OperationalErrorCategory
  readonly summary: string
  readonly suggestion?: string
}

const SG_JOBS: ReadonlyArray<string> = ['scrape_groups', 'backfill_winners']
const STEAM_WEB_JOBS: ReadonlyArray<string> = ['poll_playtime']
const STEAM_COMMUNITY_JOBS: ReadonlyArray<string> = ['scrape_steam_group_members']
const STEAM_JOBS: ReadonlyArray<string> = [...STEAM_WEB_JOBS, ...STEAM_COMMUNITY_JOBS]

const isSgJob = (jobName: string) => SG_JOBS.includes(jobName)
const isSteamJob = (jobName: string) => STEAM_JOBS.includes(jobName)

type PatternRule = {
  readonly pattern: RegExp
  readonly jobs?: ReadonlyArray<string>
  readonly build: (raw: string, ctx: OperationalErrorContext) => OperationalError
}

const RULES: ReadonlyArray<PatternRule> = [
  {
    pattern: /sign in|login (page|required)/i,
    jobs: SG_JOBS,
    build: () => ({
      category: 'sg_cookie_expired',
      summary: 'SteamGifts returned a login page. The cookie probably expired.',
      suggestion: 'Refresh the cookie on /admin/cookies and run the job again.',
    }),
  },
  {
    pattern: /429|too many requests|rate.?limit/i,
    jobs: SG_JOBS,
    build: () => ({
      category: 'sg_rate_limited',
      summary: 'SteamGifts rate-limited the worker.',
      suggestion: 'Usually transient — the next scheduled run will likely succeed.',
    }),
  },
  {
    pattern: /429|too many requests|rate.?limit/i,
    jobs: STEAM_JOBS,
    build: () => ({
      category: 'steam_rate_limited',
      summary: 'Steam rate-limited the worker.',
      suggestion: 'Usually transient — the next scheduled run will likely succeed.',
    }),
  },
  {
    pattern: /401|403|forbidden|unauthorized/i,
    jobs: STEAM_WEB_JOBS,
    build: () => ({
      category: 'steam_unauthorized',
      summary: 'Steam rejected the API key.',
      suggestion: 'Verify STEAM_WEB_API_KEY is set and active.',
    }),
  },
  {
    pattern: /401|403|forbidden|unauthorized/i,
    jobs: SG_JOBS,
    build: () => ({
      category: 'sg_cookie_expired',
      summary: 'SteamGifts rejected the request.',
      suggestion: 'The cookie may have expired — refresh it on /admin/cookies.',
    }),
  },
  {
    pattern: /5\d\d|service unavailable|gateway timeout|bad gateway/i,
    jobs: SG_JOBS,
    build: () => ({
      category: 'sg_unavailable',
      summary: 'SteamGifts is returning a server error.',
      suggestion: 'Almost always temporary — wait for the next scheduled run.',
    }),
  },
  {
    pattern: /5\d\d|service unavailable|gateway timeout|bad gateway/i,
    jobs: STEAM_JOBS,
    build: () => ({
      category: 'steam_unavailable',
      summary: 'Steam is returning a server error.',
      suggestion: 'Almost always temporary — wait for the next scheduled run.',
    }),
  },
  {
    pattern: /SQLITE_BUSY|database is locked/i,
    build: () => ({
      category: 'db_busy',
      summary: 'The database was locked when the job tried to write.',
      suggestion: 'Single retry usually clears it; check for stuck transactions if it recurs.',
    }),
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|getaddrinfo/i,
    build: (raw) => {
      const isTurso = /turso|libsql/i.test(raw)
      return {
        category: isTurso ? 'db_unreachable' : 'network_timeout',
        summary: 'Could not reach an upstream service.',
        suggestion: isTurso
          ? 'Check network and Turso credentials.'
          : 'Check network connectivity.',
      }
    },
  },
  {
    pattern: /ETIMEDOUT|timeout/i,
    build: () => ({
      category: 'network_timeout',
      summary: 'A network request timed out.',
      suggestion: 'Likely transient.',
    }),
  },
  {
    pattern: /fetch failed/i,
    build: (_raw, ctx) => {
      if (isSgJob(ctx.jobName)) {
        return {
          category: 'sg_unavailable',
          summary: 'Network request to SteamGifts failed.',
          suggestion: 'Likely transient.',
        }
      }
      if (isSteamJob(ctx.jobName)) {
        return {
          category: 'steam_unavailable',
          summary: 'Network request to Steam failed.',
          suggestion: 'Likely transient.',
        }
      }
      return {
        category: 'network_timeout',
        summary: 'Network request failed.',
        suggestion: 'Likely transient.',
      }
    },
  },
]

export const formatOperationalError = (
  rawMessage: string,
  ctx: OperationalErrorContext,
): OperationalError => {
  for (const rule of RULES) {
    if (!rule.pattern.test(rawMessage)) continue
    if (rule.jobs !== undefined && !rule.jobs.includes(ctx.jobName)) continue
    return rule.build(rawMessage, ctx)
  }
  return { category: 'unknown', summary: rawMessage }
}
