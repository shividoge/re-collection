import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import type { QuarterTurns } from '../scene/pose'
import { brushStep, PAINT_GLSL } from './paint'

/**
 * The museum's painted look (paint.ts) laid over a video on the page (photos use PaintedStill), filling the
 * screen as the element under it does (`contain` or `cover`), so it can lift away and leave the
 * picture exactly as taken. `painted` is where it's heading (true: painted, false: as taken),
 * over `ms`; once it's fully lifted the canvas hides and stops drawing.
 */
export function Painted({ source, fit, painted, ms, onSettled }: { source: HTMLImageElement | HTMLVideoElement | null; fit: 'contain' | 'cover'; painted: boolean; ms: number; onSettled?: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const goal = useRef({ painted, ms, onSettled })
  const kick = useRef<() => void>(() => {})
  useEffect(() => {
    goal.current = { painted, ms, onSettled }
    // A change of direction (lift, or paint again) wakes the loop if it had settled.
    kick.current()
  }, [painted, ms, onSettled])

  useEffect(() => {
    const holder = box.current
    if (!holder || !source) return
    // A fresh canvas for each renderer: a canvas whose context was let go can't be drawn on again.
    const el = document.createElement('canvas')
    el.className = 'stepin-painted'
    holder.replaceChildren(el)
    const renderer = new THREE.WebGLRenderer({ canvas: el, alpha: true, antialias: false, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    const video = source instanceof HTMLVideoElement
    const texture = video ? new THREE.VideoTexture(source) : new THREE.Texture(source)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.needsUpdate = true
    const aspectOf = () => (video ? source.videoWidth / source.videoHeight : source.naturalWidth / source.naturalHeight) || 16 / 9
    const material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uPicture: { value: texture },
        uStep: { value: brushStep(aspectOf()) },
        uAspect: { value: aspectOf() },
        uAmount: { value: 1 },
        uView: { value: 1 },
        uCover: { value: fit === 'cover' ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vScreen;
        void main() {
          vScreen = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${PAINT_GLSL}
        uniform float uView;
        uniform float uCover;
        varying vec2 vScreen;
        void main() {
          // Where this point of the screen falls on the picture, as object-fit places it.
          // r > 1: the screen is wider than the picture. Contain then leaves bars at the sides
          // and cover crops top and bottom; r < 1 the other way round.
          float r = uView / uAspect;
          vec2 uv = vScreen;
          if ((r > 1.0) == (uCover < 0.5)) uv.x = (vScreen.x - 0.5) * r + 0.5;
          else uv.y = (vScreen.y - 0.5) / r + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          gl_FragColor = vec4(shown(uv), 1.0);
          #include <colorspace_fragment>
        }
      `,
    })
    const scene = new THREE.Scene()
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material))
    const camera = new THREE.Camera()
    const fitSize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight, false)
      material.uniforms.uView.value = window.innerWidth / window.innerHeight
    }
    fitSize()
    window.addEventListener('resize', fitSize)

    let amount = goal.current.painted ? 1 : 0
    let from = amount
    let start = performance.now()
    let heading = goal.current.painted
    let told = false
    let frame = 0
    let running = false
    const tick = (now: number) => {
      const g = goal.current
      if (g.painted !== heading) {
        heading = g.painted
        from = amount
        start = now
        told = false
      }
      const t = Math.min(1, (now - start) / Math.max(1, g.ms))
      // Ease in and out, so the paint lifts softly from the first moment to the last.
      amount = from + ((heading ? 1 : 0) - from) * (t * t * (3 - 2 * t))
      material.uniforms.uAmount.value = amount
      const aspect = aspectOf()
      if (aspect !== material.uniforms.uAspect.value) {
        material.uniforms.uAspect.value = aspect
        material.uniforms.uStep.value = brushStep(aspect)
      }
      el.style.visibility = amount <= 0.001 ? 'hidden' : 'visible'
      if (amount > 0.001) renderer.render(scene, camera)
      if (t >= 1 && !told) {
        told = true
        g.onSettled?.()
      }
      // A video keeps changing, so it's drawn every frame while painted; a photo only while fading.
      running = t < 1 || (video && amount > 0.001)
      if (running) frame = requestAnimationFrame(tick)
    }
    kick.current = () => {
      if (running) return
      running = true
      start = performance.now()
      frame = requestAnimationFrame(tick)
    }
    kick.current()
    return () => {
      cancelAnimationFrame(frame)
      running = false
      kick.current = () => {}
      window.removeEventListener('resize', fitSize)
      texture.dispose()
      material.dispose()
      renderer.dispose()
      // Let the context go now, not whenever the browser gets round to it (each one is costly on a tablet).
      renderer.forceContextLoss()
      el.remove()
    }
    // A new renderer per picture and fit; `painted` changes are picked up by the loop.
  }, [source, fit])

  return <div ref={box} className="stepin-painted" aria-hidden="true" />
}

/**
 * The same painted look for a photo, without a second WebGL context: the museum's renderer
 * paints it once (painter.ts paintToCanvas) and the page fades that painting over the photo.
 * Fading in the page mixes the same way the shader did (in gamma), so it lifts the same.
 */
export function PaintedStill({
  src,
  turns = 0,
  paint,
  fit,
  painted,
  ms,
  onSettled,
}: {
  src: string
  /** Quarter turns clockwise that stand the photo upright. */
  turns?: QuarterTurns
  paint: (src: string, maxW: number, maxH: number, turns: QuarterTurns) => Promise<HTMLCanvasElement>
  fit: 'contain' | 'cover'
  painted: boolean
  ms: number
  onSettled?: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    const k = Math.min(2, window.devicePixelRatio || 1)
    const side = Math.min(2048, Math.ceil(Math.max(window.innerWidth, window.innerHeight) * k))
    paint(src, side, side, turns).then(
      (c) => !cancelled && setCanvas(c),
      () => !cancelled && setFailed(true),
    )
    return () => {
      cancelled = true
    }
  }, [src, turns, paint])
  useEffect(() => {
    const el = box.current
    if (!el || !canvas) return
    canvas.className = 'stepin-painted'
    canvas.style.objectFit = fit
    el.replaceChildren(canvas)
  }, [canvas, fit])

  // Fade toward the goal from wherever it is now, easing in and out.
  const settled = useRef(onSettled)
  useEffect(() => {
    settled.current = onSettled
  }, [onSettled])
  useEffect(() => {
    const el = box.current
    // Nothing to lift (the painting couldn't be made): it's already as taken.
    if (failed) return settled.current?.()
    if (!el || !canvas) return
    // Read where a running fade has got to before replacing it.
    const from = Number(getComputedStyle(el).opacity)
    el.getAnimations().forEach((a) => a.cancel())
    const a = el.animate([{ opacity: from }, { opacity: painted ? 1 : 0 }], { duration: ms, easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'forwards' })
    a.onfinish = () => settled.current?.()
  }, [painted, ms, canvas, failed])
  return <div ref={box} className="stepin-painted" aria-hidden="true" />
}
