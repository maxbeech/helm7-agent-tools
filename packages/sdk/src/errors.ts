/**
 * The error every Helm7 call throws. Never a string, never a bare `Error`.
 *
 * The API answers every failure with `{ error: { code, message, remedy,
 * request_id } }` and the `code` is the stable part of that contract — llms.txt
 * tells agents to branch on it and never on the message, so this class surfaces
 * it as a real property rather than leaving each caller to re-parse a body.
 *
 * `remedy` is carried through for the same reason it exists on the wire: the
 * difference between "budget_exceeded" and "budget_exceeded — raise the cap on
 * the key or wait for the period to roll" is the difference between an agent
 * that stops and an agent that retries the same refused call until its turn
 * budget runs out.
 */

/**
 * Codes minted by the server. `confirmation_required` is deliberately distinct
 * from `forbidden`: one means "say confirm: true and this will work", the other
 * means "never retry this". Collapsing them is how a destructive call that was
 * one flag away from succeeding gets reported as a permissions problem nobody
 * can fix.
 */
export type Helm7ServerErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'insufficient_scope'
  | 'confirmation_required'
  | 'budget_exceeded'
  | 'quota_exceeded'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal'

export type Helm7ErrorCode =
  | Helm7ServerErrorCode
  /**
   * The request never reached Helm7 — DNS, TLS, a timeout, an offline machine.
   * Named apart from the server's own codes on purpose: "we could not ask" and
   * "the answer is no" are different facts, and a client reporting the first as
   * the second turns a network blip into a confident wrong answer about
   * somebody's infrastructure.
   */
  | 'connection_error'
  /** A 2xx whose body was not the JSON the contract promises. */
  | 'invalid_response'

const SERVER_CODES = new Set<string>([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'insufficient_scope',
  'confirmation_required',
  'budget_exceeded',
  'quota_exceeded',
  'not_found',
  'conflict',
  'rate_limited',
  'internal',
])

/** Codes where replaying the identical request can plausibly succeed. */
const RETRYABLE = new Set<Helm7ErrorCode>(['rate_limited', 'internal', 'connection_error'])

export interface Helm7ErrorInit {
  code: Helm7ErrorCode
  message: string
  /** HTTP status, or 0 when the request never got a response. */
  status: number
  remedy?: string
  /** Full explanation of this code; present on every error the API sends. */
  docsUrl?: string
  requestId?: string
  request?: { method: string; path: string }
  /**
   * The parsed failure body, untouched.
   *
   * LOAD-BEARING for one case: a destructive operation refused for want of
   * `confirm: true` answers 409 and the catalogue says its body carries the
   * plan. The plan's shape is not part of `errorOutput`, so the SDK does not
   * invent a field for it — it keeps the body so a caller (the CLI's plan
   * renderer, for one) can read whatever the server actually sent instead of
   * losing it to a narrow parse.
   */
  body?: unknown
  cause?: unknown
}

export class Helm7Error extends Error {
  readonly code: Helm7ErrorCode
  readonly status: number
  readonly remedy: string | undefined
  readonly docsUrl: string | undefined
  readonly requestId: string | undefined
  readonly request: { method: string; path: string } | undefined
  readonly body: unknown

  constructor(init: Helm7ErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'Helm7Error'
    this.code = init.code
    this.status = init.status
    this.remedy = init.remedy
    this.docsUrl = init.docsUrl
    this.requestId = init.requestId
    this.request = init.request
    this.body = init.body
  }

  /** True for failures where retrying the same request can succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }
}

/**
 * Map a status onto a code for the case the body could not be read.
 *
 * A body is normally present and authoritative; this is the fallback for a
 * proxy or edge that answered before Helm7 did, where the status is the only
 * thing there is to go on. 403 falls back to `forbidden` rather than guessing
 * between the three refusals that share it — scope, capability and budget —
 * because guessing wrong sends the reader to fix the wrong thing.
 */
function codeFromStatus(status: number): Helm7ErrorCode {
  if (status === 400) return 'invalid_request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  return 'internal'
}

interface WireError {
  code?: unknown
  message?: unknown
  remedy?: unknown
  docs_url?: unknown
  request_id?: unknown
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

/**
 * Build the error for a non-2xx response.
 *
 * The body is trusted for the code ONLY when it names one this SDK knows. An
 * unrecognised string falls back to the status rather than being passed through,
 * because a caller branching on `err.code` is entitled to assume the value is
 * one of the documented set — a surprise string silently falls through every
 * branch and lands in whatever the `else` does.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  request: { method: string; path: string },
): Helm7Error {
  const wire = (body as { error?: WireError } | null)?.error
  const claimed = str(wire?.code)
  const code = claimed && SERVER_CODES.has(claimed) ? (claimed as Helm7ErrorCode) : codeFromStatus(status)
  return new Helm7Error({
    code,
    message: str(wire?.message) ?? `Helm7 ${request.method} ${request.path} failed with ${status}`,
    status,
    remedy: str(wire?.remedy),
    docsUrl: str(wire?.docs_url),
    requestId: str(wire?.request_id),
    request,
    body,
  })
}

/** The error for a request that never got an answer at all. */
export function connectionError(cause: unknown, request: { method: string; path: string }): Helm7Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Helm7Error({
    code: 'connection_error',
    message: `Helm7 ${request.method} ${request.path} could not be reached: ${detail}`,
    status: 0,
    remedy: 'Check network reachability and the baseUrl, then retry. Nothing was changed.',
    request,
    cause,
  })
}
