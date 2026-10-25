// The room geometry is the web's own code (web/src/scene/*.ts), imported as is so the bake and
// the browser can't drift apart. Those files import `three` (for the marching-cubes tables),
// which is installed here, not in web/. Without this, Bun would auto-install a copy from its
// global cache (or the network). Preloaded by bunfig.toml for `bun run` and `bun test`.
import { dirname, join } from 'node:path'

const main = Bun.resolveSync('three', import.meta.dir)
const root = dirname(Bun.resolveSync('three/package.json', import.meta.dir))

Bun.plugin({
  name: 'three-from-bake-worker',
  setup(build) {
    build.onResolve({ filter: /^three(\/.*)?$/ }, (args) => ({ path: args.path === 'three' ? main : join(root, args.path.slice('three/'.length)) }))
  },
})
