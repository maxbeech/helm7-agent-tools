import { describe, it, expect } from 'vitest'
import { applyDefaults, camel, matchCommand, parseFlags, parseInvocation, validate, type FlagSpec, type ParsableCommand } from './args.js'

const SPECS: FlagSpec[] = [
  { name: 'product', type: 'string', summary: '', required: true },
  { name: 'limit', type: 'number', summary: '' },
  { name: 'dry-run', type: 'boolean', summary: '' },
  { name: 'json', type: 'boolean', summary: '' },
  { name: 'help', type: 'boolean', alias: 'h', summary: '' },
]

const COMMANDS: ParsableCommand[] = [
  { path: ['deploy'], flags: SPECS },
  { path: ['db', 'create'], flags: SPECS },
  { path: ['db', 'restore'], flags: SPECS },
  { path: ['env', 'set'], flags: SPECS, positionals: [{ name: 'KEY=VALUE', summary: '', required: true }] },
  { path: ['whoami'], flags: [] },
]

describe('camel', () => {
  it('turns a flag name into a handler key', () => {
    expect(camel('dry-run')).toBe('dryRun')
    expect(camel('idempotency-key')).toBe('idempotencyKey')
    expect(camel('json')).toBe('json')
  })
})

describe('matchCommand', () => {
  it('matches a two-word command before a one-word prefix', () => {
    expect(matchCommand(['db', 'create', '--product', 'p'], COMMANDS)?.command.path).toEqual(['db', 'create'])
  })

  it('returns the tokens after the command words', () => {
    expect(matchCommand(['db', 'create', '--product', 'p'], COMMANDS)?.rest).toEqual(['--product', 'p'])
  })

  it('stops collecting words at the first flag, so a value cannot look like a command', () => {
    expect(matchCommand(['deploy', '--product', 'db'], COMMANDS)?.command.path).toEqual(['deploy'])
  })

  it('does not match an unknown command', () => {
    expect(matchCommand(['destroy'], COMMANDS)).toBeUndefined()
    expect(matchCommand(['db', 'nope'], COMMANDS)).toBeUndefined()
  })
})

describe('parseFlags', () => {
  it('reads --flag value and --flag=value the same way', () => {
    expect(parseFlags(['--product', 'prd_1'], SPECS).flags).toEqual({ product: 'prd_1' })
    expect(parseFlags(['--product=prd_1'], SPECS).flags).toEqual({ product: 'prd_1' })
  })

  it('does not let a boolean flag swallow the next argument', () => {
    // --dry-run prd_1 must leave prd_1 alone, or the command runs against
    // nothing and complains about an argument the person did supply.
    const parsed = parseFlags(['--dry-run', 'prd_1'], SPECS)
    expect(parsed.flags).toEqual({ dryRun: true })
    expect(parsed.positionals).toEqual(['prd_1'])
  })

  it('supports --no-<flag> for a boolean', () => {
    expect(parseFlags(['--no-dry-run'], SPECS).flags).toEqual({ dryRun: false })
  })

  it('parses a number and refuses one that is not', () => {
    expect(parseFlags(['--limit', '25'], SPECS).flags).toEqual({ limit: 25 })
    expect(parseFlags(['--limit', 'lots'], SPECS).errors).toEqual(['--limit expects a number, got "lots"'])
  })

  it('reports an unknown flag rather than ignoring it', () => {
    expect(parseFlags(['--porduct', 'p'], SPECS).errors).toEqual(['unknown flag --porduct'])
  })

  it('reports a value flag left without a value', () => {
    expect(parseFlags(['--product'], SPECS).errors).toEqual(['--product expects a value'])
    expect(parseFlags(['--product', '--json'], SPECS).errors).toEqual(['--product expects a value'])
  })

  it('collects every mistake, not just the first', () => {
    expect(parseFlags(['--porduct', 'p', '--limit', 'lots'], SPECS).errors).toHaveLength(2)
  })

  it('treats everything after -- as positional', () => {
    const parsed = parseFlags(['--', '--product', '-x'], SPECS)
    expect(parsed.positionals).toEqual(['--product', '-x'])
    expect(parsed.errors).toEqual([])
  })

  it('accepts a short alias', () => {
    expect(parseFlags(['-h'], SPECS).flags).toEqual({ help: true })
  })
})

describe('applyDefaults', () => {
  it('fills only what was not given', () => {
    expect(applyDefaults({ product: 'typed' }, { product: 'config', env: 'preview' })).toEqual({
      product: 'typed',
      env: 'preview',
    })
  })
})

describe('validate', () => {
  const command = COMMANDS[1]!

  it('names a missing required flag', () => {
    expect(validate(command, {}, [])).toEqual(['--product is required'])
  })

  it('names a missing required positional', () => {
    expect(validate(COMMANDS[3]!, { product: 'p' }, [])).toEqual(['<KEY=VALUE> is required'])
  })

  it('refuses an argument the command does not take', () => {
    expect(validate(command, { product: 'p' }, ['extra'])).toEqual(['unexpected argument "extra"'])
  })
})

describe('parseInvocation', () => {
  it('shows help for no arguments at all', () => {
    expect(parseInvocation([], COMMANDS).kind).toBe('help')
  })

  it('answers --help for a command with that command’s help, even when the flags are wrong', () => {
    const result = parseInvocation(['db', 'create', '--porduct', '--help'], COMMANDS)
    expect(result.kind).toBe('help')
    expect(result.kind === 'help' && result.command?.path).toEqual(['db', 'create'])
  })

  it('reports an unknown command with a suggestion', () => {
    const result = parseInvocation(['dbb', 'create'], COMMANDS)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.suggestions).toContain('db create')
  })

  it('merges defaults before deciding what is missing', () => {
    const result = parseInvocation(['deploy'], COMMANDS, [], { product: 'prd_from_config' })
    expect(result.kind).toBe('invocation')
    if (result.kind !== 'invocation') return
    expect(result.invocation.errors).toEqual([])
    expect(result.invocation.flags.product).toBe('prd_from_config')
  })

  it('accepts global flags on any command', () => {
    const globals: FlagSpec[] = [{ name: 'base-url', type: 'string', summary: '' }]
    const result = parseInvocation(['whoami', '--base-url', 'https://x.test'], COMMANDS, globals)
    expect(result.kind === 'invocation' && result.invocation.flags.baseUrl).toBe('https://x.test')
  })
})

describe('a longer alias is a second spelling, not a short flag', () => {
  const specs: FlagSpec[] = [{ name: 'colour', type: 'boolean', alias: 'color', summary: '' }]

  it('accepts both spellings under one key', () => {
    expect(parseFlags(['--colour'], specs).flags).toEqual({ colour: true })
    expect(parseFlags(['--color'], specs).flags).toEqual({ colour: true })
    expect(parseFlags(['--no-color'], specs).flags).toEqual({ colour: false })
  })
})
