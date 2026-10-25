// Convex hides the message of any error that isn't a ConvexError in production, so every public
// action turns failures into ConvexError({ code, message, retryable }) the screen can show.
import { ConvexError } from 'convex/values'
import { ClaudeError } from './claude'
import { R2Error } from './r2'

export function toConvexError(error: unknown): Error {
  if (error instanceof ConvexError) return error
  if (error instanceof ClaudeError) return new ConvexError({ code: 'claude', message: error.message, retryable: error.retryable })
  if (error instanceof R2Error) return new ConvexError({ code: 'storage', message: error.message, retryable: error.retryable })
  const message = error instanceof Error ? error.message : String(error)
  return new ConvexError({ code: 'error', message, retryable: false })
}

/** Runs `fn`, rethrowing any failure as a ConvexError with a readable message. */
export async function shown<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn()
  } catch (error) {
    throw toConvexError(error)
  }
}
