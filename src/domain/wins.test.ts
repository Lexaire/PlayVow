import { describe, expect, it } from 'vitest'

import {
  computePlayDeadline,
  isExpired,
  isPastDeadline,
  playtimeIncreasedSinceBaseline,
  playtimeProgress,
} from '#/domain/wins'

describe('computePlayDeadline', () => {
  it('adds the play window in days', () => {
    const wonAt = new Date('2026-01-01T00:00:00Z')
    expect(computePlayDeadline(wonAt, 30).toISOString()).toBe('2026-01-31T00:00:00.000Z')
    expect(computePlayDeadline(wonAt, 90).toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('does not mutate the input date', () => {
    const wonAt = new Date('2026-01-01T00:00:00Z')
    const original = wonAt.getTime()
    computePlayDeadline(wonAt, 30)
    expect(wonAt.getTime()).toBe(original)
  })
})

describe('isPastDeadline', () => {
  it('is true when deadline is strictly before now', () => {
    expect(isPastDeadline(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))).toBe(
      true,
    )
  })

  it('is false when deadline equals now', () => {
    const t = new Date('2026-01-01T00:00:00Z')
    expect(isPastDeadline(t, new Date(t.getTime()))).toBe(false)
  })

  it('is false when deadline is in the future', () => {
    expect(isPastDeadline(new Date('2026-02-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(
      false,
    )
  })
})

describe('isExpired', () => {
  const past = new Date('2026-01-01T00:00:00Z')
  const now = new Date('2026-02-01T00:00:00Z')
  const future = new Date('2026-03-01T00:00:00Z')

  it('is true only for pending wins past their deadline', () => {
    expect(isExpired('pending', past, now)).toBe(true)
  })

  it('is false for non-pending statuses regardless of deadline', () => {
    expect(isExpired('played', past, now)).toBe(false)
    expect(isExpired('kicked', past, now)).toBe(false)
    expect(isExpired('exempt', past, now)).toBe(false)
  })

  it('is false for pending wins with a future deadline', () => {
    expect(isExpired('pending', future, now)).toBe(false)
  })
})

describe('playtimeProgress', () => {
  it('is unknown when baseline is missing', () => {
    expect(playtimeProgress(null, 60)).toEqual({ kind: 'unknown' })
  })

  it('is unknown when current is missing', () => {
    expect(playtimeProgress(0, null)).toEqual({ kind: 'unknown' })
  })

  it('reports no_progress when current equals baseline', () => {
    expect(playtimeProgress(120, 120)).toEqual({ kind: 'no_progress' })
  })

  it('reports no_progress when current is below baseline (clock rewind / API quirk)', () => {
    expect(playtimeProgress(120, 100)).toEqual({ kind: 'no_progress' })
  })

  it('reports the delta in minutes when there is progress', () => {
    expect(playtimeProgress(120, 200)).toEqual({ kind: 'progress', minutes: 80 })
  })
})

describe('playtimeIncreasedSinceBaseline', () => {
  it('is true only when current strictly exceeds baseline', () => {
    expect(playtimeIncreasedSinceBaseline(60, 90)).toBe(true)
    expect(playtimeIncreasedSinceBaseline(60, 60)).toBe(false)
    expect(playtimeIncreasedSinceBaseline(60, 30)).toBe(false)
    expect(playtimeIncreasedSinceBaseline(null, 90)).toBe(false)
    expect(playtimeIncreasedSinceBaseline(60, null)).toBe(false)
  })
})
