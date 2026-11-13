import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { OPERATIONS, getOperation, pathParams } from '@helm7/catalogue'
import { COMMANDS, GLOBAL_FLAGS, MUTATION_FLAGS, csv, mutationFrom, parseAssignment, parsePublicPorts } from './commands.js'
import { parseInvocation } from './args.js'

/**
 * The CLI's half of the catalogue contract.
 *
 * `@helm7/catalogue` is a dev dependency only — the published CLI depends on
 * nothing but the SDK — but a test may reach for it, and this is the one place
 * worth doing so: a command naming an operation the platform does not have
 * fails on the wire as a 404, which on a terminal reads like a Product that
 * vanished rather than like a CLI that is out of date.
 */
describe('commands agree with the catalogue', () => {
  for (const command of COMMANDS) {
    const name = command.path.join(' ')

    it(`${name} names an operation that exists`, () => {
      expect(getOperation(command.operation), `${name} calls unknown operation ${command.operation}`).toBeDefined()
    })

    it(`${name} attaches the mutation controls exactly when the operation has them`, () => {
      const operation = getOperation(command.operation)!
      const hasControls = Boolean(operation.input?.properties?.dry_run)
      expect(command.mutating, `${name} disagrees with ${command.operation} about dry_run`).toBe(hasControls)
    })

    it(`${name} can supply every path param the operation needs`, () => {
      const operation = getOperation(command.operation)!
      const required =
        command.flags.filter((f) => f.required).length + (command.positionals ?? []).filter((p) => p.required).length
      expect(required, `${name} cannot fill ${operation.path}`).toBeGreaterThanOrEqual(pathParams(operation).length)
    })
  }

  it('offers --dry-run, --confirm and --idempotency-key on every mutating command', () => {
    for (const command of COMMANDS.filter((c) => c.mutating)) {
      const names = command.flags.map((f) => f.name)
      for (const control of MUTATION_FLAGS.map((f) => f.name)) {
        expect(names, `${command.path.join(' ')} is missing --${control}`).toContain(control)
      }
    }
  })

  it('asks for a Product wherever the operation is scoped to one', () => {
    for (const command of COMMANDS) {
      const operation = getOperation(command.operation)!
      if (!pathParams(operation).includes('productId')) continue
      const hasFlag = command.flags.some((f) => f.name === 'product' && f.required)
      const hasPositional = (command.positionals ?? []).some((p) => p.name === 'productId' && p.required)
      expect(hasFlag || hasPositional, `${command.path.join(' ')} never asks which Product`).toBe(true)
    }
  })
})

/**
 * The CLI has to reach everything the platform can do.
 *
 * The product promise is that every function is available from every surface:
 * the REST API, the MCP server and the CLI. The first two derive from the
 * catalogue, so they cannot fall behind; the CLI is a hand-written table, so
 * this is what stops it. Adding an operation to the catalogue without a command
 * fails here, naming the operation.
 */
const EXEMPT: Record<string, string> = {
  // `deploy --build local` is how these are called: it builds the image, then
  // streams it to the first and closes with the second. They carry raw image
  // bytes in base64 chunks with offsets, so a command a person typed would need
  // an image tarball and a sha256 they have no way to produce. The test below
  // checks local-build.ts still calls both, so this cannot go stale.
  deployment_image_upload: 'called by `deploy --build local` (local-build.ts)',
  deployment_image_finish: 'called by `deploy --build local` (local-build.ts)',
}

describe('every operation is reachable from the CLI', () => {
  const named = new Set(COMMANDS.map((c) => c.operation))

  for (const operation of OPERATIONS) {
    if (operation.id in EXEMPT) continue
    it(`${operation.id} has a command`, () => {
      expect(named.has(operation.id), `${operation.id} is in the catalogue but no command in commands.ts names it. Add one, so the CLI keeps pace with the API and MCP.`).toBe(true)
    })
  }

  it('keeps the exempt list honest', () => {
    const localBuild = readFileSync(new URL('./local-build.ts', import.meta.url), 'utf8')
    for (const id of Object.keys(EXEMPT)) {
      expect(getOperation(id), `${id} is exempt but no longer in the catalogue`).toBeDefined()
      expect(named.has(id), `${id} is exempt but has a command; remove it from EXEMPT`).toBe(false)
    }
    expect(localBuild).toContain('uploadImageChunk')
    expect(localBuild).toContain('finishImage')
  })
})

