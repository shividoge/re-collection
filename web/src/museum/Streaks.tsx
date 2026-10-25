import { useEffect, useRef } from 'react'
import { streakLevel, STREAK_FADE_MS } from './warp'

const STARS = 520
/**
 * Light streaking past on the way through a picture, like stars at warp speed: they build up as
 * the visitor rushes into the frame, peak at the crossing and die away on the far side. `out`
 * runs them the other way, falling back in toward the middle. Drawn over everything, warm and
 * soft, and never catching a tap.
 */
export function Streaks({ dir, cross }: { dir: 'in' | 'out'; cross: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const fit = () => {
      el.width = window.innerWidth * dpr
      el.height = window.innerHeight * dpr
    }
    fit()
    window.addEventListener('resize', fit)
    // Each star: where it is across the view (x, y), how far ahead (z, 0–1), and its colour.
    const hues = [38, 30, 22, 350, 45, 200]
    const stars = Array.from({ length: STARS }, () => ({
      x: (Math.random() * 2 - 1) * 1.2,
      y: (Math.random() * 2 - 1) * 1.2,
      z: Math.random(),
      hue: hues[Math.floor(Math.random() * hues.length)],
      light: 72 + Math.random() * 25,
    }))
    let last = performance.now()
    let frame = 0
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const level = streakLevel(now, cross)
      const w = el.width
      const h = el.height
      const cx = w / 2
      const cy = h / 2
      const r = Math.max(w, h) * 0.5
      ctx.clearRect(0, 0, w, h)
      if (level > 0.002) {
        ctx.globalCompositeOperation = 'lighter'
        // Speed through the field, and the length of each streak with it.
        const speed = 0.25 + 2.6 * level
        const trail = 0.02 + 0.22 * level
        ctx.lineCap = 'round'
        for (const s of stars) {
          s.z += (dir === 'in' ? -1 : 1) * speed * dt
          if (s.z < 0.04 || s.z > 1) {
            s.z = dir === 'in' ? 1 : 0.04 + Math.random() * 0.05
            s.x = (Math.random() * 2 - 1) * 1.2
            s.y = (Math.random() * 2 - 1) * 1.2
          }
          // Near end and far end of the streak, projected to the screen.
          const z0 = Math.max(0.04, s.z)
          const z1 = Math.min(1.4, s.z + trail)
          const x0 = cx + (s.x / z0) * r * 0.18
          const y0 = cy + (s.y / z0) * r * 0.18
          const x1 = cx + (s.x / z1) * r * 0.18
          const y1 = cy + (s.y / z1) * r * 0.18
          const near = 1 - s.z
          const alpha = level * Math.min(1, near * 1.6) * 0.85
          if (alpha < 0.01) continue
          ctx.strokeStyle = `hsla(${s.hue}, 90%, ${s.light}%, ${alpha})`
          ctx.lineWidth = (0.6 + near * 2.4) * dpr
          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x0, y0)
          ctx.stroke()
        }
        // A warm glow in the middle, the light at the end of the tunnel.
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.9)
        glow.addColorStop(0, `rgba(255, 238, 214, ${0.55 * level})`)
        glow.addColorStop(0.35, `rgba(255, 190, 140, ${0.18 * level})`)
        glow.addColorStop(1, 'rgba(255, 160, 120, 0)')
        ctx.fillStyle = glow
        ctx.fillRect(0, 0, w, h)
        ctx.globalCompositeOperation = 'source-over'
        // And the edges darken, like a tunnel.
        const edge = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r * 1.45)
        edge.addColorStop(0, 'rgba(0, 0, 0, 0)')
        edge.addColorStop(1, `rgba(8, 4, 10, ${0.6 * level})`)
        ctx.fillStyle = edge
        ctx.fillRect(0, 0, w, h)
      }
      if (now < cross + STREAK_FADE_MS) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', fit)
    }
  }, [dir, cross])
  return <canvas ref={canvas} className="museum-streaks" aria-hidden="true" />
}
