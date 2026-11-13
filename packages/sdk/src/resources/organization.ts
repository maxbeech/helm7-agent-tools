/**
 * The workspace: its name and spend cap, its people, and its record of who
 * did what. Invitations are links; there is no charge per person.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { JsonObject, ListEnvelope, Plan } from '../types.js'

export type Role = 'admin' | 'member' | 'viewer'

export class OrganizationResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  get(options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.organization_get, {}, options)
  }

  /**
   * `budgetUsd: null` removes the cap. `defaultBuildMode` is where a deploy
   * builds when the caller does not say; `keepAppDomain` keeps the helm7.app
   * address as a staging address once a custom domain is serving.
   */
  update(
    input: { name?: string; budgetUsd?: number | null; defaultBuildMode?: 'local' | 'remote'; keepAppDomain?: boolean } & MutationOptions,
  ): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.organization_update,
      {
        name: input.name,
        ...(input.budgetUsd !== undefined ? { budget_usd: input.budgetUsd } : {}),
        default_build_mode: input.defaultBuildMode,
        keep_app_domain: input.keepAppDomain,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** Changes, refusals and failures, newest first. Dry runs only when asked. */
  activity(
    options: { productId?: string; outcome?: 'applied' | 'planned' | 'refused' | 'failed'; includeDryRuns?: boolean; limit?: number; cursor?: string } & RequestOptions = {},
  ): Promise<ListEnvelope> {
    return this.transport.call(
      ENDPOINTS.activity_list,
      { productId: options.productId, outcome: options.outcome, include_dry_runs: options.includeDryRuns, limit: options.limit, cursor: options.cursor },
      options,
    )
  }

  members(options: RequestOptions = {}): Promise<ListEnvelope> {
    return this.transport.call(ENDPOINTS.member_list, {}, options)
  }

  /** Returns the link once. Only its hash is kept. */
  invite(input: { role?: Role } & MutationOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.invite_create, { role: input.role, ...mutationWire(input) }, input)
  }

  /** A member id, or an invitation id to cancel it. A member's keys are revoked with them. */
  removeMember(memberId: string, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(ENDPOINTS.member_remove, { memberId, ...mutationWire(options) }, options)
  }
}
