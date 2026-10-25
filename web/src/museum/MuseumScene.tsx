import { Environment, Lightformer } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { useMemo, type Ref, type RefObject } from 'react'
import * as THREE from 'three'
import { Artwork } from './Artwork'
import { Furniture, Sconces, Window } from './Classic'
import { DiveCamera } from './DiveCamera'
import type { Exhibition } from './exhibitions'
import { walkable, type MuseumPlan } from './layout'
import { LOOK } from './looks'
import { Rooms } from './Rooms'
import { EYE, Walker, type Pose, type WalkerHandle } from './Walker'
import type { Dive } from './warp'

/** Lighter settings on phones and tablets: smaller reflections, half-resolution shading. */
const handheld = typeof navigator !== 'undefined' && /iPad|iPhone|Android|Mobile/i.test(navigator.userAgent + (navigator.maxTouchPoints > 1 ? ' iPad' : ''))

export function MuseumScene({
  exhibition,
  plan,
  focus,
  onSelect,
  onArrive,
  onLook,
  onMeasure,
  walker,
  frozen = false,
  paused = false,
  dive,
  follow,
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
  /** While stepped into a picture: the museum holds still and ignores walking keys. */
  frozen?: boolean
  /** While the visitor is inside a visit's 3D room, hidden behind it: the museum stops drawing. */
  paused?: boolean
  /** Diving into a picture (or back out): flies the camera and blurs the view. */
  dive: RefObject<Dive | null>
  /** Family in a live visit: the view follows this pose (the patient's). */
  follow?: RefObject<Pose | null>
}) {
  const look = LOOK
  const walk = (walker as { current: WalkerHandle | null }) ?? null

  // Tap the floor to walk there (stopping short of a wall).
  const onFloor = (e: ThreeEvent<MouseEvent>) => {
    // Following someone in a live visit: no walking off on your own.
    if (e.delta > 8 || !walk?.current || follow?.current) return
    const from = walk.current.position()
    let to: [number, number] = [e.point.x, e.point.z]
    for (let i = 0; i < 40 && !walkable(plan, to[0], to[1]); i++) to = [to[0] + (from[0] - to[0]) * 0.1, to[1] + (from[1] - to[1]) * 0.1]
    if (walkable(plan, to[0], to[1])) walk.current.walkTo(to)
  }

  const first = plan.rooms[0]
  const last = plan.rooms[plan.rooms.length - 1]
  const lights = useMemo(
    () =>
      plan.rooms.map((r) => ({
        z: (r.zFront + r.zBack) / 2,
      })),
    [plan],
  )

  return (
    <Canvas
      frameloop={paused ? 'never' : 'always'}
      dpr={handheld ? [1, 1.5] : [1, 2]}
      camera={{ fov: 62, near: 0.05, far: 120, position: [plan.start[0], EYE, plan.start[1]] }}
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
    >
      <color attach="background" args={[look.background]} />

      {/* Soft reflections in frames, glass and the floor: the room's light shapes, no image needed. */}
      <Environment resolution={256} frames={1} environmentIntensity={0.55}>
        <color attach="background" args={[look.background]} />
        {lights.map((l, i) => (
          <Lightformer key={i} form="rect" intensity={2.4} color={look.light} position={[0, plan.spec.height, l.z]} rotation-x={Math.PI / 2} scale={[plan.spec.width * 0.5, plan.spec.depth * 0.6, 1]} />
        ))}
        <Lightformer form="rect" intensity={0.6} color={look.pool} position={[-plan.spec.width / 2, 2, (first.zFront + last.zBack) / 2]} rotation-y={Math.PI / 2} scale={[40, 2, 1]} />
        <Lightformer form="rect" intensity={0.6} color={look.pool} position={[plan.spec.width / 2, 2, (first.zFront + last.zBack) / 2]} rotation-y={-Math.PI / 2} scale={[40, 2, 1]} />
      </Environment>

      <Rooms plan={plan} look={look} title={exhibition.title} subtitle={exhibition.subtitle ?? ''} reflections={handheld ? 512 : 1024} />
      <Furniture plan={plan} />
      <Sconces plan={plan} count={exhibition.items.length} />
      <Window plan={plan} />
      {/* An invisible floor to tap on (the visible one is a reflector). */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, (first.zFront + last.zBack) / 2]} onClick={onFloor}>
        <planeGeometry args={[plan.spec.width, first.zFront - last.zBack]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>

      {exhibition.items.map((art, i) =>
        plan.slots[i] ? <Artwork key={art.id} art={art} slot={plan.slots[i]} look={look} focused={i === focus} onSelect={onSelect} onMeasure={onMeasure} /> : null,
      )}

      <Walker plan={plan} onArrive={onArrive} onLook={onLook} hung={exhibition.items.length} ref={walker} frozen={frozen} follow={follow} />

      <EffectComposer multisampling={0} enableNormalPass={false}>
        <N8AO aoRadius={0.55} distanceFalloff={0.6} intensity={look.occlusion * (handheld ? 0.75 : 1)} quality={handheld ? 'performance' : 'medium'} halfRes={handheld} color={new THREE.Color('#1a1210')} />
        <SMAA />
        <Vignette offset={0.32} darkness={look.vignette ? 0.42 : 0} />
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
        <DiveCamera dive={dive} />
      </EffectComposer>
    </Canvas>
  )
}
