import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client, createUser, startTestServer, stopTestServer, truncateAll, type TestUser } from './helpers.js'
import { query } from '../src/db/pool.js'
import { setClarityHttp } from '../src/analytics/clarity.js'

/** Analytics & Event Tracking: Clarity on the website, Clarity data in the admin. */

let base: string
let calls: string[] = []
let nextStatus = 200

before(async () => {
  base = await startTestServer()
})
after(async () => {
  setClarityHttp(null)
  await stopTestServer()
})
beforeEach(async () => {
  await truncateAll()
  calls = []
  nextStatus = 200
  setClarityHttp((async (url: string, init: RequestInit) => {
    calls.push(String(url))
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test_clarity_token_not_real')
    if (nextStatus !== 200) return new Response('{}', { status: nextStatus })
    return new Response(
      JSON.stringify([
        { metricName: 'Traffic', information: [{ totalSessionCount: '120', totalBotSessionCount: '4', distantUserCount: '98', PagesPerSessionPercentage: 1.8 }] },
        { metricName: 'RageClickCount', information: [{ sessionsCount: '3' }] },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as typeof fetch)
})
afterEach(() => setClarityHttp(null))

const adminUser = (): Promise<TestUser> => createUser(base, 'admin')

describe('clarity on the website', () => {
  it('gives the website the project id, and none when switched off', async () => {
    let site = (await new Client(base).get('/api/cms/site')).body.data
    assert.equal(site.analytics.clarityProjectId, 'zjabfz0mvo')
    assert.equal(site.analytics.googleTagId, 'GTM-MF7QXGND')

    const a = await adminUser()
    assert.equal((await a.client.request('PUT', '/api/cms/admin/settings/analytics', { clarityEnabled: false, clarityProjectId: 'zjabfz0mvo' })).status, 200)
    site = (await new Client(base).get('/api/cms/site')).body.data
    assert.equal(site.analytics.clarityProjectId, '')

    const bad = await a.client.request('PUT', '/api/cms/admin/settings/analytics', { clarityEnabled: true, clarityProjectId: '"><script>' })
    assert.equal(bad.status, 422)
    const badTag = await a.client.request('PUT', '/api/cms/admin/settings/analytics', { googleTagId: 'GTM-1"><script>' })
    assert.equal(badTag.status, 422)
    assert.equal((await a.client.request('PUT', '/api/cms/admin/settings/analytics', { googleEnabled: false })).status, 200)
    assert.equal((await new Client(base).get('/api/cms/site')).body.data.analytics.googleTagId, '')
  })
})

describe('clarity data in the admin', () => {
  it('fetches the last 3 days once, then serves the cache', async () => {
    const a = await adminUser()
    const first = await a.client.get('/api/cms/admin/analytics/clarity?report=overview')
    assert.equal(first.status, 200)
    assert.equal(first.body.data.cached, false)
    assert.equal(first.body.data.days, 3)
    assert.equal(first.body.data.metrics[0].metricName, 'Traffic')
    assert.match(calls[0]!, /numOfDays=3/)
    assert.doesNotMatch(calls[0]!, /dimension1/)

    const again = await a.client.get('/api/cms/admin/analytics/clarity?report=overview&refresh=1')
    assert.equal(again.body.data.cached, true, 'refresh within the first hour does not spend quota')
    assert.equal(calls.length, 1)

    await a.client.get('/api/cms/admin/analytics/clarity?report=pages')
    assert.match(calls[1]!, /dimension1=URL/)
  })

  it('refetches once the cache is old, and keeps old data if Clarity refuses', async () => {
    const a = await adminUser()
    await a.client.get('/api/cms/admin/analytics/clarity?report=sources')
    await query(`UPDATE cms_settings SET value = jsonb_set(value, '{fetchedAt}', to_jsonb((now() - interval '9 hours')::text)) WHERE key LIKE 'clarity_cache:%'`)

    nextStatus = 429
    const stale = await a.client.get('/api/cms/admin/analytics/clarity?report=sources')
    assert.equal(stale.status, 200)
    assert.equal(stale.body.data.cached, true)
    assert.equal(calls.length, 2)
  })

  it('explains a used-up quota when there is nothing cached', async () => {
    const a = await adminUser()
    nextStatus = 429
    const res = await a.client.get('/api/cms/admin/analytics/clarity?report=overview')
    assert.equal(res.status, 429)
    assert.match(res.body.error.message, /daily limit/)
  })

  it('reports status with links, and is admin-only', async () => {
    const a = await adminUser()
    const st = (await a.client.get('/api/cms/admin/analytics/status')).body.data
    assert.equal(st.enabled, true)
    assert.equal(st.tokenConfigured, true)
    assert.equal(st.links.dashboard, 'https://clarity.microsoft.com/projects/view/zjabfz0mvo/dashboard')
    assert.equal((await a.client.get('/api/cms/admin/analytics/clarity?report=nope')).status, 400)

    const student = await createUser(base, 'student')
    assert.equal((await student.client.get('/api/cms/admin/analytics/clarity')).status, 403)
    assert.equal((await student.client.get('/api/cms/admin/analytics/status')).status, 403)
  })
})
