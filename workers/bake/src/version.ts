import pkg from '../package.json'

/** The bake version recorded in derived.json: the package version and the git commit when known. */
export function bakeVersion(): string {
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: import.meta.dir, stderr: 'ignore' })
    const sha = r.success ? r.stdout.toString().trim() : ''
    return sha ? `${pkg.version}+${sha}` : pkg.version
  } catch {
    return pkg.version
  }
}
