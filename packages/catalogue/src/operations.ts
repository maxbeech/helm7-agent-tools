import type { Operation, JsonSchema } from './types.js'
import {
  productId, environmentName, standardEnvironmentName, region, serviceKind,
  cursorInput, limitInput, planOutput, withMutationControls, testAccountId,
} from './schemas.js'

const ok = (description: string, properties?: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', description, properties: properties ?? {},
})

const list = (itemDescription: string): JsonSchema => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: { type: 'object', description: itemDescription } },
    next_cursor: { type: 'string', nullable: true, description: 'Pass as cursor for the next page. null on the last page.' },
  },
  required: ['data'],
})

const paged = { cursor: cursorInput, limit: limitInput }

/** Shared by service_create and service_update so the two cannot drift. */
const publicPorts: JsonSchema = {
  type: 'array',
  description:
    "Web or worker. Raw TCP to publish, alongside any HTTP a web service serves, on the platform's public address, for protocols the HTTP ingress cannot carry, such as SMTP submission. Only ports 465 and 587 are offered. The process listens on container_port (1024 or above) and clients connect to port. A deploy of a service with public ports stops the old run first, because a host port has one owner, so expect a few seconds of refused connections.",
  items: {
    type: 'object',
    properties: { port: { type: 'integer', minimum: 465, maximum: 587, description: '465 or 587.' }, container_port: { type: 'integer', minimum: 1024, maximum: 65535 } },
    required: ['port', 'container_port'],
  },
}

