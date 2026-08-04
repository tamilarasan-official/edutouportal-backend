import pg from 'pg'
import { config } from '../config.js'

const { Pool, types } = pg

// Return int8 (bigint) as a JS number rather than a string. Every bigint column
// in this schema is a file size or a count, all far below Number.MAX_SAFE_INTEGER.
// Without this the frontend receives "1024" instead of 1024 and comparisons break.
types.setTypeParser(types.builtins.INT8, (value: string) => Number.parseInt(value, 10))

// Return numeric as a number too -- only used for streak_multiplier.
types.setTypeParser(types.builtins.NUMERIC, (value: string) => Number.parseFloat(value))

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

pool.on('error', (err) => {
  // A pooled client can die between checkouts (network blip, Postgres restart).
  // Log it, but do not crash: the pool creates a replacement on next acquire.
  console.error('[db] idle client error', err)
})

export type SqlParam = string | number | boolean | null | Date | Buffer | unknown[] | object

export async function query<T extends object = Record<string, unknown>>(
  text: string,
  params: SqlParam[] = []
): Promise<T[]> {
  const result = await pool.query(text, params as unknown[])
  return result.rows as T[]
}

export async function queryOne<T extends object = Record<string, unknown>>(
  text: string,
  params: SqlParam[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/**
 * Run a set of statements in a single transaction.
 *
 * Several flows in this app are multi-write and were previously non-atomic --
 * joining a session inserts a participant AND an event row; ending a session
 * updates the session, every leaderboard row, and every participant. A partial
 * failure used to leave inconsistent state.
 */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* connection already broken; the pool will discard it */
    })
    throw err
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  await pool.end()
}