describe('the command surface', () => {
  const paths = COMMANDS.map((c) => c.path.join(' '))

  it('covers the documented commands', () => {
    expect(paths.sort()).toEqual(
      [
        'activity',
        'auth enable',
        'auth import',
        'auth status',
        'auth update',
        'billing checkout',
        'billing portal',
        'bucket create',
        'bucket delete',
        'bucket list',
        'cloud claim',
        'cloud init',
        'context enable',
        'cost estimate',
        'db backup',
        'db create',
        'db execute',
        'db inspect',
        'db query',
        'db restore',
        'deploy',
        'deployment inspect',
        'deployment list',
        'domain add',
        'domain list',
        'domain remove',
        'env list',
        'env set',
        'env unset',
        'environment create',
        'environment delete',
        'environment list',
        'init',
        'key create',
        'key list',
        'key revoke',
        'logs',
        'member invite',
        'member list',
        'member remove',
        'product connect',
        'product delete',
        'product rename',
        'product inspect',
        'product list',
        'queue',
        'queue first',
        'queue order',
        'repos',
        'rollback',
        'service create',
        'service delete',
        'service list',
        'service update',
        'settings',
        'settings set',
        'test-accounts checkout',
        'test-accounts create',
        'test-accounts delete',
        'test-accounts get',
        'test-accounts list',
        'test-accounts rotate',
        'test-accounts totp',
        'usage',
        'whoami',
      ].sort(),
    )
  })

  it('declares no command twice', () => {
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('reaches every command through the parser', () => {
    for (const command of COMMANDS) {
      const result = parseInvocation(command.path, COMMANDS, GLOBAL_FLAGS)
      expect(result.kind, `${command.path.join(' ')} is unreachable`).toBe('invocation')
      expect(result.kind === 'invocation' && result.invocation.command.operation).toBe(command.operation)
    }
  })

  it('gives every command and flag a summary, because help is generated from them', () => {
    for (const command of COMMANDS) {
      expect(command.summary.length, `${command.path.join(' ')} has no summary`).toBeGreaterThan(20)
      for (const flag of command.flags) expect(flag.summary.length, `--${flag.name} has no summary`).toBeGreaterThan(5)
    }
  })
})

describe('mutationFrom', () => {
  it('translates the parsed flags into the SDK options', () => {
    expect(mutationFrom({ dryRun: true, confirm: false, idempotencyKey: 'run-1' })).toEqual({
      dryRun: true,
      confirm: false,
      idempotencyKey: 'run-1',
    })
  })

  it('leaves an unsupplied control undefined rather than inventing false', () => {
    // `confirm: false` and "no opinion" are the same to the server today, but
    // sending a value the person never typed is how a default becomes a claim.
    expect(mutationFrom({})).toEqual({ dryRun: undefined, confirm: undefined, idempotencyKey: undefined })
  })
})

describe('parseAssignment', () => {
  it('splits on the first equals only', () => {
    expect(parseAssignment('DATABASE_URL=postgres://a=b')).toEqual({
      key: 'DATABASE_URL',
      value: 'postgres://a=b',
    })
  })

  it('accepts an empty value', () => {
    expect(parseAssignment('FLAG=')).toEqual({ key: 'FLAG', value: '' })
  })

  it('refuses something that is not an assignment', () => {
    expect(parseAssignment('DATABASE_URL')).toEqual({ error: 'expected KEY=VALUE, got "DATABASE_URL"' })
    expect(parseAssignment('=value')).toEqual({ error: 'expected KEY=VALUE, got "=value"' })
  })
})

describe('parsePublicPorts', () => {
  it('pairs the public port with the one the process listens on', () => {
    expect(parsePublicPorts('465:2465, 587:2587')).toEqual([
      { port: 465, containerPort: 2465 },
      { port: 587, containerPort: 2587 },
    ])
  })

  it('refuses a pair it cannot read, and stays undefined when not given', () => {
    expect(() => parsePublicPorts('587')).toThrow('--public-port expects')
    expect(parsePublicPorts(undefined)).toBeUndefined()
  })
})

describe('csv', () => {
  it('splits, trims and drops the gaps', () => {
    expect(csv('pgvector, postgis ,')).toEqual(['pgvector', 'postgis'])
  })

  it('stays undefined when the flag was never given', () => {
    expect(csv(undefined)).toBeUndefined()
  })
})
