import { closePool } from '../db/pool.js'
import { DEFAULT_SEED, importCms } from '../cms/seed.js'

/**
 * Load CMS content (categories, domains, programmes) from a JSON file.
 *
 *   npm run cms:import                                     seeds/cms-initial.json, add what is missing
 *   npm run cms:import -- seeds/cms-initial.json --force   also overwrite existing programmes
 *
 * The API already does this by itself on its first start against an empty CMS
 * (see seedCmsIfEmpty), so this is only needed to re-import on purpose.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const file = args.find((a) => !a.startsWith('--')) ?? DEFAULT_SEED

  const r = await importCms(file, { force })
  console.log(
    `[cms-import] categories added: ${r.categories}, domains set: ${r.domainsSet ? 'yes' : 'kept existing'}, ` +
      `programmes added: ${r.added}${force ? `, overwritten: ${r.updated}` : ''}`
  )
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Failed:', (err as Error).message)
    await closePool().catch(() => {})
    process.exit(1)
  })
