// Errors from Convex in plain language. A ConvexError carries `{ code, message?, errors? }` from
// our functions; anything else is a crash or a network problem and gets a calm generic sentence.
import { ConvexError } from 'convex/values'

const CODES: Record<string, string> = {
  no_facts: 'Approve at least one fact before starting a visit.',
  not_found: 'This visit isn’t here any more.',
  invalid: 'Some files in this capture don’t match its manifest.',
  forbidden: 'This isn’t shared publicly.',
  ended: 'This visit has already ended.',
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** The error's plain-language message. */
export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data
    if (typeof data === 'string') return data
    if (isRecord(data)) {
      const list = Array.isArray(data.errors) ? data.errors.filter((e): e is string => typeof e === 'string') : []
      const message = typeof data.message === 'string' ? data.message : null
      const code = typeof data.code === 'string' ? data.code : null
      const head = message ?? (code ? CODES[code] : undefined) ?? 'Something went wrong.'
      return list.length ? `${head} ${list.join(' ')}` : head
    }
    return 'Something went wrong.'
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Cancelled.'
    // Convex server errors read "[CONVEX M(x:y)] [Request ID: …] Server Error …": not for families.
    if (/^\[CONVEX /.test(error.message)) return 'The server ran into a problem. Please try again in a moment.'
    return error.message
  }
  return String(error)
}

/** The ConvexError code, if it is one of ours. */
export function errorCode(error: unknown): string | null {
  return error instanceof ConvexError && isRecord(error.data) && typeof error.data.code === 'string' ? error.data.code : null
}

/** The list of problems a ConvexError({ code: 'invalid', errors }) carries. */
export function errorList(error: unknown): string[] {
  if (!(error instanceof ConvexError) || !isRecord(error.data) || !Array.isArray(error.data.errors)) return []
  return error.data.errors.filter((e): e is string => typeof e === 'string')
}
