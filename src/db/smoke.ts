import { count } from 'drizzle-orm'

import { env } from '#/config/env'
import { createDbClient } from '#/db/client'
import { auditLog, giveaways, groupSecrets, groups, steamApps, users, wins } from '#/db/schema'

const main = async (): Promise<void> => {
  const db = createDbClient()
  console.log(`[smoke] target: ${env.db.mode} (${env.db.url})`)

  const tables = {
    groups,
    group_secrets: groupSecrets,
    users,
    steam_apps: steamApps,
    giveaways,
    wins,
    audit_log: auditLog,
  } as const

  for (const [name, table] of Object.entries(tables)) {
    const [row] = await db.select({ n: count() }).from(table)
    console.log(`[smoke] ${name.padEnd(14)} ${row?.n ?? 0}`)
  }

  const [first] = await db.select().from(groups).limit(1)
  if (first) {
    console.log(
      `[smoke] first group: ${first.slug} / sg=${first.steamgiftsGroupCode} steam=${first.steamGroupId} window=${String(first.playWindowDays)}d`,
    )
  }

  db.$client.close()
  console.log('[smoke] done')
}

main().catch((err: unknown) => {
  console.error('[smoke] failed:', err)
  process.exit(1)
})
