import '#/lib/server-only'

import { createClient } from '@libsql/client'
import type { Client, Config } from '@libsql/client'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import type { LibSQLDatabase, LibSQLTransaction } from 'drizzle-orm/libsql'

import { env } from '#/config/env'
import type { DbConfig } from '#/config/env'
import * as schema from '#/db/schema'

export type Schema = typeof schema
export type Db = LibSQLDatabase<Schema> & { readonly $client: Client }
export type Tx = LibSQLTransaction<Schema, ExtractTablesWithRelations<Schema>>
export type DbOrTx = Db | Tx

const SYNC_INTERVAL_SECONDS = 60

const toClientConfig = (cfg: DbConfig): Config => {
  switch (cfg.mode) {
    case 'replica':
      return {
        url: cfg.url,
        syncUrl: cfg.syncUrl,
        authToken: cfg.authToken,
        syncInterval: SYNC_INTERVAL_SECONDS,
      }
    case 'remote':
      return { url: cfg.url, authToken: cfg.authToken }
    case 'local':
      return { url: cfg.url }
  }
}

// Block up to 5 seconds when a write encounters a held lock, instead of
// failing immediately with SQLITE_BUSY. Currently a no-op for the remote
// write path (Turso serializes writes server-side) but matters if we ever
// migrate to a single local file where worker + web both write directly.
// Pipelined ahead of any user query so it takes effect from the first call.
const BUSY_TIMEOUT_MS = 5000

export const createDbClient = (cfg: DbConfig = env.db): Db => {
  const client = createClient(toClientConfig(cfg))
  client.execute(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`).catch((e: unknown) => {
    console.error('failed to set busy_timeout', e instanceof Error ? e.message : String(e))
  })
  return drizzle(client, { schema, casing: 'snake_case' })
}

let cached: Db | undefined

export const db = (): Db => {
  if (!cached) cached = createDbClient()
  return cached
}

// In replica mode there are TWO authenticated libsql clients to the same
// Turso DB: db() reads from the local synced file, dbWrite() talks remote.
// Transactions invoked on the write client run remote-only, sidestepping the
// "don't open the local DB while the embedded replica is syncing" rule. The
// local replica picks up changes via background sync within syncInterval.
let cachedWrite: Db | undefined

const toWriteConfig = (cfg: DbConfig): DbConfig =>
  cfg.mode === 'replica' ? { mode: 'remote', url: cfg.syncUrl, authToken: cfg.authToken } : cfg

export const dbWrite = (): Db => {
  if (env.db.mode !== 'replica') return db()
  if (!cachedWrite) cachedWrite = createDbClient(toWriteConfig(env.db))
  return cachedWrite
}

// When the body throws and rollback also throws, drizzle's libsql session
// re-throws the rollback error and the original cause is lost. Surface both
// via AggregateError. Commit-time errors are not covered here.
export const withTransaction = async <T>(
  database: Db,
  body: (tx: Tx) => Promise<T>,
): Promise<T> => {
  let bodyError: { readonly value: unknown } | undefined
  try {
    return await database.transaction(async (tx) => {
      try {
        return await body(tx)
      } catch (e) {
        bodyError = { value: e }
        throw e
      }
    })
  } catch (thrown) {
    if (bodyError && bodyError.value !== thrown) {
      throw new AggregateError(
        [bodyError.value, thrown],
        'transaction body failed; rollback also failed',
      )
    }
    throw thrown
  }
}
