import { SparkRenderer, SplatFileType, SplatMesh } from '@sparkjsdev/spark'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'

export type SplatStatus = { state: 'loading' } | { state: 'ready' } | { state: 'failed'; message: string }

interface Props {
  url: string
  /** Hidden but kept loaded, so switching back from the points is instant. */
  visible?: boolean
  /** Brightness multiplier, like StaticCloud's `dim`. */
  dim?: number
  onStatus: (status: SplatStatus) => void
}

/**
 * The room as 3D Gaussians (docs/capture-format.md "room splat"), drawn with Spark. The file is
 * in the same world coordinates as room.bin, so it needs no transform. Spark fetches and decodes
 * it in its own workers, and draws splats in three.js's transparent pass with depth test on and
 * depth write off: the people replay (opaque) hides splats behind it, and splats in front of it
 * blend over it.
 *
 * Loaded lazily (Spark is ~3 MB with its inlined WASM), so captures without a splat never pay for it.
 */
export default function SplatRoom({ url, visible = true, dim = 1, onStatus }: Props) {
  const gl = useThree((s) => s.gl)
  const [objects, setObjects] = useState<{ spark: SparkRenderer; mesh: SplatMesh } | null>(null)

  useEffect(() => {
    const spark = new SparkRenderer({ renderer: gl })
    const mesh = new SplatMesh({ url, fileType: SplatFileType.PLY })
    let live = true
    onStatus({ state: 'loading' })
    mesh.initialized.then(
      () => {
        if (!live) return
        setObjects({ spark, mesh })
        onStatus({ state: 'ready' })
      },
      (e: unknown) => live && onStatus({ state: 'failed', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
      setObjects(null)
      mesh.dispose()
      spark.dispose()
    }
  }, [gl, url, onStatus])

  // Spark multiplies every splat's color by `recolor`.
  const recolor = useMemo(() => new THREE.Color(dim, dim, dim), [dim])

  if (!objects) return null
  return (
    <>
      <primitive object={objects.spark} />
      <primitive object={objects.mesh} visible={visible} recolor={recolor} />
    </>
  )
}
