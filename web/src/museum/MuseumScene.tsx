import { Environment, Lightformer } from '@react-three/drei'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { memo, useEffect, useMemo, useRef, type Ref, type RefObject } from 'react'
import * as THREE from 'three'
import { Artwork } from './Artwork'
import { Furniture, Sconces, Window } from './Classic'
import { DiveCamera } from './DiveCamera'
import type { Exhibition } from './exhibitions'
import { walkable, type MuseumPlan } from './layout'
import { LOOK } from './looks'
import { Merged } from './Merged'
import { IDLE_HZ, idleFrameDue } from './pace'
import { choosePlaying, Playlist, type Piece } from './playback'
import { Rooms } from './Rooms'
import { useMuseumTextures } from './textures'
import { EYE, Walker, type WalkerHandle } from './Walker'
import type { Dive } from './warp'

/** Lighter settings on phones and tablets: smaller reflections, half-resolution shading. */
const handheld = typeof navigator !== 'undefined' && /iPad|iPhone|Android|Mobile/i.test(navigator.userAgent + (navigator.maxTouchPoints > 1 ? ' iPad' : ''))
const AO_COLOR = new THREE.Color('#1a1210')
const GL = { antialias: false, powerPreference: 'high-performance', stencil: false } as const
const DPR: [number, number] = handheld ? [1, 1.5] : [1, 2]

export function MuseumScene({
  exhibition,
  plan,
  focus,
  onSelect,
  onArrive,
  onLook,
  onMeasure,
  walker,
  onWalkerReady,
  frozen = false,
  paused = false,
  dive,
  onRenderer,
}: {
  exhibition: Exhibition
  plan: MuseumPlan
  focus: number
  onSelect: (slot: number) => void
  onArrive: () => void
  /** The piece the visitor is looking at while walking freely (−1: none). */
  onLook: (slot: number) => void
  onMeasure: (slot: number, w: number, h: number) => void
  walker: Ref<WalkerHandle>
  /** The walker can take walks now (mounted, or back at the entrance of a new plan). */
  onWalkerReady?: () => void
  /** While stepped into a picture: the museum holds still and ignores walking keys. */
  frozen?: boolean
  /** While the visitor is inside a visit's 3D room, hidden behind it: the museum stops drawing. */
  paused?: boolean
  /** Diving into a picture (or back out): flies the camera and blurs the view. */
  dive: RefObject<Dive | null>
  /** The museum's renderer, for painting a picture to step into (painter.ts paintToCanvas). */
  onRenderer?: (gl: THREE.WebGLRenderer) => void
}) {
  const walk = (walker as { current: WalkerHandle | null }) ?? null

  // Tap the floor to walk there (stopping short of a wall).
  const onFloor = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 8 || !walk?.current) return
    const from = walk.current.position()
    let to: [number, number] = [e.point.x, e.point.z]
    for (let i = 0; i < 40 && !walkable(plan, to[0], to[1]); i++) to = [to[0] + (from[0] - to[0]) * 0.1, to[1] + (from[1] - to[1]) * 0.1]
    if (walkable(plan, to[0], to[1])) walk.current.walkTo(to)
  }

  const first = plan.rooms[0]
  const last = plan.rooms[plan.rooms.length - 1]
  const playlist = useMemo(() => new Playlist(), [])
  const textures = useMuseumTextures()
  const pieces = useMemo<Piece[]>(
    () => exhibition.items.flatMap((art, i) => (plan.slots[i] ? [{ index: i, video: art.kind === 'video', center: plan.slots[i].center }] : [])),
    [exhibition.items, plan],
  )

  if (textures.error) return <div className="museum-message">{textures.error}</div>
  if (!textures.ready) return null
  return (
    <Canvas
      // Drawn on demand: walking, looking, dives and video frames ask for frames; Pacer keeps
      // the candles alive in between.
      frameloop={paused ? 'never' : 'demand'}
      dpr={DPR}
      camera={{ fov: 62, near: 0.05, far: 120, position: [plan.start[0], EYE, plan.start[1]] }}
      gl={GL}
      onCreated={({ gl }) => onRenderer?.(gl)}
    >
      <StaticMuseum plan={plan} count={exhibition.items.length} title={exhibition.title} subtitle={exhibition.subtitle ?? ''} />
      {/* An invisible floor to tap on (the visible one is a reflector). */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, (first.zFront + last.zBack) / 2]} onClick={onFloor}>
        <planeGeometry args={[plan.spec.width, first.zFront - last.zBack]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>

      {exhibition.items.map((art, i) =>
        plan.slots[i] ? <Artwork key={art.id} art={art} slot={plan.slots[i]} look={LOOK} focused={i === focus} onSelect={onSelect} onMeasure={onMeasure} playlist={playlist} /> : null,
      )}

      <Walker plan={plan} onArrive={onArrive} onLook={onLook} onReady={onWalkerReady} hung={exhibition.items.length} ref={walker} frozen={frozen} />
      <PlayPolicy playlist={playlist} pieces={pieces} focus={focus} still={paused} />
      <Pacer kick={`${frozen}:${paused}:${focus}`} />
      <Effects dive={dive} />
    </Canvas>
  )
}

