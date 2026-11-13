import { describe, it, expect } from 'vitest'
import { OPERATIONS } from './operations.js'
import { matchRoute, getOperation } from './index.js'
import { mcpTools, openApiDocument, llmsTxt, skillMd, sdkEndpoints, restRoutes, pathParams } from './generate.js'
import { RESOURCE_GROUPS, READ_SCOPES, WRITE_SCOPES } from './types.js'

const ALL_SCOPES = new Set<string>([...READ_SCOPES, ...WRITE_SCOPES])

describe('catalogue integrity', () => {
  it('has unique operation ids', () => {
    const ids = OPERATIONS.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has a unique method+path per operation', () => {
    const keys = OPERATIONS.map((o) => `${o.method} ${o.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('only uses declared scopes', () => {
    for (const op of OPERATIONS) {
      for (const s of op.scopes) {
        expect(ALL_SCOPES.has(s), `${op.id} requires undeclared scope ${s}`).toBe(true)
      }
    }
  })

  it('only uses declared resource groups', () => {
    for (const op of OPERATIONS) {
      expect(RESOURCE_GROUPS).toContain(op.group)
    }
  })

  it('declares every path param in its input schema', () => {
    for (const op of OPERATIONS) {
      for (const p of pathParams(op)) {
        expect(op.input?.properties?.[p], `${op.id} takes :${p} in its path but does not declare it`).toBeDefined()
        expect(op.input?.required ?? [], `${op.id} must require :${p}`).toContain(p)
      }
    }
  })

  it('gives every operation a description that is prose, not a restatement of the summary', () => {
    for (const op of OPERATIONS) {
      expect(op.description.length, `${op.id} description is too thin for an agent to act on`).toBeGreaterThan(80)
      expect(op.description).not.toBe(op.summary)
    }
  })
})

describe('safety rails are structural, not per-endpoint choices', () => {
  it('makes every mutating operation dry-runnable', () => {
    for (const op of OPERATIONS.filter((o) => o.method !== 'GET' && !o.readOnly)) {
      // The two onboarding calls bootstrap identity rather than change
      // infrastructure: there is nothing to cost and nothing to destroy, and
      // demanding a plan before an agent can get a credential would defeat the
      // zero-friction signup that is the point of them.
      if (op.id === 'cloud_init' || op.id === 'cloud_claim') continue
      // The two halves of a local build continue a deploy that was already
      // planned and priced: the chunks move bytes, and finishing starts what
      // that deploy's dry run described.
      if (op.id === 'deployment_image_upload' || op.id === 'deployment_image_finish') continue
      expect(op.dryRunnable, `${op.id} mutates but is not dry-runnable`).toBe(true)
    }
  })

  it('offers dry_run and idempotency_key on every dry-runnable operation', () => {
    for (const op of OPERATIONS.filter((o) => o.dryRunnable)) {
      expect(op.input?.properties?.dry_run, `${op.id} is dry-runnable but takes no dry_run`).toBeDefined()
      expect(op.input?.properties?.idempotency_key, `${op.id} takes no idempotency_key`).toBeDefined()
    }
  })

  it('requires confirm on every destructive operation', () => {
    for (const op of OPERATIONS.filter((o) => o.destructive)) {
      expect(op.input?.properties?.confirm, `${op.id} is destructive but takes no confirm`).toBeDefined()
    }
  })

  it('marks a read-only POST as read-only to MCP, so an agent is not warned off a free calculator', () => {
    const tools = mcpTools(['may_deploy', 'may_administer', 'may_manage_billing'])
    const estimate = tools.find((t) => t.name === 'cost_estimate')
    expect(estimate?.annotations.readOnlyHint).toBe(true)
    expect(estimate?.annotations.destructiveHint).toBe(false)
  })

  it('never marks a read-only operation destructive or cost-impacting', () => {
    for (const op of OPERATIONS.filter((o) => o.readOnly)) {
      expect(op.destructive ?? false, `${op.id} is read-only and must not be destructive`).toBe(false)
      expect(op.costImpacting ?? false, `${op.id} is read-only and must not cost money`).toBe(false)
    }
  })

  it('never marks a GET destructive or cost-impacting', () => {
    for (const op of OPERATIONS.filter((o) => o.method === 'GET')) {
      expect(op.destructive ?? false, `${op.id} is a GET and must not be destructive`).toBe(false)
      expect(op.costImpacting ?? false, `${op.id} is a GET and must not cost money`).toBe(false)
    }
  })

  it('requires a write scope for every mutating operation that is not onboarding', () => {
    const writeSet = new Set<string>(WRITE_SCOPES)
    for (const op of OPERATIONS.filter((o) => o.method !== 'GET' && !o.readOnly)) {
      if (op.id === 'cloud_init' || op.id === 'cloud_claim') continue
      expect(op.scopes.some((s) => writeSet.has(s)), `${op.id} mutates but requires no write scope`).toBe(true)
    }
  })

  it('keeps every operation that returns a credential behind its own scope and out of idempotent replay', () => {
    const sensitive = OPERATIONS.filter((o) => o.sensitiveOutput)
    expect(sensitive.map((o) => o.id).sort()).toEqual(['test_account_checkout', 'test_account_totp'])
    const exposed = new Set(mcpTools(['may_deploy', 'may_administer', 'may_manage_billing']).map((t) => t.name))
    for (const op of sensitive) {
      expect(exposed.has(op.id), `${op.id} is offered over MCP by decision, so a caller can sign in as a test account`).toBe(true)
      expect(op.scopes, `${op.id} must sit behind its own use scope`).toEqual(['test_account:use'])
    }
  })

  it('never returns a secret value from any operation', () => {
    // The guarantee llms.txt makes. Asserted rather than trusted, because the
    // day someone adds `secret_reveal` this test is the thing that objects.
    const readsSecrets = OPERATIONS.filter((o) => /reveal|decrypt/i.test(o.id))
    expect(readsSecrets).toEqual([])
  })
})

describe('surface parity — every generated surface covers every operation', () => {
  it('REST routes match the catalogue exactly', () => {
    expect(restRoutes().map((r) => r.operationId).sort()).toEqual(OPERATIONS.map((o) => o.id).sort())
  })

  it('the SDK endpoint table matches the catalogue exactly', () => {
    expect(Object.keys(sdkEndpoints()).sort()).toEqual(OPERATIONS.map((o) => o.id).sort())
  })

  it('MCP exposes every operation that is not capability-gated or excluded', () => {
    const expected = OPERATIONS.filter((o) => !o.mcpExclude && !o.requiresCapability).map((o) => o.id).sort()
    expect(mcpTools([]).map((t) => t.name).sort()).toEqual(expected)
  })

  it('MCP exposes capability-gated operations only to a key holding the capability', () => {
    const withAll = mcpTools(['may_deploy', 'may_administer', 'may_manage_billing']).map((t) => t.name)
    const expected = OPERATIONS.filter((o) => !o.mcpExclude).map((o) => o.id)
    expect(withAll.sort()).toEqual(expected.sort())

    // A key without may_deploy must not even see deploy.
    expect(mcpTools([]).map((t) => t.name)).not.toContain('deploy')
    expect(mcpTools(['may_deploy']).map((t) => t.name)).toContain('deploy')
  })

  it('OpenAPI documents every operation', () => {
    const doc = openApiDocument('https://www.helm7.com') as any
    const ids: string[] = []
    for (const methods of Object.values(doc.paths) as any[]) {
      for (const op of Object.values(methods) as any[]) ids.push(op.operationId)
    }
    expect(ids.sort()).toEqual(OPERATIONS.map((o) => o.id).sort())
  })

  it('OpenAPI carries the safety metadata an agent needs', () => {
    const doc = openApiDocument('https://www.helm7.com') as any
    const deploy = doc.paths['/v1/products/{productId}/deployments'].post
    expect(deploy['x-helm7'].dryRunnable).toBe(true)
    expect(deploy['x-helm7'].costImpacting).toBe(true)
    expect(deploy['x-helm7'].requiresCapability).toBe('may_deploy')

    const del = doc.paths['/v1/products/{productId}'].delete
    expect(del['x-helm7'].destructive).toBe(true)
    expect(del.responses['409']).toBeDefined()
  })

  it('llms.txt mentions every operation id', () => {
    const txt = llmsTxt('https://www.helm7.com')
    expect(txt).toContain('https://www.helm7.com/skill.md')
    for (const op of OPERATIONS) {
      expect(txt, `llms.txt omits ${op.id}`).toContain(`\`${op.id}\``)
    }
  })

  it('llms.txt flags destructive and cost-impacting operations in the listing', () => {
    const txt = llmsTxt('https://www.helm7.com')
    expect(txt).toContain('DESTRUCTIVE')
    expect(txt).toContain('costs money')
  })
})

