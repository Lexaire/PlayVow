import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { env } from '#/config/env'
import { dbWrite } from '#/db/client'
import type { SgCookieTestResult } from '#/db/schema'
import { testSgCookie } from '#/external/steamgifts-cookie-test'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'
import {
  type GroupCookieStatus,
  clearCookie,
  getDecryptedCookie,
  listGroupCookieStatuses,
  recordTestResult,
  setCookie,
} from '#/repos/groupSecrets'
import { findGroupById } from '#/repos/groups'
import { requireAdmin } from '#/server/auth'

// Trim the pasted cookie to drop accidental whitespace from copy-paste, then
// reject anything obviously bogus. Real SG cookies are far longer than 10
// chars; this is a sanity floor, not a format check.
const SetCookieSchema = z.object({
  groupId: z.number().int().positive(),
  cookie: z.string().trim().min(10).max(8192),
})

const GroupIdSchema = z.object({ groupId: z.number().int().positive() })

export type SetCookieFnError = { readonly kind: 'group_not_found' }
export type ClearCookieFnError = { readonly kind: 'group_not_found' }
export type TestCookieFnError =
  | { readonly kind: 'group_not_found' }
  | { readonly kind: 'not_set' }
  | { readonly kind: 'decrypt_failed' }

// listGroupCookieStatusFn purposefully has no cookie field in its return.
// Reviewers: grep this file for `getDecryptedCookie` — that should appear
// only inside testGroupCookieFn, where the plaintext is consumed by a single
// network call and never escapes the function.
// Every read here goes through dbWrite() (the remote Turso client) rather
// than the embedded replica. The replica is on a 60s sync interval, so
// reading a row we just wrote — or testing a cookie that was set seconds
// ago — would otherwise come back stale and the admin would think the save
// failed. Admin traffic is low, so the extra remote roundtrip is fine.
export const listGroupCookieStatusFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ReadonlyArray<GroupCookieStatus>> => {
    await requireAdmin()
    return listGroupCookieStatuses(dbWrite())
  },
)

export const setGroupCookieFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { groupId: number; cookie: string }) => SetCookieSchema.parse(input))
  .handler(async ({ data }): Promise<Result<{ groupId: number }, SetCookieFnError>> => {
    const admin = await requireAdmin()
    const group = await findGroupById(dbWrite(), data.groupId)
    if (!group) return err({ kind: 'group_not_found' })
    await setCookie(dbWrite(), {
      groupId: data.groupId,
      plaintext: data.cookie,
      actorUserId: admin.id,
    })
    return ok({ groupId: data.groupId })
  })

export const clearGroupCookieFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { groupId: number }) => GroupIdSchema.parse(input))
  .handler(async ({ data }): Promise<Result<{ groupId: number }, ClearCookieFnError>> => {
    const admin = await requireAdmin()
    const group = await findGroupById(dbWrite(), data.groupId)
    if (!group) return err({ kind: 'group_not_found' })
    await clearCookie(dbWrite(), { groupId: data.groupId, actorUserId: admin.id })
    return ok({ groupId: data.groupId })
  })

export type TestCookieFnOk = { readonly result: SgCookieTestResult; readonly httpStatus?: number }

export const testGroupCookieFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { groupId: number }) => GroupIdSchema.parse(input))
  .handler(async ({ data }): Promise<Result<TestCookieFnOk, TestCookieFnError>> => {
    const admin = await requireAdmin()
    const group = await findGroupById(dbWrite(), data.groupId)
    if (!group) return err({ kind: 'group_not_found' })

    const cookieR = await getDecryptedCookie(dbWrite(), data.groupId)
    if (!cookieR.ok) {
      if (cookieR.error.kind === 'not_set') return err({ kind: 'not_set' })
      return err({ kind: 'decrypt_failed' })
    }

    // Test against the group's own listing URL — same path the worker
    // scrapes daily. When SG_PROXY_BASE is set, the request goes through the
    // CF Worker proxy so the test sees the same Cloudflare-treatment as the
    // worker (mirroring scrape behaviour avoids "test passes but scrape
    // fails" surprises).
    const sgBase = env.SG_PROXY_BASE ?? 'https://www.steamgifts.com'
    const testUrl = `${sgBase}/group/${group.steamgiftsGroupCode}/${encodeURIComponent(group.steamGroupSlug)}/search?page=1`
    // The plaintext lives only inside this block. testSgCookie returns the
    // outcome; the cookie variable goes out of scope on the next statement.
    const outcome = await testSgCookie({ cookie: cookieR.value, testUrl })

    await recordTestResult(dbWrite(), {
      groupId: data.groupId,
      result: outcome.kind,
      actorUserId: admin.id,
    })

    return ok(
      outcome.kind === 'http_error'
        ? { result: outcome.kind, httpStatus: outcome.status }
        : { result: outcome.kind },
    )
  })
