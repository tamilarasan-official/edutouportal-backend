import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { queryOne, transaction } from '../db/pool.js'
import { categoryInputSchema, programmeInputSchema, settingsSchemas } from './schema.js'

/**
 * Load CMS content (categories, domain filters, programmes) from a seed file.
 *
 * Rows that already exist are left alone unless `force` is set, so re-running
 * it never undoes edits made in the admin.
 */

export const DEFAULT_SEED = join(process.cwd(), 'seeds', 'cms-initial.json')

const seedSchema = z.object({
  categories: z.array(categoryInputSchema),
  domains: z.array(z.string()),
  programmes: z.array(programmeInputSchema),
})

export interface SeedResult {
  categories: number
  domainsSet: boolean
  added: number
  updated: number
}

export async function importCms(file: string, { force = false } = {}): Promise<SeedResult> {
  const seed = seedSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const domains = settingsSchemas.domains.parse({ items: seed.domains })

  return transaction(async (client) => {
    let categories = 0
    for (const c of seed.categories) {
      const r = await client.query(
        `INSERT INTO cms_categories (id, title, description, sort_order) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.title, c.description, c.sortOrder]
      )
      categories += r.rowCount ?? 0
    }

    const d = await client.query(
      `INSERT INTO cms_settings (key, value) VALUES ('domains', $1) ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(domains)]
    )

    let added = 0
    let updated = 0
    for (const p of seed.programmes) {
      const r = await client.query(
        `INSERT INTO cms_programmes (slug, status, sort_order, data, published_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $2 = 'published' THEN now() END)
         ON CONFLICT (slug) DO ${force ? 'UPDATE SET status = EXCLUDED.status, sort_order = EXCLUDED.sort_order, data = EXCLUDED.data, updated_at = now()' : 'NOTHING'}
         RETURNING (xmax = 0) AS inserted`,
        [p.slug, p.status, p.sortOrder, JSON.stringify(p.data)]
      )
      const row = r.rows[0] as { inserted: boolean } | undefined
      if (row?.inserted) added += 1
      else if (row) updated += 1
    }
    return { categories, domainsSet: (d.rowCount ?? 0) > 0, added, updated }
  })
}

/**
 * Startup hook: fill the CMS from the seed file the first time the API runs
 * against a database whose CMS is still empty. Once anything exists -- even if
 * an admin later deletes every programme -- it never runs again, because the
 * categories remain.
 */
export async function seedCmsIfEmpty(file = DEFAULT_SEED): Promise<SeedResult | null> {
  const row = await queryOne<{ categories: number; programmes: number }>(
    `SELECT (SELECT count(*)::int FROM cms_categories) AS categories,
            (SELECT count(*)::int FROM cms_programmes) AS programmes`
  )
  if ((row?.categories ?? 0) > 0 || (row?.programmes ?? 0) > 0) return null

  try {
    await readFile(file)
  } catch {
    console.warn(`[cms] seed file not found at ${file}; starting with an empty CMS`)
    return null
  }
  const result = await importCms(file)
  console.log(
    `[cms] first start: imported ${result.categories} categories and ${result.added} programmes from ${file}`
  )
  return result
}
