---
name: helm7
description: Deploy and run a whole application (app, Postgres, auth, storage, jobs, domains) on Helm7 through its MCP server, CLI or REST API. Use when asked to host, deploy, provision a database, or put an app on a domain.
---

# Helm7

66 operations, one API. Full list: https://www.helm7.com/llms.txt. OpenAPI: https://www.helm7.com/v1/openapi.json.

## Connect

- Claude Code: `claude mcp add --transport http helm7 https://www.helm7.com/mcp`, then authenticate in the browser.
- Anything else: send `Authorization: Bearer hlm_sk_...` to https://www.helm7.com/v1/*.
- No account yet: call `cloud_init` for a temporary workspace with no email or card. Call `cloud_claim` to keep it.

## Rules

1. Call `whoami` first. It shows your scopes, spend cap and expiry.
2. Pass `dry_run: true` before anything that changes infrastructure. It returns the plan and the monthly cost.
3. Destructive calls refuse without `confirm: true` and return the plan. Show it to the user before confirming.
4. Pass `idempotency_key` on anything that creates or spends.
5. Secrets are write-only. Never ask for a value back.

## Usual order

`product_create` → `database_create` → `auth_enable` → `deploy` → `domain_attach`.

## When a call fails

The body is `{ error: { code, message, remedy, docs_url, request_id } }`. Do what `remedy` says. If that is not enough, read `docs_url`. Do not retry an identical call after `invalid_request`, `insufficient_scope`, `budget_exceeded` or `plan_limit`. Retry `rate_limited` and `provider_unavailable` after a pause, with the same `idempotency_key`.
