/**
 * `@helm7/sdk` — the official client for the Helm7 API.
 *
 * ZERO DEPENDENCIES, `fetch` only, server-side. Runs on Node 22+, Vercel
 * Functions, Cloudflare Workers, Deno and Bun.
 *
 * ```ts
 * import { Helm7 } from '@helm7/sdk'
 *
 * const helm7 = new Helm7({ apiKey: process.env.HELM7_API_KEY! })
 *
 * const plan = await helm7.databases.create({ productId, dryRun: true })
 * console.log(plan.cost.monthly_high, plan.destructive_actions)
 * ```
 *
 * The endpoint table in `endpoints.ts` is asserted against `@helm7/catalogue`
 * in both directions, so an operation the platform gained cannot be silently
 * missing from this client, and one it never had cannot be silently invented.
 */
export { Helm7, DEFAULT_BASE_URL, KEY_PREFIX, isApiKey } from './client.js'
export type { Helm7Options } from './client.js'

export { Helm7Error } from './errors.js'
export type { Helm7ErrorCode, Helm7ServerErrorCode, Helm7ErrorInit } from './errors.js'

export { ENDPOINTS, resolvePath, pathParams } from './endpoints.js'
export type { EndpointName, EndpointSpec, HttpMethod } from './endpoints.js'

export { DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, splitParams } from './transport.js'
export type { RetryPolicy, RequestOptions, WireParams } from './transport.js'

export { mutationWire } from './mutations.js'
export type { MutationOptions } from './mutations.js'

export type {
  Capability,
  Environment,
  Instance,
  JsonObject,
  JsonValue,
  ListEnvelope,
  Plan,
  PlanAction,
  PlanChange,
  PlanCost,
  Region,
  ServiceKind,
  WhoAmI,
} from './types.js'

export type { ProductsResource, ProductCreateInput, ProductListOptions } from './resources/products.js'
export type { EnvironmentsResource, EnvironmentCreateInput } from './resources/environments.js'
export type { ServicesResource, ServiceCreateInput, ServiceUpdateInput, ServiceLogsOptions, PublicPort } from './resources/services.js'
export type { DeploymentsResource, DeployInput, DeploymentListOptions } from './resources/deployments.js'
export type { DatabasesResource, DatabaseCreateInput, DatabaseRestoreInput } from './resources/databases.js'
export type { AuthResource, AuthEnableInput, AuthGetOptions, AuthUpdateInput, AuthImportInput, AuthImportUser, AuthProviderSettings } from './resources/auth.js'
export type { StorageResource, BucketCreateInput } from './resources/storage.js'
export type { DomainsResource, DomainAttachInput } from './resources/domains.js'
export type { SecretsResource, SecretSetInput, SecretListOptions } from './resources/secrets.js'
export type {
  TestAccountsResource, TestAccountCreateInput, TestAccountRotateInput, TestAccountCheckoutInput, TestAccountCheckout,
} from './resources/test-accounts.js'
export type { ContextResource, ContextEnableInput } from './resources/context.js'
export type { BillingResource, UsageOptions, CostEstimateInput } from './resources/billing.js'
export type { AgentsResource, AgentKeyCreateInput } from './resources/agents.js'
