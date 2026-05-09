import { describe, expect, it } from 'vitest'

import { checkRoleChange } from '#/domain/admin-policy'

const target = (id: number, role: 'user' | 'moderator' | 'admin') => ({ id, role })

describe('checkRoleChange', () => {
  it('rejects self-change regardless of role rank', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(1, 'admin'),
      newRole: 'moderator',
      isActorEnvAdmin: true,
    })
    expect(r).toEqual({ ok: false, error: 'self_change_forbidden' })
  })

  it('lets a non-env admin promote a user to moderator', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'user'),
      newRole: 'moderator',
      isActorEnvAdmin: false,
    })
    expect(r).toEqual({ ok: true })
  })

  it('lets a non-env admin demote a moderator to user', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'moderator'),
      newRole: 'user',
      isActorEnvAdmin: false,
    })
    expect(r).toEqual({ ok: true })
  })

  it('blocks a non-env admin from promoting to admin', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'moderator'),
      newRole: 'admin',
      isActorEnvAdmin: false,
    })
    expect(r).toEqual({ ok: false, error: 'admin_change_requires_env_admin' })
  })

  it('blocks a non-env admin from demoting an existing admin', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'admin'),
      newRole: 'moderator',
      isActorEnvAdmin: false,
    })
    expect(r).toEqual({ ok: false, error: 'admin_change_requires_env_admin' })
  })

  it('lets an env admin promote to admin', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'moderator'),
      newRole: 'admin',
      isActorEnvAdmin: true,
    })
    expect(r).toEqual({ ok: true })
  })

  it('lets an env admin demote an admin', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'admin'),
      newRole: 'moderator',
      isActorEnvAdmin: true,
    })
    expect(r).toEqual({ ok: true })
  })

  it('still blocks env admin from changing their own admin role', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(1, 'admin'),
      newRole: 'user',
      isActorEnvAdmin: true,
    })
    expect(r).toEqual({ ok: false, error: 'self_change_forbidden' })
  })
})
