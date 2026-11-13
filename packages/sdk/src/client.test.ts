import { describe, it, expect, vi } from 'vitest'
import { Helm7, DEFAULT_BASE_URL } from './client.js'
import { ENDPOINTS, resolvePath } from './endpoints.js'

function ok(body: unknown = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

type FetchMock = ReturnType<typeof vi.fn>

function clientWith(fetchImpl: FetchMock) {
  return new Helm7({
    apiKey: 'hlm_sk_test',
    baseUrl: 'https://example.test',
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  })
}

function callOf(fetchImpl: FetchMock, index = 0) {
  const [url, init] = fetchImpl.mock.calls[index] as unknown as [string, RequestInit]
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)),
  }
}

/** Sample path params, one per placeholder the catalogue uses. */
const P = {
  productId: 'prd_7k2m9x4qw1nv8bz3ct6d',
  serviceId: 'svc_1',
  deploymentId: 'dep_1',
  databaseId: 'db_1',
  domainId: 'dom_1',
  keyId: 'key_1',
  bucketId: 'bkt_1',
  key: 'STRIPE_KEY',
  environment: 'preview',
  memberId: 'mbr_1',
  accountId: 'tac_7k2m9x4qw1nv8bz3ct6d',
}

/**
 * Every operation, and the method that reaches it.
 *
 * This table is the SDK's half of the parity guarantee. `endpoints.test.ts`
 * proves the endpoint TABLE matches the catalogue; without this, an operation
 * could sit in that table with no method able to call it — present, tested and
 * unreachable, which is the same as missing to everyone but the test suite.
 */
