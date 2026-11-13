import { describe, it, expect } from 'vitest'
import type { Helm7, Plan } from '@helm7/sdk'
import { EXIT, main, type Io } from './run.js'

const PLAN: Plan = {
  changes: [{ action: 'create', resource: 'database', name: 'primary', destructive: false }],
  cost: { currency: 'USD', monthly_low: 7, monthly_high: 9, main_driver: 'Postgres, 1 GB' },
  destructive_actions: [],
  applied: false,
}

interface Harness {
  io: Io
  out: string[]
  err: string[]
  calls: { method: string; args: unknown[] }[]
}

/**
 * A whole CLI run with no process, no network and no home directory.
 *
 * `main` takes its world as an argument precisely so this is possible: the
 * alternative is a test that spawns `node bin/helm7.mjs`, which is slow enough
 * that the twentieth case never gets written.
 */
function harness(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>
    files?: Record<string, string>
    isTty?: boolean
    result?: unknown
    fail?: unknown
    localBuild?: Io['localBuild']
    stdin?: string
  } = {},
): Harness {
  const out: string[] = []
  const err: string[] = []
  const calls: { method: string; args: unknown[] }[] = []

  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args })
    if (options.fail) throw options.fail
    return options.result ?? PLAN
  }

  const client = {
    whoami: record('whoami'),
    products: { create: record('products.create'), get: record('products.get') },
    deployments: { deploy: record('deployments.deploy'), rollback: record('deployments.rollback') },
    databases: {
      create: record('databases.create'),
      query: record('databases.query'),
      execute: record('databases.execute'),
    },
    services: { logs: record('services.logs'), update: record('services.update') },
    domains: { attach: record('domains.attach') },
    secrets: { set: record('secrets.set') },
    auth: { enable: record('auth.enable'), update: record('auth.update') },
    testAccounts: {
      create: record('testAccounts.create'),
      checkout: record('testAccounts.checkout'),
      totp: record('testAccounts.totp'),
      delete: record('testAccounts.delete'),
    },
    billing: { usage: record('billing.usage') },
    agents: { cloudInit: record('agents.cloudInit'), cloudClaim: record('agents.cloudClaim') },
  } as unknown as Helm7

  const io: Io = {
    argv,
    version: '0.1.0-test',
    env: options.env ?? { HELM7_API_KEY: 'hlm_sk_test' },
    homeDir: '/home/tester',
    isTty: options.isTty ?? false,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readFile: (path) => options.files?.[path],
    stdin: () => options.stdin ?? '',
    createClient: () => client,
    // Never the real machine's Docker: a test result must not depend on it.
    localBuild: options.localBuild ?? {
      support: async () => ({ ok: false, reason: 'Docker is not running on this machine.' }),
      upload: async () => undefined,
    },
  }

  return { io, out, err, calls }
}

describe('auth update', () => {
  it('turns anonymous sign-ins on from a flag, and changes nothing else', async () => {
    const h = harness(['auth', 'update', '--product', 'prd_7k2m9x4qw1nv8bz3ct6d', '--anonymous-signins', '--dry-run'])
    await main(h.io)
    const call = h.calls.find((c) => c.method === 'auth.update')!
    expect(call.args[0]).toMatchObject({ productId: 'prd_7k2m9x4qw1nv8bz3ct6d', anonymousSignIns: true, dryRun: true })
    expect(call.args[0]).not.toHaveProperty('disableSignup', true)
  })
})

