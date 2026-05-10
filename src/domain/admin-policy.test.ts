import { describe, expect, it } from 'vitest'

import { checkRoleChange } from '#/domain/admin-policy'

// Per-group moderation lives in the group_moderators table now; the global
// role enum is just user/admin. Role-change tests cover the user ↔ admin
// transitions and the self-change + env-admin gates.
const target = (id: number, role: 'user' | 'admin') => ({ id, role })

describe('checkRoleChange', () => {
  it('rejects self-change regardless of role rank', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(1, 'admin'),
      newRole: 'user',
      isActorEnvAdmin: true,
    })
    expect(r).toEqual({ ok: false, error: 'self_change_forbidden' })
  })

  it('blocks a non-env admin from promoting to admin', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'user'),
      newRole: 'admin',
      isActorEnvAdmin: false,
    })
    expect(r).toEqual({ ok: false, error: 'admin_change_requires_env_admin' })
  })

  it('blocks a non-env admin from demoting an existing admin', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'admin'),
      newRole: 'user',
      isActorEnvAdmin: false,
    })
    expect(r).toEqual({ ok: false, error: 'admin_change_requires_env_admin' })
  })

  it('lets an env admin promote a user to admin', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'user'),
      newRole: 'admin',
      isActorEnvAdmin: true,
    })
    expect(r).toEqual({ ok: true })
  })

  it('lets an env admin demote an admin to user', () => {
    const r = checkRoleChange({
      actorId: 1,
      target: target(2, 'admin'),
      newRole: 'user',
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
