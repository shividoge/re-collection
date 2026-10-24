import { Html } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { fileUrl, guide, type CaptureSummary } from '../api'
import './museum.css'

/** Meters between frames along the hall; frames alternate left and right walls. */
const SPACING = 3.4
const HALF_WIDTH = 2.2
const EYE = 1.55
const FRAME_W = 1.5
const FRAME_H = 1.12
const LAST_KEY = 'braindance.museum.at'

type Moment = CaptureSummary & { side: 1 | -1; z: number }

/**
 * The Memory Museum: every moment the family captured (a LiDAR visit, or a scene rebuilt from
 * an old video) hangs as a picture frame in a calm hall, oldest first. There is no free roaming
 * to get lost in: tap a frame and you're walked to it; tap it again, or "Step into this moment",
 * and it opens as a Memory Window you can look into. Made for a tablet in someone's lap.
 */
export function Museum() {
  const [moments, setMoments] = useState<Moment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<number>(() => {
    try {
      return Number(sessionStorage.getItem(LAST_KEY) ?? -1)
    } catch {
      return -1
    }
  })

  useEffect(() => {
    guide
      .captures()
      .then((list) => {
        const ready = list
          .filter((c) => c.status.upload === 'done')
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        setMoments(ready.map((c, k) => ({ ...c, side: k % 2 === 0 ? -1 : 1, z: -(k + 1) * SPACING })))
        setAt((i) => Math.min(i, ready.length - 1))
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_KEY, String(at))
    } catch {
      /* private mode: the museum just starts at the entrance next time */
    }
  }, [at])

  const enter = (m: Moment) => {
    location.hash = `#/window/${m.id}?from=museum`
  }

  if (error) return <div className="museum-message">{error}</div>
  if (!moments) return <div className="museum-message">Opening the museum…</div>
  if (moments.length === 0) return <div className="museum-message">No moments yet. Film a visit with the app, or add an old video.</div>

  const current = at >= 0 ? moments[at] : null
  const go = (i: number) => setAt(Math.max(-1, Math.min(moments.length - 1, i)))

  return (
    <div className="museum">
      <Canvas dpr={[1, 2]} camera={{ fov: 62, near: 0.05, far: 200, position: [0, EYE, 4] }} gl={{ antialias: true }}>
        <color attach="background" args={['#1b1512']} />
        <fog attach="fog" args={['#1b1512', 8, 26]} />
        <Hall length={(moments.length + 1.5) * SPACING} />
        {moments.map((m, i) => (
          <Frame key={m.id} moment={m} index={i} active={i === at} onTap={() => (i === at ? enter(m) : setAt(i))} />
        ))}
        <Walker moments={moments} at={at} />
      </Canvas>

      <header className="museum-top">
        <a className="museum-exit" href="#/captures">
          ← Family tools
        </a>
        <div className="museum-title">
          <h1>Your memories</h1>
          <p>{current ? 'Tap the picture to step inside.' : 'Tap a picture, or press Next, to walk to it.'}</p>
        </div>
      </header>

      <footer className="museum-bottom">
        <button className="museum-nav" onClick={() => go(at - 1)} disabled={at < 0} aria-label="Previous moment">
          ← Previous
        </button>
        <div className="museum-caption">
          {current ? (
            <>
              <strong>{current.title || 'A visit'}</strong>
              <span>
                {current.createdAt ? new Date(current.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : ''}
                {current.source === 'video' && <span className="estimated-badge">Estimated from a video</span>}
              </span>
              <button className="museum-enter" onClick={() => enter(current)}>
                Step into this moment
              </button>
            </>
          ) : (
            <strong>{moments.length} {moments.length === 1 ? 'moment' : 'moments'} to visit</strong>
          )}
        </div>
        <button className="museum-nav" onClick={() => go(at + 1)} disabled={at >= moments.length - 1} aria-label="Next moment">
          Next →
        </button>
      </footer>
    </div>
  )
}

/** A warm, quiet hall: wooden floor, cream walls, soft light. */
function Hall({ length }: { length: number }) {
  const mid = -length / 2 + 2
  return (
    <group>
      <hemisphereLight args={['#fff4e6', '#3a2a20', 0.9]} />
      <ambientLight intensity={0.35} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, mid]}>
        <planeGeometry args={[HALF_WIDTH * 2, length + 8]} />
        <meshStandardMaterial color="#6b4f3a" roughness={0.8} />
      </mesh>
      {/* a runner down the middle of the hall */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, mid]}>
        <planeGeometry args={[1.1, length + 8]} />
        <meshStandardMaterial color="#8a3b2e" roughness={0.95} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[side * HALF_WIDTH, 1.8, mid]} rotation={[0, -side * (Math.PI / 2), 0]}>
            <planeGeometry args={[length + 8, 3.6]} />
            <meshStandardMaterial color="#e9dfcf" roughness={0.9} />
          </mesh>
          <mesh position={[side * (HALF_WIDTH - 0.01), 0.06, mid]} rotation={[0, -side * (Math.PI / 2), 0]}>
            <planeGeometry args={[length + 8, 0.12]} />
            <meshStandardMaterial color="#4a3426" />
          </mesh>
        </group>
      ))}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 3.6, mid]}>
        <planeGeometry args={[HALF_WIDTH * 2, length + 8]} />
        <meshStandardMaterial color="#2a201b" />
      </mesh>
    </group>
  )
}