describe('deploy --build', () => {
  const started = { ...PLAN, applied: true, deployments: [{ id: 'dep_1', service: 'web', build_mode: 'local', upload: { image: 'helm7/a:dep_1', chunk_bytes: 8, max_bytes: 99 } }] }

  it('builds and uploads here when the machine can, and says so to the server', async () => {
    const uploads: string[] = []
    const h = harness(['deploy', '--product', 'prd_1'], {
      result: started,
      localBuild: { support: async () => ({ ok: true, dockerfile: '/p/Dockerfile', context: '/p' }), upload: async (_c, _p, d) => void uploads.push(d.id) },
    })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.calls[0]!.args[0]).toMatchObject({ canBuildLocally: true })
    expect(uploads).toEqual(['dep_1'])
  })

  it('does not upload when the server built remotely', async () => {
    const uploads: string[] = []
    const h = harness(['deploy', '--product', 'prd_1'], {
      result: { ...started, deployments: [{ ...started.deployments[0], build_mode: 'remote' }] },
      localBuild: { support: async () => ({ ok: true, dockerfile: '/p/Dockerfile', context: '/p' }), upload: async (_c, _p, d) => void uploads.push(d.id) },
    })
    await main(h.io)
    expect(uploads).toEqual([])
  })

  it('fails with the reason when asked for a local build it cannot do', async () => {
    const h = harness(['deploy', '--product', 'prd_1', '--build', 'local'])
    expect(await main(h.io)).toBe(EXIT.failed)
    expect(h.err.join('\n')).toContain('Docker is not running')
    expect(h.calls).toEqual([])
  })

  it('says why it is building on Helm7 when it was only the default, and still deploys', async () => {
    const h = harness(['deploy', '--product', 'prd_1'], { result: { ...PLAN, applied: true } })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.err.join('\n')).toContain('Building on Helm7: Docker is not running')
    expect(h.calls[0]!.args[0]).toMatchObject({ canBuildLocally: false })
  })

  it('asks for neither on a dry run, so planning needs no Docker', async () => {
    const h = harness(['deploy', '--product', 'prd_1', '--dry-run', '--build', 'local'])
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.calls[0]!.args[0]).toMatchObject({ build: 'local', dryRun: true })
  })

  it('rejects a build value that is neither', async () => {
    const h = harness(['deploy', '--product', 'prd_1', '--build', 'cloud'])
    expect(await main(h.io)).toBe(EXIT.failed)
  })
})

describe('db query and db execute', () => {
  const ROWS = { rows: [{ id: 1, name: 'ada' }, { id: 2, name: null }], row_count: 2, truncated: false }

  it('takes the SQL as an argument and prints the rows as a table', async () => {
    const h = harness(['db', 'query', 'db_1', 'select id, name from t', '--product', 'prd_1'], { result: ROWS })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.calls[0]).toEqual({ method: 'databases.query', args: ['prd_1', 'db_1', 'select id, name from t', { limit: undefined }] })
    expect(h.out.join('\n')).toMatch(/id\s+name\n-+\s+-+\n1\s+ada\n2\s*\n2 rows/)
  })

  it('reads the SQL from standard input for "-"', async () => {
    const h = harness(['db', 'query', 'db_1', '-', '--product', 'prd_1', '--limit', '5'], { result: ROWS, stdin: 'select 1\n' })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.calls[0]!.args).toEqual(['prd_1', 'db_1', 'select 1\n', { limit: 5 }])
  })

  it('says when the limit cut the rows short', async () => {
    const h = harness(['db', 'query', 'db_1', 'select 1', '--product', 'prd_1'], { result: { ...ROWS, truncated: true } })
    await main(h.io)
    expect(h.out.join('\n')).toContain('cut off by the limit')
  })

  it('refuses a missing, empty or doubled SQL source before sending anything', async () => {
    for (const argv of [
      ['db', 'query', 'db_1', '--product', 'prd_1'],
      ['db', 'query', 'db_1', '-', '--product', 'prd_1'],
      ['db', 'query', 'db_1', 'select 1', '--file', 'q.sql', '--product', 'prd_1'],
    ]) {
      const h = harness(argv, { result: ROWS, stdin: '  ' })
      expect(await main(h.io), argv.join(' ')).toBe(EXIT.failed)
      expect(h.calls).toEqual([])
    }
  })

  it('passes --dry-run and --confirm to execute, and exits 1 when applying was refused', async () => {
    const dry = harness(['db', 'execute', 'db_1', 'delete from t', '--product', 'prd_1', '--dry-run'])
    expect(await main(dry.io)).toBe(EXIT.ok)
    expect(dry.calls[0]).toMatchObject({ method: 'databases.execute', args: [{ productId: 'prd_1', databaseId: 'db_1', sql: 'delete from t', dryRun: true }] })

    const refused = harness(['db', 'execute', 'db_1', 'delete from t', '--product', 'prd_1'])
    expect(await main(refused.io)).toBe(EXIT.failed)
    expect(refused.out.join('\n')).toContain('needs confirmation')

    const applied = harness(['db', 'execute', 'db_1', 'delete from t', '--product', 'prd_1', '--confirm'], { result: { ...PLAN, applied: true } })
    expect(await main(applied.io)).toBe(EXIT.ok)
  })

  it('shows the rows a dry run produced, above the plan', async () => {
    const h = harness(['db', 'execute', 'db_1', '-', '--product', 'prd_1', '--dry-run'], { result: { ...PLAN, rows: [{ n: 3 }] }, stdin: 'select 3 as n' })
    await main(h.io)
    expect(h.out.join('\n')).toMatch(/^n\n-\n3\n\nPlan/)
  })
})

