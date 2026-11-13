/**
 * Everything the CLI prints, and nothing that decides when to print it.
 *
 * Pure functions over plain data: no `process`, no `console`, no client. The
 * plan renderer is the piece worth protecting that way — it is the output a
 * person reads before agreeing to spend money or destroy a database, so it has
 * to be exercised by tests over fixtures rather than eyeballed once.
 *
 * COLOUR IS A PARAMETER, NOT A LOOKUP. A renderer that asked `process.stdout`
 * whether it was a terminal would emit escape codes into a pipe on any machine
 * where that lookup was wrong, and the escape codes land in whatever log or
 * pull request the output was piped into. The caller decides; this only obeys.
 */
import type { Plan, PlanChange } from '@helm7/sdk'

export interface RenderOptions {
  colour?: boolean
  /**
   * Whether the caller asked for a dry run. `applied: false` has two causes —
   * a dry run, and a destructive call refused for want of `--confirm` — and
   * only the caller knows which happened. Telling somebody to drop `--dry-run`
   * when what they actually need is `--confirm` sends them round the loop
   * again.
   */
  dryRun?: boolean
}

const ESC = String.fromCharCode(27)

const STYLE = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
} as const

type StyleName = keyof typeof STYLE

const paint = (colour: boolean, style: StyleName, text: string): string =>
  colour ? `${STYLE[style]}${text}${STYLE.reset}` : text

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - text.length))

const ACTION_MARK: Record<PlanChange['action'], { mark: string; style: StyleName }> = {
  create: { mark: '+', style: 'green' },
  update: { mark: '~', style: 'yellow' },
  delete: { mark: '-', style: 'red' },
  'no-op': { mark: '=', style: 'dim' },
}

/** Does this look like the plan every mutating operation returns? */
export function isPlan(value: unknown): value is Plan {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Plan>
  return Array.isArray(candidate.changes) && Array.isArray(candidate.destructive_actions)
}

const money = (amount: number): string => amount.toFixed(2)

const signed = (amount: number): string => (amount > 0 ? `+${money(amount)}` : money(amount))

function renderCost(plan: Plan, colour: boolean): string[] {
  const cost = plan.cost
  if (!cost) return []
  const currency = cost.currency ?? 'USD'
  const range =
    cost.monthly_low === cost.monthly_high
      ? `${currency} ${money(cost.monthly_high)}`
      : `${currency} ${money(cost.monthly_low)} to ${money(cost.monthly_high)}`

  let delta = ''
  if (typeof cost.delta_low === 'number' && typeof cost.delta_high === 'number') {
    delta =
      cost.delta_low === 0 && cost.delta_high === 0
        ? '  (no change to the bill)'
        : `  (${signed(cost.delta_low)} to ${signed(cost.delta_high)})`
  }

  const lines = [`${paint(colour, 'bold', 'Cost')}  ${range} per month${delta}`]
  if (cost.main_driver) lines.push(`      ${paint(colour, 'dim', `largest driver: ${cost.main_driver}`)}`)
  // An estimate from current shape and recent usage, not a quote. Saying so in
  // the output is cheaper than the conversation that follows a surprise bill.
  lines.push(`      ${paint(colour, 'dim', 'estimate, not a quote')}`)
  return lines
}

/**
 * The plan, as a person should read it: one line per change, aligned, with the
 * irreversible parts called out separately from the list rather than hidden as
 * a flag on a row somebody skims past.
 */
export function renderPlan(plan: Plan, options: RenderOptions = {}): string {
  const colour = options.colour ?? false
  const changes = plan.changes ?? []
  const destructive = changes.filter((c) => c.destructive).length

  const headline =
    changes.length === 0
      ? 'Plan  no changes'
      : `Plan  ${changes.length} change${changes.length === 1 ? '' : 's'}` +
        (destructive ? `, ${destructive} destructive` : '')

  const lines: string[] = [paint(colour, 'bold', headline)]

  if (changes.length > 0) {
    lines.push('')
    const resourceWidth = Math.max(...changes.map((c) => c.resource?.length ?? 0))
    const nameWidth = Math.max(...changes.map((c) => c.name?.length ?? 0))
    for (const change of changes) {
      const shape = ACTION_MARK[change.action] ?? ACTION_MARK['no-op']
      const row = `${shape.mark} ${pad(change.resource ?? '', resourceWidth)}  ${pad(change.name ?? '', nameWidth)}`
      const detail = change.detail ? `  ${paint(colour, 'dim', change.detail)}` : ''
      lines.push(`  ${paint(colour, shape.style, row)}${detail}`)
    }
  }

  const cost = renderCost(plan, colour)
  if (cost.length > 0) lines.push('', ...cost)

  const irreversible = plan.destructive_actions ?? []
  if (irreversible.length > 0) {
    lines.push('', paint(colour, 'red', paint(colour, 'bold', 'Irreversible')))
    for (const action of irreversible) lines.push(`  ${paint(colour, 'red', '!')} ${action}`)
  }

  lines.push('')
  if (plan.applied) {
    lines.push(paint(colour, 'green', 'Applied.'))
  } else if (options.dryRun) {
    lines.push(paint(colour, 'cyan', 'Nothing was applied: this was a dry run.'))
    lines.push(paint(colour, 'dim', 'Re-run without --dry-run to apply it.'))
  } else {
    lines.push(paint(colour, 'yellow', 'Nothing was applied: this change needs confirmation.'))
    lines.push(paint(colour, 'dim', 'Re-run with --confirm once the irreversible list above is acceptable.'))
  }

  return lines.join('\n')
}

