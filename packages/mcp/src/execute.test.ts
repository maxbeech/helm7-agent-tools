import { describe, it, expect } from 'vitest'
import { getOperation, OPERATIONS, bodyParams, pathParams } from '@helm7/catalogue'
import { buildRequest, executeOperation } from './execute.js'

const BASE = 'https://example.test'
const op = (id: string) => getOperation(id)!

describe('buildRequest', () => {
  it('interpolates path params and encodes them', () => {
    const { url } = buildRequest(op('database_get'), { productId: 'prd_1', databaseId: 'db/2' }, BASE)
    expect(url).toBe('https://example.test/v1/products/prd_1/databases/db%2F2')
  })

  it('refuses a missing path param rather than sending the placeholder', () => {
    // `/v1/products/:productId` reaches the server as a 404 that reads like a
    // Product that was deleted, which is the wrong thing for a model to learn.
    expect(() => buildRequest(op('product_get'), {}, BASE)).toThrow(/needs productId/)
  })

  it('puts a GET argument in the query string and sends no body', () => {
    const { url, body } = buildRequest(op('deployment_list'), { productId: 'p', environment: 'preview', limit: 5 }, BASE)
    expect(url).toBe('https://example.test/v1/products/p/deployments?environment=preview&limit=5')
    expect(body).toBeUndefined()
  })

  it('puts a POST argument in the body and keeps path params out of it', () => {
    const { url, body } = buildRequest(
      op('database_create'),
      { productId: 'p', name: 'primary', extensions: ['pgvector'], dry_run: true },
      BASE,
    )
    expect(url).toBe('https://example.test/v1/products/p/databases')
    expect(body).toEqual({ name: 'primary', extensions: ['pgvector'], dry_run: true })
  })

  it('drops an argument the catalogue never declared', () => {
    // A model that invents `force: true` should have it ignored here, not
    // forwarded for a server that may one day start honouring it.
    const { body } = buildRequest(op('product_delete'), { productId: 'p', confirm: true, force: true }, BASE)
    expect(body).toEqual({ confirm: true })
  })

  it('sends an empty body rather than none when a mutation carries no arguments', () => {
    expect(buildRequest(op('cloud_claim'), {}, BASE).body).toEqual({})
  })

  it('builds a request for every operation the catalogue declares', () => {
    // Cheap proof that no operation's shape trips the generic builder — the
    // whole point of deriving placement from the path instead of per tool.
    for (const operation of OPERATIONS) {
      const args: Record<string, unknown> = {}
      for (const name of pathParams(operation)) args[name] = `${name}_1`
      for (const name of bodyParams(operation)) args[name] = 'x'
      const { url } = buildRequest(operation, args, BASE)
      expect(url.startsWith(BASE), `${operation.id} built ${url}`).toBe(true)
      expect(url, `${operation.id} left a placeholder in the path`).not.toContain('/:')
    }
  })
})

describe('executeOperation', () => {
  it('says the call came from MCP, which is what makes deploy build on the agent\'s machine by default', async () => {
    let sent: Record<string, string> = {}
    await executeOperation(op('product_list'), {}, {
      apiKey: 'hlm_sk_x',
      baseUrl: BASE,
      fetch: (async (_url: string, init: { headers: Record<string, string> }) => {
        sent = init.headers
        return new Response('{}', { status: 200 })
      }) as never,
    })
    expect(sent['X-Helm7-Client']).toBe('mcp')
  })
})
