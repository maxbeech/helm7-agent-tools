/**
 * Argument parsing, kept pure.
 *
 * Nothing in this file touches the network, the filesystem, the environment or
 * the process — it turns `string[]` into a described invocation and a list of
 * complaints. That is what makes the CLI's behaviour testable at all: the
 * alternative, a parser that reads `process.argv` and exits on a mistake, can
 * only be tested by launching a subprocess, which is slow enough that in
 * practice nobody writes the test for the twentieth flag.
 *
 * ERRORS ARE COLLECTED, NOT THROWN. Somebody who mistyped two flags should be
 * told about both, rather than fixing one and running again to discover the
 * next.
 */

export type FlagType = 'string' | 'boolean' | 'number'

export interface FlagSpec {
  /** Kebab-case, as typed: `dry-run`. */
  name: string
  type: FlagType
  summary: string
  /** Single-letter alias, without the dash. */
  alias?: string
  /** Placeholder shown in help, e.g. `<id>`. */
  placeholder?: string
  required?: boolean
}

export interface PositionalSpec {
  name: string
  summary: string
  required?: boolean
}

/** The shape of a command, as far as the parser is concerned. */
export interface ParsableCommand {
  /** Words that select the command, e.g. `['db', 'create']`. */
  path: string[]
  flags: FlagSpec[]
  positionals?: PositionalSpec[]
}

export type FlagValue = string | number | boolean
export type Flags = Record<string, FlagValue>

export interface Invocation<C extends ParsableCommand> {
  command: C
  flags: Flags
  positionals: string[]
  errors: string[]
}

export type ParseResult<C extends ParsableCommand> =
  | { kind: 'invocation'; invocation: Invocation<C> }
  | { kind: 'help'; command?: C }
  | { kind: 'version' }
  | { kind: 'error'; errors: string[]; suggestions?: string[] }

/** `dry-run` on the command line, `dryRun` in the handler. */
export function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

const isFlagToken = (token: string): boolean => token.startsWith('-') && token !== '-'

/**
 * Pick the command whose path is the longest prefix of the arguments.
 *
 * Longest-first matters: `cloud init` and a future bare `cloud` must not race,
 * and the shorter one would otherwise win purely by being declared first.
 */
export function matchCommand<C extends ParsableCommand>(
  argv: readonly string[],
  commands: readonly C[],
): { command: C; rest: string[] } | undefined {
  const words: string[] = []
  for (const token of argv) {
    if (isFlagToken(token)) break
    words.push(token)
  }
  const candidates = [...commands].sort((a, b) => b.path.length - a.path.length)
  for (const command of candidates) {
    if (command.path.length > words.length) continue
    if (command.path.every((word, i) => words[i] === word)) {
      return { command, rest: argv.slice(command.path.length) }
    }
  }
  return undefined
}

/** Commands sharing a stem with what was typed, for "did you mean" on a typo. */
export function suggestCommands<C extends ParsableCommand>(argv: readonly string[], commands: readonly C[]): string[] {
  const typed = argv[0]
  if (!typed) return []
  const stem = typed.slice(0, 2)
  return commands.filter((c) => (c.path[0] ?? '').startsWith(stem)).map((c) => c.path.join(' '))
}

/**
 * Parse flags and positionals for one command.
 *
 * A value-taking flag consumes the next token, which is why the specs have to
 * declare their types: without them `--dry-run prd_123` would swallow the
 * Product id and the command would run against nothing, reporting a missing
 * argument for a value the user did supply.
 */
