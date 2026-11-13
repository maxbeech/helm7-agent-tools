/** S3-compatible object storage with no egress charge, Supabase Storage compatible. */
import type { Transport, RequestOptions } from '../transport.js'
import { ENDPOINTS } from '../endpoints.js'
import { mutationWire, type MutationOptions } from '../mutations.js'
import type { Environment, ListEnvelope, Plan } from '../types.js'

export interface BucketCreateInput extends MutationOptions {
  productId: string
  name: string
  environment?: Environment
  /** Public buckets serve objects without a signed URL. Default is private. */
  public?: boolean
}

export class StorageResource {
  private readonly transport: Transport

  constructor(transport: Transport) {
    this.transport = transport
  }

  createBucket(input: BucketCreateInput): Promise<Plan> {
    return this.transport.call(
      ENDPOINTS.storage_create_bucket,
      {
        productId: input.productId,
        environment: input.environment,
        name: input.name,
        public: input.public,
        ...mutationWire(input),
      },
      input,
    )
  }

  listBuckets(options: { productId: string; environment?: Environment } & RequestOptions): Promise<ListEnvelope> {
    return this.transport.call(ENDPOINTS.bucket_list, { productId: options.productId, environment: options.environment }, options)
  }

  /** The bucket and every object in it. */
  deleteBucket(productId: string, bucketId: string, options: MutationOptions = {}): Promise<Plan> {
    return this.transport.call(ENDPOINTS.bucket_delete, { productId, bucketId, ...mutationWire(options) }, options)
  }
}
