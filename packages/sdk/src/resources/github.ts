/**
 * GitHub, as a source of code. Only works on a Helm7 that has a GitHub App
 * registered; `repositories` says so rather than failing when it has not.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { JsonObject, Plan } from '../types.js'

export interface ConnectRepoInput extends MutationOptions {
  productId: string
  /** Both from `repositories()`. */
  installationId: string
  repoId: string
  productionBranch?: string
}

export class GitHubResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  repositories(options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.github_repo_list, {}, options)
  }

  /** After this, every push to the production branch deploys. */
  connect(input: ConnectRepoInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.product_connect_repo,
      {
        productId: input.productId,
        installation_id: input.installationId,
        repo_id: input.repoId,
        production_branch: input.productionBranch,
        ...mutationWire(input),
      },
      input,
    )
  }
}