export function parseFlags(tokens: readonly string[], specs: readonly FlagSpec[]): {
  flags: Flags
  positionals: string[]
  errors: string[]
} {
  const byName = new Map<string, FlagSpec>()
  for (const spec of specs) {
    byName.set(spec.name, spec)
    if (spec.alias) byName.set(spec.alias, spec)
  }

  const flags: Flags = {}
  const positionals: string[] = []
  const errors: string[] = []
  let literal = false

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!

    if (token === '--') {
      literal = true
      continue
    }
    if (literal || !isFlagToken(token)) {
      positionals.push(token)
      continue
    }

    const body = token.replace(/^--?/, '')
    const eq = body.indexOf('=')
    const rawName = eq === -1 ? body : body.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1)

    const negated = rawName.startsWith('no-') && byName.has(rawName.slice(3))
    const name = negated ? rawName.slice(3) : rawName
    const spec = byName.get(name)

    if (!spec) {
      errors.push(`unknown flag --${rawName}`)
      continue
    }

    const key = camel(spec.name)

    if (spec.type === 'boolean') {
      if (inlineValue !== undefined) flags[key] = inlineValue !== 'false'
      else flags[key] = !negated
      continue
    }

    const value = inlineValue ?? (i + 1 < tokens.length && !isFlagToken(tokens[i + 1]!) ? tokens[(i += 1)]! : undefined)
    if (value === undefined) {
      errors.push(`--${spec.name} expects a value`)
      continue
    }
    if (spec.type === 'number') {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) errors.push(`--${spec.name} expects a number, got "${value}"`)
      else flags[key] = parsed
      continue
    }
    flags[key] = value
  }

  return { flags, positionals, errors }
}

/** Fill flags the caller did not give from configuration or the environment. */
export function applyDefaults(flags: Flags, defaults: Readonly<Flags>): Flags {
  const filled: Flags = { ...flags }
  for (const [key, value] of Object.entries(defaults)) {
    if (filled[key] === undefined && value !== undefined) filled[key] = value
  }
  return filled
}

/** Missing required flags and positionals, named so the message says what to add. */
export function validate(command: ParsableCommand, flags: Flags, positionals: readonly string[]): string[] {
  const errors: string[] = []
  for (const spec of command.flags) {
    if (spec.required && flags[camel(spec.name)] === undefined) {
      errors.push(`--${spec.name} is required`)
    }
  }
  const expected = command.positionals ?? []
  expected.forEach((spec, index) => {
    if (spec.required && positionals[index] === undefined) errors.push(`<${spec.name}> is required`)
  })
  if (positionals.length > expected.length) {
    errors.push(`unexpected argument "${positionals[expected.length]}"`)
  }
  return errors
}

/**
 * The whole invocation: which command, with what, and everything wrong with it.
 *
 * `--help` wins over a validation error on purpose. Somebody who typed the
 * command wrongly and then asked for help is asking the right question, and
 * answering with a complaint instead of the help text is how a CLI makes a
 * person go and read a web page.
 */
export function parseInvocation<C extends ParsableCommand>(
  argv: readonly string[],
  commands: readonly C[],
  globalFlags: readonly FlagSpec[] = [],
  defaults: Readonly<Flags> = {},
): ParseResult<C> {
  if (argv.length === 0) return { kind: 'help' }
  if (argv.includes('--version') || argv.includes('-v')) return { kind: 'version' }

  const matched = matchCommand(argv, commands)
  const wantsHelp = argv.includes('--help') || argv.includes('-h')
  if (!matched) {
    if (wantsHelp) return { kind: 'help' }
    const words = argv.filter((t) => !isFlagToken(t))
    return {
      kind: 'error',
      errors: [`unknown command "${words.join(' ') || argv.join(' ')}"`],
      suggestions: suggestCommands(words, commands),
    }
  }
  if (wantsHelp) return { kind: 'help', command: matched.command }

  const specs = [...matched.command.flags, ...globalFlags]
  const parsed = parseFlags(matched.rest, specs)
  const flags = applyDefaults(parsed.flags, defaults)

  return {
    kind: 'invocation',
    invocation: {
      command: matched.command,
      flags,
      positionals: parsed.positionals,
      errors: [...parsed.errors, ...validate(matched.command, flags, parsed.positionals)],
    },
  }
}
