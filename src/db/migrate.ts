import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/libsql/migrator'

import { env } from '#/config/env'
import { createDbClient } from '#/db/client'

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

const main = async (): Promise<void> => {
  const db = createDbClient()
  console.log(`[migrate] target: ${env.db.mode} (${env.db.url})`)
  await migrate(db, { migrationsFolder })
  if (env.db.mode === 'replica') {
    await db.$client.sync()
  }
  db.$client.close()
  console.log('[migrate] done')
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
