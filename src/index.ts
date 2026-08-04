import { createServer } from 'node:http'
import { config } from './config.js'
import { closePool } from './db/pool.js'
import { runMigrations } from './db/migrate.js'
import { createApp } from './app.js'
import { ensureStorageDirs } from './storage/routes.js'
import { attachRealtime } from './realtime/hub.js'
import { purgeExpiredTokens } from './auth/tokens.js'

const server = createServer(createApp())

async function start(): Promise<void> {
  // Running migrations at boot means a Dokploy deploy needs no separate step.
  // Each migration runs inside a transaction and records itself in
  // schema_migrations, so a concurrent duplicate fails cleanly rather than
  // applying twice.
  await runMigrations()
  await ensureStorageDirs()

  attachRealtime(server)

  server.listen(config.PORT, () => {
    console.log(`[server] listening on :${config.PORT} (${config.NODE_ENV})`)
    console.log(`[server] cors origins: ${config.corsOrigins.join(', ')}`)
    console.log(`[server] google oauth: ${config.googleEnabled ? 'enabled' : 'disabled'}`)
  })

  // Housekeeping: drop long-expired tokens once a day.
  setInterval(() => {
    purgeExpiredTokens().catch((err) => console.error('[server] token purge failed', err))
  }, 24 * 60 * 60 * 1000).unref()
}

start().catch((err) => {
  console.error('[server] failed to start', err)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Graceful shutdown -- Docker sends SIGTERM and waits before SIGKILL.
// ---------------------------------------------------------------------------

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} received, shutting down`)

  server.close(() => console.log('[server] http closed'))

  const timer = setTimeout(() => {
    console.warn('[server] forced exit after timeout')
    process.exit(1)
  }, 10_000)
  timer.unref()

  try {
    await closePool()
    console.log('[server] database pool closed')
    process.exit(0)
  } catch (err) {
    console.error('[server] shutdown error', err)
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