const CALLS: Record<keyof typeof ENDPOINTS, (c: Helm7) => Promise<unknown>> = {
  whoami: (c) => c.whoami(),

  product_list: (c) => c.products.list({ limit: 10 }),
  product_create: (c) => c.products.create({ name: 'shop', region: 'eu-north', externalRef: 'ext-1' }),
  product_get: (c) => c.products.get(P.productId),
  product_update: (c) => c.products.update({ productId: P.productId, name: 'x' }),
  product_delete: (c) => c.products.delete(P.productId, { confirm: true }),

  environment_list: (c) => c.environments.list(P.productId),
  environment_create: (c) => c.environments.create({ productId: P.productId, name: 'preview' }),

  service_create: (c) => c.services.create({ productId: P.productId, name: 'web', kind: 'web' }),
  service_logs: (c) => c.services.logs({ productId: P.productId, serviceId: P.serviceId, limit: 50 }),

  deploy: (c) => c.deployments.deploy({ productId: P.productId, environment: 'production' }),
  deployment_get: (c) => c.deployments.get(P.productId, P.deploymentId),
  deployment_list: (c) => c.deployments.list({ productId: P.productId }),
  deployment_rollback: (c) => c.deployments.rollback(P.productId, P.deploymentId),
  deployment_image_upload: (c) => c.deployments.uploadImageChunk(P.productId, P.deploymentId, 0, new Uint8Array([1])),
  deployment_image_finish: (c) => c.deployments.finishImage(P.productId, P.deploymentId, { size: 1, sha256: 'ab' }),
  build_queue_get: (c) => c.deployments.queue(),
  build_queue_reorder: (c) => c.deployments.reorderQueue(['dep_1']),

  database_create: (c) => c.databases.create({ productId: P.productId, extensions: ['pgvector'] }),
  database_get: (c) => c.databases.get(P.productId, P.databaseId),
  database_backup: (c) => c.databases.backup(P.productId, P.databaseId),
  database_query: (c) => c.databases.query(P.productId, P.databaseId, 'SELECT 1'),
  database_execute: (c) =>
    c.databases.execute({ productId: P.productId, databaseId: P.databaseId, sql: 'SELECT 1', confirm: true }),
  database_restore: (c) =>
    c.databases.restore({ productId: P.productId, databaseId: P.databaseId, backupId: 'bk_1', confirm: true }),

  auth_enable: (c) => c.auth.enable({ productId: P.productId, providers: ['email'] }),
  auth_get: (c) => c.auth.get({ productId: P.productId }),
  auth_update: (c) => c.auth.update({ productId: P.productId, disableSignup: true }),
  auth_users_import: (c) =>
    c.auth.importUsers({ productId: P.productId, users: [{ id: '11111111-1111-4111-8111-111111111111', email: 'a@example.com' }] }),
  storage_create_bucket: (c) => c.storage.createBucket({ productId: P.productId, name: 'uploads' }),

  domain_attach: (c) => c.domains.attach({ productId: P.productId, hostname: 'app.example.com' }),
  domain_list: (c) => c.domains.list(P.productId),
  domain_remove: (c) => c.domains.remove(P.productId, P.domainId, { confirm: true }),

  secret_set: (c) => c.secrets.set({ productId: P.productId, key: 'STRIPE_KEY', value: 'sk_live_x' }),
  secret_list: (c) => c.secrets.list({ productId: P.productId }),

  context_enable: (c) => c.context.enable({ productId: P.productId }),

  usage_get: (c) => c.billing.usage(),
  cost_estimate: (c) => c.billing.estimate({ resources: [{ type: 'service' }] }),
  billing_checkout_create: (c) =>
    c.billing.checkout({ plan: 'builder', successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel' }),

  agent_key_create: (c) => c.agents.createKey({ name: 'deployer', capabilities: ['may_deploy'] }),
  agent_key_revoke: (c) => c.agents.revokeKey(P.keyId, { confirm: true }),
  cloud_init: (c) => c.agents.cloudInit({ label: 'trial' }),
  cloud_claim: (c) => c.agents.cloudClaim(),
  agent_key_list: (c) => c.agents.listKeys(),

  environment_delete: (c) => c.environments.delete(P.productId, 'preview', { confirm: true }),
  service_list: (c) => c.services.list({ productId: P.productId }),
  service_update: (c) => c.services.update({ productId: P.productId, serviceId: P.serviceId, paused: true }),
  service_delete: (c) => c.services.delete(P.productId, P.serviceId, { confirm: true }),
  bucket_list: (c) => c.storage.listBuckets({ productId: P.productId }),
  bucket_delete: (c) => c.storage.deleteBucket(P.productId, P.bucketId, { confirm: true }),
  secret_delete: (c) => c.secrets.delete({ productId: P.productId, key: P.key, confirm: true }),

  test_account_create: (c) => c.testAccounts.create({ productId: P.productId, label: 'member', mode: 'provision', expiresIn: '24h' }),
  test_account_list: (c) => c.testAccounts.list({ productId: P.productId }),
  test_account_get: (c) => c.testAccounts.get(P.productId, P.accountId),
  test_account_rotate: (c) => c.testAccounts.rotate({ productId: P.productId, accountId: P.accountId }),
  test_account_delete: (c) => c.testAccounts.delete({ productId: P.productId, accountId: P.accountId, confirm: true }),
  test_account_checkout: (c) => c.testAccounts.checkout({ productId: P.productId, accountId: P.accountId, runRef: 'run_1' }),
  test_account_totp: (c) => c.testAccounts.totp({ productId: P.productId, accountId: P.accountId }),
  billing_portal_create: (c) => c.billing.portal({ returnUrl: 'https://example.test/billing' }),

  github_repo_list: (c) => c.github.repositories(),
  product_connect_repo: (c) => c.github.connect({ productId: P.productId, installationId: '1', repoId: '2' }),

  organization_get: (c) => c.organization.get(),
  organization_update: (c) => c.organization.update({ budgetUsd: 50 }),
  activity_list: (c) => c.organization.activity({ limit: 20 }),
  member_list: (c) => c.organization.members(),
  invite_create: (c) => c.organization.invite({ role: 'viewer' }),
  member_remove: (c) => c.organization.removeMember(P.memberId, { confirm: true }),
}

describe('every operation is reachable from the client', () => {
  it('has a method per endpoint and no method for an endpoint that does not exist', () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(ENDPOINTS).sort())
  })

  for (const [id, invoke] of Object.entries(CALLS)) {
    it(`${id} hits the catalogued method and path`, async () => {
      const fetchImpl = vi.fn(async () => ok({ applied: false }))
      await invoke(clientWith(fetchImpl))
      const call = callOf(fetchImpl)
      const endpoint = ENDPOINTS[id as keyof typeof ENDPOINTS]
      expect(call.method).toBe(endpoint.method)
      expect(call.url.split('?')[0]).toBe(`https://example.test${resolvePath(endpoint, P)}`)
    })
  }
})

