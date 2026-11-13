/**
 * Environments within a Product. Every Product has production; preview and
 * development exist only once created, and a new one starts EMPTY — it does
 * not copy production data, which is the assumption worth correcting before
 * somebody points a preview at a database that was never branched.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, ListEnvelope, Plan } from '../types.js'

export interface EnvironmentCreateInput extends MutationOptions {
  productId: string
  name: Environment
}

export class EnvironmentsResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  list(productId: string, options: RequestOptions = {}): Promise<ListEnvelope> {
    return this.transport.call(ENDPOINTS.environment_list, { productId }, options)
  }

  create(input: EnvironmentCreateInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.environment_create,
      { productId: input.productId, name: input.name, ...mutationWire(input) },
      input,
    )
  }

  /** Production cannot be deleted. Everything in the environment goes with it. */
  delete(productId: string, environment: Exclude<Environment, 'production'>, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(ENDPOINTS.environment_delete, { productId, environment, ...mutationWire(options) }, options)
  }
}
