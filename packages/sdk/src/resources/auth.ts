/**
 * Managed auth: a GoTrue-compatible service against the Product database.
 *
 * The compatibility is the point rather than a detail — an app already written
 * against Supabase Auth moves by changing its URL and key and nothing else, so
 * the SDK deliberately exposes no Helm7-shaped alternative that would tempt a
 * caller into rewriting working code.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, JsonObject, Plan } from '../types.js'

export interface AuthEnableInput extends MutationOptions {
  productId: string
  environment?: Environment
  /** email, plus any OAuth providers you have configured credentials for. */
  providers?: string[]
  /** Where auth redirects land. Defaults to the environment's primary domain. */
  siteUrl?: string
}

export interface AuthGetOptions extends RequestOptions {
  productId: string
  environment?: Environment
}

export interface AuthProviderSettings {
  enabled?: boolean
  clientId?: string
  /** Write-only. Stored as a secret and never returned. */
  clientSecret?: string
}

export interface AuthUpdateInput extends MutationOptions {
  productId: string
  environment?: Environment
  siteUrl?: string
  additionalRedirectUrls?: string[]
  emailAutoconfirm?: boolean
  disableSignup?: boolean
  /** Lets anyone create an anonymous user. Put CAPTCHA and rate limiting in your app. */
  anonymousSignIns?: boolean
  external?: { google?: AuthProviderSettings; github?: AuthProviderSettings }
  passwordMinLength?: number
  jwtExpirySeconds?: number
  refreshTokenRotation?: boolean
  refreshTokenReuseIntervalSeconds?: number
  publicHostname?: string
}

/** One user to import. Field names follow the auth.users columns. */
export interface AuthImportUser {
  id: string
  /** Required, unless `is_anonymous`. */
  email?: string
  is_anonymous?: boolean
  /** bcrypt or argon2. Never logged, never returned. */
  encrypted_password?: string
  email_confirmed_at?: string | null
  phone?: string
  created_at?: string
  updated_at?: string
  last_sign_in_at?: string | null
  banned_until?: string | null
  raw_user_meta_data?: JsonObject
  raw_app_meta_data?: JsonObject
  identities?: Array<{
    provider: 'email' | 'google' | 'github'
    provider_id?: string
    identity_data?: JsonObject
    created_at?: string
    last_sign_in_at?: string | null
  }>
}

export interface AuthImportInput extends MutationOptions {
  productId: string
  environment?: Environment
  users: AuthImportUser[]
}

export class AuthResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  enable(input: AuthEnableInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.auth_enable,
      {
        productId: input.productId,
        environment: input.environment,
        providers: input.providers,
        site_url: input.siteUrl,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** Health, URL, non-secret configuration and user counts. No secrets. */
  get(options: AuthGetOptions): Promise<JsonObject> {
    return this.transport.call(
      ENDPOINTS.auth_get,
      { productId: options.productId, environment: options.environment },
      options,
    )
  }

  /** Only the fields given change. Provider secrets are write-only. */
  update(input: AuthUpdateInput): Promise<Plan> {
    const provider = (settings: AuthProviderSettings | undefined) =>
      settings === undefined
        ? undefined
        : { enabled: settings.enabled, client_id: settings.clientId, client_secret: settings.clientSecret }
    return this.transport.call(
      ENDPOINTS.auth_update,
      {
        productId: input.productId,
        environment: input.environment,
        site_url: input.siteUrl,
        additional_redirect_urls: input.additionalRedirectUrls,
        email_autoconfirm: input.emailAutoconfirm,
        disable_signup: input.disableSignup,
        anonymous_sign_ins: input.anonymousSignIns,
        external: input.external
          ? { google: provider(input.external.google), github: provider(input.external.github) }
          : undefined,
        password_min_length: input.passwordMinLength,
        jwt_expiry_seconds: input.jwtExpirySeconds,
        refresh_token_rotation: input.refreshTokenRotation,
        refresh_token_reuse_interval_seconds: input.refreshTokenReuseIntervalSeconds,
        public_hostname: input.publicHostname,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** Idempotent on user id. Up to 200 users a call; returns counts, never hashes. */
  importUsers(input: AuthImportInput): Promise<Plan & JsonObject> {
    return this.transport.call(
      ENDPOINTS.auth_users_import,
      { productId: input.productId, environment: input.environment, users: input.users, ...mutationWire(input) },
      input,
    )
  }
}
