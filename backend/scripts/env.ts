// CONVEX_URL and WORKER_TOKEN for scripts: the environment, else ~/.config/braindance/worker.env.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function scriptEnv(): { convexUrl: string; token: string } {
  const file = join(homedir(), '.config/braindance/worker.env')
  const fromFile: Record<string, string> = {}
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) fromFile[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  const convexUrl = process.env.CONVEX_URL || fromFile.CONVEX_URL
  const token = process.env.WORKER_TOKEN || fromFile.WORKER_TOKEN
  if (!convexUrl || !token) throw new Error(`Set CONVEX_URL and WORKER_TOKEN (environment or ${file}).`)
  return { convexUrl, token }
}
