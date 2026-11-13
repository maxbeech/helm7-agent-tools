/**
 * `@helm7/mcp` — Helm7's Model Context Protocol server.
 *
 * One `createServer`, two transports: `runStdio` for a local agent and
 * `handleHttpRequest` for the hosted route the web app mounts. Both are thin
 * wrappers, so the two can never advertise different tools.
 *
 * ```ts
 * // app/api/mcp/route.ts
 * import { handleHttpRequest } from '@helm7/mcp'
 *
 * export async function POST(request: Request) {
 *   const key = await authenticate(request)
 *   return handleHttpRequest(request, { apiKey: key.secret, capabilities: key.capabilities })
 * }
 * ```
 */
export { createServer, toolsFor, DEFAULT_BASE_URL, SERVER_NAME, SERVER_VERSION } from './server.js'
export type { CreateServerOptions, Capability } from './server.js'

export { createStdioServer, runStdio } from './stdio.js'
export { createHttpServer, createHttpHandler, handleHttpRequest } from './http.js'

export { buildRequest, executeOperation } from './execute.js'
export type { ExecuteOptions, ExecuteResult } from './execute.js'