describe('service update', () => {
  it('clears an image with --clear-image and starts a paused service with --no-paused', async () => {
    const h = harness(['service', 'update', 'svc_1', '--product', 'prd_1', '--clear-image', '--no-paused', '--public-port', '587:2587'])
    await main(h.io)
    expect(h.calls[0]!.args[0]).toMatchObject({ serviceId: 'svc_1', image: null, paused: false, publicPorts: [{ port: 587, containerPort: 2587 }] })
  })
})

describe('main', () => {
  it('prints help and succeeds when asked for nothing', async () => {
    const h = harness([])
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toContain('Usage: helm7 <command> [options]')
  })

  it('prints the version', async () => {
    const h = harness(['--version'])
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.out).toEqual(['0.1.0-test'])
  })

  it('prints help for one command without touching the network', async () => {
    const h = harness(['db', 'create', '--help'])
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toContain('helm7 db create [options]')
    expect(h.calls).toEqual([])
  })

  it('exits 2 on an unknown command and says nothing was sent', async () => {
    const h = harness(['deploi'])
    expect(await main(h.io)).toBe(EXIT.usage)
    expect(h.err.join('\n')).toContain('unknown command "deploi"')
    expect(h.calls).toEqual([])
  })

  it('exits 2 when a required flag is missing', async () => {
    const h = harness(['deploy'])
    expect(await main(h.io)).toBe(EXIT.usage)
    expect(h.err.join('\n')).toContain('--product is required')
    expect(h.calls).toEqual([])
  })

  it('exits 3 when there is no credential anywhere, and says where it looked', async () => {
    const h = harness(['whoami'], { env: {} })
    expect(await main(h.io)).toBe(EXIT.credential)
    expect(h.err.join('\n')).toContain('HELM7_API_KEY')
    expect(h.err.join('\n')).toContain('/home/tester/.helm7/config.json')
  })

  it('reads the key and the default Product from the config file', async () => {
    const h = harness(['deploy'], {
      env: {},
      files: { '/home/tester/.helm7/config.json': JSON.stringify({ apiKey: 'hlm_sk_file', productId: 'prd_file' }) },
      result: { ...PLAN, applied: true },
    })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.calls[0]?.method).toBe('deployments.deploy')
    expect((h.calls[0]?.args[0] as { productId: string }).productId).toBe('prd_file')
  })

  it('lets the environment outrank the config file', async () => {
    const h = harness(['whoami'], {
      env: { HELM7_API_KEY: 'hlm_sk_env' },
      files: { '/home/tester/.helm7/config.json': JSON.stringify({ apiKey: 'hlm_sk_file' }) },
    })
    expect(await main(h.io)).toBe(EXIT.ok)
  })

  it('complains about a corrupt config file instead of failing to authenticate later', async () => {
    const h = harness(['whoami'], { files: { '/home/tester/.helm7/config.json': '{ not json' } })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.err.join('\n')).toContain('is not valid JSON')
  })

  it('renders the plan for a dry run', async () => {
    const h = harness(['db', 'create', '--product', 'prd_1', '--dry-run'])
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.calls[0]?.args[0]).toMatchObject({ productId: 'prd_1', dryRun: true })
    const output = h.out.join('\n')
    expect(output).toContain('Plan  1 change')
    expect(output).toContain('Cost  USD 7.00 to 9.00 per month')
    expect(output).toContain('this was a dry run')
  })

  it('prints no escape codes when stdout is not a terminal', async () => {
    const h = harness(['db', 'create', '--product', 'prd_1', '--dry-run'], { isTty: false })
    await main(h.io)
    expect(h.out.join('\n')).not.toContain(String.fromCharCode(27))
  })

  it('prints raw JSON for --json', async () => {
    const h = harness(['usage', '--json'], { result: { spend: 12 } })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toEqual({ spend: 12 })
  })

  it('exits 1 and prints code, message and remedy when Helm7 refuses', async () => {
    const h = harness(['deploy', '--product', 'prd_1'], {
      fail: Object.assign(new Error('this key may not deploy'), {
        code: 'insufficient_scope',
        remedy: 'mint a key with deployment:write and may_deploy',
        requestId: 'req_3',
      }),
    })
    expect(await main(h.io)).toBe(EXIT.failed)
    expect(h.err.join('\n')).toContain('insufficient_scope: this key may not deploy')
    expect(h.err.join('\n')).toContain('remedy: mint a key with deployment:write and may_deploy')
  })

  it('reports a refusal as JSON when asked for JSON', async () => {
    const h = harness(['deploy', '--product', 'prd_1', '--json'], {
      fail: Object.assign(new Error('nope'), { code: 'budget_exceeded', requestId: 'req_4' }),
    })
    expect(await main(h.io)).toBe(EXIT.failed)
    expect(JSON.parse(h.err.join('\n'))).toEqual({
      error: { code: 'budget_exceeded', message: 'nope', request_id: 'req_4' },
    })
  })

  it('exits 1 when a change that was not a dry run was not applied', async () => {
    // A deploy script that forgot --confirm must not report success and carry
    // on to the next step.
    const h = harness(['db', 'create', '--product', 'prd_1'], { result: { ...PLAN, applied: false } })
    expect(await main(h.io)).toBe(EXIT.failed)
  })

  it('exits 0 once the change is applied', async () => {
    const h = harness(['db', 'create', '--product', 'prd_1', '--confirm'], { result: { ...PLAN, applied: true } })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.calls[0]?.args[0]).toMatchObject({ confirm: true })
  })

  it('passes an idempotency key through under its SDK name', async () => {
    const h = harness(['deploy', '--product', 'prd_1', '--idempotency-key', 'run-7'])
    await main(h.io)
    expect(h.calls[0]?.args[0]).toMatchObject({ idempotencyKey: 'run-7' })
  })

  it('splits a KEY=VALUE assignment for env set', async () => {
    const h = harness(['env', 'set', 'STRIPE_KEY=sk_live_a=b', '--product', 'prd_1'])
    await main(h.io)
    expect(h.calls[0]?.args[0]).toMatchObject({ key: 'STRIPE_KEY', value: 'sk_live_a=b' })
  })

  it('exits 1 rather than sending a malformed assignment', async () => {
    const h = harness(['env', 'set', 'STRIPE_KEY', '--product', 'prd_1'])
    expect(await main(h.io)).toBe(EXIT.failed)
    expect(h.err.join('\n')).toContain('expected KEY=VALUE')
  })

  it('passes the positional argument of a two-word command', async () => {
    const h = harness(['domain', 'add', 'app.example.com', '--product', 'prd_1'])
    await main(h.io)
    expect(h.calls[0]?.args[0]).toMatchObject({ hostname: 'app.example.com', productId: 'prd_1' })
  })
})

