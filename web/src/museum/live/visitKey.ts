// The palace's visit key on this device: from the link (#/museum?visit=<key>), remembered so the
// palace opened without it (a bookmark, the editor's "Open her museum") still joins the visit.

const STORE = 'braindance.palace.visitKey'
const PATTERN = /^[A-Za-z0-9_-]{32}$/

/** The key in a hash like "#/museum?visit=<key>", or null. */
export function visitKeyIn(hash: string): string | null {
  const m = /[?&]visit=([A-Za-z0-9_-]+)/.exec(hash)
  return m && PATTERN.test(m[1]) ? m[1] : null
}

/** The key from the link (remembered from now on), else the one remembered here, else null. */
export function currentVisitKey(): string | null {
  const linked = visitKeyIn(location.hash)
  try {
    if (linked) localStorage.setItem(STORE, linked)
    const kept = linked ?? localStorage.getItem(STORE)
    return kept && PATTERN.test(kept) ? kept : null
  } catch {
    return linked
  }
}

/** The key stopped working (a new link was made): forget it here. */
export function forgetVisitKey() {
  try {
    localStorage.removeItem(STORE)
  } catch {
    /* nothing kept */
  }
}

/** Her palace's link with the visit key: the same for her iPad and for family. */
export function visitLink(key: string): string {
  return `${location.origin}${location.pathname}#/museum?visit=${key}`
}
