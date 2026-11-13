/**
 * Where the credential comes from.
 *
 * `HELM7_API_KEY` first, then `~/.helm7/config.json`. Environment first because
 * that is the one a person can set for a single command, and a config file that
 * silently outranked it would make `HELM7_API_KEY=other helm7 deploy` a lie.
 *
 * The filesystem is injected rather than imported so this is testable without
 * writing into somebody's home directory during a test run.
 */
import type { Flags } from './args.js'

export interface ConfigFile {
  apiKey?: string
  baseUrl?: string
  /** Default `--product`, so a person working on one Product stops typing it. */
  productId?: string
}

export interface ConfigSources {
  env: Record<string, string | undefined>
  /** Returns the file's contents, or undefined when it does not exist. */
  readFile: (path: string) => string | undefined
  homeDir: string
}

export interface ResolvedConfig {
  apiKey?: string
  baseUrl?: string
  /** Defaults to merge into the parsed flags. */
  defaults: Flags
  /** Where the key came from, for the message when a call is refused. */
  keySource: 'HELM7_API_KEY' | 'config file' | 'none'
  warnings: string[]
}

export const configPath = (homeDir: string): string => `${homeDir}/.helm7/config.json`

/**
 * Read the config file, tolerating its absence and complaining about its
 * corruption.
 *
 * A malformed config is reported rather than ignored: the failure it otherwise
 * produces is an authentication error on a machine where the key is right there
 * in the file, and that is an hour of somebody's afternoon.
 */
export function loadConfigFile(sources: ConfigSources): { config: ConfigFile; warnings: string[] } {
  const path = configPath(sources.homeDir)
  const raw = sources.readFile(path)
  if (raw === undefined) return { config: {}, warnings: [] }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { config: {}, warnings: [`${path} is not a JSON object; ignoring it`] }
    }
    return { config: parsed as ConfigFile, warnings: [] }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { config: {}, warnings: [`${path} is not valid JSON (${detail}); ignoring it`] }
  }
}

export function resolveConfig(sources: ConfigSources): ResolvedConfig {
  const { config, warnings } = loadConfigFile(sources)
  const envKey = sources.env.HELM7_API_KEY?.trim()
  const fileKey = config.apiKey?.trim()

  const defaults: Flags = {}
  const product = sources.env.HELM7_PRODUCT ?? config.productId
  if (product) defaults.product = product

  return {
    apiKey: envKey || fileKey || undefined,
    baseUrl: sources.env.HELM7_BASE_URL ?? config.baseUrl,
    defaults,
    keySource: envKey ? 'HELM7_API_KEY' : fileKey ? 'config file' : 'none',
    warnings,
  }
}

/** The message for having no credential at all. Says both places it looks. */
export function missingKeyMessage(homeDir: string): string {
  return (
    'No API key. Set HELM7_API_KEY, or put {"apiKey": "hlm_sk_..."} in ' +
    `${configPath(homeDir)}. Run \`helm7 cloud init\` for an ephemeral workspace if you have no account yet.`
  )
}
