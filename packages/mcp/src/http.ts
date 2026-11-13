/**
 * The hosted entry point: the same server behind a Web-standard Request and
 * Response, which is what the web app's route handler speaks.
 *
 * ONE SERVER AND TRANSPORT PER REQUEST, deliberately. The hosted route
 * authenticates each request separately, and the key it resolves decides which
 * tools exist — a server cached across requests would answer one key's
 * `tools/list` with another key's capabilities, which is the worst kind of bug
 * here because the wrong answer is a wider one.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer, type CreateServerOptions } from './server.js'

export function createHttpServer(options: CreateServerOptions) {
  return createServer(options)
}

export async function handleHttpRequest(request: Request, options: CreateServerOptions): Promise<Response> {
  const server = createHttpServer(options)
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id, and a JSON response rather than an SSE stream,
    // because a serverless route cannot hold a stream open between invocations
    // and pretending otherwise leaves clients waiting for events that are gone.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    // Nothing survives the request, so nothing should be left holding it.
    await transport.close().catch(() => undefined)
  }
}

/** A handler bound to one set of options, for a route that serves a fixed key. */
export function createHttpHandler(options: CreateServerOptions): (request: Request) => Promise<Response> {
  return (request) => handleHttpRequest(request, options)
}
