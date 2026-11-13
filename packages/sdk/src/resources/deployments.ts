/**
 * Deployments.
 *
 * `rollback` is a traffic swap onto an image that already exists, so it takes
 * seconds — but it does NOT revert database migrations. That asymmetry is the
 * one thing to know before reaching for it during an incident: rolling the code
 * back under a migrated schema can be worse than the deployment being rolled
 * back.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, JsonObject, ListEnvelope, Plan } from '../types.js'

export interface DeployInput extends MutationOptions {
  productId: string
  environment?: Environment
  /** Omit to deploy every service in the environment. */
  serviceId?: string
  /** Git SHA. Defaults to the branch tip. */
  commit?: string
  /** `local` builds on your machine and uploads; `remote` waits in the build
   *  queue. Omit it for the workspace default. */
  build?: 'local' | 'remote'
  /** Say so when this caller has Docker and the source, so a workspace
   *  default of local can apply to it. */
  canBuildLocally?: boolean
}

export interface DeploymentListOptions extends RequestOptions {
  productId: string
  environment?: Environment
  cursor?: string
  limit?: number
}

export class DeploymentsResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  /**
   * Builds the current commit and swaps traffic once health checks pass.
   * Returns immediately; poll `get` for progress.
   */
  deploy(input: DeployInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.deploy,
      {
        productId: input.productId,
        environment: input.environment,
        service_id: input.serviceId,
        commit: input.commit,
        build: input.build,
        can_build_locally: input.canBuildLocally,
        ...mutationWire(input),
      },
      input,
    )
  }

  get(productId: string, deploymentId: string, options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.deployment_get, { productId, deploymentId }, options)
  }

  /** History is immutable and nothing is pruned — the reliable way to find the
   *  last deployment that was healthy before rolling back to it. */
  list(options: DeploymentListOptions): Promise<ListEnvelope> {
    return this.transport.call(
      ENDPOINTS.deployment_list,
      {
        productId: options.productId,
        environment: options.environment,
        cursor: options.cursor,
        limit: options.limit,
      },
      options,
    )
  }

  rollback(productId: string, deploymentId: string, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.deployment_rollback,
      { productId, deploymentId, ...mutationWire(options) },
      options,
    )
  }

  /** Your running and waiting builds, with their places in the queue. */
  queue(options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.build_queue_get, {}, options)
  }

  /**
   * Puts your own waiting builds in a new order: the ids given run first, in
   * that order, and the rest follow as they were. It only rearranges the places
   * your workspace already holds, so it cannot pass another workspace's build.
   */
  reorderQueue(deploymentIds: string[], options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(ENDPOINTS.build_queue_reorder, { deployment_ids: deploymentIds, ...mutationWire(options) }, options)
  }

  /** One in-order chunk of a `docker save` archive for a local build. `offset`
   *  is what the server already holds, so repeating a chunk is harmless. */
  uploadImageChunk(productId: string, deploymentId: string, offset: number, data: Uint8Array, options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(
      ENDPOINTS.deployment_image_upload,
      { productId, deploymentId, offset, data: Buffer.from(data).toString('base64') },
      options,
    )
  }

  /** Verifies the upload and starts the deployment from it. */
  finishImage(productId: string, deploymentId: string, input: { size: number; sha256: string; commit?: string }, options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.deployment_image_finish, { productId, deploymentId, ...input }, options)
  }
}
