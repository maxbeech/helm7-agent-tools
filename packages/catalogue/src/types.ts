/**
 * The vocabulary every Helm7 surface is described in.
 *
 * One operation is declared once, here. The REST router, the MCP tool list,
 * the OpenAPI document, llms.txt and the SDK's endpoint table are all derived
 * from those declarations, and `catalogue.test.ts` fails the build if any of
 * them drifts. Contextely proved this pattern; the reason to copy it is that
 * the alternative — five hand-maintained lists — drifts silently, and the
 * surface an agent reads is exactly the surface that must not lie.
 */

/** A JSON Schema fragment. Deliberately structural, not a library type: the
 *  SDK is published zero-dependency and cannot carry a validator's types. */
export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  enum?: readonly string[]
  format?: string
  pattern?: string
  minimum?: number
  maximum?: number
  default?: unknown
  description?: string
  additionalProperties?: boolean | JsonSchema
  nullable?: boolean
}

/**
 * Read and write live in separate namespaces on purpose.
 *
 * Contextely learned this the hard way: a role that synthesises `*` for reads
 * would, if the two shared a namespace, hand every owner a write wildcard on
 * the day writes shipped. Keeping them apart means granting read access can
 * never accidentally grant the ability to spend money or delete a database.
 */
export const READ_SCOPES = [
  'product:read',
  'deployment:read',
  'database:read',
  'domain:read',
  'secret:read',
  'test_account:read',
  'billing:read',
  'context:read',
] as const

export const WRITE_SCOPES = [
  'product:write',
  'product:delete',
  'deployment:write',
  'database:write',
  'database:delete',
  'domain:write',
  'secret:write',
  'test_account:write',
  /**
   * Hands out a test account's password and one-time codes. Its own scope, not
   * part of test_account:write, because it is the only way a secret leaves
   * Helm7: a key that may create and rotate accounts should not be able to read
   * them, and the caller that signs in should not be able to delete them.
   */
  'test_account:use',
  'billing:manage',
  'context:write',
  'agent:manage',
  'member:manage',
] as const

export type ReadScope = (typeof READ_SCOPES)[number]
export type WriteScope = (typeof WRITE_SCOPES)[number]
export type Scope = ReadScope | WriteScope

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** Which part of the resource graph an operation acts on. Drives doc grouping
 *  and the MCP `features=` allow-list. */
export const RESOURCE_GROUPS = [
  'identity',
  'product',
  'environment',
  'service',
  'deployment',
  'database',
  'auth',
  'storage',
  'domain',
  'secret',
  'test_account',
  'context',
  'billing',
  'agent',
  'organization',
  'github',
] as const
export type ResourceGroup = (typeof RESOURCE_GROUPS)[number]

export interface Operation {
  /** Stable machine id. Also the MCP tool name and the SDK method key. */
  id: string
  group: ResourceGroup
  method: HttpMethod
  /** REST path with `:param` segments, e.g. `/v1/products/:productId`. */
  path: string
  summary: string
  /** Prose an agent reads before choosing this tool. Says what it does, what
   *  it costs and what it cannot do — not just its happy path. */
  description: string
  input?: JsonSchema
  output: JsonSchema
  scopes: Scope[]

  /**
   * Mutations that cannot be undone by re-running the opposite operation.
   * Destructive operations refuse to execute without `confirm: true`, and MCP
   * clients are told so through the tool annotation.
   */
  destructive?: boolean

  /**
   * Whether `dry_run: true` is honoured. Every mutating operation should be
   * dry-runnable — that is the point of §7.5 — so the test asserts it rather
   * than trusting each declaration.
   */
  dryRunnable?: boolean

  /** Changes what the organisation will be billed. Forces a cost line into
   *  the plan and makes the operation subject to the agent budget cap. */
  costImpacting?: boolean

  /**
   * Hidden from `tools/list` unless the calling key carries this capability.
   * Hiding rather than refusing matters: an agent that cannot see a tool does
   * not spend turns trying to talk itself past the refusal.
   */
  requiresCapability?: 'may_deploy' | 'may_administer' | 'may_manage_billing'

  /**
   * A POST that computes rather than changes anything.
   *
   * Some operations need a request body — a pricing calculator takes a whole
   * resource shape — but have no side effects. Method alone cannot express
   * that, and inferring "POST means mutation" would force a meaningless
   * write scope onto a calculator, which teaches callers that write scopes
   * are noise. Mark it explicitly instead.
   */
  readOnly?: boolean

  /** Not exposed over MCP (browser-session-only operations). */
  mcpExclude?: boolean

  /**
   * The response carries a credential. Such a response is never stored for
   * idempotent replay (the replay table is plain JSON, so a stored password
   * would sit in it unencrypted) and the caller is told not to repeat it. It is
   * still offered over MCP: the account's own expiry and lease bound the risk.
   */
  sensitiveOutput?: boolean
}
