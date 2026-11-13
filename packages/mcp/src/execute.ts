/**
 * Turning a tool call into an HTTP request.
 *
 * WHERE EACH ARGUMENT GOES IS READ OFF THE CATALOGUE, not hand-mapped per
 * tool: path params come from the path, and the rest are query for a GET and
 * a JSON body otherwise. There are thirty-one operations and one rule, which
 * is the only arrangement where adding the thirty-second cannot get it wrong.
 *
 * ARGUMENTS THE CATALOGUE DOES NOT DECLARE ARE DROPPED. A model that invents a
 * `force: true` or a `skip_backup: true` should have it ignored here rather
 * than forwarded for the server to ignore — the server is entitled to start
 * meaning something by a field one day, and a client that forwards whatever it
 * was handed is how that day becomes an incident.
 */
import { bodyParams, pathParams, type Operation } from '@helm7/catalogue'

export interface ExecuteOptions {
  apiKey: string
  baseUrl: string
  fetch?: typeof globalThis.fetch
  userAgent?: string
  signal?: AbortSignal
}

export interface ExecuteResult {
  status: number
  body: unknown
  ok: boolean
}

export function buildRequest(
  operation: Operation,
  args: Record<string, unknown>,
  baseUrl: string,
): { url: string; body: Record<string, unknown> | undefined } {
  let path = operation.path
  for (const name of pathParams(operation)) {
    const value = args[name]
    if (value === undefined || value === null || value === '') {
      throw new Error(`${operation.id} needs ${name}`)
    }
    path = path.replace(`:${name}`, encodeURIComponent(String(value)))
  }

  const declared = bodyParams(operation)
  const supplied: Record<string, unknown> = {}
  for (const key of declared) {
    if (args[key] !== undefined) supplied[key] = args[key]
  }

  if (operation.method === 'GET') {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(supplied)) {
      if (Array.isArray(value)) for (const item of value) query.append(key, String(item))
      else query.set(key, String(value))
    }
    const suffix = query.toString()
    return { url: `${baseUrl}${path}${suffix ? `?${suffix}` : ''}`, body: undefined }
  }

  return {
    url: `${baseUrl}${path}`,
    body: Object.keys(supplied).length > 0 ? supplied : {},
  }
}

export async function executeOperation(
  operation: Operation,
  args: Record<string, unknown>,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const doFetch = options.fetch ?? globalThis.fetch
  const { url, body } = buildRequest(operation, args, options.baseUrl.replace(/\/+$/, ''))

  const response = await doFetch(url, {
    method: operation.method,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'User-Agent': options.userAgent ?? 'helm7-mcp',
      // Tells the API this call came from an agent's tool, which is what lets
      // `deploy` default to building on the agent's own machine.
      'X-Helm7-Client': 'mcp',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal,
  })

  const text = await response.text()
  let parsed: unknown = undefined
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      /*
       * Kept as text rather than smoothed to null. A proxy's HTML error page
       * reported as an empty result is how a model concludes an organisation
       * has no Products and offers to create one.
       */
      parsed = { raw: text }
    }
  }

  return { status: response.status, body: parsed, ok: response.ok }
}
