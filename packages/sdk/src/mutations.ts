/**
 * The safety rails, in one place.
 *
 * Every mutating operation in the catalogue carries the same three controls,
 * and the value of that uniformity is lost the moment one SDK method spells
 * them differently. So methods take camelCase options and this is the only
 * thing that knows the wire names — a method cannot send `dryRun` to a server
 * that reads `dry_run`, because no method writes either string.
 *
 * The wire names are snake_case and the SDK's are not, deliberately: matching
 * the wire in TypeScript would make `dry_run` appear in call sites written in
 * a codebase that camelCases everything else, and the translation has to live
 * somewhere anyway.
 */
import type { RequestOptions, WireParams } from './transport.js'

export interface MutationOptions extends RequestOptions {
  /**
   * Return the plan — what would be created, changed or destroyed, and what it
   * would cost per month — without applying it. Free and side-effect-free.
   */
  dryRun?: boolean
  /**
   * Required by destructive operations. Without it a destructive call returns
   * its plan and refuses, exactly as a dry run would.
   */
  confirm?: boolean
  /**
   * Replaying the same key returns the original result instead of acting twice.
   * Supplying one also makes the SDK willing to retry the call at all.
   */
  idempotencyKey?: string
}

export function mutationWire(options: MutationOptions = {}): WireParams {
  return {
    dry_run: options.dryRun,
    confirm: options.confirm,
    idempotency_key: options.idempotencyKey,
  }
}
