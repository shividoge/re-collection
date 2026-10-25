import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const guideRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads guide/.env if it exists. Real environment variables win over the file. */
export function loadConfig(env = process.env) {
  const envFile = resolve(guideRoot, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  return {
    port: Number(env.PORT || 8787),
    dataDir: resolve(guideRoot, env.DATA_DIR || './data'),
    key: env.BRAINDANCE_KEY || '',
    mockClaude: env.MOCK_CLAUDE === '1',
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    // The live visit's call setup: a JSON array for RTCPeerConnection (a TURN server can go here).
    iceServers: env.ICE_SERVERS || '',
    models: {
      offline: env.MODEL_OFFLINE || 'claude-opus-5-5',
      live: env.MODEL_LIVE || 'claude-sonnet-5-5',
    },
  };
}