/** One moment: a framed picture (the visit's own thumbnail), a small light above it, a plaque. */
function Frame({ moment, index, active, onTap }: { moment: Moment; index: number; active: boolean; onTap: () => void }) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null)
  useEffect(() => {
    if (!moment.thumb) return
    let disposed = false
    new THREE.TextureLoader().load(fileUrl(moment.thumb), (t) => {
      if (disposed) return t.dispose()
      t.colorSpace = THREE.SRGBColorSpace
      setTexture(t)
    })
    return () => {
      disposed = true
    }
  }, [moment.thumb])
  useEffect(() => () => texture?.dispose(), [texture])

  // Fit the picture inside the frame, keeping its shape.
  const [pw, ph] = useMemo(() => {
    const img = texture?.image as { width?: number; height?: number } | undefined
    const aspect = img?.width && img?.height ? img.width / img.height : 4 / 3
    const inner = [FRAME_W - 0.16, FRAME_H - 0.16]
    return aspect > inner[0] / inner[1] ? [inner[0], inner[0] / aspect] : [inner[1] * aspect, inner[1]]
  }, [texture])

  const x = moment.side * (HALF_WIDTH - 0.04)
  const facing = moment.side === -1 ? Math.PI / 2 : -Math.PI / 2
  return (
    <group position={[x, 1.6, moment.z]} rotation={[0, facing, 0]}>
      <pointLight position={[0, 1.1, 0.8]} intensity={active ? 6 : 3} distance={3.5} color="#ffe2b8" />
      <mesh
        onClick={(e) => {
          e.stopPropagation()
          onTap()
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <boxGeometry args={[FRAME_W, FRAME_H, 0.06]} />
        <meshStandardMaterial color={active ? '#c9973f' : '#8f6a3a'} metalness={0.4} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0, 0.032]} onClick={(e) => (e.stopPropagation(), onTap())}>
        <planeGeometry args={[FRAME_W - 0.08, FRAME_H - 0.08]} />
        <meshStandardMaterial color="#f3ecdf" />
      </mesh>
      <mesh position={[0, 0, 0.034]} onClick={(e) => (e.stopPropagation(), onTap())}>
        <planeGeometry args={[pw, ph]} />
        {texture ? <meshBasicMaterial map={texture} toneMapped={false} /> : <meshStandardMaterial color="#3a3330" />}
      </mesh>
      <Html position={[0, -FRAME_H / 2 - 0.2, 0.05]} transform distanceFactor={1.6} occlude={false} pointerEvents="none">
        <div className={`museum-plaque ${active ? 'on' : ''}`}>
          <strong>{moment.title || `Moment ${index + 1}`}</strong>
          <span>{moment.createdAt ? new Date(moment.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''}</span>
        </div>
      </Html>
    </group>
  )
}

const target = new THREE.Vector3()
const look = new THREE.Vector3()
const goalQuat = new THREE.Quaternion()
// A camera, not a plain Object3D: lookAt points a camera's -z at the target (a plain object's +z).
const helper = new THREE.PerspectiveCamera()

/** Walks the camera to the chosen frame, slowly, and turns toward it. */
function Walker({ moments, at }: { moments: Moment[]; at: number }) {
  const camera = useThree((s) => s.camera)
  useFrame((_, delta) => {
    const m = at >= 0 ? moments[at] : null
    if (m) {
      // Stand across the hall from the picture, a little before it, and face it.
      target.set(-m.side * 0.55, EYE, m.z + 1.1)
      look.set(m.side * HALF_WIDTH, 1.55, m.z)
    } else {
      target.set(0, EYE, 3.2)
      look.set(0, 1.5, -SPACING * 2)
    }
    const a = 1 - Math.exp(-Math.min(delta, 0.1) * 1.6)
    camera.position.lerp(target, a)
    helper.position.copy(camera.position)
    helper.lookAt(look)
    goalQuat.copy(helper.quaternion)
    camera.quaternion.slerp(goalQuat, a)
  })
  return null
}
