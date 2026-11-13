/**
 * Every endpoint this SDK speaks, written down exactly once.
 *
 * WHY A TABLE RATHER THAN PATHS INLINE IN EACH METHOD. `@helm7/catalogue` is
 * the single source that drives the REST router, the MCP tools, the OpenAPI
 * document and llms.txt. An SDK spelling its paths inline would be the first
 * surface in this repo not derived from it, and it would drift the first time
 * an operation moved — silently, because a 404 from a renamed path looks
 * exactly like an empty organisation.
 *
 * So the paths live here and `endpoints.test.ts` asserts this table and
 * `sdkEndpoints()` describe the same set in BOTH directions: an operation the
 * catalogue has and the SDK does not fails the build, and so does one the SDK
 * claims that the server does not serve. Adding an operation to Helm7 is a
 * two-line change with a test that tells you the second line.
 *
 * The keys are catalogue operation ids and the `:param` spelling is verbatim,
 * so the comparison is a string equality rather than a normalisation nobody can
 * check. The catalogue itself is a dev-time import only — this package ships
 * with no dependencies at all.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface EndpointSpec {
  method: HttpMethod
  /** Path with `:param` segments, exactly as the catalogue spells them. */
  path: string
}

const spec = (method: HttpMethod, path: string): EndpointSpec => ({ method, path })

export const ENDPOINTS = {
  /* Identity */
  whoami: spec('GET', '/v1/whoami'),

  /* Products — the unit everything else hangs from. */
  product_list: spec('GET', '/v1/products'),
  product_create: spec('POST', '/v1/products'),
  product_get: spec('GET', '/v1/products/:productId'),
  product_update: spec('PATCH', '/v1/products/:productId'),
  product_delete: spec('DELETE', '/v1/products/:productId'),

  /* Environments */
  environment_list: spec('GET', '/v1/products/:productId/environments'),
  environment_create: spec('POST', '/v1/products/:productId/environments'),

  /* Services */
  service_create: spec('POST', '/v1/products/:productId/services'),
  service_logs: spec('GET', '/v1/products/:productId/services/:serviceId/logs'),

  /* Deployments */
  deploy: spec('POST', '/v1/products/:productId/deployments'),
  deployment_get: spec('GET', '/v1/products/:productId/deployments/:deploymentId'),
  deployment_list: spec('GET', '/v1/products/:productId/deployments'),
  deployment_rollback: spec('POST', '/v1/products/:productId/deployments/:deploymentId/rollback'),
  deployment_image_upload: spec('POST', '/v1/products/:productId/deployments/:deploymentId/image'),
  deployment_image_finish: spec('POST', '/v1/products/:productId/deployments/:deploymentId/image/finish'),
  build_queue_get: spec('GET', '/v1/build-queue'),
  build_queue_reorder: spec('POST', '/v1/build-queue/order'),

  /* Databases */
  database_create: spec('POST', '/v1/products/:productId/databases'),
  database_get: spec('GET', '/v1/products/:productId/databases/:databaseId'),
  database_backup: spec('POST', '/v1/products/:productId/databases/:databaseId/backups'),
  database_restore: spec('POST', '/v1/products/:productId/databases/:databaseId/restore'),
  database_query: spec('POST', '/v1/products/:productId/databases/:databaseId/query'),
  database_execute: spec('POST', '/v1/products/:productId/databases/:databaseId/execute'),

  /* Auth, storage, domains, secrets, context */
  auth_enable: spec('POST', '/v1/products/:productId/auth'),
  auth_get: spec('GET', '/v1/products/:productId/auth'),
  auth_update: spec('PATCH', '/v1/products/:productId/auth'),
  auth_users_import: spec('POST', '/v1/products/:productId/auth/users/import'),
  storage_create_bucket: spec('POST', '/v1/products/:productId/storage/buckets'),
  domain_attach: spec('POST', '/v1/products/:productId/domains'),
  domain_list: spec('GET', '/v1/products/:productId/domains'),
  domain_remove: spec('DELETE', '/v1/products/:productId/domains/:domainId'),
  secret_set: spec('POST', '/v1/products/:productId/secrets'),
  secret_list: spec('GET', '/v1/products/:productId/secrets'),
  context_enable: spec('POST', '/v1/products/:productId/context'),

  /* Billing */
  usage_get: spec('GET', '/v1/usage'),
  cost_estimate: spec('POST', '/v1/cost/estimate'),
  billing_checkout_create: spec('POST', '/v1/billing/checkout'),

  /* Agents and zero-friction onboarding */
  agent_key_create: spec('POST', '/v1/agent-keys'),
  agent_key_revoke: spec('DELETE', '/v1/agent-keys/:keyId'),
  cloud_init: spec('POST', '/v1/cloud/init'),
  cloud_claim: spec('POST', '/v1/cloud/claim'),

  /* The dashboard's operations: everything the app does, an agent can too. */
  environment_delete: spec('DELETE', '/v1/products/:productId/environments/:environment'),
  service_list: spec('GET', '/v1/products/:productId/services'),
  service_update: spec('PATCH', '/v1/products/:productId/services/:serviceId'),
  service_delete: spec('DELETE', '/v1/products/:productId/services/:serviceId'),
  bucket_list: spec('GET', '/v1/products/:productId/storage/buckets'),
  bucket_delete: spec('DELETE', '/v1/products/:productId/storage/buckets/:bucketId'),
  secret_delete: spec('DELETE', '/v1/products/:productId/secrets/:key'),
  test_account_create: spec('POST', '/v1/products/:productId/test-accounts'),
  test_account_list: spec('GET', '/v1/products/:productId/test-accounts'),
  test_account_get: spec('GET', '/v1/products/:productId/test-accounts/:accountId'),
  test_account_rotate: spec('POST', '/v1/products/:productId/test-accounts/:accountId/rotate'),
  test_account_delete: spec('DELETE', '/v1/products/:productId/test-accounts/:accountId'),
  test_account_checkout: spec('POST', '/v1/products/:productId/test-accounts/:accountId/checkout'),
  test_account_totp: spec('POST', '/v1/products/:productId/test-accounts/:accountId/totp'),
  billing_portal_create: spec('POST', '/v1/billing/portal'),
  agent_key_list: spec('GET', '/v1/agent-keys'),
  github_repo_list: spec('GET', '/v1/github/repositories'),
  product_connect_repo: spec('POST', '/v1/products/:productId/github'),
  organization_get: spec('GET', '/v1/organization'),
  organization_update: spec('PATCH', '/v1/organization'),
  activity_list: spec('GET', '/v1/activity'),
  member_list: spec('GET', '/v1/members'),
  invite_create: spec('POST', '/v1/invites'),
  member_remove: spec('DELETE', '/v1/members/:memberId'),
} as const satisfies Record<string, EndpointSpec>

export type EndpointName = keyof typeof ENDPOINTS

/** Path params derived from the path rather than declared a second time. */
export function pathParams(path: string): string[] {
  return (path.match(/:([A-Za-z0-9_]+)/g) ?? []).map((s) => s.slice(1))
}

/**
 * Substitute path parameters.
 *
 * Every value is URL-encoded, and a placeholder left unfilled THROWS rather
 * than being sent as the literal `:productId`: a request to
 * `/v1/products/:productId` is a 404 that reads like a deleted Product, which
 * is the failure mode this file exists to make impossible.
 */
export function resolvePath(endpoint: EndpointSpec, params: Record<string, unknown> = {}): string {
  return endpoint.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined || value === null || value === '') {
      throw new Error(`Helm7 SDK: ${endpoint.path} needs a value for :${name}`)
    }
    return encodeURIComponent(String(value))
  })
}
