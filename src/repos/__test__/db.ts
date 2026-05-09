import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { migrate } from 'drizzle-orm/libsql/migrator'

import type { Db } from '#/db/client'
import { createDbClient } from '#/db/client'

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'src/db/migrations')

export type TestDb = {
  readonly db: Db
  readonly close: () => void
}

export const createTestDb = async (): Promise<TestDb> => {
  const file = path.join(tmpdir(), `playvow-test-${randomBytes(8).toString('hex')}.db`)
  const db = createDbClient({ mode: 'local', url: `file:${file}` })
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  return {
    db,
    close: () => {
      db.$client.close()
      try {
        unlinkSync(file)
      } catch {
        // best-effort cleanup
      }
    },
  }
}