/** Everything that doesn't change while walking: drawn merged, and never re-rendered by focus changes. */
const StaticMuseum = memo(function StaticMuseum({ plan, count, title, subtitle }: { plan: MuseumPlan; count: number; title: string; subtitle: string }) {
  const look = LOOK
  const first = plan.rooms[0]
  const last = plan.rooms[plan.rooms.length - 1]
  return (
    <>
      <color attach="background" args={[look.background]} />
      {/* Soft reflections in frames, glass and the floor: the room's light shapes, no image needed. */}
      <Environment resolution={256} frames={1} environmentIntensity={0.55}>
        <color attach="background" args={[look.background]} />
        {plan.rooms.map((r, i) => (
          <Lightformer
            key={i}
            form="rect"
            intensity={2.4}
            color={look.light}
            position={[0, plan.spec.height, (r.zFront + r.zBack) / 2]}
            rotation-x={Math.PI / 2}
            scale={[plan.spec.width * 0.5, plan.spec.depth * 0.6, 1]}
          />
        ))}
        <Lightformer form="rect" intensity={0.6} color={look.pool} position={[-plan.spec.width / 2, 2, (first.zFront + last.zBack) / 2]} rotation-y={Math.PI / 2} scale={[40, 2, 1]} />
        <Lightformer form="rect" intensity={0.6} color={look.pool} position={[plan.spec.width / 2, 2, (first.zFront + last.zBack) / 2]} rotation-y={-Math.PI / 2} scale={[40, 2, 1]} />
      </Environment>
      {/* Remade (and merged again) when the rooms or the pictures between the sconces change. */}
      <Merged key={`${plan.rooms.length}:${count}`}>
        <Rooms plan={plan} look={look} title={title} subtitle={subtitle} reflections={handheld ? 512 : 1024} />
        <Furniture plan={plan} />
        <Sconces plan={plan} count={count} />
        <Window plan={plan} />
      </Merged>
    </>
  )
})

const Effects = memo(function Effects({ dive }: { dive: RefObject<Dive | null> }) {
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <N8AO aoRadius={0.55} distanceFalloff={0.6} intensity={LOOK.occlusion * (handheld ? 0.75 : 1)} quality={handheld ? 'performance' : 'medium'} halfRes={handheld} color={AO_COLOR} />
      <SMAA />
      <Vignette offset={0.32} darkness={LOOK.vignette ? 0.42 : 0} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <DiveCamera dive={dive} />
    </EffectComposer>
  )
})

/** Plays the piece in focus and at most one near the visitor (playback.ts), checked a few times a second. */
function PlayPolicy({ playlist, pieces, focus, still }: { playlist: Playlist; pieces: Piece[]; focus: number; still: boolean }) {
  const camera = useThree((s) => s.camera)
  const last = useRef(0)
  useEffect(() => {
    // Hidden behind a visit's room: nothing in the museum needs to play.
    if (still) playlist.set([])
  }, [still, playlist])
  useEffect(() => () => playlist.set([]), [playlist])
  useFrame(() => {
    const now = performance.now()
    if (still || now - last.current < 250) return
    last.current = now
    playlist.set(choosePlaying(pieces, focus, [camera.position.x, camera.position.y, camera.position.z]))
  })
  return null
}

/**
 * Draws a frame when something outside the scene changed (`kick`), and keeps the candles
 * flickering at IDLE_HZ for a while after the last touch or key (pace.ts).
 */
function Pacer({ kick }: { kick: string }) {
  const invalidate = useThree((s) => s.invalidate)
  const lastActivity = useRef(0)
  useEffect(() => {
    lastActivity.current = performance.now()
    invalidate()
  }, [invalidate, kick])
  useEffect(() => {
    const touched = () => {
      lastActivity.current = performance.now()
      invalidate()
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const
    for (const e of events) window.addEventListener(e, touched, { passive: true })
    const timer = window.setInterval(() => idleFrameDue(performance.now(), lastActivity.current) && invalidate(), 1000 / IDLE_HZ)
    return () => {
      for (const e of events) window.removeEventListener(e, touched)
      window.clearInterval(timer)
    }
  }, [invalidate])
  return null
}
