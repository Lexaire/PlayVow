import { describe, expect, it } from 'vitest'

import { createLogger } from '#/lib/logger'

const fixedNow = () => new Date('2026-04-25T12:00:00.000Z')

describe('createLogger', () => {
  it('writes one JSON line per call with ts, level, msg', () => {
    const lines: string[] = []
    const log = createLogger({ write: (l) => lines.push(l), now: fixedNow })
    log.info('hello', { count: 3 })
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(entry).toEqual({
      ts: '2026-04-25T12:00:00.000Z',
      level: 'info',
      msg: 'hello',
      count: 3,
    })
  })

  it('emits the correct level for each method', () => {
    const lines: string[] = []
    const log = createLogger({ write: (l) => lines.push(l), now: fixedNow })
    log.info('a')
    log.warn('b')
    log.error('c')
    const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level)
    expect(levels).toEqual(['info', 'warn', 'error'])
  })

  it('merges parent bindings into every line', () => {
    const lines: string[] = []
    const log = createLogger({
      bindings: { service: 'worker' },
      write: (l) => lines.push(l),
      now: fixedNow,
    })
    log.info('tick')
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(entry['service']).toBe('worker')
  })

  it('child loggers compose bindings without mutating the parent', () => {
    const lines: string[] = []
    const parent = createLogger({
      bindings: { service: 'worker' },
      write: (l) => lines.push(l),
      now: fixedNow,
    })
    const child = parent.child({ job: 'scrape' })
    child.info('start')
    parent.info('untouched')

    const childEntry = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    const parentEntry = JSON.parse(lines[1] ?? '') as Record<string, unknown>
    expect(childEntry['service']).toBe('worker')
    expect(childEntry['job']).toBe('scrape')
    expect(parentEntry['service']).toBe('worker')
    expect(parentEntry['job']).toBeUndefined()
  })

  it('lets call-site fields override parent bindings', () => {
    const lines: string[] = []
    const log = createLogger({
      bindings: { stage: 'init' },
      write: (l) => lines.push(l),
      now: fixedNow,
    })
    log.info('m', { stage: 'finish' })
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(entry['stage']).toBe('finish')
  })
})
