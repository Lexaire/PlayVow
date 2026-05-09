import { describe, expect, it } from 'vitest'

import { decrypt, encrypt } from '#/lib/encryption'

describe('encryption', () => {
  it('round-trips a string through encrypt/decrypt', () => {
    const plaintext = 'PHPSESSID=abc123; cf_clearance=zzz'
    const blob = encrypt(plaintext)
    const r = decrypt(blob)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(plaintext)
  })

  it('produces different ciphertext for the same input (random IV)', () => {
    const plaintext = 'same input'
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext))
  })

  it('starts with the version prefix', () => {
    expect(encrypt('x')).toMatch(/^v1:/)
  })

  it('round-trips empty string and unicode', () => {
    for (const p of ['', '🚀 héllo 🎮']) {
      const r = decrypt(encrypt(p))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toBe(p)
    }
  })

  it('rejects malformed blobs', () => {
    for (const bad of ['', 'not-versioned', 'v1:onlyonepart', 'v1:a.b', 'v1:a.b.c.d']) {
      const r = decrypt(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe('malformed')
    }
  })

  it('rejects unknown versions', () => {
    const r = decrypt('v9:aa.bb.cc')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('unknown_version')
  })

  it('detects ciphertext tamper as auth_failed', () => {
    const blob = encrypt('secret cookie value')
    // Flip a bit in the ciphertext segment.
    const [version, rest] = blob.split(':') as [string, string]
    const [iv, tag, ct] = rest.split('.') as [string, string, string]
    const ctBuf = Buffer.from(ct, 'base64')
    ctBuf[0] = (ctBuf[0] ?? 0) ^ 0x01
    const tampered = `${version}:${iv}.${tag}.${ctBuf.toString('base64')}`
    const r = decrypt(tampered)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('auth_failed')
  })

  it('detects auth tag tamper as auth_failed', () => {
    const blob = encrypt('secret')
    const [version, rest] = blob.split(':') as [string, string]
    const [iv, tag, ct] = rest.split('.') as [string, string, string]
    const tagBuf = Buffer.from(tag, 'base64')
    tagBuf[0] = (tagBuf[0] ?? 0) ^ 0x01
    const tampered = `${version}:${iv}.${tagBuf.toString('base64')}.${ct}`
    const r = decrypt(tampered)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('auth_failed')
  })
})
