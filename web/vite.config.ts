import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  plugins: [react()],
  // A static build (VITE_STATIC=1) works from any folder or sub-path, e.g. GitHub Pages project sites.
  base: process.env.VITE_STATIC === '1' ? './' : '/',
  resolve: {
    // backend/convex/_generated and shared/ live outside web/ and have no node_modules of their own:
    // their `convex` imports resolve to web's copy (one copy in the bundle).
    dedupe: ['convex'],
  },
  server: {
    port: 5173,
    // The generated Convex api and the shared codecs are imported from ../backend and ../shared.
    fs: { allow: [repoRoot] },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // three.js and the react-three stack change rarely: one long-cached chunk, loaded only by
            // 3D routes. Postprocessing, Spark and MediaPipe stay with the screens that use them.
            {
              name: 'three',
              includeDependenciesRecursively: false,
              test: /node_modules[\\/](three|@react-three[\\/](fiber|drei)|three-stdlib|three-mesh-bvh|troika-[^\\/]+|maath|meshline|camera-controls|stats-gl|@monogrid)[\\/]/,
            },
          ],
        },
      },
    },
  },
})
