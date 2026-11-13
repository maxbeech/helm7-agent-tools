import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { mcpTools, OPERATIONS } from '@helm7/catalogue'
import { createServer, toolsFor } from './server.js'
import { createStdioServer } from './stdio.js'
import { createHttpServer } from './http.js'

const OPTIONS = { apiKey: 'hlm_sk_test', baseUrl: 'https://example.test' }

/** Drive a server the way a real client would, over an in-memory pair. */
async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

async function toolNames(server: Server): Promise<string[]> {
  const client = await connect(server)
  const { tools } = await client.listTools()
  await client.close()
  return tools.map((tool) => tool.name).sort()
}

describe('the stdio bin and the hosted route serve the same server', () => {
  it('advertises the same tools through both entry points', async () => {
    for (const capabilities of [[], ['may_deploy'], ['may_deploy', 'may_administer', 'may_manage_billing']]) {
      const options = { ...OPTIONS, capabilities }
      const [stdio, http, direct] = await Promise.all([
        toolNames(createStdioServer(options)),
        toolNames(createHttpServer(options)),
        toolNames(createServer(options)),
      ])
      expect(stdio, `capabilities ${capabilities.join()} drifted between transports`).toEqual(http)
      expect(stdio).toEqual(direct)
    }
  })

  it('builds its tool list in exactly one file', () => {
    // The behavioural check above can only prove the two agree today. This is
    // what stops somebody adding a second tool list tomorrow: there is one
    // call to the catalogue's projection in this package, and it is the one
    // both entry points go through.
    const sources = readdirSync(new URL('.', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      .map((entry) => ({ name: entry.name, text: readFileSync(new URL(entry.name, import.meta.url), 'utf8') }))

    const builders = sources.filter((file) => file.text.includes('mcpTools('))
    expect(builders.map((f) => f.name)).toEqual(['server.ts'])
  })

  it('has both entry points delegate to createServer rather than to a Server of their own', () => {
    for (const name of ['stdio.ts', 'http.ts']) {
      const text = readFileSync(new URL(name, import.meta.url), 'utf8')
      expect(text, `${name} builds its own server`).toContain("from './server.js'")
      expect(text, `${name} constructs a Server directly`).not.toContain('new Server(')
    }
  })

  it('has the stdio bin go through the shared entry point', () => {
    const bin = readFileSync(new URL('../bin/helm7-mcp.mjs', import.meta.url), 'utf8')
    expect(bin).toContain('runStdio')
    expect(bin).not.toContain('mcpTools')
    expect(bin).not.toContain('new Server(')
  })
})

describe('capabilities decide what exists', () => {
  it('does not show deploy to a key with no capabilities', async () => {
    const names = await toolNames(createServer({ ...OPTIONS, capabilities: [] }))
    expect(names).not.toContain('deploy')
    expect(names).not.toContain('agent_key_create')
    // product_delete IS shown: it is gated by the product:delete scope and by
    // confirm, not by a capability. Capabilities are for organisation-level
    // actions like minting keys, and gating an ordinary delete behind one left
    // a trial workspace unable to tidy up after itself.
    expect(names).toContain('product_delete')
    expect(names).toContain('whoami')
  })

  it('shows deploy to a key carrying may_deploy', async () => {
    const names = await toolNames(createServer({ ...OPTIONS, capabilities: ['may_deploy'] }))
    expect(names).toContain('deploy')
    expect(names).not.toContain('agent_key_create')
  })

  it('treats a missing capabilities list as no capabilities, never as all of them', async () => {
    // Defaulting the other way would hand every unconfigured deployment the
    // destructive tools, which is the one direction this must not be wrong in.
    expect(await toolNames(createServer(OPTIONS))).not.toContain('deploy')
  })

  it('advertises exactly what the catalogue projects', async () => {
    const capabilities = ['may_deploy', 'may_administer', 'may_manage_billing']
    expect(await toolNames(createServer({ ...OPTIONS, capabilities }))).toEqual(
      mcpTools(capabilities).map((tool) => tool.name).sort(),
    )
  })

  it('refuses a capability-gated tool that was never advertised', async () => {
    // Hiding is not refusing: tool names are published and guessable, so the
    // filtered list must not be the only thing standing in the way.
    const client = await connect(createServer({ ...OPTIONS, capabilities: [] }))
    const result = await client.callTool({ name: 'deploy', arguments: { productId: 'prd_1' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('may_deploy')
    await client.close()
  })
})

describe('annotations', () => {
  const tools = toolsFor(['may_deploy', 'may_administer', 'may_manage_billing'])
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  it('carries the catalogue hints on every tool', () => {
    for (const tool of mcpTools(['may_deploy', 'may_administer', 'may_manage_billing'])) {
      expect(byName.get(tool.name)?.annotations, `${tool.name} lost its annotations`).toEqual(tool.annotations)
    }
  })

  it('warns about a destructive operation and not about a read', () => {
    expect(byName.get('product_delete')?.annotations?.destructiveHint).toBe(true)
    expect(byName.get('product_get')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('product_get')?.annotations?.destructiveHint).toBe(false)
  })

  it('does not warn a model off a free calculator', () => {
    expect(byName.get('cost_estimate')?.annotations?.readOnlyHint).toBe(true)
  })

  it('gives every tool the schema the catalogue declares', () => {
    for (const operation of OPERATIONS.filter((o) => !o.mcpExclude)) {
      expect(byName.get(operation.id)?.inputSchema).toEqual(operation.input ?? { type: 'object', properties: {} })
    }
  })
})

describe('calling a tool', () => {
  it('sends the call the catalogue describes and hands back the body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ applied: false, changes: [] }), { status: 200 }),
    )
    const client = await connect(
      createServer({ ...OPTIONS, capabilities: [], fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    )

    const result = await client.callTool({
      name: 'database_create',
      arguments: { productId: 'prd_1', dry_run: true },
    })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.test/v1/products/prd_1/databases')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer hlm_sk_test')
    expect(JSON.parse(String(init.body))).toEqual({ dry_run: true })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('applied')
    await client.close()
  })

  it('hands a refusal to the model rather than to the client plumbing', async () => {
    // budget_exceeded and confirmation_required are things the agent has to
    // read and act on; a protocol error never reaches it.
    const body = { error: { code: 'confirmation_required', message: 'needs confirm', request_id: 'req_1' } }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 409 }))
    const client = await connect(
      createServer({ ...OPTIONS, fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    )

    const result = await client.callTool({ name: 'domain_remove', arguments: { productId: 'p', domainId: 'd' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('confirmation_required')
    await client.close()
  })

  it('refuses a tool that does not exist', async () => {
    const client = await connect(createServer(OPTIONS))
    const result = await client.callTool({ name: 'product_nuke', arguments: {} })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it('reports an unreachable API as an error result, not a hang', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    const client = await connect(
      createServer({ ...OPTIONS, fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    )
    const result = await client.callTool({ name: 'whoami', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('connection_error')
    await client.close()
  })
})
