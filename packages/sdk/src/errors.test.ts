import { errorFromResponse } from './errors.js'
import { describe, it, expect, vi } from 'vitest'
import { Helm7 } from './client.js'
import { Helm7Error } from './errors.js'

function failure(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function clientWith(fetchImpl: ReturnType<typeof vi.fn>) {
  return new Helm7({
    apiKey: 'hlm_sk_test',
    baseUrl: 'https://example.test',
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
  })
}

const wire = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: 'the thing went wrong', remedy: 'do the other thing', request_id: 'req_1', ...extra },
})

describe('structured errors', () => {
  it('throws a Helm7Error carrying code, message, remedy, requestId and status', async () => {
    const fetchImpl = vi.fn(async () => failure(403, wire('insufficient_scope')))
    const error = await clientWith(fetchImpl)
      .whoami()
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Helm7Error)
    const typed = error as Helm7Error
    expect(typed.code).toBe('insufficient_scope')
    expect(typed.message).toBe('the thing went wrong')
    expect(typed.remedy).toBe('do the other thing')
    expect(typed.requestId).toBe('req_1')
    expect(typed.status).toBe(403)
    expect(typed.request).toEqual({ method: 'GET', path: '/v1/whoami' })
  })

  it('never throws a bare string or a plain Error for a failed call', async () => {
    const bodies = [wire('not_found'), { error: {} }, 'plain text', null]
    for (const body of bodies) {
      const fetchImpl = vi.fn(async () => failure(404, body))
      const error = await clientWith(fetchImpl)
        .products.get('prd_1')
        .catch((e: unknown) => e)
      expect(error, `body ${JSON.stringify(body)} produced ${typeof error}`).toBeInstanceOf(Helm7Error)
      expect(typeof (error as Helm7Error).message).toBe('string')
    }
  })

  it('falls back to the status when the body names a code this SDK does not know', async () => {
    // A caller branching on `code` is entitled to assume one of the documented
    // set. A surprise string falls through every branch and lands in the else.
    const fetchImpl = vi.fn(async () => failure(409, wire('flux_capacitor_offline')))
    const error = (await clientWith(fetchImpl)
      .products.delete('prd_1')
      .catch((e: unknown) => e)) as Helm7Error
    expect(error.code).toBe('conflict')
  })

  it('keeps the body of a refused destructive call, plan and all', async () => {
    // The catalogue says a 409 for want of `confirm` carries the plan, but
    // `errorOutput` does not declare where. Rather than invent a field, the SDK
    // keeps what was sent so the caller can render it.
    const plan = { changes: [], cost: { currency: 'USD' }, destructive_actions: ['everything'], applied: false }
    const fetchImpl = vi.fn(async () => failure(409, { ...wire('confirmation_required'), plan }))
    const error = (await clientWith(fetchImpl)
      .products.delete('prd_1')
      .catch((e: unknown) => e)) as Helm7Error
    expect(error.code).toBe('confirmation_required')
    expect((error.body as { plan: unknown }).plan).toEqual(plan)
  })

  it('reports a request that never arrived as a connection error, not a refusal', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const error = (await clientWith(fetchImpl)
      .whoami()
      .catch((e: unknown) => e)) as Helm7Error
    expect(error.code).toBe('connection_error')
    expect(error.status).toBe(0)
    expect(error.retryable).toBe(true)
  })

  it('refuses a 200 that is not JSON rather than reporting it as nothing found', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 200 }))
    const error = (await clientWith(fetchImpl)
      .products.list()
      .catch((e: unknown) => e)) as Helm7Error
    expect(error.code).toBe('invalid_response')
  })
})

describe('retrying', () => {
  it('retries a GET', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(failure(429, wire('rate_limited')))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const client = new Helm7({
      apiKey: 'hlm_sk_x',
      baseUrl: 'https://example.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await client.products.list()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not replay a bare mutation, because two databases is worse than one failure', async () => {
    const fetchImpl = vi.fn(async () => failure(429, wire('rate_limited')))
    const client = new Helm7({
      apiKey: 'hlm_sk_x',
      baseUrl: 'https://example.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await client.databases.create({ productId: 'prd_1' }).catch(() => undefined)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('replays a mutation the caller made safe with an idempotency key', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(failure(429, wire('rate_limited')))
      .mockResolvedValueOnce(new Response(JSON.stringify({ applied: true }), { status: 200 }))
    const client = new Helm7({
      apiKey: 'hlm_sk_x',
      baseUrl: 'https://example.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await client.databases.create({ productId: 'prd_1', idempotencyKey: 'run-1' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('replays a dry run, which by definition changed nothing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(failure(500, wire('internal')))
      .mockResolvedValueOnce(new Response(JSON.stringify({ applied: false }), { status: 200 }))
    const client = new Helm7({
      apiKey: 'hlm_sk_x',
      baseUrl: 'https://example.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await client.databases.create({ productId: 'prd_1', dryRun: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('docs_url', () => {
  it('is kept from the wire body', () => {
    const err = errorFromResponse(409, { error: { code: 'conflict', message: 'm', docs_url: 'https://www.helm7.com/docs/errors#conflict' } }, { method: 'POST', path: '/v1/x' })
    expect(err.docsUrl).toBe('https://www.helm7.com/docs/errors#conflict')
  })
})
