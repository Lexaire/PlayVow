import { describe, expect, it } from 'vitest'

import { WIN_STATUSES, type WinStatus } from '#/db/schema'
import {
  allowedActionsFrom,
  isValidAction,
  isValidTransition,
  MOD_ACTIONS,
  type ModAction,
  targetStatus,
  targetsForBulk,
} from '#/domain/win-status'

describe('targetStatus', () => {
  it('maps each mod action to its resulting status', () => {
    expect(targetStatus('mark_played')).toBe('played')
    expect(targetStatus('kick')).toBe('kicked')
    expect(targetStatus('not_in_group')).toBe('not_in_group')
    expect(targetStatus('exempt')).toBe('exempt')
    expect(targetStatus('reset')).toBe('pending')
  })
})

describe('isValidTransition', () => {
  it('rejects no-op transitions', () => {
    for (const s of WIN_STATUSES) {
      expect(isValidTransition(s, s)).toBe(false)
    }
  })

  it('accepts every distinct (from, to) pair', () => {
    for (const from of WIN_STATUSES) {
      for (const to of WIN_STATUSES) {
        if (from === to) continue
        expect(isValidTransition(from, to)).toBe(true)
      }
    }
  })
})

describe('isValidAction', () => {
  it('rejects mark_played from played', () => {
    expect(isValidAction('played', 'mark_played')).toBe(false)
  })

  it('rejects kick from kicked', () => {
    expect(isValidAction('kicked', 'kick')).toBe(false)
  })

  it('rejects exempt from exempt', () => {
    expect(isValidAction('exempt', 'exempt')).toBe(false)
  })

  it('rejects not_in_group from not_in_group', () => {
    expect(isValidAction('not_in_group', 'not_in_group')).toBe(false)
  })

  it('rejects reset from pending', () => {
    expect(isValidAction('pending', 'reset')).toBe(false)
  })

  it('accepts every other action', () => {
    expect(isValidAction('pending', 'mark_played')).toBe(true)
    expect(isValidAction('pending', 'kick')).toBe(true)
    expect(isValidAction('pending', 'exempt')).toBe(true)
    expect(isValidAction('played', 'reset')).toBe(true)
    expect(isValidAction('kicked', 'mark_played')).toBe(true)
    expect(isValidAction('exempt', 'kick')).toBe(true)
  })
})

describe('allowedActionsFrom', () => {
  const expected: Record<WinStatus, ReadonlyArray<ModAction>> = {
    pending: ['mark_played', 'kick', 'not_in_group', 'exempt'],
    played: ['kick', 'not_in_group', 'exempt', 'reset'],
    kicked: ['mark_played', 'not_in_group', 'exempt', 'reset'],
    not_in_group: ['mark_played', 'kick', 'exempt', 'reset'],
    exempt: ['mark_played', 'kick', 'not_in_group', 'reset'],
  }

  it('omits the action that would no-op the current status', () => {
    for (const s of WIN_STATUSES) {
      expect(allowedActionsFrom(s)).toEqual(expected[s])
    }
  })

  it('always returns N-1 distinct actions', () => {
    for (const s of WIN_STATUSES) {
      const actions = allowedActionsFrom(s)
      expect(actions).toHaveLength(MOD_ACTIONS.length - 1)
      expect(new Set(actions).size).toBe(actions.length)
    }
  })
})

describe('targetsForBulk', () => {
  it('returns all statuses when selection is empty', () => {
    expect(targetsForBulk(new Set())).toEqual(WIN_STATUSES)
  })

  it('excludes the single source status', () => {
    expect(targetsForBulk(new Set<WinStatus>(['pending']))).toEqual([
      'played',
      'kicked',
      'not_in_group',
      'exempt',
    ])
  })

  it('excludes every source status when selection spans multiple', () => {
    expect(targetsForBulk(new Set<WinStatus>(['pending', 'kicked']))).toEqual([
      'played',
      'not_in_group',
      'exempt',
    ])
  })

  it('returns empty when every status is in the source set', () => {
    expect(targetsForBulk(new Set<WinStatus>(WIN_STATUSES))).toEqual([])
  })
})
