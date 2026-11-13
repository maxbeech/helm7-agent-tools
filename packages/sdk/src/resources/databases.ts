/**
 * Postgres.
 *
 * `restore` REPLACES the current contents by default and is the only operation
 * here that can lose data somebody wrote a minute ago. `intoNewDatabase` exists
 * so the careful path is one flag rather than a different procedure, and this
 * SDK names it in the type documentation for the same reason the catalogue does
 * — the caller deciding under pressure should not have to go and read for it.
 */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, JsonObject, Plan } from '../types.js'

export interface DatabaseCreateInput extends MutationOptions {
  productId: string
  environment?: Environment
  name?: string
  /** e.g. ["pgvector"]. pgcrypto and uuid-ossp are always on. */
  extensions?: string[]
}

export interface DatabaseRestoreInput extends MutationOptions {
  productId: string
  databaseId: string
  backupId?: string
  /** Alternative to `backupId`. Must fall inside the retention window. */
  pointInTime?: string
  /** Restore alongside rather than over the top. Strongly preferred when unsure. */
  intoNewDatabase?: boolean
}

export class DatabasesResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  /** Postgres, at the region's current major version, with pgvector available. Sets DATABASE_URL on the environment. */
  create(input: DatabaseCreateInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.database_create,
      {
        productId: input.productId,
        environment: input.environment,
        name: input.name,
        extensions: input.extensions,
        ...mutationWire(input),
      },
      input,
    )
  }

  get(productId: string, databaseId: string, options: RequestOptions = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.database_get, { productId, databaseId }, options)
  }

  /** Forces a backup on top of the scheduled ones. */
  backup(productId: string, databaseId: string, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.database_backup,
      { productId, databaseId, ...mutationWire(options) },
      options,
    )
  }

  /** Destructive: everything written after the restore point is lost. */
  restore(input: DatabaseRestoreInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.database_restore,
      {
        productId: input.productId,
        databaseId: input.databaseId,
        backup_id: input.backupId,
        point_in_time: input.pointInTime,
        into_new_database: input.intoNewDatabase,
        ...mutationWire(input),
      },
      input,
    )
  }

  /** One read-only statement, run as the Product's own role. At most `limit` rows (default 100, maximum 1000). */
  query(productId: string, databaseId: string, sql: string, options: RequestOptions & { limit?: number } = {}): Promise<JsonObject> {
    return this.transport.call(ENDPOINTS.database_query, { productId, databaseId, sql, limit: options.limit }, options)
  }

  /**
   * A SQL script in one transaction. Destructive: applying needs `confirm`,
   * and `dryRun` runs it and rolls it back so the outcome is known first.
   */
  execute(input: { productId: string; databaseId: string; sql: string } & MutationOptions): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.database_execute,
      { productId: input.productId, databaseId: input.databaseId, sql: input.sql, ...mutationWire(input) },
      input,
    )
  }
}
