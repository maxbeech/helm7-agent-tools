/**
 * Cost, as a first-class verb rather than a dashboard.
 *
 * `estimate` is a POST that changes nothing — it prices a shape you have not
 * built. It is free and takes no write scope, which is why it is here beside
 * `usage` and not filed with the mutations its method would otherwise group it
 * with.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import type { JsonObject } from '../types.js'

export interface UsageOptions extends RequestOptions {
  /** Narrow to one Product. Omit for the whole organisation. */
  productId?: string
}

export interface CostEstimateInput extends RequestOptions {
  /** e.g. [{ type: 'service', instance: 'shared-0.25', always_on: false }]. */
  resources: JsonObject[]
  monthlyEgressGb?: number
}

export interface CheckoutInput extends RequestOptions {
  plan: 'builder' | 'pro' | 'scale'
  successUrl: string
  cancelUrl: string
}

export class BillingResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  /** Spend to date, the month-end projection, and the budget remaining if set. */
  usage(options: UsageOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.usage_get, { productId: options.productId }, options)
  }

  estimate(input: CostEstimateInput): Promise<JsonObject> {
    return this.transport.call(
      ENDPOINTS.cost_estimate,
      { resources: input.resources, monthly_egress_gb: input.monthlyEgressGb },
      input,
    )
  }

  /** A hosted Checkout URL for upgrading to a paid plan. Nothing changes until
   *  Stripe confirms the subscription — redirect the customer to the URL this
   *  returns and the plan updates itself when the webhook fires. */
  checkout(input: CheckoutInput): Promise<JsonObject> {
    return this.transport.call(
      ENDPOINTS.billing_checkout_create,
      { plan: input.plan, success_url: input.successUrl, cancel_url: input.cancelUrl },
      input,
    )
  }

  /** A Stripe customer portal session: invoices, the card, and cancelling. */
  portal(input: { returnUrl: string } & RequestOptions): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.billing_portal_create, { return_url: input.returnUrl }, input)
  }
}
