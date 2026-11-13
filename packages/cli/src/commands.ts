/**
 * The command table.
 *
 * Every command names the catalogue operation it stands for, and
 * `commands.test.ts` checks those ids against `@helm7/catalogue` — a
 * dev-time dependency only, since the CLI ships depending on nothing but the
 * SDK. That check is what stops this table describing an operation the platform
 * no longer has, which on the wire is a 404 and on the terminal reads like a
 * Product that vanished.
 *
 * `mutating` is not decoration: it is what attaches `--dry-run`, `--confirm`
 * and `--idempotency-key`, and the same test asserts it agrees with whether the
 * catalogue gave that operation the mutation controls. Getting it wrong in
 * either direction is how a command that spends money loses its plan step.
 */
import { readFileSync } from 'node:fs'
import type { Helm7, MutationOptions } from '@helm7/sdk'
// Types only. The command table is also bundled into the website's CLI docs,
// which cannot take a module that spawns Docker; `run.ts` supplies the real one.
import type { buildAndUpload, localBuildSupport, LocalDeployment } from './local-build.js'
import type { FlagSpec, Flags, ParsableCommand, PositionalSpec } from './args.js'

export interface CommandContext {
  flags: Flags
  positionals: string[]
  /** Already translated from `--dry-run` and friends. */
  mutation: MutationOptions
  /** Progress for a person, on stderr so `--json` output stays parseable. */
  log?: (line: string) => void
  /** Standard input, read whole. Swapped by tests so none of them waits on a terminal. */
  stdin?: () => string
  /** Swapped by tests, so none of them depends on this machine having Docker. */
  localBuild?: { support: typeof localBuildSupport; upload: typeof buildAndUpload }
}

export interface Command extends ParsableCommand {
  path: string[]
  /** Catalogue operation id. */
  operation: string
  summary: string
  mutating: boolean
  flags: FlagSpec[]
  positionals?: PositionalSpec[]
  run: (client: Helm7, context: CommandContext) => Promise<unknown>
}

/** Accepted everywhere, so a script never has to know which commands take them. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'json', type: 'boolean', summary: 'Print the raw JSON response instead of formatted output.' },
  {
    name: 'colour',
    type: 'boolean',
    // Spelled both ways. The house style is British, but half the world types
    // --color and being told it is an unknown flag over one letter is a poor
    // first impression of a tool somebody reached for during an incident.
    alias: 'color',
    summary: 'Force colour on or off. Defaults to on only when stdout is a terminal.',
  },
  { name: 'api-key', type: 'string', placeholder: '<key>', summary: 'Override HELM7_API_KEY for this call.' },
  { name: 'base-url', type: 'string', placeholder: '<url>', summary: 'Point at a different Helm7 deployment.' },
  { name: 'help', type: 'boolean', alias: 'h', summary: 'Show help for this command.' },
]

/** Attached to every command whose operation carries the catalogue's controls. */
export const MUTATION_FLAGS: FlagSpec[] = [
  {
    name: 'dry-run',
    type: 'boolean',
    summary: 'Print the plan and change nothing: what would change, what it costs, and what cannot be undone.',
  },
  { name: 'confirm', type: 'boolean', summary: 'Required by destructive operations. Without it they only plan.' },
  {
    name: 'idempotency-key',
    type: 'string',
    placeholder: '<key>',
    summary: 'Replaying the same key returns the original result instead of acting twice.',
  },
]

const PRODUCT_FLAG: FlagSpec = {
  name: 'product',
  type: 'string',
  placeholder: '<prd_...>',
  required: true,
  summary: 'Product id. Defaults to HELM7_PRODUCT or productId in your config file.',
}

const ENV_FLAG: FlagSpec = {
  name: 'env',
  type: 'string',
  placeholder: '<production|preview|development>',
  summary: 'Environment within the Product. Defaults to production.',
}

/** Read a flag as the type its spec promised, without lying about a missing one. */
export const str = (flags: Flags, key: string): string | undefined =>
  typeof flags[key] === 'string' ? (flags[key] as string) : undefined
export const bool = (flags: Flags, key: string): boolean | undefined =>
  typeof flags[key] === 'boolean' ? (flags[key] as boolean) : undefined
export const num = (flags: Flags, key: string): number | undefined =>
  typeof flags[key] === 'number' ? (flags[key] as number) : undefined

/** `--extension pgvector,postgis` — one flag, several values, no repetition. */
export const csv = (value: string | undefined): string[] | undefined =>
  value === undefined ? undefined : value.split(',').map((part) => part.trim()).filter(Boolean)

/**
 * `KEY=VALUE`, split on the FIRST `=` only.
 *
 * A secret value that itself contains an equals sign — base64 padding, a
 * connection string — is the common case, not the exotic one, and splitting on
 * every `=` would silently truncate it.
 */
export function parseAssignment(input: string): { key: string; value: string } | { error: string } {
  const at = input.indexOf('=')
  if (at <= 0) return { error: `expected KEY=VALUE, got "${input}"` }
  return { key: input.slice(0, at), value: input.slice(at + 1) }
}

const environmentOf = (flags: Flags): 'production' | 'preview' | 'development' | undefined => {
  const value = str(flags, 'env')
  if (value === 'production' || value === 'preview' || value === 'development') return value
  return undefined
}

const PAGE_FLAGS: FlagSpec[] = [
  { name: 'cursor', type: 'string', placeholder: '<cursor>', summary: 'next_cursor from the previous page.' },
  { name: 'limit', type: 'number', placeholder: '<n>', summary: 'Maximum rows to return.' },
]

/** Environments a Product can be given or lose. Production is never one of them. */
const standardEnvironment = (value: string): 'preview' | 'development' => {
  if (value === 'preview' || value === 'development') return value
  throw new Error(`environment must be preview or development, got "${value}"`)
}

/** `465:2465,587:2587` — the public port, then what the process listens on. */
export function parsePublicPorts(input: string | undefined): Array<{ port: number; containerPort: number }> | undefined {
  return csv(input)?.map((pair) => {
    const [port, containerPort] = pair.split(':').map(Number)
    if (!Number.isInteger(port) || !Number.isInteger(containerPort)) {
      throw new Error(`--public-port expects <465|587>:<container port>, got "${pair}"`)
    }
    return { port: port!, containerPort: containerPort! }
  })
}

/**
 * The SQL for `db query` and `db execute`: an argument, `-` for standard input,
 * or `--file`.
 *
 * Exactly one source, because two would leave the person guessing which ran,
 * and for `db execute` the answer decides what happened to their data.
 */
export function resolveSql(ctx: CommandContext, positionalIndex: number): string {
  const inline = ctx.positionals[positionalIndex]
  const file = str(ctx.flags, 'file')
  if (inline !== undefined && file !== undefined) throw new Error('Give the SQL as an argument or with --file, not both.')
  let sql: string
  if (file !== undefined) {
    try {
      sql = readFileSync(file, 'utf8')
    } catch {
      throw new Error(`${file} could not be read.`)
    }
  } else if (inline === '-') {
    // fd 0 rather than a stream: the command table is synchronous to read and
    // a script piping SQL in has already finished writing it.
    sql = (ctx.stdin ?? (() => readFileSync(0, 'utf8')))()
  } else if (inline !== undefined) {
    sql = inline
  } else {
    throw new Error('Give the SQL as an argument, "-" to read it from standard input, or --file <path>.')
  }
  if (sql.trim() === '') throw new Error('The SQL is empty.')
  return sql
}

