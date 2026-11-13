# Helm7 agent tools

TypeScript SDK, CLI, MCP server and API catalogue for [Helm7](https://www.helm7.com).

The hosted MCP server is available at `https://www.helm7.com/mcp`. Clients that support OAuth can sign in through their browser. In Claude Code:

```sh
claude mcp add --transport http helm7 https://www.helm7.com/mcp
```

To build the tools locally, install Node.js 22 or later and run:

```sh
npm ci
npm run build
npm test
```

The CLI is `node packages/cli/bin/helm7.mjs`. The local MCP server is `node packages/mcp/bin/helm7-mcp.mjs` and requires `HELM7_API_KEY`. Use a scoped key and keep it out of source control. The packages are not yet published to npm.

API operations are defined in `packages/catalogue`; the MCP server and SDK use the catalogue to keep their interfaces aligned. The hosted API reference and error codes are available at [helm7.com/docs](https://www.helm7.com/docs).

Licensed under Apache-2.0. This repository contains the client and integration tools; the hosted Helm7 control plane is separate.
