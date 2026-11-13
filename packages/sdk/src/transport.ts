/**
 * The HTTP layer. Zero dependencies and `fetch` only, because this client runs
 * in the CLI on somebody's laptop, in the web app's route handlers and inside
 * an agent's sandbox, and a transitive dependency that assumes one of those is
 * how an SDK stops being portable.
 *
 * WHERE A PARAMETER GOES IS DERIVED, NOT DECLARED. Path params come out of the
 * path pattern itself; for a GET the rest become query string, and for anything
 * else the rest become the JSON body. Resource methods therefore cannot put a
 * parameter in the wrong place, because they never choose — they hand over one
 * flat object of wire names and this decides. The alternative, each method
 * spelling out its own query/body split, drifts one method at a time and each
 * drift looks like a server bug.
 *
 * WHEN A MUTATION IS RETRIED. A non-GET is replayed only when the caller made
 * replaying safe: `dry_run: true` changes nothing by definition, and
 * `idempotency_key` is the server's promise that a replay returns the original
 * result rather than acting twice. Anything else is left alone, so the default
 * for a new operation is "do not retry" — the safe direction to be wrong in,
 * since the failure it avoids is two databases where the caller asked for one.
 */
import { Helm7Error, connectionError, errorFromResponse } from './errors.js'
import { resolvePath, pathParams, type EndpointSpec } from './endpoints.js'

export interface RetryPolicy {
  /** Attempts after the first. 0 disables retrying. */
  maxRetries: number
  /** First backoff step in ms; doubles each attempt. */
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 400, maxDelayMs: 8_000 }
export const DEFAULT_TIMEOUT_MS = 60_000

export interface TransportOptions {
  baseUrl: string
  /** Read per request, so a rotated key takes effect without a new client. */
  authHeaders: () => Record<string, string>
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  retry?: RetryPolicy
  userAgent?: string
}

/** Options every method accepts, whether it mutates or not. */
export interface RequestOptions {
  signal?: AbortSignal
}

/** Wire-shaped parameters: snake_case keys, exactly as the catalogue names them. */
export type WireParams = Record<string, unknown>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How long to wait before the next attempt. `Retry-After` is the server naming
 * its own window, so it wins over our guess: a backoff shorter than the window
 * just burns an attempt against a limit that has not reset. Jitter keeps a
 * fleet that failed together from retrying in lockstep.
 */
export function backoffMs(attempt: number, policy: RetryPolicy, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, policy.maxDelayMs)
  }
  const exponential = policy.baseDelayMs * 2 ** attempt
  return Math.min(exponential + Math.random() * policy.baseDelayMs, policy.maxDelayMs)
}

/** Split a flat parameter object by where the endpoint wants each value. */
export function splitParams(
  endpoint: EndpointSpec,
  params: WireParams,
): { path: WireParams; rest: WireParams } {
  const inPath = new Set(pathParams(endpoint.path))
  const path: WireParams = {}
  const rest: WireParams = {}
  for (const [key, value] of Object.entries(params)) {
    // An explicit `undefined` means "not supplied", never "send null": the
    // catalogue's defaults live on the server and sending null would overwrite
    // them with nothing.
    if (value === undefined) continue
    if (inPath.has(key)) path[key] = value
    else rest[key] = value
  }
  return { path, rest }
}

function buildQuery(params: WireParams): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) search.append(key, String(item))
    else search.set(key, String(value))
  }
  const out = search.toString()
  return out ? `?${out}` : ''
}

export class Transport {
  readonly baseUrl: string
  private readonly doFetch: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly retry: RetryPolicy
  private readonly userAgent: string
  private readonly authHeaders: () => Record<string, string>

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.doFetch = options.fetch ?? globalThis.fetch
    if (typeof this.doFetch !== 'function') {
      throw new Error('Helm7 SDK: no fetch available. Pass one as `fetch`, or run on Node 22+.')
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retry = options.retry ?? DEFAULT_RETRY
    this.userAgent = options.userAgent ?? 'helm7-sdk'
    this.authHeaders = options.authHeaders
  }

  async call<T>(endpoint: EndpointSpec, params: WireParams = {}, options: RequestOptions = {}): Promise<T> {
    const { path: pathValues, rest } = splitParams(endpoint, params)
    const path = resolvePath(endpoint, pathValues)
    const isGet = endpoint.method === 'GET'
    const query = isGet ? buildQuery(rest) : ''
    const body = isGet || Object.keys(rest).length === 0 ? undefined : rest
    const where = { method: endpoint.method, path }
    const url = `${this.baseUrl}${path}${query}`

    const replayIsSafe = isGet || rest.dry_run === true || typeof rest.idempotency_key === 'string'
    const attempts = replayIsSafe ? this.retry.maxRetries : 0

    /*
     * Built ONCE, outside the attempt loop: a failure to produce the headers is
     * a caller mistake, not a network one. Building them inside the try would
     * let "you never supplied a key" be caught as a connection error, retried
     * with backoff and finally reported as a server that could not be reached
     * — pointing the reader at the network on a machine where the network is
     * fine.
     */
    const auth = this.authHeaders()

    let lastError: Helm7Error | undefined
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      let response: Response
      const timer = new AbortController()
      const timeout = setTimeout(() => timer.abort(), this.timeoutMs)
      /*
       * A caller's own signal must still win. Listening rather than replacing
       * keeps `signal` working while the timeout stays in force — a request
       * with a caller signal and no timeout is how a hung connection holds a
       * deploy open until something else kills the run.
       */
      const onAbort = () => timer.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        response = await this.doFetch(url, {
          method: endpoint.method,
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            'User-Agent': this.userAgent,
            ...auth,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: timer.signal,
        })
      } catch (cause) {
        lastError = connectionError(cause, where)
        if (attempt < attempts) {
          await sleep(backoffMs(attempt, this.retry, null))
          continue
        }
        throw lastError
      } finally {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
      }

      if (response.ok) {
        const text = await response.text()
        if (!text) return undefined as T
        try {
          return JSON.parse(text) as T
        } catch {
          /*
           * A 2xx whose body is not JSON is a broken contract, not an empty
           * answer. Returning `undefined` would let a caller read a proxy's
           * HTML error page as "no resources".
           */
          throw new Helm7Error({
            code: 'invalid_response',
            message: `Helm7 ${where.method} ${where.path} answered ${response.status} with a body that is not JSON`,
            status: response.status,
            remedy: 'Check whether a proxy is answering in front of the API.',
            request: where,
          })
        }
      }

      const failure = await response.json().catch(() => null)
      lastError = errorFromResponse(response.status, failure, where)
      if (attempt < attempts && lastError.retryable) {
        await sleep(backoffMs(attempt, this.retry, response.headers.get('retry-after')))
        continue
      }
      throw lastError
    }

    /* Unreachable: the loop either returns or throws. Kept so the type is honest. */
    throw lastError ?? connectionError(new Error('no attempt was made'), where)
  }
}
