import { homedir } from 'node:os'
import { join } from 'node:path'

/** KEY=value lines; # comments, optional quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export const CONFIG_FILE = join(homedir(), '.config', 'braindance', 'worker.env')

/** CONVEX_URL and WORKER_TOKEN from the environment, else from ~/.config/braindance/worker.env. */
export async function loadConfig(file = CONFIG_FILE): Promise<{ convexUrl: string; token: string }> {
  const f = Bun.file(file)
  const fromFile = (await f.exists()) ? parseEnv(await f.text()) : {}
  const get = (k: string) => process.env[k] || fromFile[k] || ''
  const convexUrl = get('CONVEX_URL')
  const token = get('WORKER_TOKEN')
  const missing = [!convexUrl && 'CONVEX_URL', !token && 'WORKER_TOKEN'].filter(Boolean)
  if (missing.length) throw new Error(`Set ${missing.join(' and ')} in the environment or in ${file}.`)
  return { convexUrl, token }
}
