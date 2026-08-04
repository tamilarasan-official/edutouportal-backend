import { z } from 'zod'
import {
  findRelationship,
  getTable,
  hasColumn,
  isTable,
  type TableName,
} from './schema.js'
import type { PolicyResult, RowFilter } from './policies.js'

/**
 * Safe SQL construction for the generic query endpoint.
 *
 * The only text that ever reaches Postgres from this module is either a
 * constant, or an identifier that has been matched against the table registry.
 * Every value is a bound parameter. There is no path by which request text
 * becomes SQL text.
 */

export class QueryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'BAD_REQUEST'
  ) {
    super(message)
    this.name = 'QueryError'
  }
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

const FILTER_OPS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in',
] as const

export const QueryRequestSchema = z.object({
  table: z.string(),
  op: z.enum(['select', 'insert', 'update', 'delete']),
  select: z.string().optional(),
  filters: z
    .array(
      z.object({
        column: z.string(),
        op: z.enum(FILTER_OPS),
        value: z.unknown(),
        negate: z.boolean().optional(),
      })
    )
    .max(30)
    .optional(),
  order: z
    .array(
      z.object({
        column: z.string(),
        ascending: z.boolean().default(true),
        nullsFirst: z.boolean().optional(),
      })
    )
    .max(5)
    .optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
  /** 'single' errors unless exactly one row; 'maybe' allows zero or one. */
  cardinality: z.enum(['many', 'single', 'maybe']).default('many'),
  /** Insert/update payload. */
  values: z.union([z.record(z.unknown()), z.array(z.record(z.unknown())).max(500)]).optional(),
  /** Return the affected rows (PostgREST returns them by default). */
  returning: z.boolean().default(true),
  /** Include an exact row count, for `{ count: 'exact' }`. */
  count: z.boolean().default(false),
  /** Ignore conflicts on insert, for upsert-ish behaviour. */
  ignoreDuplicates: z.boolean().default(false),
})

export type QueryRequest = z.infer<typeof QueryRequestSchema>

// ---------------------------------------------------------------------------
// Parameter accumulator
// ---------------------------------------------------------------------------

class Params {
  private readonly values: unknown[] = []

  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }

  /** Splice a policy filter's `$$` markers into real placeholders. */
  inline(filter: RowFilter): string {
    let index = 0
    const sql = filter.sql.replace(/\$\$/g, () => {
      const param = filter.params[index]
      index += 1
      return this.add(param)
    })
    if (index !== filter.params.length) {
      throw new QueryError('Malformed policy filter', 500, 'INTERNAL')
    }
    return sql
  }

  all(): unknown[] {
    return this.values
  }
}

// ---------------------------------------------------------------------------
// Identifier quoting
// ---------------------------------------------------------------------------

