import { describe, expect, it } from 'vitest'

import { flattenErrorMessage, formatOperationalError } from './operational-errors'

const sg = { jobName: 'scrape_groups' }
const backfill = { jobName: 'backfill_winners' }
const pollPlaytime = { jobName: 'poll_playtime' }
const steamGroup = { jobName: 'scrape_steam_group_members' }
const unknown = { jobName: 'unknown_job' }

describe('formatOperationalError', () => {
  describe('sg_cookie_expired', () => {
    it('maps sign-in page to sg_cookie_expired for SG jobs', () => {
      const result = formatOperationalError('sign in required', sg)
      expect(result.category).toBe('sg_cookie_expired')
      expect(result.summary).toContain('login page')
    })

    it('maps login page variant', () => {
      const result = formatOperationalError('login page returned', sg)
      expect(result.category).toBe('sg_cookie_expired')
    })

    it('maps 403 Forbidden to sg_cookie_expired for SG jobs', () => {
      const result = formatOperationalError('403 Forbidden', sg)
      expect(result.category).toBe('sg_cookie_expired')
      expect(result.summary).toContain('SteamGifts rejected')
    })

    it('maps 401 to sg_cookie_expired for backfill_winners', () => {
      const result = formatOperationalError('401 Unauthorized', backfill)
      expect(result.category).toBe('sg_cookie_expired')
    })

    it('maps "forbidden" to sg_cookie_expired for SG jobs', () => {
      const result = formatOperationalError('Forbidden', sg)
      expect(result.category).toBe('sg_cookie_expired')
    })
  })

  describe('steam_unauthorized', () => {
    it('maps 403 Forbidden to steam_unauthorized for poll_playtime', () => {
      const result = formatOperationalError('403 Forbidden', pollPlaytime)
      expect(result.category).toBe('steam_unauthorized')
      expect(result.summary).toContain('API key')
    })

    it('maps 401 to steam_unauthorized for poll_playtime', () => {
      const result = formatOperationalError('401 Unauthorized', pollPlaytime)
      expect(result.category).toBe('steam_unauthorized')
    })

    it('context disambiguation: 403 → steam for poll_playtime, sg for scrape_groups', () => {
      const steam = formatOperationalError('403 Forbidden', pollPlaytime)
      const sg_ = formatOperationalError('403 Forbidden', sg)
      expect(steam.category).toBe('steam_unauthorized')
      expect(sg_.category).toBe('sg_cookie_expired')
    })
  })

  describe('sg_rate_limited', () => {
    it('maps 429 to sg_rate_limited for SG jobs', () => {
      const result = formatOperationalError('429 Too Many Requests', sg)
      expect(result.category).toBe('sg_rate_limited')
    })

    it('maps "rate limit" to sg_rate_limited', () => {
      const result = formatOperationalError('rate limit exceeded', sg)
      expect(result.category).toBe('sg_rate_limited')
    })

    it('maps "ratelimit" (no space) to sg_rate_limited', () => {
      const result = formatOperationalError('ratelimit hit', sg)
      expect(result.category).toBe('sg_rate_limited')
    })
  })

  describe('steam_rate_limited', () => {
    it('maps 429 to steam_rate_limited for poll_playtime', () => {
      const result = formatOperationalError('429 Too Many Requests', pollPlaytime)
      expect(result.category).toBe('steam_rate_limited')
    })

    it('maps 429 to steam_rate_limited for scrape_steam_group_members', () => {
      const result = formatOperationalError('429 Too Many Requests', steamGroup)
      expect(result.category).toBe('steam_rate_limited')
    })

    it('context disambiguation: 429 → steam_rate_limited for Steam, sg_rate_limited for SG', () => {
      const steam = formatOperationalError('429 Too Many Requests', pollPlaytime)
      const sg_ = formatOperationalError('429 Too Many Requests', sg)
      expect(steam.category).toBe('steam_rate_limited')
      expect(sg_.category).toBe('sg_rate_limited')
    })
  })

  describe('sg_unavailable', () => {
    it('maps 503 to sg_unavailable for SG jobs', () => {
      const result = formatOperationalError('503 Service Unavailable', sg)
      expect(result.category).toBe('sg_unavailable')
    })

    it('maps "bad gateway" to sg_unavailable', () => {
      const result = formatOperationalError('502 Bad Gateway', sg)
      expect(result.category).toBe('sg_unavailable')
    })

    it('maps "gateway timeout" to sg_unavailable', () => {
      const result = formatOperationalError('504 Gateway Timeout', sg)
      expect(result.category).toBe('sg_unavailable')
    })

    it('maps fetch failed to sg_unavailable for SG jobs', () => {
      const result = formatOperationalError('fetch failed', sg)
      expect(result.category).toBe('sg_unavailable')
    })
  })

  describe('steam_unavailable', () => {
    it('maps 503 to steam_unavailable for Steam jobs', () => {
      const result = formatOperationalError('503 Service Unavailable', pollPlaytime)
      expect(result.category).toBe('steam_unavailable')
    })

    it('maps fetch failed to steam_unavailable for Steam jobs', () => {
      const result = formatOperationalError('fetch failed', steamGroup)
      expect(result.category).toBe('steam_unavailable')
    })
  })

  describe('db_busy', () => {
    it('maps SQLITE_BUSY for any job', () => {
      const result = formatOperationalError('SQLITE_BUSY: database is locked', sg)
      expect(result.category).toBe('db_busy')
    })

    it('maps "database is locked" for Steam jobs too', () => {
      const result = formatOperationalError('database is locked', pollPlaytime)
      expect(result.category).toBe('db_busy')
    })

    it('maps SQLITE_BUSY for unknown jobs', () => {
      const result = formatOperationalError('SQLITE_BUSY', unknown)
      expect(result.category).toBe('db_busy')
    })
  })

  describe('db_constraint', () => {
    it('maps a UNIQUE constraint failure to db_constraint', () => {
      const result = formatOperationalError('UNIQUE constraint failed: users.steam_id', sg)
      expect(result.category).toBe('db_constraint')
    })

    it('maps SQLITE_CONSTRAINT to db_constraint for any job', () => {
      const result = formatOperationalError('SQLITE_CONSTRAINT_UNIQUE: write rejected', unknown)
      expect(result.category).toBe('db_constraint')
    })

    it('does not mistake a Steam ID in a failed-query dump for an HTTP 5xx', () => {
      // The "561" inside the Steam ID used to match /5\d\d/ and mislabel this
      // DB error as "SteamGifts is returning a server error".
      const raw =
        'Failed query: insert into "users" ... params: Kzander,76561198094834966,user,Kzander | UNIQUE constraint failed: users.steam_id'
      const result = formatOperationalError(raw, sg)
      expect(result.category).toBe('db_constraint')
    })
  })

  describe('flattenErrorMessage', () => {
    it('joins an error and its cause chain', () => {
      const cause = new Error('UNIQUE constraint failed: users.steam_id')
      const wrapped = new Error('Failed query: insert into "users" ...', { cause })
      expect(flattenErrorMessage(wrapped)).toBe(
        'Failed query: insert into "users" ... | UNIQUE constraint failed: users.steam_id',
      )
    })

    it('stringifies non-Error values', () => {
      expect(flattenErrorMessage('boom')).toBe('boom')
    })

    it('does not loop on a cyclic cause', () => {
      const a = new Error('a')
      a.cause = a
      expect(flattenErrorMessage(a)).toBe('a')
    })
  })

  describe('db_unreachable', () => {
    it('maps ECONNREFUSED with turso to db_unreachable', () => {
      const result = formatOperationalError('ECONNREFUSED: turso connection failed', sg)
      expect(result.category).toBe('db_unreachable')
    })

    it('maps ECONNREFUSED with libsql to db_unreachable', () => {
      const result = formatOperationalError('ECONNREFUSED from libsql client', sg)
      expect(result.category).toBe('db_unreachable')
    })
  })

  describe('network_timeout', () => {
    it('maps ETIMEDOUT to network_timeout', () => {
      const result = formatOperationalError('ETIMEDOUT after 30s', sg)
      expect(result.category).toBe('network_timeout')
    })

    it('maps "timeout" to network_timeout', () => {
      const result = formatOperationalError('request timeout', sg)
      expect(result.category).toBe('network_timeout')
    })

    it('maps ECONNREFUSED without turso/libsql to network_timeout', () => {
      const result = formatOperationalError('ECONNREFUSED 127.0.0.1:8080', sg)
      expect(result.category).toBe('network_timeout')
    })

    it('maps ENOTFOUND to network_timeout when no turso mention', () => {
      const result = formatOperationalError('ENOTFOUND api.steampowered.com', pollPlaytime)
      expect(result.category).toBe('network_timeout')
    })

    it('maps fetch failed to network_timeout for unknown jobs', () => {
      const result = formatOperationalError('fetch failed', unknown)
      expect(result.category).toBe('network_timeout')
    })
  })

  describe('unknown pass-through', () => {
    it('returns unknown category with raw message as summary', () => {
      const raw = 'something unexpected happened'
      const result = formatOperationalError(raw, sg)
      expect(result.category).toBe('unknown')
      expect(result.summary).toBe(raw)
      expect(result.suggestion).toBeUndefined()
    })

    it('handles empty string without throwing', () => {
      const result = formatOperationalError('', sg)
      expect(result.category).toBe('unknown')
      expect(result.summary).toBe('')
    })

    it('has no suggestion for unknown errors', () => {
      const result = formatOperationalError('some weird error', unknown)
      expect(result.suggestion).toBeUndefined()
    })
  })

  describe('suggestions present', () => {
    it('sg_cookie_expired includes cookie suggestion', () => {
      const result = formatOperationalError('403 Forbidden', sg)
      expect(result.suggestion).toContain('/admin/cookies')
    })

    it('steam_unauthorized includes API key suggestion', () => {
      const result = formatOperationalError('401 Unauthorized', pollPlaytime)
      expect(result.suggestion).toContain('STEAM_WEB_API_KEY')
    })

    it('db_busy includes retry suggestion', () => {
      const result = formatOperationalError('SQLITE_BUSY', unknown)
      expect(result.suggestion).toBeTruthy()
    })
  })
})
