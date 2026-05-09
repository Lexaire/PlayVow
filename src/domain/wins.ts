import type { WinStatus } from '#/db/schema'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export const computePlayDeadline = (wonAt: Date, playWindowDays: number): Date =>
  new Date(wonAt.getTime() + playWindowDays * MS_PER_DAY)

export const isPastDeadline = (playDeadline: Date, now: Date): boolean =>
  playDeadline.getTime() < now.getTime()

export const isExpired = (status: WinStatus, playDeadline: Date, now: Date): boolean =>
  status === 'pending' && isPastDeadline(playDeadline, now)

export type PlaytimeProgress =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'no_progress' }
  | { readonly kind: 'progress'; readonly minutes: number }

export const playtimeProgress = (
  baselineMinutes: number | null,
  currentMinutes: number | null,
): PlaytimeProgress => {
  if (baselineMinutes === null || currentMinutes === null) return { kind: 'unknown' }
  const delta = currentMinutes - baselineMinutes
  if (delta <= 0) return { kind: 'no_progress' }
  return { kind: 'progress', minutes: delta }
}

export const playtimeIncreasedSinceBaseline = (
  baselineMinutes: number | null,
  currentMinutes: number | null,
): boolean => playtimeProgress(baselineMinutes, currentMinutes).kind === 'progress'
