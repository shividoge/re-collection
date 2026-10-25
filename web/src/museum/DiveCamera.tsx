import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type RefObject } from 'react'
import type * as THREE from 'three'
import { flyDive, WarpBlurEffect, type Dive } from './warp'

/**
 * Flies the camera into (or back out of) a picture while a dive is on, and blurs the museum
 * with it. Goes inside the EffectComposer, last: the blur is its own pass over the finished image.
 */
export function DiveCamera({ dive }: { dive: RefObject<Dive | null> }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const effect = useMemo(() => new WarpBlurEffect(), [])
  useEffect(() => () => effect.dispose(), [effect])
  useFrame(() => {
    const d = dive.current
    if (!d) return effect.set(0, 0, [0.5, 0.5])
    const { blur, flash, center } = flyDive(d, camera, performance.now())
    effect.set(blur, flash, center)
  })
  return <primitive object={effect} dispose={null} />
}