describe('client', () => {
  it('sends anonymous sign-ins and an anonymous import user as the catalogue names them', async () => {
    const f = vi.fn().mockImplementation(async () => ok())
    const c = clientWith(f)
    await c.auth.update({ productId: P.productId, anonymousSignIns: true })
    await c.auth.importUsers({ productId: P.productId, users: [{ id: '11111111-1111-4111-8111-111111111111', is_anonymous: true }] })
    expect(callOf(f, 0).body).toMatchObject({ anonymous_sign_ins: true })
    expect(callOf(f, 1).body.users[0]).toEqual({ id: '11111111-1111-4111-8111-111111111111', is_anonymous: true })
  })

  it('requires an api key', () => {
    expect(() => new Helm7({ apiKey: '' })).toThrow(/apiKey/)
  })

  it('defaults to the hosted deployment', async () => {
    const fetchImpl = vi.fn(async () => ok())
    await new Helm7({ apiKey: 'hlm_sk_x', fetch: fetchImpl as unknown as typeof globalThis.fetch }).whoami()
    expect(callOf(fetchImpl).url).toBe(`${DEFAULT_BASE_URL}/v1/whoami`)
  })

  it('does not double a slash when the base URL has a trailing one', async () => {
    const fetchImpl = vi.fn(async () => ok())
    await new Helm7({
      apiKey: 'hlm_sk_x',
      baseUrl: 'https://example.test/',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    }).whoami()
    expect(callOf(fetchImpl).url).toBe('https://example.test/v1/whoami')
  })

  it('reads a function-valued key on every call, so a rotation takes effect', async () => {
    const fetchImpl = vi.fn(async () => ok())
    let key = 'hlm_sk_first'
    const client = new Helm7({
      apiKey: () => key,
      baseUrl: 'https://example.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })
    await client.whoami()
    key = 'hlm_sk_rotated'
    await client.whoami()
    expect(callOf(fetchImpl, 0).headers.Authorization).toBe('Bearer hlm_sk_first')
    expect(callOf(fetchImpl, 1).headers.Authorization).toBe('Bearer hlm_sk_rotated')
  })
})

describe('parameter placement', () => {
  it('puts a GET non-path param in the query string and sends no body', async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [] }))
    await clientWith(fetchImpl).deployments.list({ productId: P.productId, environment: 'preview', limit: 5 })
    const call = callOf(fetchImpl)
    expect(call.url).toBe(`https://example.test/v1/products/${P.productId}/deployments?environment=preview&limit=5`)
    expect(call.body).toBeUndefined()
  })

  it('puts a POST non-path param in the JSON body and leaves the query empty', async () => {
    const fetchImpl = vi.fn(async () => ok())
    await clientWith(fetchImpl).databases.create({
      productId: P.productId,
      environment: 'production',
      name: 'primary',
      extensions: ['pgvector'],
    })
    const call = callOf(fetchImpl)
    expect(call.url).toBe(`https://example.test/v1/products/${P.productId}/databases`)
    expect(call.body).toEqual({ environment: 'production', name: 'primary', extensions: ['pgvector'] })
  })

  it('never leaks a path param into the body', async () => {
    const fetchImpl = vi.fn(async () => ok())
    await clientWith(fetchImpl).deployments.rollback(P.productId, P.deploymentId, { dryRun: true })
    expect(callOf(fetchImpl).body).toEqual({ dry_run: true })
  })

  it('omits an unsupplied option rather than sending null over a server default', async () => {
    const fetchImpl = vi.fn(async () => ok())
    await clientWith(fetchImpl).products.create({ name: 'shop' })
    expect(callOf(fetchImpl).body).toEqual({ name: 'shop' })
  })
})

