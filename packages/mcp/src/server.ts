/**
 * The MCP server, built in exactly one place.
 *
 * WHY ONE FACTORY FOR BOTH TRANSPORTS. Helm7 serves MCP twice: over stdio from
 * `bin/helm7-mcp.mjs`, and over HTTP from a route in the web app. Two factories
 * would be two tool lists, and they would diverge the first time an operation
 * was added — quietly, since neither surface can see the other. An agent would
 * then be told a tool exists or does not depending on how it happened to
 * connect, which is indistinguishable from the platform being broken.
 * `server.test.ts` asserts the two agree, and the assertion holds because there
 * is only one thing to agree with.
 *
 * TOOLS ARE NEVER HAND-WRITTEN. `mcpTools(capabilities)` is the catalogue's own
 * projection, annotations included. A hand-kept list is the surface that says a
 * destructive operation is safe on the day somebody adds one and forgets.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { getOperation, llmsTxt, mcpTools } from '@helm7/catalogue'
import { executeOperation } from './execute.js'

export const DEFAULT_BASE_URL = 'https://www.helm7.com'
export const SERVER_NAME = 'helm7'
export const SERVER_VERSION = '0.1.0'

export type Capability = 'may_deploy' | 'may_administer' | 'may_manage_billing'

export interface CreateServerOptions {
  /** The key every tool call is made with. Its capabilities decide the tool list. */
  apiKey: string
  baseUrl?: string
  /**
   * Capabilities the key carries. A tool the key cannot use is not advertised
   * at all — an agent that cannot see a tool does not spend turns arguing its
   * way past a refusal, and the narrower list is a cheaper prompt besides.
   */
  capabilities?: readonly string[]
  /** Injected by tests; the hosted route and the bin both use the real one. */
  fetch?: typeof globalThis.fetch
}

/**
 * The tool list for a set of capabilities.
 *
 * The catalogue's `annotations` are passed through untouched: `readOnlyHint`,
 * `destructiveHint` and `idempotentHint` are the only warning a client has
 * before asking a person to approve a call, and a client that re-derived them
 * would be guessing at facts the catalogue already knows.
 */
export function toolsFor(capabilities: readonly string[] = []): Tool[] {
  return mcpTools(capabilities).map((tool) => ({
    name: tool.name,
    description: tool.description,
    // The catalogue's JSON Schema is structural and deliberately not a
    // library type; the MCP types want a narrower object schema. The shape is
    // the same, so this asserts rather than converts — a conversion would be a
    // second place for the schema to be wrong.
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    annotations: { ...tool.annotations },
  }))
}

const textResult = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
})

export function createServer(options: CreateServerOptions): Server {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const capabilities = options.capabilities ?? []

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      /*
       * The same text `/llms.txt` serves, generated from the same catalogue.
       * Instructions written separately would eventually contradict the
       * published documentation, and the contradiction would be invisible to
       * everyone except the agent that had read both.
       */
      instructions: llmsTxt(baseUrl),
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(capabilities) }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    const operation = getOperation(name)

    if (!operation || operation.mcpExclude) return textResult(`No such tool: ${name}`, true)

    /*
     * Hiding a tool is not the same as refusing it, and a client that asks for
     * one it was never shown must still be refused. Relying on the filtered
     * list alone would make `tools/list` a security boundary, which it is not:
     * a tool name is guessable, and the catalogue publishes all of them.
     */
    if (operation.requiresCapability && !capabilities.includes(operation.requiresCapability)) {
      return textResult(
        {
          error: {
            code: 'insufficient_capability',
            message: `${name} requires the ${operation.requiresCapability} capability, which this key does not carry.`,
            remedy: 'Mint a key with that capability, or ask a person to run this operation.',
          },
        },
        true,
      )
    }

    try {
      const result = await executeOperation(operation, request.params.arguments ?? {}, {
        apiKey: options.apiKey,
        baseUrl,
        fetch: options.fetch,
        signal: extra?.signal,
      })
      /*
       * A refusal comes back as an ERROR RESULT, not a protocol error. The
       * model has to read it to act on it — `confirmation_required` is one
       * flag away from success and `budget_exceeded` means stop — and a
       * protocol error is handed to the client's plumbing instead, where the
       * remedy the API took care to write never reaches the agent.
       */
      return textResult(result.body ?? { status: result.status }, !result.ok)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return textResult({ error: { code: 'connection_error', message } }, true)
    }
  })

  return server
}
