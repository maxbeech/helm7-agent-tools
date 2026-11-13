/**
 * The shapes the API actually guarantees.
 *
 * WHY SOME RETURNS ARE OPEN OBJECTS. The catalogue specifies `planOutput`, the
 * list envelope and `whoami` field by field, so those are typed field by field
 * here. The rest — a Product's graph, a deployment, a database — are declared
 * as open objects in the catalogue, and inventing a precise interface for them
 * in the SDK would be the client asserting a contract the server never made.
 * The first time a field was renamed the type would still compile and still be
 * wrong, which is worse than `JsonObject`: a caller who has to reach into an
 * open object knows to check, where a caller holding a confident interface does
 * not. These tighten when the catalogue does, not before.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = Record<string, unknown>

/** Every list endpoint answers this envelope. `next_cursor` is null on the last page. */
export interface ListEnvelope<T = JsonObject> {
  data: T[]
  next_cursor?: string | null
}

export type PlanAction = 'create' | 'update' | 'delete' | 'no-op'

export interface PlanChange {
  action: PlanAction
  /** Resource type, e.g. `database`. */
  resource: string
  name: string
  detail?: string
  destructive: boolean
}

export interface PlanCost {
  currency: string
  monthly_low: number
  monthly_high: number
  /** Change against the current bill. Absent when the server cannot compare. */
  delta_low?: number
  delta_high?: number
  main_driver: string
}

/**
 * What would happen, what it would cost, and what could not be undone.
 *
 * Returned by every dry run AND by every destructive call refused for want of
 * `confirm: true`, so the two paths are indistinguishable to a caller that
 * always plans first. `applied` is the only field that tells them apart, which
 * is why nothing here should be read as "it happened".
 */
export interface Plan {
  changes: PlanChange[]
  cost: PlanCost
  /** Plain-language list of what would be irreversibly lost. Empty when nothing would be. */
  destructive_actions: string[]
  applied: boolean
}

/** The calling identity and its ceiling. Worth one call before planning anything. */
export interface WhoAmI extends JsonObject {
  organization?: JsonObject
  member?: JsonObject
  /** Scopes, capabilities, budget_remaining_usd and expires_at where applicable. */
  key?: JsonObject
  /** true for an unclaimed trial workspace. Ephemeral workspaces expire. */
  is_ephemeral?: boolean
}

export type Environment = 'production' | 'preview' | 'development'
export type Region = 'eu-central' | 'eu-north'
export type ServiceKind = 'web' | 'worker' | 'cron'
export type Instance = 'shared-0.25' | 'shared-0.5' | 'standard-1' | 'standard-2'
export type Capability = 'may_deploy' | 'may_administer' | 'may_manage_billing'
