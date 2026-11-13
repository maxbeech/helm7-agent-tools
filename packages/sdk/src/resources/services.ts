/**
 * Services — the things that run. web takes HTTP traffic and can hold a domain,
 * worker runs continuously with no ingress, cron runs on a schedule and exits.
 *
 * `logs` redaction is best effort on the platform side. This SDK repeats that
 * warning rather than hiding it, because a caller who believes redaction is a
 * guarantee is a caller who will paste a log tail into somewhere public.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, Instance, ListEnvelope, Plan, ServiceKind } from '../types.js'

export interface PublicPort {
  /** 465 or 587. */
  port: number
  /** What the process listens on, 1024 or above. */
  containerPort: number
}

/** The catalogue names it container_port; callers of this SDK write camelCase. */
const publicPortsWire = (ports: PublicPort[] | undefined) =>
  ports?.map((p) => ({ port: p.port, container_port: p.containerPort }))

export interface ServiceCreateInput extends MutationOptions {
  productId: string
  name: string
  kind: ServiceKind
  environment?: Environment
  /** Git URL. Required unless `image` is given. */
  repo?: string
  branch?: string
  /** Subdirectory to build from, for monorepos. */
  rootDirectory?: string
  /** With `rootDirectory`: skip a push-triggered build when the push changed nothing under it. */
  buildOnlyOnChanges?: boolean
  /** Container image reference, as an alternative to building from a repo. */
  image?: string
  /** Cron expression. Required when `kind` is cron, ignored otherwise. */
  schedule?: string
  instance?: Instance
  /** Web or worker: raw TCP ports to publish. Only 465 and 587 are offered. */
  publicPorts?: PublicPort[]
  /** Cron only: a path on one of your web services to call on the schedule, instead of running a container. */
  path?: string
  /** Cron with a path only. Defaults to GET. */
  method?: 'GET' | 'POST'
  /** Cron with a path only: the web service to call. Defaults to the only one, or the one called web. */
  target?: string
}

export interface ServiceLogsOptions extends RequestOptions {
  productId: string
  serviceId: string
  since?: string
  limit?: number
}

export interface ServiceUpdateInput extends MutationOptions {
  productId: string
  serviceId: string
  instance?: Instance
  /** Git URL to build from; for a repository that was renamed or moved. */
  repo?: string
  branch?: string
  rootDirectory?: string | null
  /** Skip a push-triggered build when the push changed nothing under `rootDirectory`. Needs one. */
  buildOnlyOnChanges?: boolean
  image?: string | null
  schedule?: string
  paused?: boolean
  /** Raw TCP ports to publish. Only 465 and 587 are offered. */
  publicPorts?: PublicPort[]
  /** A cron that calls a web service: the path on one of your web services to call on the schedule, instead of running a container. */
  path?: string
  /** A cron that calls a web service: the HTTP method. */
  method?: 'GET' | 'POST'
  /** A cron that calls a web service: the web service to call. Defaults to the only one, or the one called web. */
  target?: string
}

export class ServicesResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  create(input: ServiceCreateInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.service_create,
      {
        productId: input.productId,
        name: input.name,
        kind: input.kind,
        environment: input.environment,
        repo: input.repo,
        branch: input.branch,
        root_directory: input.rootDirectory,
        build_only_on_changes: input.buildOnlyOnChanges,
        image: input.image,
        schedule: input.schedule,
        instance: input.instance,
        public_ports: publicPortsWire(input.publicPorts),
        path: input.path,
        method: input.method,
        target: input.target,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** Recent stdout and stderr. Secrets are redacted best-effort, not reliably. */
  logs(options: ServiceLogsOptions): Promise<ListEnvelope> {
    return this.transport.call(
      ENDPOINTS.service_logs,
      {
        productId: options.productId,
        serviceId: options.serviceId,
        since: options.since,
        limit: options.limit,
      },
      options,
    )
  }

  list(options: { productId: string; environment?: Environment } & RequestOptions): Promise<ListEnvelope> {
    return this.transport.call(ENDPOINTS.service_list, { productId: options.productId, environment: options.environment }, options)
  }

  /** `paused: true` stops the service and keeps its configuration. */
  update(input: ServiceUpdateInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.service_update,
      {
        productId: input.productId,
        serviceId: input.serviceId,
        instance: input.instance,
        repo: input.repo,
        branch: input.branch,
        root_directory: input.rootDirectory,
        build_only_on_changes: input.buildOnlyOnChanges,
        image: input.image,
        schedule: input.schedule,
        paused: input.paused,
        public_ports: publicPortsWire(input.publicPorts),
        path: input.path,
        method: input.method,
        target: input.target,
        ...mutationWire(input),
      },
      input,
    )
  }

  delete(productId: string, serviceId: string, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(ENDPOINTS.service_delete, { productId, serviceId, ...mutationWire(options) }, options)
  }
}
