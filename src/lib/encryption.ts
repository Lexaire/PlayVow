import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { env } from '#/config/env'
import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

// AES-256-GCM with a SHA-256-derived key. The 32-char ENCRYPTION_KEY env is
// already required application-wide; we hash it to obtain exactly 32 bytes
// regardless of the input encoding. A fresh 12-byte IV per encrypt is
// authenticated alongside the ciphertext via GCM's auth tag, so any
// tamper (including ciphertext bit-flips) fails decryption with auth_failed.
const VERSION = 'v1'
const IV_BYTES = 12
const ALGO = 'aes-256-gcm'

export type DecryptError =
  | { readonly kind: 'malformed' }
  | { readonly kind: 'unknown_version'; readonly version: string }
  | { readonly kind: 'auth_failed' }

const deriveKey = (): Buffer => createHash('sha256').update(env.ENCRYPTION_KEY).digest()

export const encrypt = (plaintext: string): string => {
  const key = deriveKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${VERSION}:${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`
}

export const decrypt = (blob: string): Result<string, DecryptError> => {
  const colonIdx = blob.indexOf(':')
  if (colonIdx === -1) return err({ kind: 'malformed' })
  const version = blob.slice(0, colonIdx)
  if (version !== VERSION) return err({ kind: 'unknown_version', version })

  const parts = blob.slice(colonIdx + 1).split('.')
  if (parts.length !== 3) return err({ kind: 'malformed' })
  const [ivB64, tagB64, ctB64] = parts
  // ctB64 may be empty (empty plaintext encrypts to empty ciphertext under GCM).
  if (!ivB64 || !tagB64 || ctB64 === undefined) return err({ kind: 'malformed' })

  let iv: Buffer
  let authTag: Buffer
  let ciphertext: Buffer
  try {
    iv = Buffer.from(ivB64, 'base64')
    authTag = Buffer.from(tagB64, 'base64')
    ciphertext = Buffer.from(ctB64, 'base64')
  } catch {
    return err({ kind: 'malformed' })
  }
  if (iv.length !== IV_BYTES) return err({ kind: 'malformed' })

  try {
    const key = deriveKey()
    const decipher = createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return ok(plaintext.toString('utf8'))
  } catch {
    return err({ kind: 'auth_failed' })
  }
}
