/**
 * `@helm7/cli` — the `helm7` command.
 *
 * Depends on nothing but `@helm7/sdk`, which itself depends on nothing. A CLI
 * people install to fix a production problem should not be able to fail because
 * a transitive dependency published a bad version that morning.
 *
 * The module exports the pure layers as well as `main`, so the parser, the plan
 * renderer and the command table can be used and tested — and, if the web app
 * ever wants to show the same plan output, rendered — without a process.
 */
export { main, EXIT } from './run.js'
export type { Io } from './run.js'

export {
  parseInvocation,
  parseFlags,
  matchCommand,
  applyDefaults,
  validate,
  camel,
} from './args.js'
export type { FlagSpec, Flags, Invocation, ParsableCommand, ParseResult, PositionalSpec } from './args.js'

export { COMMANDS, GLOBAL_FLAGS, MUTATION_FLAGS, mutationFrom, parseAssignment, csv } from './commands.js'
export type { Command, CommandContext } from './commands.js'

export { renderPlan, renderResult, renderRecord, renderError, toRenderableError, isPlan } from './render.js'
export type { RenderOptions, RenderableError } from './render.js'

export { renderHelp, renderCommandHelp } from './help.js'

export { resolveConfig, loadConfigFile, configPath, missingKeyMessage } from './config.js'
export type { ConfigFile, ConfigSources, ResolvedConfig } from './config.js'
