export * from './types.js'
export * from './schemas.js'
export { OPERATIONS } from './operations.js'
export * from './generate.js'

import { OPERATIONS } from './operations.js'
import type { Operation } from './types.js'

const BY_ID = new Map<string, Operation>(OPERATIONS.map((o) => [o.id, o]))

export function getOperation(id: string): Operation | undefined {
  return BY_ID.get(id)
}

/** Router lookup: match an incoming method+path to an operation, pulling the
 *  path params out as it goes. */
export function matchRoute(
  method: string,
  pathname: string,
): { operation: Operation; params: Record<string, string> } | undefined {
  const segments = pathname.split('/').filter(Boolean)
  for (const op of OPERATIONS) {
    if (op.method !== method.toUpperCase()) continue
    const opSegments = op.path.split('/').filter(Boolean)
    if (opSegments.length !== segments.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < opSegments.length; i++) {
      const expected = opSegments[i]!
      const actual = segments[i]!
      if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual)
      else if (expected !== actual) { matched = false; break }
    }
    if (matched) return { operation: op, params }
  }
  return undefined
}