/**
 * Quote an identifier that has ALREADY been validated against the registry.
 * The doubling of `"` is belt-and-braces: registry names never contain quotes.
 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// ---------------------------------------------------------------------------
// Select-list parsing (including PostgREST resource embedding)
// ---------------------------------------------------------------------------

interface ParsedSelect {
  readonly columns: string[]
  readonly embeds: Array<{ alias: string; columns: string[] }>
}

/**
 * Split a select string on commas that are not inside parentheses.
 *   "id, full_name, profiles:user_id (full_name, email)"
 *     -> ["id", "full_name", "profiles:user_id (full_name, email)"]
 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''

  for (const char of input) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)

  if (depth !== 0) throw new QueryError('Unbalanced parentheses in select')
  return parts.map((p) => p.trim()).filter(Boolean)
}

function parseSelect(table: TableName, select: string | undefined): ParsedSelect {
  const def = getTable(table)

  if (!select || select.trim() === '*') {
    return { columns: [...def.columns], embeds: [] }
  }

  const columns: string[] = []
  const embeds: Array<{ alias: string; columns: string[] }> = []

  for (const token of splitTopLevel(select)) {
    const open = token.indexOf('(')

    // Plain column, or `*`.
    if (open === -1) {
      if (token === '*') {
        columns.push(...def.columns)
        continue
      }
      // PostgREST allows `alias:column`; we only need the column itself.
      const column = token.includes(':') ? token.split(':')[1]!.trim() : token
      if (!hasColumn(table, column)) {
        throw new QueryError(`Unknown column "${column}" on ${table}`)
      }
      columns.push(column)
      continue
    }

    // Embedded relation: `alias:hint (cols)` or `table (cols)`.
    if (!token.endsWith(')')) throw new QueryError('Malformed embedded select')

    const head = token.slice(0, open).trim()
    const body = token.slice(open + 1, -1).trim()
    const alias = (head.includes(':') ? head.split(':')[0]! : head).trim()

    const rel = findRelationship(table, alias)
    if (!rel) {
      throw new QueryError(`No relationship "${alias}" defined on ${table}`)
    }

    const foreignDef = getTable(rel.table)
    const foreignColumns =
      body === '*' || body === ''
        ? [...foreignDef.columns]
        : splitTopLevel(body).map((c) => {
            const column = c.includes(':') ? c.split(':')[1]!.trim() : c
            if (!hasColumn(rel.table, column)) {
              throw new QueryError(`Unknown column "${column}" on ${rel.table}`)
            }
            return column
          })

    embeds.push({ alias, columns: foreignColumns })
  }

  // The primary key is always needed so the client can key rows.
  if (!columns.includes('id') && hasColumn(table, 'id')) columns.unshift('id')

  return { columns: [...new Set(columns)], embeds }
}

function buildSelectList(table: TableName, parsed: ParsedSelect): string {
  const pieces = parsed.columns.map((c) => `t.${ident(c)}`)

  for (const embed of parsed.embeds) {
    const rel = findRelationship(table, embed.alias)!
    const foreign = ident(rel.table)
    const inner = embed.columns.map((c) => `f.${ident(c)}`).join(', ')
    const join = `f.${ident(rel.foreignColumn)} = t.${ident(rel.localColumn)}`

    // Scalar subquery rather than a JOIN: it cannot multiply the outer rows,
    // which keeps LIMIT and count correct.
    if (rel.cardinality === 'one') {
      pieces.push(
        `(SELECT to_jsonb(sub) FROM (SELECT ${inner} FROM ${foreign} f WHERE ${join}) sub) AS ${ident(embed.alias)}`
      )
    } else {
      pieces.push(
        `(SELECT COALESCE(jsonb_agg(to_jsonb(sub)), '[]'::jsonb)
            FROM (SELECT ${inner} FROM ${foreign} f WHERE ${join}) sub) AS ${ident(embed.alias)}`
      )
    }
  }

  return pieces.join(', ')
}

// ---------------------------------------------------------------------------
// WHERE construction
// ---------------------------------------------------------------------------

function buildWhere(
  table: TableName,
  request: QueryRequest,
  policy: Extract<PolicyResult, { allow: true }>,
  params: Params
): string {
  const clauses: string[] = []

  for (const filter of request.filters ?? []) {
    if (!hasColumn(table, filter.column)) {
      throw new QueryError(`Unknown column "${filter.column}" on ${table}`)
    }
    const column = `t.${ident(filter.column)}`
    let clause: string

    switch (filter.op) {
      case 'eq':
        clause = `${column} = ${params.add(filter.value)}`
        break
      case 'neq':
        clause = `${column} <> ${params.add(filter.value)}`
        break
      case 'gt':
        clause = `${column} > ${params.add(filter.value)}`
        break
      case 'gte':
        clause = `${column} >= ${params.add(filter.value)}`
        break
      case 'lt':
        clause = `${column} < ${params.add(filter.value)}`
        break
      case 'lte':
        clause = `${column} <= ${params.add(filter.value)}`
        break
      case 'like':
        clause = `${column}::text LIKE ${params.add(filter.value)}`
        break
      case 'ilike':
        clause = `${column}::text ILIKE ${params.add(filter.value)}`
        break
      case 'is':
        // Only NULL / true / false are meaningful, and each is a literal.
        if (filter.value === null) clause = `${column} IS NULL`
        else if (filter.value === true) clause = `${column} IS TRUE`
        else if (filter.value === false) clause = `${column} IS FALSE`
        else throw new QueryError('`is` accepts only null, true or false')
        break
      case 'in': {
        if (!Array.isArray(filter.value)) throw new QueryError('`in` requires an array')
        if (filter.value.length === 0) {
          // `IN ()` is a syntax error; an empty set matches nothing.
          clause = 'false'
          break
        }
        clause = `${column} = ANY(${params.add(filter.value)})`
        break
      }
      default:
        throw new QueryError(`Unsupported operator`)
    }

    clauses.push(filter.negate ? `NOT (${clause})` : clause)
  }

  if (policy.filter) {
    clauses.push(`(${params.inline(policy.filter)})`)
  }

  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}

function buildOrderLimit(table: TableName, request: QueryRequest, params: Params): string {
  let sql = ''

  if (request.order?.length) {
    const terms = request.order.map((o) => {
      if (!hasColumn(table, o.column)) {
        throw new QueryError(`Cannot order by unknown column "${o.column}"`)
      }
      const direction = o.ascending ? 'ASC' : 'DESC'
      // Match PostgREST's default: nulls sort last ascending, first descending.
      const nulls =
        o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'
      return `t.${ident(o.column)} ${direction}${nulls}`
    })
    sql += ` ORDER BY ${terms.join(', ')}`
  }

  if (request.limit !== undefined) sql += ` LIMIT ${params.add(request.limit)}`
  if (request.offset !== undefined) sql += ` OFFSET ${params.add(request.offset)}`

  return sql
}

// ---------------------------------------------------------------------------
// Payload sanitising
// ---------------------------------------------------------------------------

function sanitiseRow(
  table: TableName,
  row: Record<string, unknown>,
  allowed: readonly string[],
  force: Readonly<Record<string, unknown>> | undefined,
  operation: 'insert' | 'update'
): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  const jsonColumns = getTable(table).jsonColumns ?? []

  for (const [key, value] of Object.entries(row)) {
    if (!allowed.includes(key)) {
      // Silently dropping would hide privilege-escalation attempts (e.g. a
      // student sending role:'admin'). Fail loudly instead.
      throw new QueryError(`Column "${key}" is not writable on ${table} (${operation})`)
    }
    // jsonb columns must be bound as a JSON string: node-postgres turns a JS
    // array into a Postgres ARRAY literal, which a jsonb column rejects.
    clean[key] =
      jsonColumns.includes(key) && value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : value
  }

  // Server-controlled columns always win over anything the client sent.
  if (force) Object.assign(clean, force)

  if (Object.keys(clean).length === 0) {
    throw new QueryError(`No writable columns supplied for ${table}`)
  }

  return clean
}

// ---------------------------------------------------------------------------
// Statement builders
// ---------------------------------------------------------------------------

export interface BuiltQuery {
  readonly text: string
  readonly params: unknown[]
  readonly countText?: string
  readonly countParams?: unknown[]
}

export function buildQuery(
  request: QueryRequest,
  policy: Extract<PolicyResult, { allow: true }>
): BuiltQuery {
  if (!isTable(request.table)) {
    throw new QueryError(`Unknown table "${request.table}"`, 404, 'UNKNOWN_TABLE')
  }
  const table = request.table
  const def = getTable(table)
  const relation = ident(table)

  switch (request.op) {
    // -----------------------------------------------------------------------
    case 'select': {
      const params = new Params()
      const parsed = parseSelect(table, request.select)
      const where = buildWhere(table, request, policy, params)
      const tail = buildOrderLimit(table, request, params)

      const text = `SELECT ${buildSelectList(table, parsed)} FROM ${relation} t ${where}${tail}`

      if (!request.count) return { text, params: params.all() }

      // Count needs its own parameter numbering, so rebuild the WHERE clause.
      const countParams = new Params()
      const countWhere = buildWhere(table, request, policy, countParams)
      return {
        text,
        params: params.all(),
        countText: `SELECT count(*)::int AS count FROM ${relation} t ${countWhere}`,
        countParams: countParams.all(),
      }
    }

    // -----------------------------------------------------------------------
    case 'insert': {
      if (!request.values) throw new QueryError('insert requires values')
      const params = new Params()

      const rows = (Array.isArray(request.values) ? request.values : [request.values]).map((r) =>
        sanitiseRow(table, r, def.insertable, policy.force, 'insert')
      )
      if (rows.length === 0) throw new QueryError('insert requires at least one row')

      // Every row must have identical columns for a single multi-row VALUES.
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
      const tuples = rows.map(
        (row) => `(${columns.map((c) => params.add(row[c] ?? null)).join(', ')})`
      )

      // An insert policy filter behaves like a WITH CHECK constraint: it must
      // hold for the row being written. It cannot be expressed in this
      // statement (the row does not exist yet, and a bare VALUES list has no
      // inferable column types), so routes.ts runs the insert inside a
      // transaction and re-checks the returned ids against the filter before
      // committing. See `buildInsertCheck` below.
      const conflict = request.ignoreDuplicates ? ' ON CONFLICT DO NOTHING' : ''
      const returning = request.returning
        ? ` RETURNING ${def.columns.map((c) => ident(c)).join(', ')}`
        : ''

      const text =
        `INSERT INTO ${relation} (${columns.map(ident).join(', ')}) ` +
        `VALUES ${tuples.join(', ')}${conflict}${returning}`

      return { text, params: params.all() }
    }

    // -----------------------------------------------------------------------
    case 'update': {
      if (!request.values || Array.isArray(request.values)) {
        throw new QueryError('update requires a single values object')
      }
      const params = new Params()
      const row = sanitiseRow(table, request.values, def.updatable, policy.force, 'update')

      const assignments = Object.entries(row)
        .map(([column, value]) => `${ident(column)} = ${params.add(value)}`)
        .join(', ')

      const where = buildWhere(table, request, policy, params)
      if (!where) {
        // A filterless UPDATE would rewrite the entire table.
        throw new QueryError('update requires at least one filter', 400, 'UNSAFE_UPDATE')
      }

      const returning = request.returning
        ? ` RETURNING ${def.columns.map((c) => ident(c)).join(', ')}`
        : ''

      return {
        text: `UPDATE ${relation} t SET ${assignments} ${where}${returning}`,
        params: params.all(),
      }
    }

    // -----------------------------------------------------------------------
    case 'delete': {
      const params = new Params()
      const where = buildWhere(table, request, policy, params)
      if (!where) {
        throw new QueryError('delete requires at least one filter', 400, 'UNSAFE_DELETE')
      }

      const returning = request.returning
        ? ` RETURNING ${def.columns.map((c) => ident(c)).join(', ')}`
        : ''

      return {
        text: `DELETE FROM ${relation} t ${where}${returning}`,
        params: params.all(),
      }
    }
  }
}

/**
 * Post-insert verification for tables whose insert policy carries a row filter.
 *
 * Returns a query that counts how many of the just-inserted ids actually
 * satisfy the policy. The caller compares it to the number of rows inserted and
 * rolls back on a mismatch, which gives WITH CHECK semantics without needing
 * type information for a bare VALUES list.
 */
export function buildInsertCheck(
  table: TableName,
  ids: unknown[],
  filter: RowFilter
): { text: string; params: unknown[] } {
  const params = new Params()
  const idList = params.add(ids)
  const condition = params.inline(filter)
  return {
    text: `SELECT count(*)::int AS count FROM ${ident(table)} t WHERE t."id" = ANY(${idList}) AND (${condition})`,
    params: params.all(),
  }
}

/**
 * Strip redacted columns from rows the actor does not own.
 */
export function applyRedaction(
  rows: Record<string, unknown>[],
  redact: readonly string[] | undefined,
  ownerColumn: string | undefined,
  actorId: string
): Record<string, unknown>[] {
  if (!redact || redact.length === 0) return rows

  return rows.map((row) => {
    if (ownerColumn && row[ownerColumn] === actorId) return row
    const copy = { ...row }
    for (const column of redact) delete copy[column]
    return copy
  })
}
