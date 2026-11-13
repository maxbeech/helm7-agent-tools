/**
 * Custom domains.
 *
 * `attach` returns the DNS record to create and the domain sits at `pending`
 * until it resolves. Pending is NOT an error, and the SDK does not smooth it
 * into one — a client that treated the wait as a failure would have callers
 * retrying an attach that already succeeded.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, ListEnvelope, Plan } from '../types.js'

export interface DomainAttachInput extends MutationOptions {
  productId: string
  /** Fully qualified, e.g. app.example.com or example.com. A bare domain redirects to www unless `serve` is set. */
  hostname: string
  environment?: Environment
  /** Defaults to the environment's only web service when there is exactly one. */
  serviceId?: string
  /** Bare domains only: answer on the bare domain itself instead of redirecting to www. */
  serve?: boolean
}

export class DomainsResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  attach(input: DomainAttachInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.domain_attach,
      {
        productId: input.productId,
        environment: input.environment,
        hostname: input.hostname,
        service_id: input.serviceId,
        serve: input.serve,
        ...mutationWire(input),
      },
      input,
    )
  }

  list(productId: string, options: RequestOptions = {}): Promise<ListEnvelope> {
    return this.transport.call(ENDPOINTS.domain_list, { productId }, options)
  }

  /** Destructive: traffic to the hostname stops immediately and the certificate is revoked. */
  remove(productId: string, domainId: string, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(ENDPOINTS.domain_remove, { productId, domainId, ...mutationWire(options) }, options)
  }
}
