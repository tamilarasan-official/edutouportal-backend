import express, { type NextFunction, type Request, type Response } from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { config } from './config.js'
import { pool } from './db/pool.js'
import { attachActor } from './middleware/auth.js'
import { authRouter } from './auth/routes.js'
import { queryRouter } from './query/routes.js'
import { adminRouter, rpcRouter } from './rpc/routes.js'
import { quizRouter } from './quiz/routes.js'
import { storageRouter } from './storage/routes.js'

/**
 * Builds the Express app without binding a port.
 *
 * Separated from index.ts so the test suite can mount the real application --
 * same routers, same middleware, same policy engine -- against an ephemeral
 * server rather than testing a mock that could drift from production.
 */
export function createApp() {
  const app = express()

  // Behind Dokploy's reverse proxy, so the client IP that rate limiting and
  // cookie `secure` depend on comes from X-Forwarded-For.
  app.set('trust proxy', 1)

  app.use(
    helmet({
      // This is a JSON API; it never serves HTML that could load resources.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    })
  )

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests arrive with no Origin header.
        if (!origin) return callback(null, true)
        if (config.corsOrigins.includes(origin)) return callback(null, true)
        callback(new Error(`Origin ${origin} is not allowed`))
      },
      // Required for the session cookies to cross from the frontend origin.
      credentials: true,
    })
  )

  app.use(express.json({ limit: '2mb' }))
  app.use(cookieParser())

  // Blanket ceiling. The auth routes add their own, much tighter, limits.
  // Disabled under NODE_ENV=test so a fast test run is not throttled.
  if (config.NODE_ENV !== 'test') {
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 300,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
      })
    )
  }

  app.use(attachActor)

  // -------------------------------------------------------------------------
  // Health checks -- Dokploy polls these to decide if a deploy succeeded.
  // -------------------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  app.get('/health/ready', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1')
      res.json({ status: 'ready' })
    } catch {
      res.status(503).json({ status: 'unavailable' })
    }
  })

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  app.use('/auth', authRouter)
  app.use('/api/db', queryRouter)
  app.use('/api/rpc', rpcRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api/quiz', quizRouter)
  app.use('/api/storage', storageRouter)

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } })
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // multer surfaces size violations as a coded error rather than an HTTP status.
    if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: { message: 'File is too large', code: 'TOO_LARGE' } })
      return
    }
    if (err.message?.startsWith('Origin ')) {
      res.status(403).json({ error: { message: 'Origin not allowed', code: 'CORS' } })
      return
    }

    console.error('[server] unhandled error', err)
    res.status(500).json({ error: { message: 'Internal server error', code: 'INTERNAL' } })
  })

  return app
}
