import { describe, it, expect } from 'vitest'
import { sdkEndpoints } from '@helm7/catalogue'
import { ENDPOINTS, resolvePath, pathParams } from './endpoints.js'

/**
 * The guard the whole SDK rests on.
 *
 * Both directions, deliberately. "The SDK covers the catalogue" alone would
 * pass while the SDK carried an endpoint the server does not serve — which
 * fails at runtime as a 404, and a 404 from a path that never existed reads
 * exactly like an empty organisation.
 */
describe('endpoint table parity with the catalogue', () => {
  it('claims exactly the operations the catalogue declares', () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(Object.keys(sdkEndpoints()).sort())
  })

  it('agrees with the catalogue on every method and path', () => {
    expect(ENDPOINTS).toEqual(sdkEndpoints())
  })

  it('spells path params the way the catalogue does', () => {
    for (const [id, endpoint] of Object.entries(ENDPOINTS)) {
      const theirs = sdkEndpoints()[id]
      expect(pathParams(endpoint.path), `${id} params drifted`).toEqual(pathParams(theirs!.path))
    }
  })
})

describe('resolvePath', () => {
  it('substitutes and encodes', () => {
    expect(resolvePath(ENDPOINTS.product_get, { productId: 'prd_1' })).toBe('/v1/products/prd_1')
    expect(resolvePath(ENDPOINTS.domain_remove, { productId: 'p', domainId: 'a/b' })).toBe(
      '/v1/products/p/domains/a%2Fb',
    )
  })

  it('refuses a missing param rather than sending the placeholder', () => {
    // A request to `/v1/products/:productId` is a 404 that reads like a deleted
    // Product. Throwing here names the real mistake at the call site.
    expect(() => resolvePath(ENDPOINTS.product_get, {})).toThrow(/needs a value for :productId/)
    expect(() => resolvePath(ENDPOINTS.product_get, { productId: '' })).toThrow(/needs a value/)
  })
})
