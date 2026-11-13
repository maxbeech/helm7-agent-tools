/**
 * Environment variables.
 *
 * THERE IS NO READ METHOD FOR A VALUE, and there never will be: no endpoint
 * returns one, so a leaked read key cannot exfiltrate credentials. `list` gives
 * names, environments and fingerprints. If you find yourself wanting a `get`
 * here, the answer is to set the value again rather than to read it back.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, ListEnvelope, Plan } from '../types.js'

export interface SecretSetInput extends MutationOptions {
  productId: string
  /** Shell-style: uppercase, digits and underscores, not starting with a digit. */
  key: string
  value: string
  environment?: Environment
}

export interface SecretListOptions extends RequestOptions {
  productId: string
  environment?: Environment
}

export class SecretsResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  /** Services pick the change up on their next deployment, not immediately. */
  set(input: SecretSetInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.secret_set,
      {
        productId: input.productId,
        environment: input.environment,
        key: input.key,
        value: input.value,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** Names and fingerprints only. Values are never returned by any endpoint. */
  list(options: SecretListOptions): Promise<ListEnvelope> {
    return this.transport.call(
      ENDPOINTS.secret_list,
      { productId: options.productId, environment: options.environment },
      options,
    )
  }

  /** Running services keep the value until their next deployment. */
  delete(input: { productId: string; key: string; environment?: Environment } & MutationOptions): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.secret_delete,
      { productId: input.productId, key: input.key, environment: input.environment, ...mutationWire(input) },
      input,
    )
  }
}
