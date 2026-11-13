import type { Operation, JsonSchema, ResourceGroup } from './types.js'
import { OPERATIONS } from './operations.js'
import { errorOutput } from './schemas.js'

/** REST: `GET /v1/products/:productId` → the router's lookup key. */
export function restRoutes(): { method: string; path: string; operationId: string }[] {
  return OPERATIONS.map((o) => ({ method: o.method, path: o.path, operationId: o.id }))
}

/** Path params, in order, derived from the path rather than declared twice. */
export function pathParams(op: Operation): string[] {
  return (op.path.match(/:([A-Za-z0-9_]+)/g) ?? []).map((s) => s.slice(1))
}

/** Params that belong in the query string or body rather than the path. */
export function bodyParams(op: Operation): string[] {
  const inPath = new Set(pathParams(op))
  return Object.keys(op.input?.properties ?? {}).filter((k) => !inPath.has(k))
}

export interface McpTool {
  name: string
  description: string
  inputSchema: JsonSchema
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    title: string
  }
}

/**
 * MCP tools.
 *
 * `capabilities` filters the list rather than the call: a tool the key cannot
 * use is not advertised at all. An agent that cannot see a tool does not spend
 * turns trying to argue its way past a refusal, and a narrow tool list is a
 * cheaper prompt besides.
 */
export function mcpTools(capabilities: readonly string[] = []): McpTool[] {
  const held = new Set(capabilities)
  return OPERATIONS.filter((o) => !o.mcpExclude)
    .filter((o) => !o.requiresCapability || held.has(o.requiresCapability))
    .map((o) => ({
      name: o.id,
      description: o.description,
      inputSchema: o.input ?? { type: 'object', properties: {} },
      annotations: {
        readOnlyHint: o.method === 'GET' || Boolean(o.readOnly),
        destructiveHint: Boolean(o.destructive),
        // GET only. Every dry-runnable mutation *accepts* an idempotency_key,
        // but accepting one is not the same as having been given one, and a
        // static hint cannot tell. Advertising `deploy` or `database_restore`
        // as idempotent would tell a client that retrying a restore is free.
        idempotentHint: o.method === 'GET',
        title: o.summary,
      },
    }))
}

/** The SDK's endpoint table. The SDK is hand-written for ergonomics but its
 *  table is asserted against this, so a new operation cannot be silently
 *  missing from the client. */
export function sdkEndpoints(): Record<string, { method: string; path: string }> {
  return Object.fromEntries(OPERATIONS.map((o) => [o.id, { method: o.method, path: o.path }]))
}

const OPENAPI_PATH = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}')

export function openApiDocument(baseUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const op of OPERATIONS) {
    const p = OPENAPI_PATH(op.path)
    paths[p] ??= {}

    const inPath = new Set(pathParams(op))
    const parameters = [...inPath].map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: op.input?.properties?.[name] ?? { type: 'string' },
    }))

    const bodyKeys = bodyParams(op)
    const hasBody = op.method !== 'GET' && bodyKeys.length > 0

    // GET params that are not path params are query params.
    if (op.method === 'GET') {
      for (const k of bodyKeys) {
        parameters.push({
          name: k,
          in: 'query',
          required: (op.input?.required ?? []).includes(k),
          schema: op.input?.properties?.[k] ?? { type: 'string' },
        })
      }
    }

    paths[p][op.method.toLowerCase()] = {
      operationId: op.id,
      summary: op.summary,
      description: op.description,
      tags: [op.group],
      security: [{ bearerAuth: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(hasBody
        ? {
            requestBody: {
              required: (op.input?.required ?? []).some((r) => !inPath.has(r)),
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: Object.fromEntries(bodyKeys.map((k) => [k, op.input!.properties![k]!])),
                    required: (op.input?.required ?? []).filter((r) => !inPath.has(r)),
                  },
                },
              },
            },
          }
        : {}),
      responses: {
        '200': { description: 'Success', content: { 'application/json': { schema: op.output } } },
        '400': { description: 'Invalid request', content: { 'application/json': { schema: errorOutput } } },
        '401': { description: 'Missing or invalid credential', content: { 'application/json': { schema: errorOutput } } },
        '403': {
          description: 'Scope, capability or budget refusal. Code distinguishes which.',
          content: { 'application/json': { schema: errorOutput } },
        },
        '409': {
          description: 'Destructive operation without confirm: true. Body carries the plan.',
          content: { 'application/json': { schema: errorOutput } },
        },
        '429': { description: 'Rate limited', content: { 'application/json': { schema: errorOutput } } },
      },
      'x-helm7': {
        destructive: Boolean(op.destructive),
        dryRunnable: Boolean(op.dryRunnable),
        costImpacting: Boolean(op.costImpacting),
        scopes: op.scopes,
        ...(op.requiresCapability ? { requiresCapability: op.requiresCapability } : {}),
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Helm7 API',
      version: '0.1.0',
      description:
        'Deploy and operate a complete application (compute, Postgres, auth, storage, domains and jobs) from one API. Every endpoint that changes infrastructure accepts dry_run to return a costed plan instead of acting.',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API key, sent as `Authorization: Bearer hlm_sk_...`.' },
      },
    },
    paths,
  }
}

