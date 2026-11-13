/**
 * Agent credentials, and the two calls that let an agent start with no account.
 *
 * A minted key can never exceed the scopes of the member minting it, and a key
 * holding `may_administer` cannot mint another one holding it — that ceiling is
 * what makes revoking a key mean something. The SDK cannot enforce it and does
 * not pretend to: asking for more than you hold NARROWS rather than fails, so
 * read back what you were given instead of assuming you got what you asked for.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Capability, JsonObject, ListEnvelope, Plan } from '../types.js'

export interface AgentKeyCreateInput extends MutationOptions {
  /** What this agent is for. Shown in the audit trail. */
  name: string
  /** Intersected with your own scopes. */
  scopes?: string[]
  /** Confine the key to one Product. Omit for the whole organisation. */
  productId?: string
  /** Hard monthly cap. Cost-impacting calls are refused once reached. */
  budgetUsd?: number
  /** Prefer a short life and re-mint. */
  expiresInHours?: number
  capabilities?: Capability[]
}

export class AgentsResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  /** The secret comes back once and never again. */
  createKey(input: AgentKeyCreateInput): Promise<JsonObject> {
    return this.transport.call(
      ENDPOINTS.agent_key_create,
      {
        name: input.name,
        scopes: input.scopes,
        product_id: input.productId,
        budget_usd: input.budgetUsd,
        expires_in_hours: input.expiresInHours,
        capabilities: input.capabilities,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** Destructive: in-flight requests using the key fail, and it cannot be restored. */
  revokeKey(keyId: string, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(ENDPOINTS.agent_key_revoke, { keyId, ...mutationWire(options) }, options)
  }

  /**
   * An ephemeral workspace: a temporary organisation and a scoped key, with no
   * email, no card and no human step. It expires, so this is for trying Helm7
   * end to end, not for running anything real.
   *
   * Takes no dry_run because there is nothing to cost and nothing to destroy —
   * demanding a plan before an agent can hold a credential would defeat the
   * zero-friction start that is the whole point of it.
   */
  cloudInit(input: { label?: string } & RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.cloud_init, { label: input.label }, input)
  }

  /** Attaches an ephemeral workspace to a real account. Returns a URL a human completes. */
  cloudClaim(options: MutationOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.cloud_claim, { ...mutationWire(options) }, options)
  }

  /** Keys in the workspace, without their secrets, which exist only at minting. */
  listKeys(options: { includeRevoked?: boolean } & RequestOptions = {}): Promise<ListEnvelope> {
    return this.transport.call(ENDPOINTS.agent_key_list, { include_revoked: options.includeRevoked }, options)
  }
}
