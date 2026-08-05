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
  //
  // 1 assumes the browser reaches this API through exactly one proxy. That is
  // NOT true when the portal proxies browser calls through its own server
  // (NEXT_PUBLIC_API_PROXY_PATH=/backend, its default): the chain is then
  // browser -> edge proxy -> Next -> here, and req.ip resolves to a piece of
  // infrastructure shared by every user. Check GET /health/ip from a browser;
  // if it does not return your own public address, raise this to 2.
  //
  // Left at 1 because raising it without checking is the worse mistake: an
  // over-long chain lets a caller forge its own IP with a crafted header.
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

  /**
   * Who the `trust proxy` setting above resolves the caller to.
   *
   * Mounted above the rate limiter deliberately: the moment you most need to
   * know whether req.ip is right is when a shared bucket is already returning
   * 429, and an endpoint behind that bucket could not answer.
   *
   * Call it from a browser. `ip` should be your own public address. If it is a
   * private/container address (10.x, 172.16-31.x, 192.168.x) or the same value
   * for two people on different networks, the hop count is wrong and every
   * per-IP limit below is being applied to the whole userbase at once.
   */
  app.get('/health/ip', (req: Request, res: Response) => {
    res.json({
      ip: req.ip,
      trustProxy: app.get('trust proxy'),
      forwardedFor: req.headers['x-forwarded-for'] ?? null,
    })
  })

  // Blanket ceiling. The auth routes add their own, much tighter, limits.
  // Disabled under NODE_ENV=test so a fast test run is not throttled.
  //
  // Sized for the whole userbase, not for one person. This is keyed per IP, and
  // while the portal proxies browser calls through its own server every user
  // shares this single bucket -- at 300 a class of 200 exhausted it in seconds
  // and everyone was locked out. 3000/min holds a few hundred concurrent
  // students; it is a runaway-client backstop, and the per-account cap in
  // auth/routes.ts is what actually resists password guessing.
  //
  // Once GET /health/ip shows a real client address, this can come back down.
  if (config.NODE_ENV !== 'test') {
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 3000,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: { message: 'Too many requests', code: 'RATE_LIMITED' } },
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
    const code = (err as { code?: string }).code

    // multer surfaces size violations as a coded error rather than an HTTP status.
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: { message: 'File is too large', code: 'TOO_LARGE' } })
      return
    }

    // multer rejects a file arriving under an unexpected field name.
    if (code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({
        error: { message: 'Unexpected file field; upload the file as "file"', code: 'BAD_UPLOAD' },
      })
      return
    }

    // A malformed request body is the caller's mistake, not a server fault.
    // express.json() throws a SyntaxError when the body does not parse -- which
    // is what happened when uploads were sent as multipart but labelled
    // application/json. That produced a 500 and told the client nothing.
    if (
      err instanceof SyntaxError ||
      code === 'entity.parse.failed' ||
      code === 'encoding.unsupported'
    ) {
      res.status(400).json({
        error: {
          message:
            'Request body could not be parsed. For file uploads send multipart/form-data ' +
            'and do not set a content-type header.',
          code: 'MALFORMED_BODY',
        },
      })
      return
    }

    if (code === 'entity.too.large') {
      res.status(413).json({ error: { message: 'Request body is too large', code: 'TOO_LARGE' } })
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