describe('agent skill', () => {
  const skill = skillMd('https://www.helm7.com')

  it('has the frontmatter a skill loader requires', () => {
    expect(skill).toMatch(/^---\nname: helm7\ndescription: .+\n---\n/)
  })

  it('names only operations that exist', () => {
    const ids = new Set(OPERATIONS.map((o) => o.id))
    for (const m of skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      if (['dry_run', 'idempotency_key', 'request_id', 'docs_url', 'invalid_request', 'insufficient_scope', 'budget_exceeded', 'plan_limit', 'rate_limited', 'provider_unavailable'].includes(m[1]!)) continue
      expect(ids.has(m[1]!), `skill names unknown operation ${m[1]}`).toBe(true)
    }
  })

  it('points at the published paths, not internal ones', () => {
    expect(skill).toContain('https://www.helm7.com/mcp')
    expect(skill).not.toContain('/api/')
  })
})

describe('routing', () => {
  it('matches a static path', () => {
    const m = matchRoute('GET', '/v1/whoami')
    expect(m?.operation.id).toBe('whoami')
  })

  it('extracts path params', () => {
    const m = matchRoute('GET', '/v1/products/prd_7k2m9x4qw1nv8bz3ct6d')
    expect(m?.operation.id).toBe('product_get')
    expect(m?.params.productId).toBe('prd_7k2m9x4qw1nv8bz3ct6d')
  })

  it('distinguishes methods on the same path', () => {
    expect(matchRoute('GET', '/v1/products')?.operation.id).toBe('product_list')
    expect(matchRoute('POST', '/v1/products')?.operation.id).toBe('product_create')
  })

  it('does not match a path of the wrong shape', () => {
    expect(matchRoute('GET', '/v1/products/a/b/c/d/e')).toBeUndefined()
    expect(matchRoute('GET', '/v1/nope')).toBeUndefined()
  })

  it('prefers a literal segment over a param when both could match', () => {
    // /v1/cost/estimate must not be swallowed by a :param route.
    expect(matchRoute('POST', '/v1/cost/estimate')?.operation.id).toBe('cost_estimate')
  })

  it('resolves an operation by id', () => {
    expect(getOperation('deploy')?.method).toBe('POST')
    expect(getOperation('nope')).toBeUndefined()
  })
})
