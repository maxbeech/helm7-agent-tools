#!/usr/bin/env node
/**
 * Helm7 over stdio, for an agent running on somebody's machine.
 *
 * It builds nothing itself: the tool list comes from `createServer`, the same
 * one the hosted HTTP route uses, so the two cannot drift. Everything this file
 * decides is which key to speak with and which capabilities to claim.
 *
 * HELM7_CAPABILITIES is an allow-list the operator narrows, never widens — the
 * server refuses a capability the key does not really hold, so naming one here
 * that it lacks buys a clear refusal rather than access.
 */
import process from 'node:process'

const entry = new URL('../dist/index.js', import.meta.url)

let runStdio
try {
  ;({ runStdio } = await import(entry.href))
} catch (cause) {
  if (cause?.code !== 'ERR_MODULE_NOT_FOUND') throw cause
  if (cause.url === entry.href) {
    process.stderr.write('helm7-mcp: this checkout has not been built. Run `npm run build -w @helm7/mcp`.\n')
  } else {
    /*
     * Almost always @helm7/catalogue: it is published as TypeScript source
     * whose internal specifiers end in `.js`, and Node resolves those
     * literally — it does not map `foo.js` to `foo.ts`. A compiled consumer
     * therefore cannot import it under bare Node, and this bin is the only
     * bare-Node consumer there is. The hosted route is unaffected because the
     * web app bundles its workspace sources. Say so plainly rather than
     * blaming a build the reader has already run.
     */
    process.stderr.write(
      `helm7-mcp: could not load ${cause.url}. A dependency ships TypeScript source that Node cannot ` +
        'import directly; the server needs bundling (or that package needs a build) before the stdio ' +
        'bin can run.\n',
    )
  }
  process.exitCode = 70
}

if (runStdio) {
  const apiKey = process.env.HELM7_API_KEY
  if (!apiKey) {
    // stderr, never stdout: stdout is the protocol channel, and a friendly
    // message written there is a parse error at the other end rather than a
    // message anybody reads.
    process.stderr.write('helm7-mcp: HELM7_API_KEY is not set.\n')
    process.exitCode = 3
  } else {
    await runStdio({
      apiKey,
      baseUrl: process.env.HELM7_BASE_URL,
      capabilities: (process.env.HELM7_CAPABILITIES ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    })
  }
}
