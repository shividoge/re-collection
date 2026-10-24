import { useCallback, useEffect, useRef } from 'react'

const REMAPPED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'] as const

/**
 * Browsers can't move the OS cursor, so after Fly steering ends we hide it and draw our own
 * cursor at the crosshair instead. It moves with the mouse from there and lands back on the
 * real cursor by the time either reaches a screen edge; then the real one shows again.
 * While it's showing, clicks are re-sent to whatever is under the drawn cursor, so you click
 * where you see the pointer.
 */
export function useVirtualCursor(enabled: boolean) {
  const el = useRef<HTMLDivElement>(null)
  const s = useRef({ active: false, pending: false, fx: 0, fy: 0, ox: 0, oy: 0, rx: 0, ry: 0 })

  const render = useCallback(() => {
    const st = s.current
    if (el.current) el.current.style.transform = `translate(${st.fx}px, ${st.fy}px)`
  }, [])

  const stop = useCallback(() => {
    s.current.active = false
    s.current.pending = false
    document.documentElement.classList.remove('bd-virtual-cursor')
    if (el.current) el.current.style.display = 'none'
  }, [])

  /** Show the drawn cursor at (x, y) in client coordinates, e.g. the crosshair. */
  const placeAt = useCallback(
    (x: number, y: number) => {
      if (!enabled) return
      Object.assign(s.current, { active: true, pending: true, fx: x, fy: y })
      document.documentElement.classList.add('bd-virtual-cursor')
      if (el.current) el.current.style.display = 'block'
      render()
    },
    [enabled, render],
  )

  useEffect(() => {
    if (!enabled) {
      stop()
      return
    }
    // The real cursor's position is unknown until it moves; the first event fixes the offset.
    const sync = (e: MouseEvent) => {
      const st = s.current
      if (!st.pending) return
      st.ox = st.fx - e.clientX
      st.oy = st.fy - e.clientY
      st.rx = e.clientX
      st.ry = e.clientY
      st.pending = false
    }
    // Move the drawn cursor along one axis. Moving away from the real cursor's side is 1:1.
    // Moving toward it, the drawn cursor goes just fast enough that both reach that screen
    // edge together, so it can always get everywhere and quietly lands on the real cursor.
    const step = (f: number, rOld: number, rNew: number, size: number) => {
      const d = rNew - rOld
      const max = size - 1
      let gain = 1
      if (d > 0 && f < rOld && max - rOld > 0) gain = (max - f) / (max - rOld)
      if (d < 0 && f > rOld && rOld > 0) gain = f / rOld
      return Math.min(max, Math.max(0, f + d * gain))
    }
    const onMove = (e: PointerEvent) => {
      const st = s.current
      if (!st.active || document.pointerLockElement) return
      if (st.pending) return sync(e)
      st.fx = step(st.fx, st.rx, e.clientX, window.innerWidth)
      st.fy = step(st.fy, st.ry, e.clientY, window.innerHeight)
      st.rx = e.clientX
      st.ry = e.clientY
      st.ox = st.fx - e.clientX
      st.oy = st.fy - e.clientY
      if (Math.hypot(st.ox, st.oy) < 2) return stop()
      render()
    }
    const remap = (e: MouseEvent) => {
      const st = s.current
      if (!st.active || !e.isTrusted || document.pointerLockElement) return
      sync(e)
      const x = e.clientX + st.ox
      const y = e.clientY + st.oy
      const target = document.elementFromPoint(x, y)
      e.stopPropagation()
      e.preventDefault()
      if (!target) return
      const init: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        screenX: e.screenX + st.ox,
        screenY: e.screenY + st.oy,
        button: e.button,
        buttons: e.buttons,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        detail: e.detail,
      }
      if (e instanceof PointerEvent) {
        Object.assign(init, { pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary })
        target.dispatchEvent(new PointerEvent(e.type, init))
      } else target.dispatchEvent(new MouseEvent(e.type, init))
    }
    // Leaving the window hands control back to the real cursor.
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget && s.current.active) stop()
    }
    window.addEventListener('pointermove', onMove, true)
    for (const t of REMAPPED) window.addEventListener(t, remap, true)
    document.addEventListener('mouseout', onOut)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      for (const t of REMAPPED) window.removeEventListener(t, remap, true)
      document.removeEventListener('mouseout', onOut)
      stop()
    }
  }, [enabled, render, stop])

  return { ref: el, placeAt, stop }
}
