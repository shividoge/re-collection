import Anthropic from '@anthropic-ai/sdk';

/**
 * The one place the guide talks to Claude. Every call asks for JSON that
 * matches a schema (structured outputs), streams so long requests never hit
 * an HTTP timeout, and opts into server-side fallbacks so a policy decline is
 * retried on Anthropic's recommended model instead of failing the step.
 *
 * With MOCK_CLAUDE=1 it returns the caller's canned `mock` output instead,
 * prefixed "[mock]" by the caller, and never touches the network.
 */
export class ClaudeError extends Error {}

export function createClaude(config, { client } = {}) {
  if (config.mockClaude) {
    return {
      mock: true,
      async json({ mock }) {
        return { data: mock(), model: 'mock', usage: null };
      },
    };
  }

  const anthropic = client ?? (config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null);

  return {
    mock: false,
    /**
     * @param {object} p
     * @param {string} p.model
     * @param {string} p.system
     * @param {Array} p.content     user message content blocks (text and images)
     * @param {object} p.schema     JSON schema the reply must match
     * @param {string} [p.effort]   low | medium | high | xhigh | max
     * @returns {Promise<{ data: any, model: string, usage: object }>}
     */
    async json({ model, system, content, schema, effort = 'high', maxTokens = 64000 }) {
      if (!anthropic) {
        throw new ClaudeError('No ANTHROPIC_API_KEY in guide/.env, so Claude steps can\'t run. Add the key and restart the guide.');
      }
      let message;
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
        });
        message = await stream.finalMessage();
      } catch (error) {
        throw new ClaudeError(describeApiError(error));
      }

      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        throw new ClaudeError(`Claude declined this request${category ? ` (${category})` : ''}.`);
      }
      if (message.stop_reason === 'max_tokens') {
        throw new ClaudeError('Claude\'s answer was cut off at the output limit.');
      }
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return { data: JSON.parse(text), model: message.model, usage: message.usage };
      } catch {
        throw new ClaudeError('Claude\'s answer wasn\'t valid JSON.');
      }
    },
  };
}

/** Plain-language messages for the failures a person can act on. */
function describeApiError(error) {
  if (error instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in guide/.env.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'This API key isn\'t allowed to use that model.';
  if (error instanceof Anthropic.RateLimitError) return 'Claude is rate-limited right now. Try again in a minute.';
  if (error instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return 'Can\'t reach the Anthropic API. Check the internet connection.';
  if (error instanceof Anthropic.APIError) return `Claude API error ${error.status ?? ''}: ${error.message}`;
  return `Claude call failed: ${error.message}`;
}
