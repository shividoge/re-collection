/**
 * The one place the backend talks to Claude. Every call asks for JSON that matches a schema
 * (structured outputs), streams so long requests never hit an HTTP timeout, and opts into
 * server-side fallbacks so a policy decline is retried on Anthropic's recommended model instead
 * of failing the step. Ported from guide/src/claude.mjs.
 *
 * With MOCK_CLAUDE=1 it returns the caller's canned `mock` output (texts start with "[mock]")
 * and never touches the network.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { ContentBlock, JsonSchema } from './prompts'

export class ClaudeError extends Error {
  constructor(
    message: string,
    /** Worth trying again later (rate limit, overload, network). */
    readonly retryable = false,
  ) {
    super(message)
  }
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type JsonRequest = {
  model: string
  system: string
  content: ContentBlock[]
  schema: JsonSchema
  effort?: Effort
  maxTokens?: number
  /** Canned output for MOCK_CLAUDE=1. */
  mock: () => unknown
}
export type JsonResult = { data: unknown; model: string }
export type ClaudeClient = { mock: boolean; json(request: JsonRequest): Promise<JsonResult> }

export type ClaudeConfig = { mock: boolean; apiKey: string; models: { offline: string; live: string } }

type Env = Record<string, string | undefined>

export function claudeConfig(env: Env = process.env): ClaudeConfig {
  return {
    mock: env.MOCK_CLAUDE === '1',
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    models: { offline: env.MODEL_OFFLINE || 'claude-opus-5-5', live: env.MODEL_LIVE || 'claude-sonnet-5-5' },
  }
}

/** Tests replace the client here (no network, no key). */
export const testing: { client: ClaudeClient | null } = { client: null }

/** The client for this deployment's environment. */
export function claudeFromEnv(): ClaudeClient {
  return testing.client ?? createClaude(claudeConfig())
}

export function createClaude(config: ClaudeConfig, deps: { client?: Anthropic } = {}): ClaudeClient {
  if (config.mock) {
    return { mock: true, json: async ({ mock }) => ({ data: mock(), model: 'mock' }) }
  }
  const anthropic = deps.client ?? (config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : null)

  return {
    mock: false,
    async json({ model, system, content, schema, effort = 'high', maxTokens = 64000 }) {
      if (!anthropic) {
        throw new ClaudeError("ANTHROPIC_API_KEY isn't set in the Convex deployment, so Claude steps can't run. Set it with `bunx convex env set ANTHROPIC_API_KEY ...`.")
      }
      let message: Anthropic.Beta.BetaMessage
      try {
        const stream = anthropic.beta.messages.stream({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }],
          // Opus 5.5 defaults to medium effort; ask for what the step needs.
          output_config: { effort, format: { type: 'json_schema', schema } },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
        message = await stream.finalMessage()
      } catch (error) {
        throw describeApiError(error)
      }

      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category
        throw new ClaudeError(`Claude declined this request${category ? ` (${category})` : ''}.`)
      }
      if (message.stop_reason === 'max_tokens') throw new ClaudeError("Claude's answer was cut off at the output limit.")
      const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      try {
        return { data: JSON.parse(text) as unknown, model: message.model }
      } catch {
        throw new ClaudeError("Claude's answer wasn't valid JSON.")
      }
    },
  }
}

/** Plain-language messages for the failures a person can act on. */
function describeApiError(error: unknown): ClaudeError {
  if (error instanceof Anthropic.AuthenticationError) return new ClaudeError('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in the Convex deployment.')
  if (error instanceof Anthropic.PermissionDeniedError) return new ClaudeError("This API key isn't allowed to use that model.")
  if (error instanceof Anthropic.RateLimitError) return new ClaudeError('Claude is rate-limited right now. Try again in a minute.', true)
  if (error instanceof Anthropic.BadRequestError) return new ClaudeError(`Claude rejected the request: ${error.message}`)
  if (error instanceof Anthropic.APIConnectionError) return new ClaudeError("Can't reach the Anthropic API. Check the internet connection.", true)
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : 0
    return new ClaudeError(`Claude API error ${status || ''}: ${error.message}`, status >= 500)
  }
  return new ClaudeError(`Claude call failed: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- reading Claude's JSON ----------------------------------------------------------------
// Structured outputs match the schema, but nothing from the network is trusted blindly.

export type Json = Record<string, unknown>
export const obj = (x: unknown): Json => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : {})
export const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
export const str = (x: unknown, fallback = ''): string => (x === null || x === undefined ? fallback : String(x))