function parseJsonArray(text: string, what: string): Record<string, unknown>[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${what} is not valid JSON.`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${what} must be a JSON array.`)
  return parsed as Record<string, unknown>[]
}

/** Declare a mutating command: the controls are attached here, never by hand. */
function mutating(command: Omit<Command, 'mutating' | 'flags'> & { flags?: FlagSpec[] }): Command {
  return { ...command, mutating: true, flags: [...(command.flags ?? []), ...MUTATION_FLAGS] }
}

function reading(command: Omit<Command, 'mutating' | 'flags'> & { flags?: FlagSpec[] }): Command {
  return { ...command, mutating: false, flags: command.flags ?? [] }
}

export const COMMANDS: Command[] = [
  reading({
    path: ['whoami'],
    operation: 'whoami',
    summary: 'Show the organisation, member, scopes and budget this key speaks with.',
    run: (client) => client.whoami(),
  }),

  mutating({
    path: ['init'],
    operation: 'product_create',
    summary: 'Create a Product, the unit everything else belongs to.',
    positionals: [{ name: 'name', summary: 'Human-readable Product name.', required: true }],
    flags: [
      { name: 'region', type: 'string', placeholder: '<eu-central|eu-north>', summary: 'Where the Product runs.' },
      { name: 'repo', type: 'string', placeholder: '<git-url>', summary: 'Repository to inspect for a proposed shape.' },
      {
        name: 'external-ref',
        type: 'string',
        placeholder: '<id>',
        summary: 'Your own id for this Product. Creating twice with it returns the first one.',
      },
    ],
    run: (client, ctx) =>
      client.products.create({
        name: ctx.positionals[0]!,
        region: str(ctx.flags, 'region') as 'eu-central' | 'eu-north' | undefined,
        repo: str(ctx.flags, 'repo'),
        externalRef: str(ctx.flags, 'externalRef'),
        ...ctx.mutation,
      }),
  }),

  mutating({
    path: ['deploy'],
    operation: 'deploy',
    summary: 'Build the current commit and swap traffic to it once it is healthy.',
    flags: [
      PRODUCT_FLAG,
      ENV_FLAG,
      { name: 'service', type: 'string', placeholder: '<svc_...>', summary: 'Omit to deploy every service in the environment.' },
      { name: 'commit', type: 'string', placeholder: '<sha>', summary: 'Git SHA. Defaults to the branch tip.' },
      {
        name: 'build',
        type: 'string',
        placeholder: '<local|remote>',
        summary: 'Where to build. local builds here with Docker and uploads, so it never waits; remote queues on Helm7. Defaults to your workspace setting.',
      },
      { name: 'dockerfile', type: 'string', placeholder: '<path>', summary: 'Dockerfile for a local build. Defaults to ./Dockerfile.' },
      { name: 'context', type: 'string', placeholder: '<dir>', summary: 'Build context for a local build. Defaults to the current directory.' },
    ],
    run: async (client, ctx) => {
      const requested = str(ctx.flags, 'build')
      if (requested !== undefined && requested !== 'local' && requested !== 'remote') throw new Error('--build must be local or remote')
      const productId = str(ctx.flags, 'product')!
      const log = ctx.log ?? (() => undefined)

      // A dry run builds nothing, so it does not need Docker to say what would happen.
      const local = ctx.localBuild
      if (requested === 'local' && !local) throw new Error('This CLI cannot build locally here.')
      const support = !local || requested === 'remote' || ctx.mutation.dryRun ? null : await local.support({ cwd: process.cwd(), dockerfile: str(ctx.flags, 'dockerfile'), context: str(ctx.flags, 'context') })
      if (requested === 'local' && support && !support.ok) throw new Error(support.reason)
      if (requested === undefined && support && !support.ok) log(`Building on Helm7: ${support.reason}`)

      const result = (await client.deployments.deploy({
        productId,
        environment: environmentOf(ctx.flags),
        serviceId: str(ctx.flags, 'service'),
        commit: str(ctx.flags, 'commit'),
        build: requested,
        canBuildLocally: support?.ok === true,
        ...ctx.mutation,
      })) as { deployments?: Array<LocalDeployment & { build_mode?: string }> }

      if (support?.ok) {
        for (const deployment of (result.deployments ?? []).filter((d) => d.build_mode === 'local')) {
          await local!.upload(client, productId, deployment, support, log)
        }
      }
      return result
    },
  }),

  reading({
    path: ['queue'],
    operation: 'build_queue_get',
    summary: 'Where your builds are in the build queue, and how many are ahead of them.',
    run: (client) => client.deployments.queue(),
  }),

  mutating({
    path: ['queue', 'first'],
    operation: 'build_queue_reorder',
    summary: 'Run one of your waiting builds before your others. It cannot pass another workspace.',
    positionals: [{ name: 'deploymentId', summary: 'A waiting deployment, from `helm7 queue`.', required: true }],
    run: (client, ctx) => client.deployments.reorderQueue([ctx.positionals[0]!], ctx.mutation),
  }),

  mutating({
    path: ['queue', 'order'],
    operation: 'build_queue_reorder',
    summary: 'Put your waiting builds in an exact order. Builds you leave out follow, as they were.',
    flags: [{ name: 'ids', type: 'string', required: true, placeholder: '<dep_a,dep_b>', summary: 'Deployment ids, first to run first.' }],
    run: (client, ctx) => client.deployments.reorderQueue(csv(str(ctx.flags, 'ids'))!, ctx.mutation),
  }),

  reading({
    path: ['settings'],
    operation: 'organization_get',
    summary: 'Workspace settings: plan, spend cap, where deploys build, and what happens to helm7.app addresses.',
    run: (client) => client.organization.get(),
  }),

  mutating({
    path: ['settings', 'set'],
    operation: 'organization_update',
    summary: 'Rename the workspace, set its spend cap, change where deploys build by default, or whether services keep their helm7.app address.',
    flags: [
      { name: 'name', type: 'string', placeholder: '<name>', summary: 'Rename the workspace.' },
      { name: 'budget', type: 'string', placeholder: '<usd|none>', summary: 'Monthly spend cap in USD across the workspace. none removes it.' },
      { name: 'build-mode', type: 'string', placeholder: '<local|remote>', summary: 'Where a deploy builds when you do not say. local uses this machine.' },
      { name: 'keep-app-domain', type: 'string', placeholder: '<on|off>', summary: 'on keeps the helm7.app address as a staging address once a custom domain is serving.' },
    ],
    run: (client, ctx) => {
      const mode = str(ctx.flags, 'buildMode')
      if (mode !== undefined && mode !== 'local' && mode !== 'remote') throw new Error('--build-mode must be local or remote')
      const keep = str(ctx.flags, 'keepAppDomain')
      if (keep !== undefined && keep !== 'on' && keep !== 'off') throw new Error('--keep-app-domain must be on or off')
      const budget = str(ctx.flags, 'budget')
      let budgetUsd: number | null | undefined
      if (budget === 'none') budgetUsd = null
      else if (budget !== undefined) {
        budgetUsd = Number(budget)
        if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error('--budget must be a number of dollars, or none')
      }
      return client.organization.update({
        name: str(ctx.flags, 'name'),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(mode ? { defaultBuildMode: mode } : {}),
        ...(keep ? { keepAppDomain: keep === 'on' } : {}),
        ...ctx.mutation,
      })
    },
  }),

  mutating({
    path: ['db', 'create'],
    operation: 'database_create',
    summary: 'Provision Postgres and set DATABASE_URL on the environment.',
    flags: [
      PRODUCT_FLAG,
      ENV_FLAG,
      { name: 'name', type: 'string', placeholder: '<name>', summary: 'Database name. Defaults to primary.' },
      {
        name: 'extension',
        type: 'string',
        placeholder: '<a,b>',
        summary: 'Extensions to enable. pgcrypto and uuid-ossp are always on.',
      },
    ],
    run: (client, ctx) =>
      client.databases.create({
        productId: str(ctx.flags, 'product')!,
        environment: environmentOf(ctx.flags),
        name: str(ctx.flags, 'name'),
        extensions: csv(str(ctx.flags, 'extension')),
        ...ctx.mutation,
      }),
  }),

  mutating({
    path: ['auth', 'enable'],
    operation: 'auth_enable',
    summary: 'Turn on managed auth. Supabase-compatible, so an existing app moves by changing its URL and key.',
    flags: [
      PRODUCT_FLAG,
      ENV_FLAG,
      { name: 'provider', type: 'string', placeholder: '<email,github>', summary: 'Providers to enable. Defaults to email.' },
      { name: 'site-url', type: 'string', placeholder: '<url>', summary: 'Where auth redirects land.' },
    ],
    run: (client, ctx) =>
      client.auth.enable({
        productId: str(ctx.flags, 'product')!,
        environment: environmentOf(ctx.flags),
        providers: csv(str(ctx.flags, 'provider')),
        siteUrl: str(ctx.flags, 'siteUrl'),
        ...ctx.mutation,
      }),
  }),

  {
    path: ['auth', 'status'],
    operation: 'auth_get',
    summary: 'Show managed auth: health, URL, settings and how many users it holds.',
    mutating: false,
    flags: [PRODUCT_FLAG, ENV_FLAG],
    run: (client, ctx) => client.auth.get({ productId: str(ctx.flags, 'product')!, environment: environmentOf(ctx.flags) }),
  },

  mutating({
    path: ['auth', 'update'],
    operation: 'auth_update',
    summary: 'Change how auth behaves: redirect URLs, sign-up, providers, password length, token lifetimes.',
    flags: [
      PRODUCT_FLAG,
      ENV_FLAG,
      { name: 'site-url', type: 'string', placeholder: '<url>', summary: 'Where auth redirects land by default.' },
      { name: 'redirect-url', type: 'string', placeholder: '<url,url>', summary: 'Every other URL an app may redirect to. Replaces the list.' },
      { name: 'autoconfirm', type: 'boolean', summary: 'Sign people in without confirming their email.' },
      { name: 'disable-signup', type: 'boolean', summary: 'Refuse new sign-ups.' },
      { name: 'anonymous-signins', type: 'boolean', summary: 'Let anyone create an anonymous user (signInAnonymously). Needs CAPTCHA and rate limiting in your app.' },
      { name: 'password-min-length', type: 'number', placeholder: '<6-72>', summary: 'Minimum password length.' },
      { name: 'jwt-expiry', type: 'number', placeholder: '<seconds>', summary: 'How long an access token lasts.' },
      { name: 'google-client-id', type: 'string', placeholder: '<id>', summary: 'Turns Google sign-in on with this client id.' },
      { name: 'google-client-secret', type: 'string', placeholder: '<secret>', summary: 'Write-only. Stored as a secret.' },
      { name: 'github-client-id', type: 'string', placeholder: '<id>', summary: 'Turns GitHub sign-in on with this client id.' },
      { name: 'github-client-secret', type: 'string', placeholder: '<secret>', summary: 'Write-only. Stored as a secret.' },
    ],
    run: (client, ctx) => {
      const provider = (id: string | undefined, secret: string | undefined) =>
        id === undefined && secret === undefined ? undefined : { enabled: true, clientId: id, clientSecret: secret }
      const google = provider(str(ctx.flags, 'googleClientId'), str(ctx.flags, 'googleClientSecret'))
      const github = provider(str(ctx.flags, 'githubClientId'), str(ctx.flags, 'githubClientSecret'))
      return client.auth.update({
        productId: str(ctx.flags, 'product')!,
        environment: environmentOf(ctx.flags),
        siteUrl: str(ctx.flags, 'siteUrl'),
        additionalRedirectUrls: csv(str(ctx.flags, 'redirectUrl')),
        emailAutoconfirm: bool(ctx.flags, 'autoconfirm'),
        disableSignup: bool(ctx.flags, 'disableSignup'),
        anonymousSignIns: bool(ctx.flags, 'anonymousSignins'),
        passwordMinLength: num(ctx.flags, 'passwordMinLength'),
        jwtExpirySeconds: num(ctx.flags, 'jwtExpiry'),
        ...(google || github ? { external: { ...(google ? { google } : {}), ...(github ? { github } : {}) } } : {}),
        ...ctx.mutation,
      })
    },
  }),

  mutating({
    path: ['auth', 'import'],
    operation: 'auth_users_import',
    summary: 'Import users, with their password hashes, from a JSON file. Idempotent on user id.',
    flags: [
      PRODUCT_FLAG,
      ENV_FLAG,
      { name: 'file', type: 'string', placeholder: '<users.json>', required: true, summary: 'A JSON array of users (up to 200), named like the auth.users columns.' },
    ],
    run: (client, ctx) => {
      // Read here, not by the SDK: the SDK ships with no filesystem access.
      // Nothing about the file is printed, because it holds password hashes.
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(str(ctx.flags, 'file')!, 'utf8'))
      } catch {
        // Not the parser's own message: recent Node quotes the text around the
        // fault, and here that text can be a password hash.
        throw new Error(`${str(ctx.flags, 'file')} could not be read as JSON.`)
      }
      const users = Array.isArray(parsed) ? parsed : (parsed as { users?: unknown }).users
      if (!Array.isArray(users)) throw new Error('The file must be a JSON array of users, or an object with a "users" array.')
      return client.auth.importUsers({
        productId: str(ctx.flags, 'product')!,
        environment: environmentOf(ctx.flags),
        users: users as never,
        ...ctx.mutation,
      })
    },
  }),

  mutating({
    path: ['domain', 'add'],
    operation: 'domain_attach',
    summary: 'Attach a custom domain and issue its certificate.',
    positionals: [{ name: 'hostname', summary: 'Fully qualified, e.g. app.example.com. A bare domain (example.com) gets an A record and redirects to www unless --serve is given.', required: true }],
    flags: [
      PRODUCT_FLAG,
      ENV_FLAG,
      { name: 'service', type: 'string', placeholder: '<svc_...>', summary: 'Defaults to the only web service, when there is one.' },
      { name: 'serve', type: 'boolean', summary: 'Bare domains only: answer on the bare domain itself instead of redirecting to www.' },
    ],
    run: (client, ctx) =>
      client.domains.attach({
        productId: str(ctx.flags, 'product')!,
        hostname: ctx.positionals[0]!,
        environment: environmentOf(ctx.flags),
        serviceId: str(ctx.flags, 'service'),
        serve: bool(ctx.flags, 'serve'),
        ...ctx.mutation,
      }),
  }),

  reading({
    path: ['logs'],
    operation: 'service_logs',
    summary: 'Recent stdout and stderr for a service. Redaction is best effort, not a guarantee.',
    flags: [
      PRODUCT_FLAG,
      { name: 'service', type: 'string', placeholder: '<svc_...>', required: true, summary: 'Service to read.' },
      { name: 'since', type: 'string', placeholder: '<iso-8601>', summary: 'Only lines after this timestamp.' },
      { name: 'limit', type: 'number', placeholder: '<n>', summary: 'Maximum lines to return.' },
    ],
    run: (client, ctx) =>
      client.services.logs({
        productId: str(ctx.flags, 'product')!,
        serviceId: str(ctx.flags, 'service')!,
        since: str(ctx.flags, 'since'),
        limit: num(ctx.flags, 'limit'),
      }),
  }),

  mutating({
    path: ['rollback'],
    operation: 'deployment_rollback',
    summary: 'Move traffic back to an earlier deployment. Does NOT revert database migrations.',
    positionals: [{ name: 'deploymentId', summary: 'Deployment to roll back to.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) =>
      client.deployments.rollback(str(ctx.flags, 'product')!, ctx.positionals[0]!, ctx.mutation),
  }),

  mutating({
    path: ['env', 'set'],
    operation: 'secret_set',
    summary: 'Set an environment variable. Values are never readable again, by design.',
    positionals: [{ name: 'KEY=VALUE', summary: 'The variable and its value.', required: true }],
    flags: [PRODUCT_FLAG, ENV_FLAG],
    run: (client, ctx) => {
      const assignment = parseAssignment(ctx.positionals[0]!)
      if ('error' in assignment) throw new Error(assignment.error)
      return client.secrets.set({
        productId: str(ctx.flags, 'product')!,
        environment: environmentOf(ctx.flags),
        key: assignment.key,
        value: assignment.value,
        ...ctx.mutation,
      })
    },
  }),

  reading({
    path: ['product', 'inspect'],
    operation: 'product_get',
    summary: 'The whole resource graph for one Product.',
    positionals: [{ name: 'productId', summary: 'Product to inspect.', required: true }],
    run: (client, ctx) => client.products.get(ctx.positionals[0]!),
  }),

  reading({
    path: ['usage'],
    operation: 'usage_get',
    summary: 'Spend to date, the month-end projection, and the budget remaining.',
    flags: [{ name: 'product', type: 'string', placeholder: '<prd_...>', summary: 'Narrow to one Product.' }],
    run: (client, ctx) => client.billing.usage({ productId: str(ctx.flags, 'product') }),
  }),

  reading({
    path: ['product', 'list'],
    operation: 'product_list',
    summary: 'Every Product in the workspace.',
    flags: PAGE_FLAGS,
    run: (client, ctx) => client.products.list({ cursor: str(ctx.flags, 'cursor'), limit: num(ctx.flags, 'limit') }),
  }),

  mutating({
    path: ['product', 'rename'],
    operation: 'product_update',
    summary: 'Rename a Product. Its addresses and ids stay the same.',
    positionals: [
      { name: 'productId', summary: 'Product to rename.', required: true },
      { name: 'name', summary: 'The new name, up to 64 characters.', required: true },
    ],
    run: (client, ctx) => client.products.update({ productId: ctx.positionals[0]!, name: ctx.positionals[1]!, ...ctx.mutation }),
  }),

  mutating({
    path: ['product', 'delete'],
    operation: 'product_delete',
    summary: 'Delete a Product and everything in it: services, databases, storage and domains. It cannot be undone.',
    positionals: [{ name: 'productId', summary: 'Product to delete.', required: true }],
    run: (client, ctx) => client.products.delete(ctx.positionals[0]!, ctx.mutation),
  }),

  mutating({
    path: ['product', 'connect'],
    operation: 'product_connect_repo',
    summary: 'Deploy a Product from a repository on every push to its production branch.',
    flags: [
      PRODUCT_FLAG,
      { name: 'installation', type: 'string', placeholder: '<id>', required: true, summary: 'Installation id, from `helm7 repos`.' },
      { name: 'repo-id', type: 'string', placeholder: '<id>', required: true, summary: 'Repository id, from `helm7 repos`.' },
      { name: 'branch', type: 'string', placeholder: '<branch>', summary: 'Production branch. Defaults to main.' },
    ],
    run: (client, ctx) =>
      client.github.connect({
        productId: str(ctx.flags, 'product')!,
        installationId: str(ctx.flags, 'installation')!,
        repoId: str(ctx.flags, 'repoId')!,
        productionBranch: str(ctx.flags, 'branch'),
        ...ctx.mutation,
      }),
  }),

  reading({
    path: ['repos'],
    operation: 'github_repo_list',
    summary: 'Repositories the Helm7 GitHub App can see, or the link to install it when it is not installed yet.',
    run: (client) => client.github.repositories(),
  }),

  reading({
    path: ['environment', 'list'],
    operation: 'environment_list',
    summary: 'The environments a Product has: production, and any preview or development.',
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.environments.list(str(ctx.flags, 'product')!),
  }),

  mutating({
    path: ['environment', 'create'],
    operation: 'environment_create',
    summary: 'Add a preview or development environment. It starts empty and does not copy production data.',
    positionals: [{ name: 'name', summary: 'preview or development.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) =>
      client.environments.create({ productId: str(ctx.flags, 'product')!, name: standardEnvironment(ctx.positionals[0]!), ...ctx.mutation }),
  }),

  mutating({
    path: ['environment', 'delete'],
    operation: 'environment_delete',
    summary: 'Delete a preview or development environment and everything in it. Production cannot be deleted.',
    positionals: [{ name: 'name', summary: 'preview or development.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) =>
      client.environments.delete(str(ctx.flags, 'product')!, standardEnvironment(ctx.positionals[0]!), ctx.mutation),
  }),

  reading({
    path: ['service', 'list'],
    operation: 'service_list',
    summary: 'The services in a Product: web, worker and cron.',
    flags: [PRODUCT_FLAG, ENV_FLAG],
    run: (client, ctx) => client.services.list({ productId: str(ctx.flags, 'product')!, environment: environmentOf(ctx.flags) }),
  }),

  mutating({
    path: ['service', 'create'],
    operation: 'service_create',
    summary: 'Add a web, worker or cron service, built from a repository or run from an image.',
    positionals: [{ name: 'name', summary: 'Service name.', required: true }],
    flags: [
      PRODUCT_FLAG,
      ENV_FLAG,
      { name: 'kind', type: 'string', placeholder: '<web|worker|cron>', required: true, summary: 'What the service does.' },
      { name: 'repo', type: 'string', placeholder: '<git-url>', summary: 'Git URL to build from. Required unless --image is given.' },
      { name: 'branch', type: 'string', placeholder: '<branch>', summary: 'Branch to build. Defaults to main.' },
      { name: 'root-directory', type: 'string', placeholder: '<dir>', summary: 'Subdirectory to build from, for monorepos.' },
      { name: 'build-only-on-changes', type: 'boolean', summary: 'With --root-directory: skip a push build when the push changed nothing under it.' },
      { name: 'image', type: 'string', placeholder: '<ref>', summary: 'Container image to run instead of building.' },
      { name: 'schedule', type: 'string', placeholder: '<cron>', summary: 'Cron expression. Required for a cron service.' },
      { name: 'path', type: 'string', placeholder: '</api/cron/x>', summary: 'Cron only: call this path on one of your web services instead of running a container.' },
      { name: 'method', type: 'string', placeholder: '<GET|POST>', summary: 'Cron with --path only. Defaults to GET.' },
      { name: 'target', type: 'string', placeholder: '<web-service>', summary: 'Cron with --path only: which web service to call. Defaults to the only one, or the one called web.' },
      { name: 'instance', type: 'string', placeholder: '<size>', summary: 'shared-0.25, shared-0.5, standard-1 or standard-2. Shared sizes sleep when idle; standard sizes stay running.' },
      { name: 'public-port', type: 'string', placeholder: '<465:2465,587:2587>', summary: 'Raw TCP to publish: public port (465 or 587), then the port the process listens on.' },
    ],
    run: (client, ctx) =>
      client.services.create({
        productId: str(ctx.flags, 'product')!,
        name: ctx.positionals[0]!,
        kind: str(ctx.flags, 'kind') as 'web' | 'worker' | 'cron',
        environment: environmentOf(ctx.flags),
        repo: str(ctx.flags, 'repo'),
        branch: str(ctx.flags, 'branch'),
        rootDirectory: str(ctx.flags, 'rootDirectory'),
        buildOnlyOnChanges: bool(ctx.flags, 'buildOnlyOnChanges'),
        image: str(ctx.flags, 'image'),
        schedule: str(ctx.flags, 'schedule'),
        path: str(ctx.flags, 'path'),
        method: str(ctx.flags, 'method') as 'GET' | 'POST' | undefined,
        target: str(ctx.flags, 'target'),
        instance: str(ctx.flags, 'instance') as never,
        publicPorts: parsePublicPorts(str(ctx.flags, 'publicPort')),
        ...ctx.mutation,
      }),
  }),

  mutating({
    path: ['service', 'update'],
    operation: 'service_update',
    summary: 'Change a service: size, source, schedule, published ports, or pause and resume it.',
    positionals: [{ name: 'serviceId', summary: 'Service to change, from `helm7 service list`.', required: true }],
    flags: [
      PRODUCT_FLAG,
      { name: 'instance', type: 'string', placeholder: '<size>', summary: 'shared-0.25, shared-0.5, standard-1 or standard-2. Takes effect at once on a running service.' },
      { name: 'repo', type: 'string', placeholder: '<git-url>', summary: 'Repository to build, from the next deploy. For a repository that was renamed or moved.' },
      { name: 'branch', type: 'string', placeholder: '<branch>', summary: 'Branch to build, from the next deploy.' },
      { name: 'root-directory', type: 'string', placeholder: '<dir>', summary: 'Subdirectory to build from, from the next deploy.' },
      { name: 'clear-root-directory', type: 'boolean', summary: 'Build from the repository root again.' },
      { name: 'build-only-on-changes', type: 'boolean', summary: 'Skip a push build when the push changed nothing under the root directory. --no-build-only-on-changes builds on every push again.' },
      { name: 'image', type: 'string', placeholder: '<ref>', summary: 'Container image to run.' },
      { name: 'clear-image', type: 'boolean', summary: 'Stop using an image and build from the repository.' },
      { name: 'schedule', type: 'string', placeholder: '<cron>', summary: 'New schedule, for a cron service.' },
      { name: 'path', type: 'string', placeholder: '</api/cron/x>', summary: 'For a cron that calls a web service: the path to call.' },
      { name: 'method', type: 'string', placeholder: '<GET|POST>', summary: 'For a cron that calls a web service: the HTTP method.' },
      { name: 'target', type: 'string', placeholder: '<web-service>', summary: 'For a cron that calls a web service: which one.' },
      { name: 'public-port', type: 'string', placeholder: '<465:2465,587:2587>', summary: 'Replace the published raw TCP ports.' },
      { name: 'paused', type: 'boolean', summary: 'Stop the service and keep its configuration. --no-paused starts it again.' },
    ],
    run: (client, ctx) =>
      client.services.update({
        productId: str(ctx.flags, 'product')!,
        serviceId: ctx.positionals[0]!,
        instance: str(ctx.flags, 'instance') as never,
        repo: str(ctx.flags, 'repo'),
        branch: str(ctx.flags, 'branch'),
        // null is how the catalogue says "remove it"; an absent flag means "leave it".
        rootDirectory: bool(ctx.flags, 'clearRootDirectory') ? null : str(ctx.flags, 'rootDirectory'),
        buildOnlyOnChanges: bool(ctx.flags, 'buildOnlyOnChanges'),
        image: bool(ctx.flags, 'clearImage') ? null : str(ctx.flags, 'image'),
        schedule: str(ctx.flags, 'schedule'),
        path: str(ctx.flags, 'path'),
        method: str(ctx.flags, 'method') as 'GET' | 'POST' | undefined,
        target: str(ctx.flags, 'target'),
        publicPorts: parsePublicPorts(str(ctx.flags, 'publicPort')),
        paused: bool(ctx.flags, 'paused'),
        ...ctx.mutation,
      }),
  }),

  mutating({
    path: ['service', 'delete'],
    operation: 'service_delete',
    summary: 'Delete a service and its deployments. It cannot be undone.',
    positionals: [{ name: 'serviceId', summary: 'Service to delete.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.services.delete(str(ctx.flags, 'product')!, ctx.positionals[0]!, ctx.mutation),
  }),

  reading({
    path: ['deployment', 'list'],
    operation: 'deployment_list',
    summary: 'Deployments for a Product, newest first.',
    flags: [PRODUCT_FLAG, ENV_FLAG, ...PAGE_FLAGS],
    run: (client, ctx) =>
      client.deployments.list({
        productId: str(ctx.flags, 'product')!,
        environment: environmentOf(ctx.flags),
        cursor: str(ctx.flags, 'cursor'),
        limit: num(ctx.flags, 'limit'),
      }),
  }),

  reading({
    path: ['deployment', 'inspect'],
    operation: 'deployment_get',
    summary: 'One deployment: its state, commit, build mode and the health checks it passed.',
    positionals: [{ name: 'deploymentId', summary: 'Deployment to read.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.deployments.get(str(ctx.flags, 'product')!, ctx.positionals[0]!),
  }),

  reading({
    path: ['db', 'inspect'],
    operation: 'database_get',
    summary: 'A database: size, extensions, connections and backup state.',
    positionals: [{ name: 'databaseId', summary: 'Database to read, from `helm7 product inspect`.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.databases.get(str(ctx.flags, 'product')!, ctx.positionals[0]!),
  }),

  mutating({
    path: ['db', 'backup'],
    operation: 'database_backup',
    summary: 'Take a backup now, on top of the daily ones. Kept for 7 days.',
    positionals: [{ name: 'databaseId', summary: 'Database to back up.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.databases.backup(str(ctx.flags, 'product')!, ctx.positionals[0]!, ctx.mutation),
  }),

  mutating({
    path: ['db', 'restore'],
    operation: 'database_restore',
    summary: 'Restore from a backup or to a point in time. This replaces the current contents unless --into-new-database is given.',
    positionals: [{ name: 'databaseId', summary: 'Database to restore.', required: true }],
    flags: [
      PRODUCT_FLAG,
      { name: 'backup', type: 'string', placeholder: '<backup id>', summary: 'Backup to restore from. Give this or --at.' },
      { name: 'at', type: 'string', placeholder: '<iso-8601>', summary: 'Point in time inside the retention window. Give this or --backup.' },
      { name: 'into-new-database', type: 'boolean', summary: 'Restore alongside the current database instead of over it. Safer when you are unsure.' },
    ],
    run: (client, ctx) =>
      client.databases.restore({
        productId: str(ctx.flags, 'product')!,
        databaseId: ctx.positionals[0]!,
        backupId: str(ctx.flags, 'backup'),
        pointInTime: str(ctx.flags, 'at'),
        intoNewDatabase: bool(ctx.flags, 'intoNewDatabase'),
        ...ctx.mutation,
      }),
  }),

  reading({
    path: ['db', 'query'],
    operation: 'database_query',
    summary: 'Run one read-only SQL statement and print the rows. SQL is an argument, "-" for standard input, or --file.',
    positionals: [
      { name: 'databaseId', summary: 'Database to query.', required: true },
      { name: 'sql', summary: 'One SELECT, WITH, VALUES or TABLE statement, or "-" to read it from standard input.' },
    ],
    flags: [
      PRODUCT_FLAG,
      { name: 'file', type: 'string', placeholder: '<path>', summary: 'Read the SQL from a file instead.' },
      { name: 'limit', type: 'number', placeholder: '<1-1000>', summary: 'Most rows to return. Defaults to 100.' },
    ],
    run: (client, ctx) =>
      client.databases.query(str(ctx.flags, 'product')!, ctx.positionals[0]!, resolveSql(ctx, 1), { limit: num(ctx.flags, 'limit') }),
  }),

  mutating({
    path: ['db', 'execute'],
    operation: 'database_execute',
    summary: 'Run a SQL script that changes data or schema, in one transaction. --dry-run runs it and rolls it back.',
    positionals: [
      { name: 'databaseId', summary: 'Database to change.', required: true },
      { name: 'sql', summary: 'One or more statements, or "-" to read them from standard input.' },
    ],
    flags: [
      PRODUCT_FLAG,
      { name: 'file', type: 'string', placeholder: '<path>', summary: 'Read the SQL from a file instead.' },
    ],
    run: (client, ctx) =>
      client.databases.execute({
        productId: str(ctx.flags, 'product')!,
        databaseId: ctx.positionals[0]!,
        sql: resolveSql(ctx, 1),
        ...ctx.mutation,
      }),
  }),

  reading({
    path: ['bucket', 'list'],
    operation: 'bucket_list',
    summary: 'Storage buckets in a Product.',
    flags: [PRODUCT_FLAG, ENV_FLAG],
    run: (client, ctx) => client.storage.listBuckets({ productId: str(ctx.flags, 'product')!, environment: environmentOf(ctx.flags) }),
  }),

  mutating({
    path: ['bucket', 'create'],
    operation: 'storage_create_bucket',
    summary: 'Create an S3-compatible storage bucket.',
    positionals: [{ name: 'name', summary: 'Bucket name.', required: true }],
    flags: [PRODUCT_FLAG, ENV_FLAG, { name: 'public', type: 'boolean', summary: 'Let anyone read the objects in it.' }],
    run: (client, ctx) =>
      client.storage.createBucket({
        productId: str(ctx.flags, 'product')!,
        name: ctx.positionals[0]!,
        environment: environmentOf(ctx.flags),
        public: bool(ctx.flags, 'public'),
        ...ctx.mutation,
      }),
  }),

  mutating({
    path: ['bucket', 'delete'],
    operation: 'bucket_delete',
    summary: 'Delete a storage bucket and every object in it. It cannot be undone.',
    positionals: [{ name: 'bucketId', summary: 'Bucket to delete, from `helm7 bucket list`.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.storage.deleteBucket(str(ctx.flags, 'product')!, ctx.positionals[0]!, ctx.mutation),
  }),

  reading({
    path: ['domain', 'list'],
    operation: 'domain_list',
    summary: 'Domains attached to a Product, and whether their certificates are issued.',
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.domains.list(str(ctx.flags, 'product')!),
  }),

  mutating({
    path: ['domain', 'remove'],
    operation: 'domain_remove',
    summary: 'Detach a domain. The service stops answering on it.',
    positionals: [{ name: 'domainId', summary: 'Domain to remove, from `helm7 domain list`.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.domains.remove(str(ctx.flags, 'product')!, ctx.positionals[0]!, ctx.mutation),
  }),

  reading({
    path: ['env', 'list'],
    operation: 'secret_list',
    summary: 'Environment variable names and fingerprints. Values are never returned.',
    flags: [PRODUCT_FLAG, ENV_FLAG],
    run: (client, ctx) => client.secrets.list({ productId: str(ctx.flags, 'product')!, environment: environmentOf(ctx.flags) }),
  }),

  mutating({
    path: ['env', 'unset'],
    operation: 'secret_delete',
    summary: 'Remove an environment variable. Services lose it on their next deployment.',
    positionals: [{ name: 'KEY', summary: 'Variable name.', required: true }],
    flags: [PRODUCT_FLAG, ENV_FLAG],
    run: (client, ctx) =>
      client.secrets.delete({
        productId: str(ctx.flags, 'product')!,
        key: ctx.positionals[0]!,
        environment: environmentOf(ctx.flags),
        ...ctx.mutation,
      }),
  }),

  mutating({
    path: ['test-accounts', 'create'],
    operation: 'test_account_create',
    summary: 'Create a test account an automated tester can sign in with. Passwords are write-only.',
    flags: [
      PRODUCT_FLAG,
      ENV_FLAG,
      { name: 'label', type: 'string', placeholder: '<name>', required: true, summary: 'Lower case letters, digits and hyphens. Unique in the environment.' },
      { name: 'mode', type: 'string', placeholder: '<provision|external|register>', required: true, summary: 'provision creates the user in managed auth with a generated password. external does it in the Product\'s own auth service (--auth-provider). register records an account made elsewhere.' },
      { name: 'auth-provider', type: 'string', placeholder: '<supabase>', summary: 'external only: which auth service holds the Product\'s users.' },
      { name: 'role', type: 'string', placeholder: '<role>', summary: 'What it is for: member, admin, free-tier.' },
      { name: 'email', type: 'string', placeholder: '<address>', summary: 'register: required. provision: optional, must carry +helm7test.' },
      { name: 'password', type: 'string', placeholder: '<password>', summary: 'register only. Write-only.' },
      { name: 'totp-secret', type: 'string', placeholder: '<base32>', summary: 'Seed for two-factor sign-in. Write-only.' },
      { name: 'notes', type: 'string', placeholder: '<text>', summary: 'A note for people. Never put a secret in it.' },
      { name: 'expires-in', type: 'string', placeholder: '<90m|24h|7d>', summary: 'Make the account temporary. Its user and secrets are removed after this long.' },
      { name: 'expires-at', type: 'string', placeholder: '<iso time>', summary: 'Make the account temporary until this time. Not with --expires-in.' },
    ],
    run: (client, ctx) => {
      const mode = str(ctx.flags, 'mode')
      if (mode !== 'provision' && mode !== 'external' && mode !== 'register') throw new Error('--mode must be provision, external or register')
      return client.testAccounts.create({
        productId: str(ctx.flags, 'product')!,
        environment: environmentOf(ctx.flags),
        label: str(ctx.flags, 'label')!,
        mode,
        authProvider: str(ctx.flags, 'authProvider') as 'supabase' | undefined,
        role: str(ctx.flags, 'role'),
        email: str(ctx.flags, 'email'),
        password: str(ctx.flags, 'password'),
        totpSecret: str(ctx.flags, 'totpSecret'),
        notes: str(ctx.flags, 'notes'),
        expiresIn: str(ctx.flags, 'expiresIn'),
        expiresAt: str(ctx.flags, 'expiresAt'),
        ...ctx.mutation,
      })
    },
  }),

  reading({
    path: ['test-accounts', 'list'],
    operation: 'test_account_list',
    summary: 'Test accounts: label, email, fingerprint, expiry and last use. Never a password.',
    flags: [PRODUCT_FLAG, ENV_FLAG],
    run: (client, ctx) => client.testAccounts.list({ productId: str(ctx.flags, 'product')!, environment: environmentOf(ctx.flags) }),
  }),

  reading({
    path: ['test-accounts', 'get'],
    operation: 'test_account_get',
    summary: 'One test account, without its secrets.',
    positionals: [{ name: 'accountId', summary: 'From `helm7 test-accounts list`.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.testAccounts.get(str(ctx.flags, 'product')!, ctx.positionals[0]!),
  }),

  mutating({
    path: ['test-accounts', 'rotate'],
    operation: 'test_account_rotate',
    summary: 'Replace a test account password (and end its sessions). Registered accounts need --password.',
    positionals: [{ name: 'accountId', summary: 'From `helm7 test-accounts list`.', required: true }],
    flags: [
      PRODUCT_FLAG,
      { name: 'password', type: 'string', placeholder: '<password>', summary: 'register only: the new password you set in the product. Write-only.' },
      { name: 'totp-secret', type: 'string', placeholder: '<base32>', summary: 'Replace the stored TOTP seed. Write-only.' },
    ],
    run: (client, ctx) =>
      client.testAccounts.rotate({
        productId: str(ctx.flags, 'product')!,
        accountId: ctx.positionals[0]!,
        password: str(ctx.flags, 'password'),
        totpSecret: str(ctx.flags, 'totpSecret'),
        ...ctx.mutation,
      }),
  }),

  mutating({
    path: ['test-accounts', 'delete'],
    operation: 'test_account_delete',
    summary: 'Delete a test account and, if Helm7 made it, its auth user.',
    positionals: [{ name: 'accountId', summary: 'From `helm7 test-accounts list`.', required: true }],
    flags: [PRODUCT_FLAG],
    run: (client, ctx) => client.testAccounts.delete({ productId: str(ctx.flags, 'product')!, accountId: ctx.positionals[0]!, ...ctx.mutation }),
  }),

  mutating({
    path: ['test-accounts', 'checkout'],
    operation: 'test_account_checkout',
    summary: 'Print a test account sign-in (email, password, TOTP code, session). Needs test_account:use; logged with --run-ref.',
    positionals: [{ name: 'accountId', summary: 'From `helm7 test-accounts list`.', required: true }],
    flags: [
      PRODUCT_FLAG,
      { name: 'run-ref', type: 'string', placeholder: '<run id>', required: true, summary: 'What is using the account. Written to the activity log.' },
      { name: 'ttl', type: 'number', placeholder: '<60-3600>', summary: 'Lease in seconds. Default 900. Sessions Helm7 minted end with it.' },
      { name: 'include-password', type: 'boolean', summary: 'Also print the password of a provisioned account. Off by default: the session is usually enough.' },
    ],
    run: (client, ctx) => {
      ctx.log?.('This prints a credential. Do not paste it into a log or a prompt.')
      return client.testAccounts.checkout({
        productId: str(ctx.flags, 'product')!,
        accountId: ctx.positionals[0]!,
        runRef: str(ctx.flags, 'runRef')!,
        ttlSeconds: num(ctx.flags, 'ttl'),
        includePassword: ctx.flags.includePassword === true ? true : undefined,
        ...ctx.mutation,
      })
    },
  }),

  reading({
    path: ['test-accounts', 'totp'],
    operation: 'test_account_totp',
    summary: 'Print the current two-factor code for a test account. Needs test_account:use.',
    positionals: [{ name: 'accountId', summary: 'From `helm7 test-accounts list`.', required: true }],
    flags: [PRODUCT_FLAG, { name: 'run-ref', type: 'string', placeholder: '<run id>', summary: 'What is asking.' }],
    run: (client, ctx) => client.testAccounts.totp({ productId: str(ctx.flags, 'product')!, accountId: ctx.positionals[0]!, runRef: str(ctx.flags, 'runRef') }),
  }),

  mutating({
    path: ['context', 'enable'],
    operation: 'context_enable',
    summary: 'Give the Product memory: its own Contextely product, with credentials set on the environment.',
    flags: [
      PRODUCT_FLAG,
      { name: 'share-memory', type: 'boolean', summary: "Let other Products in the workspace read this one's memory." },
      { name: 'share-sources', type: 'boolean', summary: 'Pool connections with the rest of the workspace.' },
    ],
    run: (client, ctx) =>
      client.context.enable({
        productId: str(ctx.flags, 'product')!,
        sharesMemory: bool(ctx.flags, 'shareMemory'),
        sharesSources: bool(ctx.flags, 'shareSources'),
        ...ctx.mutation,
      }),
  }),

  reading({
    path: ['cost', 'estimate'],
    operation: 'cost_estimate',
    summary: 'Price a shape per month without building it. Resources are a JSON array, inline or from a file.',
    flags: [
      { name: 'resources', type: 'string', placeholder: '<json>', summary: 'e.g. [{"type":"service","instance":"shared-0.25","always_on":false}].' },
      { name: 'file', type: 'string', placeholder: '<path>', summary: 'Read the resources JSON from a file instead.' },
      { name: 'egress-gb', type: 'number', placeholder: '<gb>', summary: 'Expected monthly egress in GB.' },
    ],
    run: (client, ctx) => {
      const inline = str(ctx.flags, 'resources')
      const file = str(ctx.flags, 'file')
      if ((inline === undefined) === (file === undefined)) throw new Error('Give the resources with --resources or --file, one of them.')
      let text = inline
      if (file !== undefined) {
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          throw new Error(`${file} could not be read.`)
        }
      }
      return client.billing.estimate({ resources: parseJsonArray(text!, 'The resources'), monthlyEgressGb: num(ctx.flags, 'egressGb') })
    },
  }),

  mutating({
    path: ['billing', 'checkout'],
    operation: 'billing_checkout_create',
    summary: 'Start a subscription. Prints a checkout link for a person to open.',
    flags: [
      { name: 'plan', type: 'string', placeholder: '<builder|pro|scale>', required: true, summary: 'The plan to subscribe to.' },
      { name: 'success-url', type: 'string', placeholder: '<url>', required: true, summary: 'Where to send the person after paying.' },
      { name: 'cancel-url', type: 'string', placeholder: '<url>', required: true, summary: 'Where to send the person if they back out.' },
    ],
    run: (client, ctx) => {
      const plan = str(ctx.flags, 'plan')
      if (plan !== 'builder' && plan !== 'pro' && plan !== 'scale') throw new Error('--plan must be builder, pro or scale')
      return client.billing.checkout({ plan, successUrl: str(ctx.flags, 'successUrl')!, cancelUrl: str(ctx.flags, 'cancelUrl')! })
    },
  }),

  reading({
    path: ['billing', 'portal'],
    operation: 'billing_portal_create',
    summary: 'A link to manage the subscription, invoices and payment method.',
    flags: [{ name: 'return-url', type: 'string', placeholder: '<url>', required: true, summary: 'Where to send the person back to.' }],
    run: (client, ctx) => client.billing.portal({ returnUrl: str(ctx.flags, 'returnUrl')! }),
  }),

  mutating({
    path: ['key', 'create'],
    operation: 'agent_key_create',
    summary: 'Mint a key for one agent, with its own scopes, spend cap and expiry. The secret is shown once.',
    positionals: [{ name: 'name', summary: 'What this agent is for. Shown in the audit trail.', required: true }],
    flags: [
      { name: 'scope', type: 'string', placeholder: '<a,b>', summary: 'Scopes to grant, narrowed to what you hold yourself.' },
      // Not `--product`: that flag is filled from your default Product, and a key
      // silently confined to it would be a surprise nobody asked for.
      { name: 'confine-to', type: 'string', placeholder: '<prd_...>', summary: 'Confine the key to one Product. Omit for the whole workspace.' },
      { name: 'budget', type: 'number', placeholder: '<usd>', summary: 'Hard monthly spend cap for this key.' },
      { name: 'expires-in-hours', type: 'number', placeholder: '<hours>', summary: 'The key stops working after this long.' },
      { name: 'capability', type: 'string', placeholder: '<may_deploy,may_administer,may_manage_billing>', summary: 'Capabilities beyond the scopes.' },
    ],
    run: (client, ctx) =>
      client.agents.createKey({
        name: ctx.positionals[0]!,
        scopes: csv(str(ctx.flags, 'scope')),
        productId: str(ctx.flags, 'confineTo'),
        budgetUsd: num(ctx.flags, 'budget'),
        expiresInHours: num(ctx.flags, 'expiresInHours'),
        capabilities: csv(str(ctx.flags, 'capability')) as never,
        ...ctx.mutation,
      }),
  }),

  reading({
    path: ['key', 'list'],
    operation: 'agent_key_list',
    summary: 'Agent keys: name, scopes, spend against the cap, expiry and last use. Never the secret.',
    flags: [{ name: 'include-revoked', type: 'boolean', summary: 'Also list revoked keys.' }],
    run: (client, ctx) => client.agents.listKeys({ includeRevoked: bool(ctx.flags, 'includeRevoked') }),
  }),

  mutating({
    path: ['key', 'revoke'],
    operation: 'agent_key_revoke',
    summary: 'Stop a key at once. In-flight requests using it fail, and it cannot be undone.',
    positionals: [{ name: 'keyId', summary: 'Key to revoke, from `helm7 key list`.', required: true }],
    run: (client, ctx) => client.agents.revokeKey(ctx.positionals[0]!, ctx.mutation),
  }),

  reading({
    path: ['activity'],
    operation: 'activity_list',
    summary: 'The audit trail: what was done, by whom, and whether it was applied, refused or failed.',
    flags: [
      { name: 'product', type: 'string', placeholder: '<prd_...>', summary: 'Narrow to one Product.' },
      { name: 'outcome', type: 'string', placeholder: '<applied|planned|refused|failed>', summary: 'Only entries with this outcome.' },
      { name: 'include-dry-runs', type: 'boolean', summary: 'Include plans that were only looked at.' },
      ...PAGE_FLAGS,
    ],
    run: (client, ctx) => {
      const outcome = str(ctx.flags, 'outcome')
      if (outcome !== undefined && !['applied', 'planned', 'refused', 'failed'].includes(outcome)) {
        throw new Error('--outcome must be applied, planned, refused or failed')
      }
      return client.organization.activity({
        productId: str(ctx.flags, 'product'),
        outcome: outcome as 'applied' | 'planned' | 'refused' | 'failed' | undefined,
        includeDryRuns: bool(ctx.flags, 'includeDryRuns'),
        cursor: str(ctx.flags, 'cursor'),
        limit: num(ctx.flags, 'limit'),
      })
    },
  }),

  reading({
    path: ['member', 'list'],
    operation: 'member_list',
    summary: 'People in the workspace, with their role, and invitations not yet accepted.',
    run: (client) => client.organization.members(),
  }),

  mutating({
    path: ['member', 'invite'],
    operation: 'invite_create',
    summary: 'Make an invitation link, shown once, valid for 7 days. Nothing is emailed.',
    flags: [{ name: 'role', type: 'string', placeholder: '<admin|member|viewer>', summary: 'Role the invited person gets. Defaults to member.' }],
    run: (client, ctx) => {
      const role = str(ctx.flags, 'role')
      if (role !== undefined && role !== 'admin' && role !== 'member' && role !== 'viewer') throw new Error('--role must be admin, member or viewer')
      return client.organization.invite({ role, ...ctx.mutation })
    },
  }),

  mutating({
    path: ['member', 'remove'],
    operation: 'member_remove',
    summary: 'Remove a person from the workspace. Their keys stop working.',
    positionals: [{ name: 'memberId', summary: 'Member to remove, from `helm7 member list`.', required: true }],
    run: (client, ctx) => client.organization.removeMember(ctx.positionals[0]!, ctx.mutation),
  }),

  /*
   * The one command that creates something and still has no --dry-run. The
   * catalogue gives cloud_init no mutation controls because there is nothing to
   * cost and nothing to destroy, and demanding a plan before an agent can hold
   * a credential would defeat the zero-friction start that is the point of it.
   */
  reading({
    path: ['cloud', 'init'],
    operation: 'cloud_init',
    summary: 'Start an ephemeral workspace with no account, no card and no human step.',
    flags: [{ name: 'label', type: 'string', placeholder: '<name>', summary: 'Optional name, to find it again.' }],
    run: (client, ctx) => client.agents.cloudInit({ label: str(ctx.flags, 'label') }),
  }),

  /*
   * Bare, like `cloud init`, and for the same reason. The catalogue gives
   * cloud_claim no mutation controls — there is nothing to cost and nothing to
   * destroy — so advertising --dry-run here would put a flag on the wire that
   * the operation does not honour. A flag that silently does nothing is worse
   * than no flag, and `commands.test.ts` holds the two sides to that.
   */
  reading({
    path: ['cloud', 'claim'],
    operation: 'cloud_claim',
    summary: 'Keep an ephemeral workspace by attaching it to a real account.',
    run: (client) => client.agents.cloudClaim(),
  }),
]

/** Translate the parsed mutation flags into the SDK's options. */
export function mutationFrom(flags: Flags): MutationOptions {
  return {
    dryRun: bool(flags, 'dryRun'),
    confirm: bool(flags, 'confirm'),
    idempotencyKey: str(flags, 'idempotencyKey'),
  }
}
