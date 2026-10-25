// Dev only: Vite with file access to capture folders on this machine, for scene/dev/localAssets.ts.
// BD_LOCAL_DIRS is a colon-separated list of folders to allow. Run from web/:
//   BD_LOCAL_DIRS=/path/captures:/tmp/bd-baked bunx vite --config src/scene/dev/vite.local.config.ts --port 5185
import react from '@vitejs/plugin-react'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

// Typed by hand: this file is checked with the browser tsconfig, which has no Node types.
const node = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [searchForWorkspaceRoot(node.cwd()), ...(node.env.BD_LOCAL_DIRS ?? '').split(':').filter(Boolean)] },
  },
})