const GROUP_TITLES: Record<ResourceGroup, string> = {
  identity: 'Identity',
  product: 'Products',
  environment: 'Environments',
  service: 'Services',
  deployment: 'Deployments',
  database: 'Databases',
  auth: 'Auth',
  storage: 'Storage',
  domain: 'Domains',
  secret: 'Secrets',
  test_account: 'Test accounts',
  context: 'Context',
  billing: 'Billing and cost',
  agent: 'Agents',
  organization: 'Workspace',
  github: 'GitHub',
}

/** llms.txt — written for a model that has never seen this API, so it leads
 *  with the rules that prevent expensive mistakes rather than with a route list. */
export function llmsTxt(baseUrl: string): string {
  const byGroup = new Map<ResourceGroup, Operation[]>()
  for (const op of OPERATIONS) {
    const arr = byGroup.get(op.group) ?? []
    arr.push(op)
    byGroup.set(op.group, arr)
  }

  const sections = [...byGroup.entries()]
    .map(([group, ops]) => {
      const rows = ops
        .map((o) => {
          const flags = [
            o.destructive ? 'DESTRUCTIVE' : null,
            o.costImpacting ? 'costs money' : null,
            o.requiresCapability ? `needs ${o.requiresCapability}` : null,
          ].filter(Boolean)
          const suffix = flags.length ? `  [${flags.join(', ')}]` : ''
          return `- \`${o.id}\`: ${o.method} ${o.path}${suffix}\n  ${o.summary}.`
        })
        .join('\n')
      return `### ${GROUP_TITLES[group]}\n\n${rows}`
    })
    .join('\n\n')

  return `# Helm7

Deploy and operate a whole application (compute, Postgres, auth, storage, domains and jobs) through one API, one CLI and one MCP server.

Base URL: ${baseUrl}
OpenAPI: ${baseUrl}/v1/openapi.json
Agent skill: ${baseUrl}/skill.md
Auth: \`Authorization: Bearer hlm_sk_...\`
MCP: ${baseUrl}/mcp. A client that supports OAuth (Claude Code: \`claude mcp add --transport http helm7 ${baseUrl}/mcp\`, then Authenticate) signs in through the browser and is issued a key; any other client sends an API key as above.

## Read this before you call anything

1. **Call \`whoami\` first.** A key resolves to a member and cannot exceed what that member can do. It may also carry a spend cap and an expiry. Knowing your ceiling costs one call and saves guessing.

2. **Plan before you act.** Every operation that changes infrastructure takes \`dry_run: true\` and returns what would change, what it would cost per month, and what could not be undone. Dry runs are free and have no side effects.

3. **Destructive operations refuse without \`confirm: true\`.** A refusal returns the same plan a dry run would, so a caller that always plans first never hits a surprise.

4. **Use \`idempotency_key\` on anything that creates or spends.** Replaying a key returns the original result rather than acting twice.

5. **Secret values are never readable.** No endpoint returns them. \`secret_list\` gives names and fingerprints only. The one deliberate exception is \`test_account_checkout\` (and \`test_account_totp\`), which hand a test user's sign-in to a caller holding the separate \`test_account:use\` scope and are recorded with the run that asked. Both are offered over MCP: prefer a temporary account and do not repeat the values in a reply.

6. **Cost is first-class.** \`cost_estimate\` prices a shape without building it. \`usage_get\` shows spend to date and the month-end projection.

## Resource graph

Everything hangs off a Product:

    Organization → Product → Environment → Service | Database | Auth | Storage | Domain | Secret | Context

A Product is the unit, not a "project" or a bare container. One Product is one application, with everything it needs to run.

## Typical first session

    cloud_init                 → an ephemeral workspace, no account needed
    product_create             → dry_run first, then apply
    database_create
    auth_enable
    deploy
    domain_attach
    cloud_claim                → keep it

## Errors

Every failure returns \`{ error: { code, message, remedy, docs_url, request_id } }\`. Codes are stable; branch on \`code\`, never on \`message\`. \`remedy\` tells you what to do. \`docs_url\` links to the full entry for that code (${baseUrl}/docs/errors).

Notable codes: \`insufficient_scope\`, \`confirmation_required\`, \`budget_exceeded\`, \`quota_exceeded\`, \`plan_limit\`, \`not_found\`, \`conflict\`, \`rate_limited\`.

## Operations

${sections}
`
}

