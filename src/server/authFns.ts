import { redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

import { env } from '#/config/env'
import { dbWrite } from '#/db/client'
import { findUserBySteamId, setUserRole, upsertUserBySteamId } from '#/repos/users'
import { setSession, signOut } from '#/server/auth'
import { getOAuthState, setOAuthState } from '#/server/session'
import { buildSteamLoginUrl, verifySteamCallback } from '#/server/steamAuth'

const STEAM_RETURN_PATH = '/auth/steam/callback'

const expectedReturnTo = (state: string): string => {
  const realm = env.STEAM_OPENID_REALM.replace(/\/+$/, '')
  return `${realm}${STEAM_RETURN_PATH}?state=${encodeURIComponent(state)}`
}

const newState = (): string => randomBytes(16).toString('hex')

export const startSteamLogin = createServerFn({ method: 'GET' }).handler(async () => {
  const state = newState()
  await setOAuthState(state)
  const url = buildSteamLoginUrl({
    realm: env.STEAM_OPENID_REALM,
    returnTo: expectedReturnTo(state),
  })
  throw redirect({ href: url })
})

// Forwarded from the callback route. `state` is our per-flow CSRF token;
// `params` is the verbatim openid.* dictionary for re-POSTing to Steam.
const CallbackSchema = z.object({
  state: z.string().min(1).max(64).optional(),
  params: z.record(z.string(), z.string()),
})

const loginRedirect = (error: string) => redirect({ to: '/login', search: { error } })

export const completeSteamLogin = createServerFn({ method: 'POST' })
  .inputValidator((input: { state?: string; params: Record<string, string> }) =>
    CallbackSchema.parse(input),
  )
  .handler(async ({ data }) => {
    // 1) State cookie binds this callback to the same browser that hit
    //    /auth/steam/start. Without this, an attacker can deliver their own
    //    valid Steam callback URL to a victim and log them into the
    //    attacker's account (login CSRF, sameSite=lax allows top-level
    //    cross-site GETs to send our cookie).
    const expectedState = await getOAuthState()
    // Always single-use: clear regardless of outcome.
    await setOAuthState('')
    const incomingState = data.state
    if (!expectedState || !incomingState || expectedState !== incomingState) {
      throw loginRedirect('state_mismatch')
    }

    // 2) RFC requires verifying that openid.return_to matches the URL we
    //    actually received. Steam signs return_to, so this binds Steam's
    //    signature to the URL the victim's browser hit (defends against
    //    return_to substitution attacks where Steam signs URL A but the
    //    callback fires at URL B).
    const signedReturnTo = data.params['openid.return_to']
    if (signedReturnTo !== expectedReturnTo(incomingState)) {
      throw loginRedirect('return_to_mismatch')
    }

    // 3) Re-POST to Steam to confirm the signature.
    const verifyResult = await verifySteamCallback(new URLSearchParams(data.params))
    if (!verifyResult.ok) {
      throw loginRedirect(verifyResult.error.kind)
    }
    const steamId = verifyResult.value

    // 4) Upsert. We treat "row didn't exist before this call" as the
    //    first-login signal; only that case fires the env-admin bootstrap so
    //    a deliberate later demotion doesn't get silently re-promoted on
    //    the next sign-in.
    const db = dbWrite()
    const existed = await findUserBySteamId(db, steamId)
    const user = await upsertUserBySteamId(db, { steamId })

    if (existed === null && env.ADMIN_STEAM_IDS.includes(steamId) && user.role !== 'admin') {
      await setUserRole(db, {
        userId: user.id,
        newRole: 'admin',
        actorUserId: user.id,
        reason: 'bootstrap',
      })
    }

    // 5) Rotate the session — drops any pre-login cookie value and writes
    //    a fresh encrypted blob keyed only on userId.
    await setSession(user.id)
    throw redirect({ to: '/' })
  })

export const logout = createServerFn({ method: 'POST' }).handler(async () => {
  await signOut()
  return { ok: true } as const
})