export const OPERATIONS: Operation[] = [
  // ─── identity ──────────────────────────────────────────────────────────
  {
    id: 'whoami',
    group: 'identity',
    method: 'GET',
    path: '/v1/whoami',
    summary: 'Identify the calling credential',
    description:
      'Returns the organisation, the member this key speaks as, its scopes, its capability flags, and, for an agent key, its budget and expiry. Call this first: a key resolves to a member and cannot exceed what that member can do, so this tells you your real ceiling before you plan anything.',
    output: ok('The calling identity and its limits.', {
      organization: { type: 'object' },
      member: { type: 'object' },
      key: { type: 'object', description: 'Scopes, capabilities, budget_remaining_usd and expires_at where applicable.' },
      is_ephemeral: { type: 'boolean', description: 'true for an unclaimed trial workspace. Ephemeral workspaces expire; claim yours to keep it.' },
    }),
    scopes: ['product:read'],
  },

  // ─── product ───────────────────────────────────────────────────────────
  {
    id: 'product_list',
    group: 'product',
    method: 'GET',
    path: '/v1/products',
    summary: 'List Products',
    description:
      'Every Product in the organisation this key belongs to, newest first. Returns a summary per Product (id, name, region, environments and health), not the full graph; call product_get for that. A key confined to a single Product sees only that one.',
    input: { type: 'object', properties: paged },
    output: list('A Product with its id, name, region, environments and health.'),
    scopes: ['product:read'],
  },
  {
    id: 'product_create',
    group: 'product',
    method: 'POST',
    path: '/v1/products',
    summary: 'Create a Product',
    description:
      'A Product is the unit everything else hangs from: environments, services, databases, auth, storage, domains, secrets and context. Creating one provisions nothing billable on its own: it is the empty graph. Pass external_ref to make this idempotent against your own identifiers.',
    input: withMutationControls({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable. Shown in the dashboard and used to derive the default subdomain.' },
        region,
        external_ref: { type: 'string', description: 'Your own stable id for this Product. Creating twice with the same value returns the existing Product rather than a second one.' },
        repo: { type: 'string', description: 'Optional git URL. When given, Helm7 inspects it and proposes a service and resource shape you can apply.' },
      },
      required: ['name'],
    }),
    output: planOutput,
    scopes: ['product:write'],
    dryRunnable: true,
  },
  {
    id: 'product_get',
    group: 'product',
    method: 'GET',
    path: '/v1/products/:productId',
    summary: 'Inspect a Product',
    description:
      'The whole resource graph for one Product: environments, services, databases, domains, secrets (names only, never values), context linkage and current health. This is the single call to make before reasoning about a Product.',
    input: { type: 'object', properties: { productId }, required: ['productId'] },
    output: ok('The Product and its full resource graph.'),
    scopes: ['product:read'],
  },
  {
    id: 'product_update',
    group: 'product',
    method: 'PATCH',
    path: '/v1/products/:productId',
    summary: 'Rename a Product',
    description:
      'Changes the name a Product is shown under: the dashboard, the sender name on its auth emails and the activity trail. Addresses do not change. Its helm7.app hostnames, image names and ids stay exactly as they were, so nothing already deployed or pointed at it moves. A Contextely product created by context_enable keeps the name it was given then.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, name: { type: 'string', description: 'The new name. Up to 64 characters.' } },
      required: ['productId', 'name'],
    }),
    output: planOutput,
    scopes: ['product:write'],
    dryRunnable: true,
  },
  {
    id: 'product_delete',
    group: 'product',
    method: 'DELETE',
    path: '/v1/products/:productId',
    summary: 'Delete a Product and everything in it',
    description:
      'Destroys every environment, service, database, bucket and domain binding under the Product. Databases are backed up first and the backup is retained for 7 days, but the running resources are gone. Requires confirm: true; without it you get the plan and nothing happens.',
    input: withMutationControls({ type: 'object', properties: { productId }, required: ['productId'] }),
    output: planOutput,
    // No capability gate. Deleting a Product you own is an ordinary operation,
    // guarded by the `product:delete` scope and by `confirm: true`;
    // may_administer is for organisation-level actions such as minting keys,
    // and requiring it here left a trial workspace unable to tidy up after
    // itself — which teaches an agent that capabilities are arbitrary.
    scopes: ['product:delete'],
    destructive: true,
    dryRunnable: true,
  },

  // ─── environment ───────────────────────────────────────────────────────
  {
    id: 'environment_list',
    group: 'environment',
    method: 'GET',
    path: '/v1/products/:productId/environments',
    summary: 'List environments',
    description:
      'Environments in a Product, each with a summary of the services, databases and domains bound to it. Every Product has production; preview and development exist only if created. Use this to find an environment name before calling anything scoped to one.',
    input: { type: 'object', properties: { productId }, required: ['productId'] },
    output: list('An environment and its resource summary.'),
    scopes: ['product:read'],
  },
  {
    id: 'environment_create',
    group: 'environment',
    method: 'POST',
    path: '/v1/products/:productId/environments',
    summary: 'Create an environment',
    description:
      'Adds preview or development alongside production. A new environment starts empty; it does not copy production data. Use database_branch for that, when you want a copy.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, name: standardEnvironmentName },
      required: ['productId', 'name'],
    }),
    output: planOutput,
    scopes: ['product:write'],
    dryRunnable: true,
    costImpacting: true,
  },
  {
    id: 'environment_delete',
    group: 'environment',
    method: 'DELETE',
    path: '/v1/products/:productId/environments/:environment',
    summary: 'Delete an environment and everything in it',
    description:
      'Stops every service in a preview or development environment and removes its databases, buckets, domains and variables. Production cannot be deleted this way; delete the Product instead. Requires confirm: true.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, environment: { ...environmentName, description: 'preview, development or a pull request preview (pr-<number>). Production is refused.' } },
      required: ['productId', 'environment'],
    }),
    output: planOutput,
    scopes: ['product:delete'],
    destructive: true,
    dryRunnable: true,
  },

  // ─── service ───────────────────────────────────────────────────────────
  {
    id: 'service_create',
    group: 'service',
    method: 'POST',
    path: '/v1/products/:productId/services',
    summary: 'Create a service',
    description:
      'Adds a web, worker or cron service. Helm7 detects the framework from the repo and picks a build; you only need to override when detection is wrong. A service has no execution time limit, so long jobs do not need splitting.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        name: { type: 'string' },
        kind: serviceKind,
        environment: environmentName,
        repo: { type: 'string', description: 'Git URL. Required unless image is given.' },
        branch: { type: 'string', default: 'main' },
        root_directory: { type: 'string', description: 'Subdirectory to build from, for monorepos.' },
        build_only_on_changes: { type: 'boolean', default: false, description: 'With root_directory: skip a push-triggered build when the push changed nothing under it. See service_update.' },
        image: { type: 'string', description: 'Container image reference, as an alternative to building from a repo.' },
        schedule: { type: 'string', description: 'Cron expression. Required when kind is cron, ignored otherwise.' },
        public_ports: publicPorts,
        path: { type: 'string', description: 'Cron only. A path on one of your web services, such as /api/cron/digest. The cron then calls it on the schedule instead of running a container: no repo or image, nothing to build. The call is made from inside that service, so it does not cross the public internet or time out at 100 seconds, and it carries Authorization: Bearer $CRON_SECRET (created for the environment if it has none).' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET', description: 'Cron with a path only.' },
        target: { type: 'string', description: 'Cron with a path only. The name of the web service to call. Defaults to the only web service, or the one called web.' },
        instance: {
          type: 'string', enum: ['shared-0.25', 'shared-0.5', 'standard-1', 'standard-2'], default: 'shared-0.25',
          description: 'vCPU allocation. shared tiers sleep when idle and wake on request in a few seconds; standard tiers stay running.',
        },
      },
      required: ['productId', 'name', 'kind'],
    }),
    output: planOutput,
    scopes: ['product:write', 'deployment:write'],
    dryRunnable: true,
    costImpacting: true,
    requiresCapability: 'may_deploy',
  },
  {
    id: 'service_logs',
    group: 'service',
    method: 'GET',
    path: '/v1/products/:productId/services/:serviceId/logs',
    summary: 'Read runtime logs',
    description:
      'Recent stdout and stderr for a service. Secrets are redacted on a best-effort basis before the logs leave the platform; treat redaction as a safety net, not a guarantee.',
    input: {
      type: 'object',
      properties: {
        productId, serviceId: { type: 'string' },
        since: { type: 'string', format: 'date-time' },
        limit: limitInput,
      },
      required: ['productId', 'serviceId'],
    },
    output: list('A log line with its timestamp, stream and text.'),
    scopes: ['deployment:read'],
  },
  {
    id: 'service_list',
    group: 'service',
    method: 'GET',
    path: '/v1/products/:productId/services',
    summary: 'List services',
    description:
      'Every service in a Product with its kind, instance size, whether it sleeps, its status, the deployment it is running and the address it answers on. Filter by environment. Use this to find a service id before reading its logs or changing it.',
    input: { type: 'object', properties: { productId, environment: environmentName }, required: ['productId'] },
    output: list('A service with its status, current deployment and address.'),
    scopes: ['product:read'],
  },
  {
    id: 'service_update',
    group: 'service',
    method: 'PATCH',
    path: '/v1/products/:productId/services/:serviceId',
    summary: 'Change how a service runs',
    description:
      'Changes the instance size, the repository, branch or directory it builds from, whether pushes that miss that directory skip the build, the image, the schedule of a cron service, or pauses it. Size and pause take effect at once on a running service; source changes take effect on the next deploy. Returns a costed plan, because a bigger instance costs more.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        serviceId: { type: 'string', description: 'Service identifier, e.g. svc_...' },
        instance: { type: 'string', enum: ['shared-0.25', 'shared-0.5', 'standard-1', 'standard-2'] },
        repo: { type: 'string', description: 'Git URL to build from. Use it after a repository is renamed or moved: the clone token is only minted for repositories the Product\'s GitHub installation lists, so a service still on the old URL stops cloning. Takes effect on the next deploy.' },
        branch: { type: 'string' },
        root_directory: { type: 'string', nullable: true },
        build_only_on_changes: { type: 'boolean', description: 'Skip a push-triggered build when the push changed nothing under root_directory. Needs a root_directory. Builds anyway when the push cannot be read, or changes a root lockfile, package.json or Dockerfile. Off by default, because a build uses the whole clone and a service that imports from outside its folder would go stale. Skips are recorded in activity_list and returned by the webhook.' },
        image: { type: 'string', nullable: true },
        schedule: { type: 'string', description: 'Cron expression, for cron services only.' },
        path: { type: 'string', description: 'For a cron that calls a web service: the path to call.' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'For a cron that calls a web service: the HTTP method.' },
        target: { type: 'string', description: 'For a cron that calls a web service: the name of the web service to call.' },
        public_ports: publicPorts,
        paused: { type: 'boolean', description: 'true stops the service and keeps its configuration; false starts it again on its last deployment.' },
      },
      required: ['productId', 'serviceId'],
    }),
    output: planOutput,
    scopes: ['product:write', 'deployment:write'],
    dryRunnable: true,
    costImpacting: true,
  },
  {
    id: 'service_delete',
    group: 'service',
    method: 'DELETE',
    path: '/v1/products/:productId/services/:serviceId',
    summary: 'Delete a service',
    description:
      'Stops the service and removes it with its deployment history. Domains pointing at it are detached. Databases and variables in the environment are not touched. Requires confirm: true.',
    input: withMutationControls({ type: 'object', properties: { productId, serviceId: { type: 'string', description: 'Service identifier, e.g. svc_...' } }, required: ['productId', 'serviceId'] }),
    output: planOutput,
    scopes: ['product:delete'],
    destructive: true,
    dryRunnable: true,
  },

  // ─── deployment ────────────────────────────────────────────────────────
  {
    id: 'deploy',
    group: 'deployment',
    method: 'POST',
    path: '/v1/products/:productId/deployments',
    summary: 'Build and deploy',
    description:
      'Builds the current commit and swaps traffic to it once health checks pass. The previous deployment is kept and can be restored with deployment_rollback. Returns immediately with a deployment id; poll deployment_get for progress. Through MCP a build from a repository is built on your own machine by default, so it never waits in Helm7\'s build queue: nothing builds until you run the `local_build.command` in the response (the CLI builds, uploads and starts it) in a shell with Docker and the repository. If you have no shell or Docker, call deploy again with `build: "remote"`, which replaces it and builds on Helm7 (use build_queue_get to see how long the queue is).',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        environment: environmentName,
        service_id: { type: 'string', description: 'Omit to deploy every service in the environment.' },
        commit: { type: 'string', description: 'Git SHA. Defaults to the branch tip.' },
        build: {
          type: 'string',
          enum: ['local', 'remote'],
          description:
            "Where the image is built. `remote` waits its turn in Helm7's build queue. `local` is built on your own machine and uploaded, so it never waits: the response names the image to build and deployment_image_upload takes it (the CLI does all of this). Omit it to use the default: local through MCP, otherwise the workspace setting (which falls back to remote when the caller cannot build locally).",
        },
        can_build_locally: {
          type: 'boolean',
          default: false,
          description: 'Set by clients that have Docker and the source to hand (the CLI does). With `build` omitted, the workspace default of local only applies when this is true.',
        },
        wait: {
          type: 'boolean',
          default: false,
          description: 'Wait for the build and the swap to finish before returning. Off by default: a build can take minutes, and deployment_get follows it as it runs.',
        },
      },
      required: ['productId'],
    }),
    output: planOutput,
    scopes: ['deployment:write'],
    dryRunnable: true,
    costImpacting: true,
    requiresCapability: 'may_deploy',
  },
  {
    id: 'deployment_get',
    group: 'deployment',
    method: 'GET',
    path: '/v1/products/:productId/deployments/:deploymentId',
    summary: 'Inspect a deployment',
    description:
      'Status, timing, commit, build logs and, when a deployment failed, the specific reason, extracted rather than left for you to find in the log tail.',
    input: {
      type: 'object',
      properties: {
        productId,
        deploymentId: { type: 'string' },
        build_log_after: {
          type: 'integer',
          minimum: 0,
          description: 'Return only build log lines after this sequence number. Pass back the last seq you saw to follow a build as it runs.',
        },
      },
      required: ['productId', 'deploymentId'],
    },
    output: ok('The deployment, its status and its failure reason where one exists.'),
    scopes: ['deployment:read'],
  },
  {
    id: 'deployment_list',
    group: 'deployment',
    method: 'GET',
    path: '/v1/products/:productId/deployments',
    summary: 'List deployments',
    description:
      'Deployment history for a Product, newest first, with status, commit and timing for each. History is immutable and nothing is pruned, so this is the reliable way to find the last deployment that was healthy before rolling back to it.',
    input: { type: 'object', properties: { productId, environment: environmentName, ...paged }, required: ['productId'] },
    output: list('A deployment with its status, commit and timing.'),
    scopes: ['deployment:read'],
  },
  {
    id: 'deployment_rollback',
    group: 'deployment',
    method: 'POST',
    path: '/v1/products/:productId/deployments/:deploymentId/rollback',
    summary: 'Roll back to a previous deployment',
    description:
      'Moves traffic back to an earlier deployment. The image already exists, so this is a traffic swap and takes seconds. It does not revert database migrations. If the newer deployment migrated the schema, roll that back yourself first.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, deploymentId: { type: 'string' } },
      required: ['productId', 'deploymentId'],
    }),
    output: planOutput,
    scopes: ['deployment:write'],
    dryRunnable: true,
    requiresCapability: 'may_deploy',
  },

  {
    id: 'build_queue_get',
    group: 'deployment',
    method: 'GET',
    path: '/v1/build-queue',
    summary: 'Where your builds are in the queue',
    description:
      "Your workspace's builds that are running or waiting for a build slot, in the order they will run, with each one's place in the whole queue and how many builds start before it. Builds from other workspaces are counted but never named. Higher plans start ahead of lower ones, by a head start that is reported as head_start_minutes. typical_build_seconds is the median of your recent builds, or null until you have some. A deploy that builds on your own machine never appears here.",
    output: ok('Your running and waiting builds with their positions, and the size of the queue.'),
    scopes: ['deployment:read'],
  },
  {
    id: 'build_queue_reorder',
    group: 'deployment',
    method: 'POST',
    path: '/v1/build-queue/order',
    summary: 'Reorder your waiting builds',
    description:
      "Puts your own waiting builds in a new order. The ids you list run first, in that order; your other waiting builds follow in the order they already had. It only rearranges the places your workspace already holds in the queue, so it can never put a build ahead of another workspace's, and your earliest place stays your earliest place. A build that has started cannot be moved: it is reported as not waiting. Returns the queue as it stands afterwards.",
    input: withMutationControls({
      type: 'object',
      properties: {
        deployment_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Deployment ids from build_queue_get, in the order you want them to run. Naming one id runs that build first.',
        },
      },
      required: ['deployment_ids'],
    }),
    output: planOutput,
    scopes: ['deployment:write'],
    dryRunnable: true,
    requiresCapability: 'may_deploy',
  },

  {
    id: 'deployment_image_upload',
    group: 'deployment',
    method: 'POST',
    path: '/v1/products/:productId/deployments/:deploymentId/image',
    summary: 'Upload a locally built image',
    description:
      'Adds one chunk of a `docker save` archive to a deployment that was started with a local build. Chunks go in order: `offset` must equal what has been received so far, which makes a retry after a dropped connection safe, and the response says how many bytes are held. Finish with deployment_image_finish. The CLI does this for you.',
    input: {
      type: 'object',
      properties: {
        productId,
        deploymentId: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: 'Bytes already uploaded. Start at 0.' },
        data: { type: 'string', description: 'This chunk, base64-encoded. Keep each chunk to the chunk_bytes the deploy returned.' },
      },
      required: ['productId', 'deploymentId', 'offset', 'data'],
    },
    output: ok('How many bytes of the image are held.'),
    scopes: ['deployment:write'],
    requiresCapability: 'may_deploy',
  },
  {
    id: 'deployment_image_finish',
    group: 'deployment',
    method: 'POST',
    path: '/v1/products/:productId/deployments/:deploymentId/image/finish',
    summary: 'Deploy a locally built image',
    description:
      'Checks the uploaded archive against the size and sha256 you give, loads it onto the region and starts the deployment from it. It goes live the same way a remote build does: traffic moves once the new run is healthy. Poll deployment_get for progress.',
    input: {
      type: 'object',
      properties: {
        productId,
        deploymentId: { type: 'string' },
        size: { type: 'integer', minimum: 1, description: 'Total bytes uploaded.' },
        sha256: { type: 'string', description: 'Hex sha256 of the whole archive, so a damaged upload is refused rather than run.' },
        commit: { type: 'string', description: 'The git SHA the image was built from, shown beside the deployment.' },
      },
      required: ['productId', 'deploymentId', 'size', 'sha256'],
    },
    output: ok('The deployment, now starting.'),
    scopes: ['deployment:write'],
    requiresCapability: 'may_deploy',
  },

  // ─── database ──────────────────────────────────────────────────────────
  {
    id: 'database_create',
    group: 'database',
    method: 'POST',
    path: '/v1/products/:productId/databases',
    summary: 'Provision Postgres',
    description:
      'Creates a Postgres database, at the major version the region runs, with pgvector available, and sets DATABASE_URL on the environment. Connections are pooled; use the pooled URL for serverless-style workloads and the direct URL for migrations.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        environment: environmentName,
        name: { type: 'string', default: 'primary' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Extensions to enable, e.g. ["pgvector"]. pgcrypto and uuid-ossp are always on.' },
      },
      required: ['productId'],
    }),
    output: planOutput,
    scopes: ['database:write'],
    dryRunnable: true,
    costImpacting: true,
  },
  {
    id: 'database_get',
    group: 'database',
    method: 'GET',
    path: '/v1/products/:productId/databases/:databaseId',
    summary: 'Inspect a database',
    description:
      'Size, extensions, connection counts and backup state. Connection strings are returned only to a key carrying database:read, and the password is shown only on creation.',
    input: { type: 'object', properties: { productId, databaseId: { type: 'string' } }, required: ['productId', 'databaseId'] },
    output: ok('The database and its current state.'),
    scopes: ['database:read'],
  },
  {
    id: 'database_backup',
    group: 'database',
    method: 'POST',
    path: '/v1/products/:productId/databases/:databaseId/backups',
    summary: 'Take a backup now',
    description:
      'Takes a backup now, on top of the daily ones paid plans get. Kept 7 days. Returns a backup id usable with database_restore.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, databaseId: { type: 'string' } },
      required: ['productId', 'databaseId'],
    }),
    output: planOutput,
    scopes: ['database:write'],
    dryRunnable: true,
  },
  {
    id: 'database_restore',
    group: 'database',
    method: 'POST',
    path: '/v1/products/:productId/databases/:databaseId/restore',
    summary: 'Restore to a point in time',
    description:
      'Restores from a backup id or to a timestamp. This REPLACES the current database contents: everything written after the restore point is lost. Requires confirm: true. Restore into a fresh database first if you are not certain.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId, databaseId: { type: 'string' },
        backup_id: { type: 'string' },
        point_in_time: { type: 'string', format: 'date-time', description: 'Alternative to backup_id. Must fall inside the retention window.' },
        into_new_database: { type: 'boolean', default: false, description: 'Restore alongside rather than over the top. Strongly preferred when you are unsure.' },
      },
      required: ['productId', 'databaseId'],
    }),
    output: planOutput,
    scopes: ['database:write'],
    destructive: true,
    dryRunnable: true,
  },
  {
    id: 'database_query',
    group: 'database',
    method: 'POST',
    path: '/v1/products/:productId/databases/:databaseId/query',
    summary: 'Read rows with SQL',
    description:
      "Runs one read-only SQL statement (SELECT, WITH, VALUES or TABLE) against a Product's database and returns the rows as JSON. It runs as the Product's own database role inside a READ ONLY transaction with a 15 second timeout, so it cannot change anything and cannot see another Product's data. At most `limit` rows come back (default 100, maximum 1000); `truncated` says whether there were more. Use it to inspect schema (information_schema.columns) and data before deciding on a change, then database_execute to change it. Reads are not audited.",
    input: {
      type: 'object',
      properties: {
        productId,
        databaseId: { type: 'string' },
        sql: { type: 'string', description: 'One statement. A trailing semicolon is fine; a second statement is refused.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Most rows to return.' },
      },
      required: ['productId', 'databaseId', 'sql'],
    },
    output: ok('The rows, and whether the limit cut them short.', {
      rows: { type: 'array', items: { type: 'object' } },
      row_count: { type: 'integer' },
      truncated: { type: 'boolean' },
    }),
    scopes: ['database:read'],
    readOnly: true,
  },
  {
    id: 'database_execute',
    group: 'database',
    method: 'POST',
    path: '/v1/products/:productId/databases/:databaseId/execute',
    summary: 'Change data or schema with SQL',
    description:
      "Runs a SQL script (INSERT, UPDATE, DELETE, DDL, several statements) against a Product's database as the Product's own database role, in one transaction: if any statement fails nothing is kept. `dry_run: true` really runs the script and then rolls it back, so you learn whether it would succeed and, through a final SELECT or a RETURNING clause, what it would produce, without changing anything. Applying requires `confirm: true` because a bad UPDATE cannot be undone: take a database_backup first when the change is large. Row counts are not reported; end with a RETURNING clause or a SELECT count(*) when you need one. Transaction control (BEGIN, COMMIT, ROLLBACK, SAVEPOINT) is refused because the script already is one transaction. The first 500 characters of the SQL are kept in the audit trail, so keep secrets out of it; use secret_set for those.",
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        databaseId: { type: 'string' },
        sql: { type: 'string', description: 'One or more statements separated by semicolons. If the last returns rows (SELECT, or anything with RETURNING) they come back in `rows`.' },
      },
      required: ['productId', 'databaseId', 'sql'],
    }),
    output: planOutput,
    scopes: ['database:write'],
    destructive: true,
    dryRunnable: true,
  },

  // ─── auth ──────────────────────────────────────────────────────────────
  {
    id: 'auth_enable',
    group: 'auth',
    method: 'POST',
    path: '/v1/products/:productId/auth',
    summary: 'Enable managed auth',
    description:
      'Starts a GoTrue auth service (the engine behind Supabase Auth) against the Product database, on its own hostname, and sets AUTH_URL, AUTH_ANON_KEY, AUTH_SERVICE_ROLE_KEY, AUTH_JWT_SECRET and AUTH_SITE_URL on the environment. supabase-js and @supabase/ssr work against it unchanged: pass AUTH_URL (an origin, no path) and AUTH_ANON_KEY. Sign-in email goes out through Helm7, so nothing needs configuring for it. Calling it again on an environment whose auth is recorded but not running starts the missing container and keeps every key already in use; it never rotates a key. The record only reads available once the container passes its health check.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        environment: environmentName,
        providers: { type: 'array', items: { type: 'string' }, default: ['email'], description: 'email, and google or github once you have set their credentials with auth_update.' },
        site_url: { type: 'string', description: 'Where auth redirects land. Defaults to the environment primary domain.' },
      },
      required: ['productId'],
    }),
    output: planOutput,
    scopes: ['product:write'],
    dryRunnable: true,
    costImpacting: true,
  },
  {
    id: 'auth_get',
    group: 'auth',
    method: 'GET',
    path: '/v1/products/:productId/auth',
    summary: 'Inspect managed auth',
    description:
      'The state of the auth service for one environment: whether its container is healthy right now, the URL apps use, its non-secret configuration, and how many users and identities it holds. The counts are how a migration proves every user arrived. No secret, key or password hash is ever returned; secret_list shows which variables exist.',
    input: { type: 'object', properties: { productId, environment: environmentName }, required: ['productId'] },
    output: ok('The auth service, its URL, configuration and user counts.', {
      status: { type: 'string', description: 'available only while the container passes its health check; otherwise provisioning, unhealthy or stopped, with the reason in health.' },
      url: { type: 'string', description: 'The origin apps pass as the Supabase URL. GoTrue answers at {url}/auth/v1 and at {url}.' },
      users: { type: 'object', description: 'count and identities: rows in the auth schema of the Product database.' },
    }),
    scopes: ['product:read'],
  },
  {
    id: 'auth_update',
    group: 'auth',
    method: 'PATCH',
    path: '/v1/products/:productId/auth',
    summary: 'Configure managed auth',
    description:
      'Changes how the auth service behaves: the site URL and the allow-list of redirect URLs, whether email needs confirming, whether new sign-ups are closed, whether anonymous sign-ins are allowed, which OAuth providers are on (Google and GitHub, with their client id and secret, stored as secrets and never returned), the minimum password length, how long access tokens last and how refresh tokens rotate. Only the fields you send change. The service restarts on the new settings with the old one serving until the new one is healthy. Signed-in users are not signed out. A field this operation does not have is refused by name, not ignored.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        environment: environmentName,
        site_url: { type: 'string', description: 'Where auth redirects land by default, and the base for links in emails.' },
        additional_redirect_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Every URL an app may ask auth to redirect to, beyond site_url. Patterns are allowed, e.g. https://*.example.com/**. Replaces the list.',
        },
        email_autoconfirm: { type: 'boolean', description: 'true signs people in without confirming their email. Leave it off unless the app confirms addresses itself.' },
        disable_signup: { type: 'boolean', description: 'true refuses new sign-ups. Existing users, and users you invite, still get in.' },
        anonymous_sign_ins: { type: 'boolean', description: 'true lets anyone create an anonymous user with an empty POST /auth/v1/signup (supabase.auth.signInAnonymously()), which they can later upgrade to a real account with updateUser. Anyone on the internet can do this, so put CAPTCHA and rate limiting in your app; auth limits it to 30 an hour per address. Default false.' },
        external: {
          type: 'object',
          description: 'OAuth providers. Send client_secret only when it changes; it is stored as a secret and cannot be read back. The redirect URI to register with the provider is {AUTH_URL}/auth/v1/callback.',
          properties: {
            google: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                client_id: { type: 'string' },
                client_secret: { type: 'string', description: 'Write-only.' },
              },
            },
            github: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                client_id: { type: 'string' },
                client_secret: { type: 'string', description: 'Write-only.' },
              },
            },
          },
        },
        password_min_length: { type: 'integer', minimum: 6, maximum: 72, description: 'Six is GoTrue’s floor and 72 is bcrypt’s ceiling.' },
        jwt_expiry_seconds: { type: 'integer', minimum: 300, maximum: 604800, description: 'How long an access token lasts. Default 3600.' },
        refresh_token_rotation: { type: 'boolean', description: 'Each refresh issues a new refresh token and retires the old one. On by default, and worth keeping on.' },
        refresh_token_reuse_interval_seconds: { type: 'integer', minimum: 0, maximum: 300, description: 'How long a just-used refresh token may be presented again, so two tabs refreshing together do not sign the user out. Default 10.' },
        public_hostname: { type: 'string', description: 'Which hostname AUTH_URL names: the default one, or a custom domain attached to the auth service. Changing it changes the redirect URI OAuth providers must have registered.' },
      },
      required: ['productId'],
    }),
    output: planOutput,
    scopes: ['product:write'],
    dryRunnable: true,
  },
  {
    id: 'auth_users_import',
    group: 'auth',
    method: 'POST',
    path: '/v1/products/:productId/auth/users/import',
    summary: 'Import users into managed auth',
    description:
      'Upserts a batch of users, with their provider identities, into the auth schema of the Product database, keeping each id, email, password hash, confirmation time, timestamps and metadata, so nobody has to reset a password. Hashes must be bcrypt ($2a$, $2b$, $2y$) or argon2 ($argon2i$, $argon2id$); scrypt and anything else is refused, naming the row. Idempotent on id: running a batch twice changes nothing the second time. Up to 200 users per call. Hashes are never logged and never returned; the response carries counts only. Compare them with auth_get to verify a migration.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        environment: environmentName,
        users: {
          type: 'array',
          description: 'Field names follow the auth.users columns, so an export from a Supabase or GoTrue database maps straight across.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid', description: 'Kept as is. Your own tables reference it.' },
              email: { type: 'string', description: 'Required, unless is_anonymous.' },
              encrypted_password: { type: 'string', description: 'bcrypt or argon2 hash. Omit for a user who signs in only through a provider or a link.' },
              email_confirmed_at: { type: 'string', format: 'date-time', nullable: true },
              phone: { type: 'string' },
              is_anonymous: { type: 'boolean', description: 'An anonymous user, as signInAnonymously() makes. Has no email, password or identities; email may be left out.' },
              created_at: { type: 'string', format: 'date-time' },
              updated_at: { type: 'string', format: 'date-time' },
              last_sign_in_at: { type: 'string', format: 'date-time', nullable: true },
              banned_until: { type: 'string', format: 'date-time', nullable: true },
              raw_user_meta_data: { type: 'object', description: 'What the user may edit: name, avatar and the like.' },
              raw_app_meta_data: { type: 'object', description: 'What only the server may set. Defaults to the providers of the identities given.' },
              identities: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string', enum: ['email', 'google', 'github'] },
                    provider_id: { type: 'string', description: 'The provider’s id for the person. For email it is the user id, and is filled in when omitted.' },
                    identity_data: { type: 'object' },
                    created_at: { type: 'string', format: 'date-time' },
                    last_sign_in_at: { type: 'string', format: 'date-time', nullable: true },
                  },
                  required: ['provider'],
                },
              },
            },
            required: ['id'],
          },
        },
      },
      required: ['productId', 'users'],
    }),
    output: planOutput,
    scopes: ['database:write'],
    dryRunnable: true,
  },

  // ─── storage ───────────────────────────────────────────────────────────
  {
    id: 'storage_create_bucket',
    group: 'storage',
    method: 'POST',
    path: '/v1/products/:productId/storage/buckets',
    summary: 'Create a storage bucket',
    description:
      'S3-compatible object storage with no egress charge. The API is Supabase Storage compatible, so supabase-js storage calls work unchanged.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId, environment: environmentName,
        name: { type: 'string' },
        public: { type: 'boolean', default: false, description: 'Public buckets serve objects without a signed URL. Default is private.' },
      },
      required: ['productId', 'name'],
    }),
    output: planOutput,
    scopes: ['product:write'],
    dryRunnable: true,
    costImpacting: true,
  },
  {
    id: 'bucket_list',
    group: 'storage',
    method: 'GET',
    path: '/v1/products/:productId/storage/buckets',
    summary: 'List storage buckets',
    description:
      'Buckets in a Product, each with its environment, whether it is public, its size and the S3-compatible name to address it by. Objects themselves are listed through the S3 API, not here.',
    input: { type: 'object', properties: { productId, environment: environmentName }, required: ['productId'] },
    output: list('A bucket with its visibility and size.'),
    scopes: ['product:read'],
  },
  {
    id: 'bucket_delete',
    group: 'storage',
    method: 'DELETE',
    path: '/v1/products/:productId/storage/buckets/:bucketId',
    summary: 'Delete a storage bucket and every object in it',
    description: 'Removes the bucket and everything stored in it. There is no recycle bin. Requires confirm: true.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, bucketId: { type: 'string', description: 'Bucket identifier, e.g. bkt_...' } },
      required: ['productId', 'bucketId'],
    }),
    output: planOutput,
    scopes: ['product:delete'],
    destructive: true,
    dryRunnable: true,
  },

  // ─── domain ────────────────────────────────────────────────────────────
  {
    id: 'domain_attach',
    group: 'domain',
    method: 'POST',
    path: '/v1/products/:productId/domains',
    summary: 'Attach a custom domain',
    description:
      'Binds a domain to a web service and issues a certificate. Returns the DNS record to create; the certificate is issued once that record resolves, usually within a minute. Until then the domain is listed as pending, which is not an error. A name under a domain (app.example.com, www.example.com) takes a CNAME. A bare domain (example.com) takes an A record to a fixed address and, by default, redirects to www.example.com, which is attached with it if it is not already; this works at any DNS provider. Pass serve: true to answer on the bare domain itself instead of redirecting, for a site whose address people know without the www, or a webhook or API that calls it (a redirect drops the body of a POST for clients that do not follow it).',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId, environment: environmentName,
        hostname: { type: 'string', description: 'Fully qualified, e.g. app.example.com or example.com.' },
        service_id: { type: 'string', description: 'A web service id, or the id of the auth service (aut_...) to give auth its own domain. Defaults to the environment\'s only web service when there is exactly one.' },
        serve: { type: 'boolean', default: false, description: 'Bare domains only. Answer on the bare domain itself instead of redirecting to www. www is still attached with it.' },
      },
      required: ['productId', 'hostname'],
    }),
    output: planOutput,
    scopes: ['domain:write'],
    dryRunnable: true,
    costImpacting: true,
  },
  {
    id: 'domain_list',
    group: 'domain',
    method: 'GET',
    path: '/v1/products/:productId/domains',
    summary: 'List domains',
    description: 'Domains bound to a Product, with certificate status and the DNS record each one expects.',
    input: { type: 'object', properties: { productId }, required: ['productId'] },
    output: list('A domain with its verification and certificate status.'),
    scopes: ['domain:read'],
  },
  {
    id: 'domain_remove',
    group: 'domain',
    method: 'DELETE',
    path: '/v1/products/:productId/domains/:domainId',
    summary: 'Remove a domain',
    description: 'Unbinds the domain and revokes its certificate. Traffic to it stops immediately. Requires confirm: true.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, domainId: { type: 'string' } },
      required: ['productId', 'domainId'],
    }),
    output: planOutput,
    scopes: ['domain:write'],
    destructive: true,
    dryRunnable: true,
  },

  // ─── secret ────────────────────────────────────────────────────────────
  {
    id: 'secret_set',
    group: 'secret',
    method: 'POST',
    path: '/v1/products/:productId/secrets',
    summary: 'Set an environment variable',
    description:
      'Sets or replaces a variable for an environment. Values are encrypted at rest and are never returned by any read endpoint, including this one. Only names and a fingerprint come back. Services pick up the change on their next deployment.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId, environment: environmentName,
        key: { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' },
        value: { type: 'string' },
      },
      required: ['productId', 'key', 'value'],
    }),
    output: planOutput,
    scopes: ['secret:write'],
    dryRunnable: true,
  },
  {
    id: 'secret_list',
    group: 'secret',
    method: 'GET',
    path: '/v1/products/:productId/secrets',
    summary: 'List secret names',
    description:
      'Names, environments and fingerprints. Values are never returned. There is no endpoint that returns them, by design, so a leaked read key cannot exfiltrate credentials.',
    input: { type: 'object', properties: { productId, environment: environmentName }, required: ['productId'] },
    output: list('A secret name with its environment and value fingerprint.'),
    scopes: ['secret:read'],
  },
  {
    id: 'secret_delete',
    group: 'secret',
    method: 'DELETE',
    path: '/v1/products/:productId/secrets/:key',
    summary: 'Remove an environment variable',
    description:
      'Removes a variable from one environment. Running services keep the value until their next deploy. The value cannot be recovered, which is why this requires confirm: true.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, key: { type: 'string', description: 'Variable name, e.g. STRIPE_SECRET_KEY.' }, environment: environmentName },
      required: ['productId', 'key'],
    }),
    output: planOutput,
    scopes: ['secret:write'],
    destructive: true,
    dryRunnable: true,
  },

  // ─── test accounts ─────────────────────────────────────────────────────
  {
    id: 'test_account_create',
    group: 'test_account',
    method: 'POST',
    path: '/v1/products/:productId/test-accounts',
    summary: 'Create a test account',
    description:
      "Makes a sign-in a tester can use to drive the product's real interface, kept per environment. mode `provision` creates the user in the environment's managed auth: Helm7 generates a strong password, stores only a hash in auth and an encrypted copy of its own, confirms the address, and tags the user (app_metadata.is_test = true, email <label>+helm7test@<domain>) so analytics and revenue views can leave it out. Needs managed auth enabled, so run auth_enable first. mode `external` does the same in the Product's own auth service instead, with auth_provider (today: supabase): Helm7 reads the project URL and admin key from the environment's stored variables (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY), uses them for that one call and never returns them, so a Product whose auth lives elsewhere needs no key handed to the caller. The user is confirmed and tagged app_metadata.is_test; rotate and delete only ever touch a tagged user. mode `register` records an account somebody created elsewhere (a product hosted outside Helm7): send its email and password, and optionally a TOTP seed. Nothing here is ever returned: the password and seed are write-only, and list and get show a fingerprint and whether a seed exists. The one way to read them is test_account_checkout. Pass expires_in (for example 24h or 7d) or expires_at to make the account temporary: once it passes, the account is disabled, its stored secrets are wiped and, for provision, its auth user is removed, within about five minutes. Leave both out for a long-lived account. Test accounts must never pay for anything real; a flow that reaches a live paywall should stop there.",
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        environment: environmentName,
        label: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$', description: 'Lower case letters, digits and hyphens. Names the account and, for provision, its email local part. Unique within the environment.' },
        role: { type: 'string', description: 'What the account is for, in your words: member, admin, free-tier, paid. Shown beside it; Helm7 does not interpret it.' },
        mode: { type: 'string', enum: ['provision', 'external', 'register'], description: 'provision creates the user in managed auth. external creates it in the Product\'s own auth service (see auth_provider). register records an account that already exists.' },
        auth_provider: { type: 'string', enum: ['supabase'], description: 'external only: which auth service holds the Product\'s users.' },
        email: { type: 'string', description: 'register: required. provision: leave out to use <label>+helm7test@<domain>; if given it must still carry the +helm7test tag so it is recognisable as a test user.' },
        password: { type: 'string', description: 'register: required. provision: leave out, Helm7 generates one. Write-only.' },
        totp_secret: { type: 'string', description: 'Base32 seed of the account\'s authenticator app, if it has two-factor sign-in. Helm7 stores it and generates codes with test_account_totp; it does not enrol it anywhere. Write-only.' },
        notes: { type: 'string', description: 'Free text for people, up to 500 characters. Never put a secret here.' },
        expires_in: { type: 'string', pattern: '^[0-9]{1,4}[mhd]$', description: 'Make the account temporary: minutes, hours or days from now, e.g. 90m, 24h, 7d. From 5 minutes to 90 days. Exclusive with expires_at.' },
        expires_at: { type: 'string', format: 'date-time', description: 'Make the account temporary until this moment. Between 5 minutes and 90 days away. Exclusive with expires_in.' },
      },
      required: ['productId', 'label', 'mode'],
    }),
    output: planOutput,
    scopes: ['test_account:write'],
    dryRunnable: true,
  },
  {
    id: 'test_account_list',
    group: 'test_account',
    method: 'GET',
    path: '/v1/products/:productId/test-accounts',
    summary: 'List test accounts',
    description:
      'The test accounts of an environment: label, role, email, mode, a fingerprint of the password, whether a TOTP seed is stored, status (active, expired), when it expires, when it was last checked out and by which run, and when it was last rotated. Never a password, a seed or a code.',
    input: { type: 'object', properties: { productId, environment: environmentName }, required: ['productId'] },
    output: list('A test account, without its secrets.'),
    scopes: ['test_account:read'],
  },
  {
    id: 'test_account_get',
    group: 'test_account',
    method: 'GET',
    path: '/v1/products/:productId/test-accounts/:accountId',
    summary: 'Inspect a test account',
    description:
      'One test account with the same fields as the list: label, role, email, mode, fingerprint, whether it has a TOTP seed, status, expiry, last use and last rotation. Never a password, a seed or a code. Use test_account_checkout to sign in as it.',
    input: { type: 'object', properties: { productId, accountId: testAccountId }, required: ['productId', 'accountId'] },
    output: ok('A test account, without its secrets.'),
    scopes: ['test_account:read'],
  },
  {
    id: 'test_account_rotate',
    group: 'test_account',
    method: 'POST',
    path: '/v1/products/:productId/test-accounts/:accountId/rotate',
    summary: 'Rotate a test account password',
    description:
      'Replaces the password. provision: Helm7 generates a new one and changes it in managed auth too, which also signs out every session the account has. register: send the new password you have set in the product, because Helm7 cannot reach it. The stored TOTP seed is left alone unless totp_secret is sent. Nothing secret is returned; the new fingerprint is. An expired account cannot be rotated.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        accountId: testAccountId,
        password: { type: 'string', description: 'register: required. provision: not accepted, Helm7 generates it. Write-only.' },
        totp_secret: { type: 'string', description: 'Replace the stored TOTP seed. Write-only.' },
      },
      required: ['productId', 'accountId'],
    }),
    output: planOutput,
    scopes: ['test_account:write'],
    dryRunnable: true,
  },
  {
    id: 'test_account_delete',
    group: 'test_account',
    method: 'DELETE',
    path: '/v1/products/:productId/test-accounts/:accountId',
    summary: 'Delete a test account',
    description:
      'Removes the record and its stored secrets and, for a provision account, deletes the user from managed auth along with its sessions. Only a user tagged is_test can be removed this way, so a real customer is never at risk from a wrong id. Requires confirm: true.',
    input: withMutationControls({
      type: 'object',
      properties: { productId, accountId: testAccountId },
      required: ['productId', 'accountId'],
    }),
    output: planOutput,
    scopes: ['test_account:write'],
    destructive: true,
    dryRunnable: true,
  },
  {
    id: 'test_account_checkout',
    group: 'test_account',
    method: 'POST',
    path: '/v1/products/:productId/test-accounts/:accountId/checkout',
    summary: 'Check out a test account to sign in with',
    description:
      "The one operation that returns a test account's secrets: email, password, the current TOTP code if it has a seed and, for a provision account, a real session so the caller need not sign in at all. Meant for whatever signs in to the product, an agent included. Type the values into the sign-in and do not repeat them in your reply or write them to a file. Prefer a short-lived account (expires_in on create) and a short lease. run_ref is required and is written to the activity log with who asked, so every use is traceable to a run. The result is never kept for replay. The checkout is a lease of ttl_seconds (default 900, from 60 to 3600): when it ends, the sessions Helm7 minted for the account are revoked, so a credential that leaks from a finished run stops working quickly. Refused for an expired account.",
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        accountId: testAccountId,
        run_ref: { type: 'string', description: 'What is using the account: a run id, a job name. Up to 200 characters. Recorded in the activity log.' },
        ttl_seconds: { type: 'integer', minimum: 60, maximum: 3600, default: 900, description: 'How long the lease lasts. When it ends the sessions minted for this checkout are revoked.' },
        include_password: { type: 'boolean', default: false, description: 'provision accounts: also return the password. Off by default, since the session is usually enough; turn it on only for a form sign-in. register accounts and a provision account with no session always get it. The request is recorded in the activity log.' },
      },
      required: ['productId', 'accountId', 'run_ref'],
    }),
    output: ok('Email, password, totp_code and session for the account. This response is a credential: do not log it.', {
      email: { type: 'string' },
      password: { type: 'string', description: 'Present for register accounts, when include_password is true, or when no session could be made.' },
      totp_code: { type: 'string', nullable: true, description: 'Six digits, valid for the seconds in totp_valid_for. null when the account has no seed.' },
      session: { type: 'object', nullable: true, description: 'provision only: access_token, refresh_token and expires_at (unix seconds) from a real sign-in. null, with session_error, if auth could not be reached.' },
      lease_expires_at: { type: 'string', format: 'date-time' },
    }),
    scopes: ['test_account:use'],
    dryRunnable: true,
    sensitiveOutput: true,
  },
  {
    id: 'test_account_totp',
    group: 'test_account',
    method: 'POST',
    path: '/v1/products/:productId/test-accounts/:accountId/totp',
    summary: 'Get the current two-factor code',
    description:
      'The current six-digit code for a test account that has a TOTP seed, with the seconds it stays valid. The seed never leaves Helm7, so a caller that needs a fresh code mid-flow asks again rather than holding the seed. Every call stamps the account’s last-used time, and run_ref if given, but is not written to the activity log on its own, because a flow may ask every few seconds; the checkout it follows is. Returns a code and nothing else.',
    input: { type: 'object', properties: { productId, accountId: testAccountId, run_ref: { type: 'string', description: 'What is asking, up to 200 characters. Kept as the account\'s last user.' } }, required: ['productId', 'accountId'] },
    output: ok('A one-time code. Do not log it.', {
      code: { type: 'string' },
      valid_for_seconds: { type: 'integer' },
    }),
    scopes: ['test_account:use'],
    readOnly: true,
    sensitiveOutput: true,
  },

  // ─── context (Contextely) ──────────────────────────────────────────────
  {
    id: 'context_enable',
    group: 'context',
    method: 'POST',
    path: '/v1/products/:productId/context',
    summary: 'Give the Product memory',
    description:
      'Creates a Contextely product scoped to this Helm7 Product and sets its credentials on the environment, so agents operating the application can read and write its context. Memory and sources are private to this Product unless you say otherwise.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        shares_memory: { type: 'boolean', default: false, description: 'Whether other Products in the organisation can read this one\'s memory.' },
        shares_sources: { type: 'boolean', default: false, description: 'Whether connections are pooled with the rest of the organisation.' },
      },
      required: ['productId'],
    }),
    output: planOutput,
    scopes: ['context:write'],
    dryRunnable: true,
    costImpacting: true,
  },

  // ─── billing ───────────────────────────────────────────────────────────
  {
    id: 'usage_get',
    group: 'billing',
    method: 'GET',
    path: '/v1/usage',
    summary: 'Current usage and spend',
    description:
      'This month\'s spend, measured hourly from what actually ran, broken down by Product and resource; the projection to month end at what is running now; what the workspace as it stands would cost over a whole month; and the budget remaining if one is set. Read this before creating anything expensive.',
    input: { type: 'object', properties: { productId: { ...productId, description: 'Narrow to one Product. Omit for the whole organisation.' } } },
    output: ok('Usage, spend to date and month-end projection.'),
    scopes: ['billing:read'],
  },
  {
    id: 'cost_estimate',
    group: 'billing',
    method: 'POST',
    path: '/v1/cost/estimate',
    summary: 'Price a hypothetical shape',
    description:
      'What a given set of resources would cost per month, without creating anything. Use this to choose between shapes before you build one. Free and side-effect-free.',
    input: {
      type: 'object',
      properties: {
        resources: {
          type: 'array',
          description: 'Resources to price, e.g. [{"type":"service","instance":"shared-0.25","always_on":false}].',
          items: { type: 'object' },
        },
        monthly_egress_gb: { type: 'number', default: 0 },
      },
      required: ['resources'],
    },
    output: ok('The estimated monthly cost, itemised, with the largest driver named.'),
    scopes: ['billing:read'],
    readOnly: true,
  },
  {
    id: 'billing_checkout_create',
    group: 'billing',
    method: 'POST',
    path: '/v1/billing/checkout',
    summary: 'Start a Stripe Checkout session',
    description:
      'A hosted Stripe Checkout URL for upgrading the organisation to a paid plan. For an organisation that has never paid, nothing changes yet: the plan updates when Stripe confirms the subscription. For one that already pays, the existing subscription changes plan in place straight away, with no Checkout page.',
    input: withMutationControls({
      type: 'object',
      properties: {
        plan: { type: 'string', enum: ['builder', 'pro', 'scale'], description: 'The plan to subscribe to.' },
        success_url: { type: 'string', description: 'Where Stripe redirects the customer after a completed payment.' },
        cancel_url: { type: 'string', description: 'Where Stripe redirects the customer if they back out.' },
      },
      required: ['plan', 'success_url', 'cancel_url'],
    }),
    output: ok('A Checkout URL to redirect the customer to.', { url: { type: 'string' } }),
    scopes: ['billing:manage'],
    // Not read-only: for an organisation that already pays it changes a live
    // subscription's plan. MCP clients trust readOnlyHint and skip confirmation,
    // so this must stay false.
    readOnly: false,
    dryRunnable: true,
  },
  {
    id: 'billing_portal_create',
    group: 'billing',
    method: 'POST',
    path: '/v1/billing/portal',
    summary: 'Open the billing portal',
    description:
      'A Stripe-hosted page where a person changes plan, updates the card, downloads invoices or cancels. Only for an organisation that has paid before; one that has not starts with billing_checkout_create.',
    input: { type: 'object', properties: { return_url: { type: 'string', description: 'Where to send the person back to.' } }, required: ['return_url'] },
    output: ok('A portal URL to redirect the person to.', { url: { type: 'string' } }),
    scopes: ['billing:manage'],
    readOnly: true,
  },

  // ─── agent ─────────────────────────────────────────────────────────────
  {
    id: 'agent_key_create',
    group: 'agent',
    method: 'POST',
    path: '/v1/agent-keys',
    summary: 'Mint a scoped agent credential',
    description:
      'Creates a key for one agent, with its own scopes, an optional spend cap and an optional expiry. The key can never exceed the scopes of the member minting it, and a key holding may_administer cannot mint another key holding may_administer, which is what makes revoking one mean something. The secret is shown once and never again.',
    input: withMutationControls({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What this agent is for. Shown in the audit trail.' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Intersected with your own scopes. Asking for more than you hold narrows rather than fails.' },
        product_id: { ...productId, description: 'Confine the key to one Product. Omit for the whole organisation. A key cannot choose its own Product at call time, by design.' },
        budget_usd: { type: 'number', description: 'Hard monthly cap. Cost-impacting calls are refused once reached, with code budget_exceeded.' },
        expires_in_hours: { type: 'integer', description: 'Key stops working after this. Prefer a short life and re-mint.' },
        capabilities: { type: 'array', items: { type: 'string', enum: ['may_deploy', 'may_administer', 'may_manage_billing'] }, default: [] },
      },
      required: ['name'],
    }),
    // planOutput, like every other dry-runnable operation: a caller that always
    // plans first must not meet a shape its renderer cannot read. The minted
    // key is added alongside the plan on apply.
    output: planOutput,
    scopes: ['agent:manage'],
    dryRunnable: true,
    requiresCapability: 'may_administer',
  },
  {
    id: 'agent_key_revoke',
    group: 'agent',
    method: 'DELETE',
    path: '/v1/agent-keys/:keyId',
    summary: 'Revoke an agent credential',
    description: 'Stops the key immediately. In-flight requests using it fail. Revocation cannot be undone; mint a new key instead.',
    input: withMutationControls({ type: 'object', properties: { keyId: { type: 'string' } }, required: ['keyId'] }),
    output: planOutput,
    scopes: ['agent:manage'],
    destructive: true,
    dryRunnable: true,
    requiresCapability: 'may_administer',
  },
  {
    id: 'agent_key_list',
    group: 'agent',
    method: 'GET',
    path: '/v1/agent-keys',
    summary: 'List keys',
    description:
      'Every key in the organisation: its name, the first characters of the secret, its scopes and capabilities, the Product it is confined to, its spend against its cap, its expiry and when it was last used. Never the secret. Revoked keys are included, marked as revoked, because the audit trail still names them.',
    input: { type: 'object', properties: { include_revoked: { type: 'boolean', default: false } } },
    output: list('A key, without its secret.'),
    scopes: ['agent:manage'],
  },
  // ─── github ─────────────────────────────────────────────────────────────
  {
    id: 'github_repo_list',
    group: 'github',
    method: 'GET',
    path: '/v1/github/repositories',
    summary: 'List repositories Helm7 can deploy from GitHub',
    description:
      'Repositories the workspace has given the Helm7 GitHub App access to, most recently pushed first, with their default branch and whether they are private. When the app is not installed yet, says so and returns the link a person follows to install it.',
    output: ok('Installations, their repositories, and an install link.'),
    scopes: ['product:read'],
  },
  {
    id: 'product_connect_repo',
    group: 'github',
    method: 'POST',
    path: '/v1/products/:productId/github',
    summary: 'Deploy a Product from a GitHub repository on every push',
    description:
      'Connects a repository the GitHub App can see to a Product. Every push to the production branch then builds and deploys, recorded as triggered by the push. Private repositories are cloned with a short-lived token that is never stored.',
    input: withMutationControls({
      type: 'object',
      properties: {
        productId,
        installation_id: { type: 'string', description: 'From github_repo_list.' },
        repo_id: { type: 'string', description: 'From github_repo_list.' },
        production_branch: { type: 'string', default: 'main' },
      },
      required: ['productId', 'installation_id', 'repo_id'],
    }),
    output: planOutput,
    scopes: ['product:write'],
    dryRunnable: true,
  },

  // ─── organization ───────────────────────────────────────────────────────
  {
    id: 'organization_get',
    group: 'organization',
    method: 'GET',
    path: '/v1/organization',
    summary: 'Read the workspace',
    description:
      'The workspace this key belongs to: its name, plan, spend cap, whether it is a trial and when it expires, and what it is committed to spend this month across every Product. Call this before planning anything large.',
    output: ok('The organisation, its plan, cap and committed monthly cost.'),
    scopes: ['billing:read'],
  },
  {
    id: 'organization_update',
    group: 'organization',
    method: 'PATCH',
    path: '/v1/organization',
    summary: 'Change workspace settings',
    description:
      "Changes the workspace name, its monthly spend cap, where deploys build by default, or whether services keep their helm7.app address. The spend cap is checked against every cost-impacting change, whoever or whatever makes it; set budget_usd to null to remove it. default_build_mode is where a deploy builds when the caller does not say: local on the machine running the CLI, remote in the platform's build queue. A deploy from somewhere that cannot build (the dashboard, a push to GitHub, the hosted MCP server) always builds remotely. keep_app_domain decides whether a service keeps answering on its helm7.app address once a custom domain is serving it; off by default, so the custom domain replaces it. Turn it on to keep helm7.app as a staging address.",
    input: withMutationControls({
      type: 'object',
      properties: {
        name: { type: 'string' },
        budget_usd: { type: 'number', nullable: true, description: 'Monthly ceiling in USD across the whole workspace. null removes it.' },
        default_build_mode: { type: 'string', enum: ['local', 'remote'], description: 'Where a deploy builds when the caller does not say.' },
        keep_app_domain: { type: 'boolean', description: 'true keeps a service on its helm7.app address after a custom domain is serving it; false (the default for new workspaces) lets the custom domain replace it.' },
      },
    }),
    output: planOutput,
    scopes: ['billing:manage'],
    dryRunnable: true,
    requiresCapability: 'may_administer',
  },
  {
    id: 'activity_list',
    group: 'organization',
    method: 'GET',
    path: '/v1/activity',
    summary: 'What has been done, and by whom',
    description:
      'The audit trail: every change, whether it was applied, refused or failed, who made it (a person or a named key) and the plan it carried. Refusals are included, so an agent that was stopped is on the record. Newest first.',
    input: {
      type: 'object',
      properties: {
        productId: { ...productId, description: 'Narrow to one Product.' },
        outcome: { type: 'string', enum: ['applied', 'planned', 'refused', 'failed'] },
        include_dry_runs: {
          type: 'boolean',
          default: false,
          description: 'Include plans that were only looked at. Off by default: an agent or a form planning as it goes would bury the changes that were made.',
        },
        ...paged,
      },
    },
    output: list('An audit entry.'),
    scopes: ['product:read'],
  },
  {
    id: 'member_list',
    group: 'organization',
    method: 'GET',
    path: '/v1/members',
    summary: 'List the people in the workspace',
    description:
      'People with access to the workspace, with their role, and invitations that have not been accepted yet. There is no charge per person, so this is about who can do what, not what it costs.',
    output: list('A member or a pending invitation.'),
    scopes: ['product:read'],
  },
  {
    id: 'invite_create',
    group: 'organization',
    method: 'POST',
    path: '/v1/invites',
    summary: 'Invite someone by link',
    description:
      'Returns a link that adds whoever opens it and signs in to the workspace, with the role given. The link is shown once, works once and expires after 7 days. Nothing is emailed; send it however you like.',
    input: withMutationControls({
      type: 'object',
      properties: { role: { type: 'string', enum: ['admin', 'member', 'viewer'], default: 'member' } },
    }),
    output: planOutput,
    scopes: ['member:manage'],
    dryRunnable: true,
    requiresCapability: 'may_administer',
  },
  {
    id: 'member_remove',
    group: 'organization',
    method: 'DELETE',
    path: '/v1/members/:memberId',
    summary: 'Remove someone from the workspace, or cancel an invitation',
    description:
      'Removes a person, revoking every key they minted, or cancels an invitation that has not been used. The last owner cannot be removed. Requires confirm: true.',
    input: withMutationControls({
      type: 'object',
      properties: { memberId: { type: 'string', description: 'A member id (mbr_...) or an invitation id (inv_...).' } },
      required: ['memberId'],
    }),
    output: planOutput,
    scopes: ['member:manage'],
    destructive: true,
    dryRunnable: true,
    requiresCapability: 'may_administer',
  },

  {
    id: 'cloud_init',
    group: 'agent',
    method: 'POST',
    path: '/v1/cloud/init',
    summary: 'Start an ephemeral workspace with no account',
    description:
      'Creates a temporary organisation and a scoped key with no email, no card and no human step, so an agent can try Helm7 end to end. One Product, a small quota, and it expires. This is for experimentation, not for running anything real. Call cloud_claim to keep what you built.',
    input: { type: 'object', properties: { label: { type: 'string', description: 'Optional name to make it findable later.' } } },
    output: ok('The ephemeral organisation, its key, its quota and its expiry.'),
    scopes: [],
  },
  {
    id: 'cloud_claim',
    group: 'agent',
    method: 'POST',
    path: '/v1/cloud/claim',
    summary: 'Keep an ephemeral workspace',
    description:
      'Returns a single-use link a person opens to attach this ephemeral workspace to their account. The workspace keeps running while they do. Claiming keeps it; choosing Builder or Pro is what lifts the 72-hour expiry and the trial quota.',
    // Deliberately bare. It carried the standard mutation controls, which put
    // a dry_run flag on the wire that this operation does not honour — and an
    // advertised flag that silently does nothing is worse than no flag.
    input: { type: 'object', properties: {} },
    output: ok('A claim URL and how long it stays valid.'),
    scopes: [],
  },
]
