/**
 * The impure shell: everything the pure layers refuse to touch.
 *
 * `main` takes its world as an argument — argv, env, home directory, whether
 * stdout is a terminal, how to read a file, how to build a client — and returns
 * an exit code instead of calling `process.exit`. The bin supplies the real
 * world. That is what lets the interesting behaviour be tested without a
 * subprocess and without a network.
 *
 * EXIT CODES ARE NOT ALL 1. A script that shells out needs to tell "I asked
 * wrongly" from "Helm7 refused" from "there is no credential here" — the first
 * is a bug in the script, the second may be worth retrying, and the third is a
 * setup problem on the machine. Collapsing them makes every failure look the
 * same to the only thing that was going to react automatically.
 */
import type { Helm7 } from '@helm7/sdk'
import { parseInvocation } from './args.js'
import { COMMANDS, GLOBAL_FLAGS, bool, mutationFrom, str, type CommandContext } from './commands.js'
import { buildAndUpload, localBuildSupport } from './local-build.js'
import { missingKeyMessage, resolveConfig, type ConfigSources } from './config.js'
import { renderCommandHelp, renderHelp } from './help.js'
import { isPlan, renderError, renderResult, toRenderableError } from './render.js'

export const EXIT = {
  ok: 0,
  /** Helm7 answered, and the answer was no. */
  failed: 1,
  /** The command line was wrong. Nothing was sent. */
  usage: 2,
  /** No credential was found. Nothing was sent. */
  credential: 3,
} as const

export interface Io extends ConfigSources {
  argv: string[]
  version: string
  isTty: boolean
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** Injected by tests; the real one is loaded on demand. */
  createClient?: (options: { apiKey: string; baseUrl?: string }) => Helm7
  localBuild?: CommandContext['localBuild']
  /** Standard input, for `db query -`. Defaults to reading fd 0. */
  stdin?: () => string
}

/**
 * Build the real client, loading the SDK only at the moment a request is
 * actually going to be made. See `client.ts` for why that boundary exists.
 */
async function defaultClient(options: { apiKey: string; baseUrl?: string }): Promise<Helm7> {
  const { createClient } = await import('./client.js')
  return createClient(options)
}

export async function main(io: Io): Promise<number> {
  const config = resolveConfig(io)
  for (const warning of config.warnings) io.stderr(warning)

  const parsed = parseInvocation(io.argv, COMMANDS, GLOBAL_FLAGS, config.defaults)

  if (parsed.kind === 'version') {
    io.stdout(io.version)
    return EXIT.ok
  }

  if (parsed.kind === 'help') {
    io.stdout(parsed.command ? renderCommandHelp(parsed.command, GLOBAL_FLAGS) : renderHelp(COMMANDS, GLOBAL_FLAGS))
    return EXIT.ok
  }

  if (parsed.kind === 'error') {
    for (const error of parsed.errors) io.stderr(error)
    if (parsed.suggestions?.length) io.stderr(`Did you mean: ${parsed.suggestions.join(', ')}?`)
    io.stderr('Run `helm7 --help` for the command list.')
    return EXIT.usage
  }

  const { command, flags, positionals, errors } = parsed.invocation
  const colour = bool(flags, 'colour') ?? (io.isTty && !io.env.NO_COLOR)

  if (errors.length > 0) {
    for (const error of errors) io.stderr(error)
    io.stderr(`Run \`helm7 ${command.path.join(' ')} --help\` for what this command takes.`)
    return EXIT.usage
  }

  const apiKey = str(flags, 'apiKey') ?? config.apiKey
  if (!apiKey) {
    io.stderr(missingKeyMessage(io.homeDir))
    return EXIT.credential
  }

  const json = bool(flags, 'json') === true
  const baseUrl = str(flags, 'baseUrl') ?? config.baseUrl

  try {
    const create = io.createClient ?? defaultClient
    const client = await create({ apiKey, baseUrl })
    const result = await command.run(client, { flags, positionals, mutation: mutationFrom(flags), log: json ? () => undefined : io.stderr, stdin: io.stdin, localBuild: io.localBuild ?? { support: localBuildSupport, upload: buildAndUpload } })

    if (json) {
      io.stdout(JSON.stringify(result ?? null, null, 2))
      return EXIT.ok
    }

    const dryRun = bool(flags, 'dryRun') === true
    io.stdout(renderResult(result, { colour, dryRun }))
    return exitCodeFor(command.mutating, dryRun, result)
  } catch (error) {
    if (json) {
      const { code, message, remedy, requestId } = toRenderableError(error)
      io.stderr(JSON.stringify({ error: { code, message, remedy, request_id: requestId } }, null, 2))
    } else {
      io.stderr(renderError(error, { colour }))
    }
    return EXIT.failed
  }
}

/**
 * A refused destructive call is a failure, even though it answered 200-shaped.
 *
 * `applied: false` from a command the person did NOT run with --dry-run means
 * the change did not happen. Returning 0 there would let a deploy script that
 * forgot --confirm report success and carry on to the next step, which is
 * exactly the kind of quiet non-event this CLI exists to make loud.
 */
function exitCodeFor(mutating: boolean, dryRun: boolean, result: unknown): number {
  if (!mutating || dryRun || !isPlan(result)) return EXIT.ok
  return result.applied === false ? EXIT.failed : EXIT.ok
}
