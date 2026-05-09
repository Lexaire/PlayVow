import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@libsql/client'

import { env } from '#/config/env'

type JournalEntry = { readonly idx: number; readonly tag: string; readonly when: number }
type Journal = { readonly entries: readonly JournalEntry[] }
type ExpectedMigration = { readonly tag: string; readonly when: number; readonly hash: string }

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

// Connect directly to the primary, bypassing the embedded-replica indirection —
// we want an authoritative answer, not whatever a stale local file says.
const directConfig = (): { url: string; authToken?: string } => {
  switch (env.db.mode) {
    case 'replica':
      return { url: env.db.syncUrl, authToken: env.db.authToken }
    case 'remote':
      return { url: env.db.url, authToken: env.db.authToken }
    case 'local':
      return { url: env.db.url }
  }
}

const readExpected = (): readonly ExpectedMigration[] => {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal
  return journal.entries.map((entry) => {
    const sql = fs.readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf8')
    return {
      tag: entry.tag,
      when: entry.when,
      // Must match drizzle-orm/migrator.js — sha256 of the raw file contents.
      hash: crypto.createHash('sha256').update(sql).digest('hex'),
    }
  })
}

const main = async (): Promise<void> => {
  const expected = readExpected()

  const cfg = directConfig()
  console.log(`[migrate-check] target: ${cfg.url}`)
  const client = createClient(cfg)

  let applied: readonly { hash: string; createdAt: number }[] = []
  try {
    const result = await client.execute(
      'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC',
    )
    applied = result.rows.map((row) => ({
      hash: String(row.hash),
      createdAt: Number(row.created_at),
    }))
  } catch (err) {
    if (!(err instanceof Error) || !err.message.toLowerCase().includes('no such table')) {
      client.close()
      throw err
    }
  }

  client.close()

  if (applied.length > expected.length) {
    console.error(
      `[migrate-check] DB has ${applied.length} applied migrations but the repo journal lists ${expected.length}.`,
    )
    console.error('[migrate-check] DB is ahead of the repo — investigate before deploying.')
    process.exit(1)
  }

  // Compare each applied row against the expected entry at the same index.
  // A hash mismatch means the file content for an already-applied migration
  // changed in the repo (e.g. a squash) — prod's schema does NOT match what
  // the repo says it should be, and counting alone would silently miss it.
  const mismatches: { index: number; expected: ExpectedMigration; gotHash: string }[] = []
  for (let i = 0; i < applied.length; i++) {
    const exp = expected[i]
    const got = applied[i]
    if (!exp || !got) continue
    if (got.hash !== exp.hash) {
      mismatches.push({ index: i, expected: exp, gotHash: got.hash })
    }
  }

  if (mismatches.length > 0) {
    console.error(
      `[migrate-check] DB schema does NOT match the repo — ${mismatches.length} migration(s) have a different hash than what's checked in.`,
    )
    for (const m of mismatches) {
      console.error(
        `  - idx ${m.index} (${m.expected.tag}): expected ${m.expected.hash.slice(0, 12)}…, db has ${m.gotHash.slice(0, 12)}…`,
      )
    }
    console.error('')
    console.error('This usually means a migration file was rewritten or squashed after it was')
    console.error('already applied to this DB. Deploying now would leave prod on the OLD schema')
    console.error('while the app expects the NEW one.')
    console.error('')
    console.error('Pick one:')
    console.error('  1. Write a forward-only migration that ALTERs the live schema to match, OR')
    console.error('  2. If this DB is disposable, drop it and re-init from scratch.')
    process.exit(1)
  }

  if (applied.length < expected.length) {
    const pending = expected.slice(applied.length)
    console.error(`[migrate-check] ${pending.length} pending migration(s):`)
    for (const entry of pending) {
      console.error(`  - ${entry.tag}`)
    }
    console.error('')
    console.error('Apply them, then re-run deploy:')
    console.error('  make prod-db-migrate')
    process.exit(1)
  }

  console.log(`[migrate-check] up to date (${applied.length} applied, hashes match)`)
}

main().catch((err: unknown) => {
  console.error('[migrate-check] failed:', err)
  process.exit(1)
})