describe('test-accounts', () => {
  const product = ['--product', 'prd_7k2m9x4qw1nv8bz3ct6d']

  it('creates a temporary provisioned account from flags', async () => {
    const h = harness(['test-accounts', 'create', ...product, '--label', 'member', '--mode', 'provision', '--expires-in', '24h', '--dry-run'])
    await main(h.io)
    expect(h.calls.find((c) => c.method === 'testAccounts.create')!.args[0]).toMatchObject({ label: 'member', mode: 'provision', expiresIn: '24h', dryRun: true })
  })

  it('refuses a mode that is neither provision nor register, before any call', async () => {
    const h = harness(['test-accounts', 'create', ...product, '--label', 'member', '--mode', 'invent'])
    expect(await main(h.io)).toBe(EXIT.failed)
    expect(h.calls).toEqual([])
  })

  it('requires a run reference to check an account out', async () => {
    const h = harness(['test-accounts', 'checkout', 'tac_7k2m9x4qw1nv8bz3ct6d', ...product])
    expect(await main(h.io)).toBe(EXIT.usage)
    expect(h.calls).toEqual([])
  })

  it('checks out with the run reference and a lease, and warns on stderr rather than stdout', async () => {
    const h = harness(['test-accounts', 'checkout', 'tac_7k2m9x4qw1nv8bz3ct6d', ...product, '--run-ref', 'run_9', '--ttl', '300'], {
      result: { email: 'a+helm7test@x.test', password: 'pw' },
    })
    expect(await main(h.io)).toBe(EXIT.ok)
    expect(h.calls[0]!.args[0]).toMatchObject({ accountId: 'tac_7k2m9x4qw1nv8bz3ct6d', runRef: 'run_9', ttlSeconds: 300 })
    expect(h.err.join('\n')).toContain('credential')
  })

  it('treats a delete refused for want of --confirm as a failure', async () => {
    const h = harness(['test-accounts', 'delete', 'tac_7k2m9x4qw1nv8bz3ct6d', ...product])
    expect(await main(h.io)).toBe(EXIT.failed)
  })
})
