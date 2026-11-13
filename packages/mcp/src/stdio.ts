/**
 * The stdio entry point, for an agent running Helm7 on somebody's machine.
 *
 * It builds its server with `createServer` and nothing else — see the comment
 * there for why that matters. `createStdioServer` returns the server without
 * connecting it so the tests can inspect exactly what the bin would serve,
 * rather than a hand-built approximation of it.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer, type CreateServerOptions } from './server.js'

export function createStdioServer(options: CreateServerOptions) {
  return createServer(options)
}

export async function runStdio(options: CreateServerOptions): Promise<void> {
  const server = createStdioServer(options)
  await server.connect(new StdioServerTransport())
}
