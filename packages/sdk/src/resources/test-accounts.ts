/**
 * Test accounts: sign-ins for an automated tester.
 *
 * Passwords and TOTP seeds are write-only here as everywhere else. `list` and
 * `get` carry a fingerprint and whether a seed exists. The ONLY methods that
 * return a secret are `checkout` and `totp`, behind their own `test_account:use`
 * scope and recorded with the run that asked, so call them from the process
 * that drives the browser and keep the result out of logs and model prompts.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, JsonObject, ListEnvelope, Plan } from '../types.js'

export interface TestAccountCreateInput extends MutationOptions {
  productId: string
  environment?: Environment
  /** Lower case letters, digits and hyphens. Unique within the environment. */
  label: string
  /** `provision` makes the user in managed auth; `external` in the Product's own auth service; `register` records one made elsewhere. */
  mode: 'provision' | 'external' | 'register'
  /** `external` only: which auth service holds the Product's users. */
  authProvider?: 'supabase'
  role?: string
  /** `register`: required. `provision`: optional, and must carry `+helm7test`. */
  email?: string
  /** `register`: required. `provision`: not accepted. Write-only. */
  password?: string
  /** Base32 seed for an account with two-factor sign-in. Write-only. */
  totpSecret?: string
  notes?: string
  /** Make the account temporary: `90m`, `24h`, `7d` (5 minutes to 90 days). */
  expiresIn?: string
  /** Make the account temporary until this time (ISO 8601). Not with `expiresIn`. */
  expiresAt?: string
}

export interface TestAccountRotateInput extends MutationOptions {
  productId: string
  accountId: string
  /** `register` accounts: the new password. Not accepted for `provision`. Write-only. */
  password?: string
  totpSecret?: string
}

export interface TestAccountCheckoutInput extends MutationOptions {
  productId: string
  accountId: string
  /** What is using the account (a run id). Written to the activity log. */
  runRef: string
  /** Lease length, 60 to 3600. Default 900. */
  ttlSeconds?: number
  /** provision accounts: also return the password. Default false; the session is usually enough. */
  includePassword?: boolean
}

/** What `checkout` returns. A credential: do not log it. */
export interface TestAccountCheckout extends JsonObject {
  email: string
  /** Absent for a provision account when a session was returned and includePassword was not set. */
  password?: string
  totp_code: string | null
  totp_valid_for_seconds: number | null
  session?: { access_token: string; refresh_token: string; expires_at: number } | null
  session_error?: string
  lease_expires_at: string
}

export class TestAccountsResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  create(input: TestAccountCreateInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.test_account_create,
      {
        productId: input.productId,
        environment: input.environment,
        label: input.label,
        mode: input.mode,
        auth_provider: input.authProvider,
        role: input.role,
        email: input.email,
        password: input.password,
        totp_secret: input.totpSecret,
        notes: input.notes,
        expires_in: input.expiresIn,
        expires_at: input.expiresAt,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** Never a password, seed or code. */
  list(options: { productId: string; environment?: Environment } & RequestOptions): Promise<ListEnvelope> {
    return this.transport.call(ENDPOINTS.test_account_list, { productId: options.productId, environment: options.environment }, options)
  }

  get(productId: string, accountId: string, options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.test_account_get, { productId, accountId }, options)
  }

  rotate(input: TestAccountRotateInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.test_account_rotate,
      { productId: input.productId, accountId: input.accountId, password: input.password, totp_secret: input.totpSecret, ...mutationWire(input) },
      input,
    )
  }

  delete(input: { productId: string; accountId: string } & MutationOptions): Promise<Plan> {
    return this.transport.call(ENDPOINTS.test_account_delete, { productId: input.productId, accountId: input.accountId, ...mutationWire(input) }, input)
  }

  /** The one call that returns a password. Needs `test_account:use`. */
  checkout(input: TestAccountCheckoutInput): Promise<TestAccountCheckout | Plan> {
    return this.transport.call(
      ENDPOINTS.test_account_checkout,
      { productId: input.productId, accountId: input.accountId, run_ref: input.runRef, ttl_seconds: input.ttlSeconds, include_password: input.includePassword, ...mutationWire(input) },
      input,
    )
  }

  /** The current one-time code, generated server-side so the seed stays in Helm7. Needs `test_account:use`. */
  totp(input: { productId: string; accountId: string; runRef?: string } & RequestOptions): Promise<{ code: string; valid_for_seconds: number }> {
    return this.transport.call(ENDPOINTS.test_account_totp, { productId: input.productId, accountId: input.accountId, run_ref: input.runRef }, input)
  }
}
