import type { JsonSchema } from './types.js'

/** Shared fragments. Declared once so a field means the same thing in every
 *  operation that mentions it — the whole point of a single catalogue. */

export const productId: JsonSchema = {
  type: 'string',
  pattern: '^prd_[a-z0-9]{20}$',
  description: 'Product identifier, e.g. prd_7k2m9x4qw1nv8bz3ct6d.',
}

/** The environments a caller can create. */
export const standardEnvironmentName: JsonSchema = {
  type: 'string',
  enum: ['production', 'preview', 'development'],
  description: 'Environment within a Product. Every Product has production; preview and development are optional.',
}

/** Any environment that can exist, including a pull request's preview. */
export const environmentName: JsonSchema = {
  type: 'string',
  pattern: '^(production|preview|development|pr-[0-9]+)$',
  description:
    'Environment within a Product. Every Product has production; preview and development are optional. pr-<number> is the preview of an open pull request, made and removed by the GitHub integration on Pro.',
}

export const testAccountId: JsonSchema = {
  type: 'string',
  pattern: '^tac_[0-9a-z]{20}$',
  description: 'Test account identifier, e.g. tac_7k2m9x4qw1nv8bz3ct6d.',
}

export const region: JsonSchema = {
  type: 'string',
  enum: ['eu-central', 'eu-north'],
  default: 'eu-central',
  description:
    'Where the Product runs. eu-central is Falkenstein, eu-north is Helsinki. Additional regions are not yet offered; do not assume a US region exists.',
}

export const serviceKind: JsonSchema = {
  type: 'string',
  enum: ['web', 'worker', 'cron'],
  description:
    'web receives HTTP traffic and can hold a domain. worker runs continuously with no ingress. cron runs on a schedule and exits.',
}

export const cursorInput: JsonSchema = {
  type: 'string',
  description: 'Opaque cursor from a previous response. Omit for the first page.',
}

export const limitInput: JsonSchema = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  default: 25,
  description: 'Maximum items to return.',
}

/**
 * Attached to the input of every mutating operation by `withMutationControls`.
 * Uniform placement matters more than the fields themselves: an agent should
 * never have to learn per-endpoint where the safety rails live.
 */
export const mutationControls: Record<string, JsonSchema> = {
  dry_run: {
    type: 'boolean',
    default: false,
    description:
      'Return the plan without applying it: the resources it would create, change or destroy, and an estimated monthly cost. Free, and has no side effects. Call this before any change you have not made before.',
  },
  confirm: {
    type: 'boolean',
    default: false,
    description:
      'Required for destructive operations. Without it a destructive call returns its plan and refuses, exactly as dry_run would.',
  },
  idempotency_key: {
    type: 'string',
    description:
      'Replaying the same key returns the original result instead of acting twice. Strongly recommended for anything that creates a resource or spends money.',
  },
}

/** A costed plan. Returned by every dry run, and by every refused destructive
 *  call, so the two paths are indistinguishable to a caller that always plans. */
export const planOutput: JsonSchema = {
  type: 'object',
  description: 'What would happen, what it would cost, and what could not be undone.',
  properties: {
    changes: {
      type: 'array',
      description: 'Ordered list of resource changes.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'delete', 'no-op'] },
          resource: { type: 'string', description: 'Resource type, e.g. database.' },
          name: { type: 'string' },
          detail: { type: 'string', description: 'Human-readable summary of the change.' },
          destructive: { type: 'boolean' },
        },
        required: ['action', 'resource', 'name', 'destructive'],
      },
    },
    cost: {
      type: 'object',
      description:
        'Estimated monthly cost in USD after this change, as a range. An estimate from current shape and recent usage, not a quote.',
      properties: {
        currency: { type: 'string', default: 'USD' },
        monthly_low: { type: 'number' },
        monthly_high: { type: 'number' },
        delta_low: { type: 'number', description: 'Change against the current bill, low end.' },
        delta_high: { type: 'number', description: 'Change against the current bill, high end.' },
        main_driver: { type: 'string', description: 'The single largest contributor, named plainly.' },
      },
      required: ['currency', 'monthly_low', 'monthly_high', 'main_driver'],
    },
    destructive_actions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Plain-language list of what would be irreversibly lost. Empty when nothing would be.',
    },
    applied: {
      type: 'boolean',
      description: 'false for a dry run or a refused destructive call; true when the change was made.',
    },
  },
  required: ['changes', 'cost', 'destructive_actions', 'applied'],
}

export const errorOutput: JsonSchema = {
  type: 'object',
  description: 'Every non-2xx response has this shape. No endpoint returns a bare string.',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Stable machine code, e.g. insufficient_scope, budget_exceeded, confirmation_required, not_found, conflict, rate_limited.',
        },
        message: { type: 'string', description: 'What went wrong, in plain language.' },
        remedy: { type: 'string', description: 'What to do about it. Present whenever a remedy exists.' },
        request_id: { type: 'string' },
        plan: {
          type: 'object',
          description:
            'Present on a 409 confirmation_required: the plan the call would have run. Declared here because llms.txt promises a refused destructive call returns what a dry run would, and an undeclared field is one a generated client will drop.',
        },
      },
      required: ['code', 'message', 'request_id'],
    },
  },
  required: ['error'],
}

/** Merge the standard mutation controls into an operation's input schema. */
export function withMutationControls(input: JsonSchema): JsonSchema {
  return {
    ...input,
    type: 'object',
    properties: { ...(input.properties ?? {}), ...mutationControls },
  }
}