describe('mutation controls', () => {
  it('maps dryRun, confirm and idempotencyKey onto their wire names', async () => {
    const fetchImpl = vi.fn(async () => ok())
    await clientWith(fetchImpl).products.delete(P.productId, {
      dryRun: true,
      confirm: false,
      idempotencyKey: 'run-42',
    })
    expect(callOf(fetchImpl).body).toEqual({ dry_run: true, confirm: false, idempotency_key: 'run-42' })
  })

  it('offers them on every mutating method', async () => {
    const fetchImpl = vi.fn(async () => ok())
    const client = clientWith(fetchImpl)
    const controls = { dryRun: true, idempotencyKey: 'k' } as const

    await client.products.create({ name: 'a', ...controls })
    await client.environments.create({ productId: P.productId, name: 'preview', ...controls })
    await client.services.create({ productId: P.productId, name: 'web', kind: 'web', ...controls })
    await client.deployments.deploy({ productId: P.productId, ...controls })
    await client.deployments.rollback(P.productId, P.deploymentId, controls)
    await client.databases.create({ productId: P.productId, ...controls })
    await client.databases.backup(P.productId, P.databaseId, controls)
    await client.databases.restore({ productId: P.productId, databaseId: P.databaseId, ...controls })
    await client.auth.enable({ productId: P.productId, ...controls })
    await client.storage.createBucket({ productId: P.productId, name: 'b', ...controls })
    await client.domains.attach({ productId: P.productId, hostname: 'a.example.com', ...controls })
    await client.domains.remove(P.productId, P.domainId, controls)
    await client.secrets.set({ productId: P.productId, key: 'K', value: 'v', ...controls })
    await client.context.enable({ productId: P.productId, ...controls })
    await client.agents.createKey({ name: 'a', ...controls })
    await client.agents.revokeKey(P.keyId, controls)
    await client.agents.cloudClaim(controls)
    await client.products.delete(P.productId, controls)

    for (let i = 0; i < fetchImpl.mock.calls.length; i += 1) {
      const body = callOf(fetchImpl, i).body as Record<string, unknown>
      expect(body.dry_run, `call ${i} dropped dry_run`).toBe(true)
      expect(body.idempotency_key, `call ${i} dropped idempotency_key`).toBe('k')
    }
  })
})

describe('service fields the catalogue defines beyond the basics', () => {
  it('sends public ports with the catalogue\'s container_port spelling, and a cron\'s path call', async () => {
    const fetchImpl = vi.fn(async () => ok({}))
    const client = clientWith(fetchImpl)

    await client.services.create({
      productId: P.productId,
      name: 'mail',
      kind: 'worker',
      publicPorts: [{ port: 587, containerPort: 2587 }],
    })
    await client.services.create({
      productId: P.productId,
      name: 'digest',
      kind: 'cron',
      schedule: '0 7 * * *',
      path: '/api/cron/digest',
      method: 'POST',
      target: 'web',
    })
    await client.services.update({ productId: P.productId, serviceId: P.serviceId, publicPorts: [{ port: 465, containerPort: 2465 }], path: '/x' })

    expect(callOf(fetchImpl, 0).body.public_ports).toEqual([{ port: 587, container_port: 2587 }])
    expect(callOf(fetchImpl, 1).body).toMatchObject({ path: '/api/cron/digest', method: 'POST', target: 'web' })
    expect(callOf(fetchImpl, 2).body).toMatchObject({ public_ports: [{ port: 465, container_port: 2465 }], path: '/x' })
  })

  it('sends a changed repository so a renamed repo can be pointed at again', async () => {
    const fetchImpl = vi.fn(async () => ok({}))
    const client = clientWith(fetchImpl)

    await client.services.update({ productId: P.productId, serviceId: P.serviceId, repo: 'https://github.com/acme/renamed' })

    expect(callOf(fetchImpl, 0).body).toMatchObject({ repo: 'https://github.com/acme/renamed' })
  })
})
