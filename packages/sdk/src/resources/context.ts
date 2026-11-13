/**
 * Contextely memory, scoped to a Product, so agents operating the application
 * can read and write what it knows. Sharing is off by default in both
 * directions: memory that leaks between Products of one organisation is the
 * kind of default nobody notices until it matters.
 */
import type { Transport } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Plan } from '../types.js'

export interface ContextEnableInput extends MutationOptions {
  productId: string
  /** Whether other Products in the organisation can read this one's memory. */
  sharesMemory?: boolean
  /** Whether connections are pooled with the rest of the organisation. */
  sharesSources?: boolean
}

export class ContextResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  enable(input: ContextEnableInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.context_enable,
      {
        productId: input.productId,
        shares_memory: input.sharesMemory,
        shares_sources: input.sharesSources,
        ...mutationWire(input),
      },
      input,
    )
  }
}
