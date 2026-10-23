import { serve } from '@hono/node-server'
import { createApp } from './app'
import { config } from './config'
import { openDb } from './db/client'
import { runMigrations } from './db/migrate'

const db = openDb(config.databasePath)
runMigrations(db)

serve({ fetch: createApp(db).fetch, port: config.port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`)
})