/**
 * An Agent Skill (SKILL.md): the short, loadable version of llms.txt.
 *
 * llms.txt is a reference an agent fetches when it needs one; a skill is what
 * a coding agent installs so the rules are already in context when it picks a
 * platform. It carries the rules that prevent expensive mistakes and points at
 * llms.txt for the operation list, so it cannot drift from the catalogue.
 */
export function skillMd(baseUrl: string): string {
  return `---
name: helm7
description: Deploy and run a whole application (app, Postgres, auth, storage, jobs, domains) on Helm7 through its MCP server, CLI or REST API. Use when asked to host, deploy, provision a database, or put an app on a domain.
---

# Helm7

${OPERATIONS.length} operations, one API. Full list: ${baseUrl}/llms.txt. OpenAPI: ${baseUrl}/v1/openapi.json.

## Connect

- Claude Code: \`claude mcp add --transport http helm7 ${baseUrl}/mcp\`, then authenticate in the browser.
- Anything else: send \`Authorization: Bearer hlm_sk_...\` to ${baseUrl}/v1/*.
- No account yet: call \`cloud_init\` for a temporary workspace with no email or card. Call \`cloud_claim\` to keep it.

## Rules

1. Call \`whoami\` first. It shows your scopes, spend cap and expiry.
2. Pass \`dry_run: true\` before anything that changes infrastructure. It returns the plan and the monthly cost.
3. Destructive calls refuse without \`confirm: true\` and return the plan. Show it to the user before confirming.
4. Pass \`idempotency_key\` on anything that creates or spends.
5. Secrets are write-only. Never ask for a value back.

## Usual order

\`product_create\` → \`database_create\` → \`auth_enable\` → \`deploy\` → \`domain_attach\`.

## When a call fails

The body is \`{ error: { code, message, remedy, docs_url, request_id } }\`. Do what \`remedy\` says. If that is not enough, read \`docs_url\`. Do not retry an identical call after \`invalid_request\`, \`insufficient_scope\`, \`budget_exceeded\` or \`plan_limit\`. Retry \`rate_limited\` and \`provider_unavailable\` after a pause, with the same \`idempotency_key\`.
`
}