export interface RenderableError {
  code: string
  message: string
  remedy?: string
  docsUrl?: string
  requestId?: string
}

/**
 * Normalise anything thrown into something printable.
 *
 * Duck-typed rather than `instanceof Helm7Error` so this module stays free of
 * runtime imports — and because a client built against a different copy of the
 * SDK still throws the same shape, where `instanceof` would quietly fall
 * through to "unknown error" and lose the remedy.
 */
export function toRenderableError(error: unknown): RenderableError {
  if (typeof error === 'object' && error !== null) {
    const shape = error as { code?: unknown; message?: unknown; remedy?: unknown; docsUrl?: unknown; requestId?: unknown }
    if (typeof shape.code === 'string' && typeof shape.message === 'string') {
      return {
        code: shape.code,
        message: shape.message,
        remedy: typeof shape.remedy === 'string' ? shape.remedy : undefined,
        docsUrl: typeof shape.docsUrl === 'string' ? shape.docsUrl : undefined,
        requestId: typeof shape.requestId === 'string' ? shape.requestId : undefined,
      }
    }
    if (error instanceof Error) return { code: 'cli_error', message: error.message }
  }
  return { code: 'cli_error', message: String(error) }
}

export function renderError(error: unknown, options: RenderOptions = {}): string {
  const colour = options.colour ?? false
  const { code, message, remedy, docsUrl, requestId } = toRenderableError(error)
  const lines = [`${paint(colour, 'red', code)}: ${message}`]
  if (remedy) lines.push(`  ${paint(colour, 'bold', 'remedy')}: ${remedy}`)
  if (docsUrl) lines.push(`  ${paint(colour, 'dim', `docs: ${docsUrl}`)}`)
  if (requestId) lines.push(`  ${paint(colour, 'dim', `request id: ${requestId}`)}`)
  return lines.join('\n')
}

/** A list envelope, a log tail, an identity — anything that is not a plan. */
export function renderResult(value: unknown, options: RenderOptions = {}): string {
  const colour = options.colour ?? false
  if (value === undefined || value === null) return 'Done.'
  if (isPlan(value)) {
    // A `db execute` dry run that ends in a SELECT or RETURNING says what it
    // would have produced; dropping that would hide the reason to rehearse it.
    const produced = (value as { rows?: unknown }).rows
    const plan = renderPlan(value, options)
    return Array.isArray(produced) && produced.length > 0 ? `${renderRows(produced, colour)}\n\n${plan}` : plan
  }

  // `db query`: rows of one shape, plus whether the limit cut them short.
  const queried = value as { rows?: unknown; row_count?: unknown; truncated?: unknown }
  if (Array.isArray(queried.rows)) {
    const count = typeof queried.row_count === 'number' ? queried.row_count : queried.rows.length
    const footer = `${count} row${count === 1 ? '' : 's'}${queried.truncated === true ? ', more were cut off by the limit (raise --limit, up to 1000)' : ''}`
    return `${renderRows(queried.rows, colour)}\n${paint(colour, 'dim', footer)}`
  }

  const rows = (value as { data?: unknown }).data
  if (Array.isArray(rows)) {
    if (rows.length === 0) return paint(colour, 'dim', 'Nothing to show.')
    return rows.map((row) => renderRecord(row, colour)).join('\n')
  }
  return renderRecord(value, colour)
}

const cell = (raw: unknown): string =>
  raw === null || raw === undefined ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw)

/**
 * Rows as a table, columns in the order each first appears.
 *
 * Cells are cut at 60 characters in a terminal because one long text column
 * would push every other one off the screen; `--json` has the whole value.
 */
export function renderRows(rows: unknown[], colour = false): string {
  const objects = rows.map((row) => (typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : { value: row }))
  if (objects.length === 0) return paint(colour, 'dim', '(no rows)')
  const columns: string[] = []
  for (const row of objects) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  const clip = (raw: string) => {
    const text = raw.replace(/\s+/g, ' ')
    return text.length > 60 ? `${text.slice(0, 59)}…` : text
  }
  const body = objects.map((row) => columns.map((column) => clip(cell(row[column]))))
  const widths = columns.map((column, i) => Math.max(column.length, ...body.map((line) => line[i]!.length)))
  const line = (cells: string[]) => cells.map((text, i) => pad(text, widths[i]!)).join('  ').trimEnd()
  return [paint(colour, 'bold', line(columns)), paint(colour, 'dim', line(widths.map((w) => '-'.repeat(w)))), ...body.map(line)].join('\n')
}

/**
 * One object as aligned `key  value` lines.
 *
 * Nested objects are printed as compact JSON rather than flattened: a reader
 * who needs the inside of one can ask for --json, and a flattening that invents
 * dotted key names would have them typing paths that exist nowhere else.
 */
export function renderRecord(value: unknown, colour = false): string {
  if (typeof value !== 'object' || value === null) return String(value)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return paint(colour, 'dim', '(empty)')
  const keyWidth = Math.max(...entries.map(([key]) => key.length))
  return entries
    .map(([key, raw]) => {
      const printed =
        raw === null || raw === undefined
          ? paint(colour, 'dim', '—')
          : typeof raw === 'object'
            ? JSON.stringify(raw)
            : String(raw)
      return `${paint(colour, 'dim', pad(key, keyWidth))}  ${printed}`
    })
    .join('\n')
}
