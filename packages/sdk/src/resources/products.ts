/**
 * Products — the unit everything else hangs from.
 *
 * A Product is one application with everything it needs to run, not a folder
 * and not a "project". Creating one provisions nothing billable: it is the
 * empty graph, which is why `create` is cheap to dry-run and why `delete`
 * is the most dangerous call in this SDK.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { JsonObject, ListEnvelope, Plan, Region } from '../types.js'

export interface ProductListOptions extends RequestOptions {
  cursor?: string
  limit?: number
}

export interface ProductUpdateInput extends MutationOptions {
  productId: string
  /** The new name, up to 64 characters. */
  name: string
}

export interface ProductCreateInput extends MutationOptions {
  name: string
  region?: Region
  /**
   * Your own stable id for this Product. Creating twice with the same value
   * returns the existing Product rather than a second one — the cheapest way
   * to make a retry loop safe without minding idempotency keys.
   */
  externalRef?: string
  /** Optional git URL. Helm7 inspects it and proposes a shape you can apply. */
  repo?: string
}

export class ProductsResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  list(options: ProductListOptions = {}): Promise<ListEnvelope> {
    return this.transport.call(ENDPOINTS.product_list, { cursor: options.cursor, limit: options.limit }, options)
  }

  create(input: ProductCreateInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.product_create,
      {
        name: input.name,
        region: input.region,
        external_ref: input.externalRef,
        repo: input.repo,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** The whole resource graph for one Product. Make this call before reasoning about one. */
  get(productId: string, options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.product_get, { productId }, options)
  }

  /**
   * Renames a Product. Only the name changes: its helm7.app addresses, image
   * names and ids stay as they were, so nothing deployed moves.
   */
  update(input: ProductUpdateInput): Promise<Plan> {
    const { productId, name, ...options } = input
    return this.transport.call(ENDPOINTS.product_update, { productId, name, ...mutationWire(options) }, options)
  }

  /**
   * Destroys every environment, service, database, bucket and domain binding
   * under the Product. Databases are backed up first and kept for 7 days; the
   * running resources are gone. Without `confirm: true` this returns the plan
   * and changes nothing, which is what a caller should do first.
   */
  delete(productId: string, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(ENDPOINTS.product_delete, { productId, ...mutationWire(options) }, options)
  }
}
