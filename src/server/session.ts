import { useSession } from '@tanstack/react-start/server'
import type { SessionConfig } from '@tanstack/react-start/server'

import { env } from '#/config/env'

const SESSION_NAME = 'pv-session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

export type SessionData = {
  readonly userId?: number
  // Random per-flow token written before redirecting to Steam OpenID and
  // matched on the callback. Binds the callback to the same browser that
  // initiated the request (login-CSRF protection).
  readonly oauthState?: string
}

const sessionConfig = (): SessionConfig => ({
  password: env.ENCRYPTION_KEY,
  name: SESSION_NAME,
  maxAge: SESSION_MAX_AGE_SECONDS,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
  },
})

const session = () => useSession<SessionData>(sessionConfig())

export const getSessionUserId = async (): Promise<number | null> => {
  const s = await session()
  return s.data.userId ?? null
}

export const getOAuthState = async (): Promise<string | null> => {
  const s = await session()
  return s.data.oauthState ?? null
}

export const setOAuthState = async (state: string): Promise<void> => {
  const s = await session()
  await s.update({ ...s.data, oauthState: state })
}

// Drop the entire session and write a fresh one keyed only on userId. Called
// at successful sign-in to defeat session fixation: any pre-login cookie an
// attacker may have planted in the victim's browser is replaced with a
// freshly-encrypted blob (h3 re-encrypts on every update with a new IV) that
// the attacker never saw.
export const rotateSessionTo = async (userId: number): Promise<void> => {
  const s = await session()
  await s.clear()
  await s.update({ userId })
}

export const clearSession = async (): Promise<void> => {
  const s = await session()
  await s.clear()
}
