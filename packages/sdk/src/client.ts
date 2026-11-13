/**
 * The client.
 *
 * SERVER-SIDE ONLY, and not out of squeamishness: this holds an `hlm_sk_` in
 * memory, and a browser bundle holding one has published it. Anything
 * user-facing should call its own backend, which calls this.
 *
 * THE RESOURCES ARE GROUPED BY THE CATALOGUE'S `group` FIELD, not by whatever
 * felt natural while writing them. That is what keeps `client.databases.create`
 * and the `database_create` tool an agent sees over MCP recognisably the same
 * operation — a person reading the docs for one surface should not have to
 * re-learn the other. `endpoints.test.ts` enforces the set; the grouping is
 * enforced by nothing but this comment, so keep it.
 */
import { Transport, type RetryPolicy, type RequestOptions } from './transport.js'
import { ENDPOINTS } from './endpoints.js'
import { ProductsResource } from './resources/products.js'
import { EnvironmentsResource } from './resources/environments.js'
import { ServicesResource } from './resources/services.js'
import { DeploymentsResource } from './resources/deployments.js'
import { DatabasesResource } from './resources/databases.js'
import { AuthResource } from './resources/auth.js'
import { StorageResource } from './resources/storage.js'
import { DomainsResource } from './resources/domains.js'
import { SecretsResource } from './resources/secrets.js'
import { TestAccountsResource } from './resources/test-accounts.js'
import { ContextResource } from './resources/context.js'
import { BillingResource } from './resources/billing.js'
import { AgentsResource } from './resources/agents.js'
import { GitHubResource } from './resources/github.js'
import { OrganizationResource } from './resources/organization.js'
import type { WhoAmI } from './types.js'

export const DEFAULT_BASE_URL = 'https://www.helm7.com'

/** The prefix every Helm7 key carries. */
export const KEY_PREFIX = 'hlm_sk_'

export interface Helm7Options {
  /**
   * The API key. Either the string, or a synchronous function returning it —
   * use the function form whenever the key can rotate underneath a long-lived
   * process, or the first rotation leaves that process authenticating with a
   * credential that no longer exists and reporting it as an auth failure
   * nobody changed anything to cause.
   */
  apiKey: string | (() => string)
  /** Defaults to Helm7's hosted deployment. */
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  retry?: RetryPolicy
  /** Appended to the SDK's User-Agent, so a deployment can identify itself. */
  appName?: string
}

/** Is this a Helm7 API key? Exported so a caller classifying a stored
 *  credential by prefix has one definition of the answer to use. */
export function isApiKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(KEY_PREFIX)
}

export class Helm7 {
  readonly products: ProductsResource
  readonly environments: EnvironmentsResource
  readonly services: ServicesResource
  readonly deployments: DeploymentsResource
  readonly databases: DatabasesResource
  readonly auth: AuthResource
  readonly storage: StorageResource
  readonly domains: DomainsResource
  readonly secrets: SecretsResource
  readonly testAccounts: TestAccountsResource
  readonly context: ContextResource
  readonly billing: BillingResource
  readonly agents: AgentsResource
  readonly github: GitHubResource
  readonly organization: OrganizationResource

  private readonly transport: Transport

  constructor(options: Helm7Options) {
    if (!options.apiKey) throw new Error('Helm7 SDK: `apiKey` is required')

    const resolveKey = typeof options.apiKey === 'function' ? options.apiKey : () => options.apiKey as string

    this.transport = new Transport({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      userAgent: options.appName ? `helm7-sdk (${options.appName})` : 'helm7-sdk',
      authHeaders: () => {
        const key = resolveKey()
        if (!key) throw new Error('Helm7 SDK: the key resolver returned nothing')
        return { Authorization: `Bearer ${key}` }
      },
    })

    this.products = new ProductsResource(this.transport)
    this.environments = new EnvironmentsResource(this.transport)
    this.services = new ServicesResource(this.transport)
    this.deployments = new DeploymentsResource(this.transport)
    this.databases = new DatabasesResource(this.transport)
    this.auth = new AuthResource(this.transport)
    this.storage = new StorageResource(this.transport)
    this.domains = new DomainsResource(this.transport)
    this.secrets = new SecretsResource(this.transport)
    this.testAccounts = new TestAccountsResource(this.transport)
    this.context = new ContextResource(this.transport)
    this.billing = new BillingResource(this.transport)
    this.agents = new AgentsResource(this.transport)
    this.github = new GitHubResource(this.transport)
    this.organization = new OrganizationResource(this.transport)
  }

  /**
   * Who this key speaks as, and what it may spend.
   *
   * Top-level rather than filed under a resource because it is the call to make
   * FIRST: a key resolves to a member and cannot exceed what that member can
   * do, so one call tells you your real ceiling before you plan anything
   * against a scope you turn out not to hold.
   */
  whoami(options: RequestOptions = {}): Promise<WhoAmI> {
    return this.transport.call(ENDPOINTS.whoami, {}, options)
  }
}
