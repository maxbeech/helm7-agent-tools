/**
 * The one place the CLI touches the SDK as a value rather than a type.
 *
 * Isolated so that `main` — and therefore the parser, the command table and the
 * renderer — can be loaded and tested without the client being constructed or
 * even resolved. `helm7 --help`, every usage error and every missing-credential
 * message answer without reaching this file, because none of them was ever
 * going to make a request.
 */
import { Helm7 } from '@helm7/sdk'

export function createClient(options: { apiKey: string; baseUrl?: string }): Helm7 {
  return new Helm7(options)
}
