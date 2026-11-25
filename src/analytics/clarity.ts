import { config } from '../config.js'
import { query, queryOne } from '../db/pool.js'

/**
 * Microsoft Clarity Data Export API, for the admin's Analytics & Event
 * Tracking page.
 * https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api
 *
 * Clarity allows only 10 requests per project per day and returns the last 1-3
 * days. We always ask for the last 3 days, for 3 reports, each cached in
 * cms_settings (so restarts do not spend the quota again) and refreshed at most
 * every CACHE_HOURS: at most 3 x 3 = 9 calls a day.
 */

const ENDPOINT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights'
const CACHE_HOURS = 8
export const CLARITY_DAYS = 3

/** overview = no breakdown; the others break the same metrics down by one dimension. */
export const CLARITY_REPORTS = {
  overview: null,
  pages: 'URL',
  sources: 'Source',
} as const
export type ClarityReport = keyof typeof CLARITY_REPORTS

export interface ClarityMetric {
  metricName: string
  information: Record<string, unknown>[]
}

export interface ClarityResult {
  report: ClarityReport
  days: number
  fetchedAt: string
  nextRefreshAt: string
  metrics: ClarityMetric[]
  cached: boolean
}

type Http = typeof fetch
let http: Http = (...args) => fetch(...args)
export function setClarityHttp(h: Http | null): void {
  http = h ?? ((...args) => fetch(...args))
}

export class ClarityError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

const cacheKey = (report: ClarityReport, days: number) => `clarity_cache:${report}:${days}`

export async function clarityReport(report: ClarityReport, { refresh = false } = {}): Promise<ClarityResult> {
  const days = CLARITY_DAYS
  const key = cacheKey(report, days)
  const cached = await queryOne<{ value: { fetchedAt: string; metrics: ClarityMetric[] } }>(
    'SELECT value FROM cms_settings WHERE key = $1',
    [key]
  )
  const age = cached ? Date.now() - new Date(cached.value.fetchedAt).getTime() : Infinity
  const fresh = age < CACHE_HOURS * 3600_000
  // "Refresh" may only bypass a cache older than an hour, so it cannot drain the daily quota.
  const mayRefresh = refresh && age > 3600_000

  if (cached && (fresh && !mayRefresh)) {
    return shape(report, days, cached.value.fetchedAt, cached.value.metrics, true)
  }

  if (!config.CLARITY_API_TOKEN) {
    if (cached) return shape(report, days, cached.value.fetchedAt, cached.value.metrics, true)
    throw new ClarityError('Clarity data is not connected yet. Add CLARITY_API_TOKEN to the API environment.', 409)
  }

  const params = new URLSearchParams({ numOfDays: String(days) })
  const dimension = CLARITY_REPORTS[report]
  if (dimension) params.set('dimension1', dimension)

  let res: Response
  try {
    res = await http(`${ENDPOINT}?${params}`, {
      headers: { authorization: `Bearer ${config.CLARITY_API_TOKEN}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    if (cached) return shape(report, days, cached.value.fetchedAt, cached.value.metrics, true)
    throw new ClarityError(`Could not reach Clarity: ${(err as Error).message}`, 502)
  }

  if (!res.ok) {
    // Out of quota or a token problem: keep showing the last good data if we have it.
    if (cached) return shape(report, days, cached.value.fetchedAt, cached.value.metrics, true)
    const reason =
      res.status === 429
        ? 'Clarity’s daily limit (10 requests) is used up. Data will refresh tomorrow.'
        : res.status === 401 || res.status === 403
          ? 'Clarity rejected the API token. Generate a new one in Clarity > Settings > Data Export.'
          : `Clarity returned an error (${res.status}).`
    throw new ClarityError(reason, res.status === 429 ? 429 : 502)
  }

  const body = (await res.json().catch(() => [])) as unknown
  const metrics: ClarityMetric[] = Array.isArray(body)
    ? body
        .filter((m): m is ClarityMetric => !!m && typeof m === 'object' && typeof (m as ClarityMetric).metricName === 'string')
        .map((m) => ({ metricName: m.metricName, information: Array.isArray(m.information) ? m.information.slice(0, 200) : [] }))
    : []

  const fetchedAt = new Date().toISOString()
  await query(
    `INSERT INTO cms_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify({ fetchedAt, metrics })]
  )
  return shape(report, days, fetchedAt, metrics, false)
}

function shape(report: ClarityReport, days: number, fetchedAt: string, metrics: ClarityMetric[], cached: boolean): ClarityResult {
  return {
    report,
    days,
    fetchedAt,
    nextRefreshAt: new Date(new Date(fetchedAt).getTime() + CACHE_HOURS * 3600_000).toISOString(),
    metrics,
    cached,
  }
}
