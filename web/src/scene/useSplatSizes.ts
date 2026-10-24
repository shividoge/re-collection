import { useEffect, useState } from 'react'
import type { PointCloud } from './formats'

/**
 * Per-point splat sizes for the room, so neighboring points overlap into surfaces (see gaps.ts).
 * Null until the worker finishes; the cloud draws at a fixed size meanwhile.
 */
export function useSplatSizes(cloud: PointCloud | null): Float32Array | null {
  const [sizes, setSizes] = useState<{ cloud: PointCloud; sizes: Float32Array } | null>(null)
  useEffect(() => {
    if (!cloud) return
    const worker = new Worker(new URL('./splatWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<Float32Array>) => setSizes({ cloud, sizes: e.data })
    worker.onerror = () => worker.terminate() // keep the fixed size; nothing else depends on it
    worker.postMessage(cloud.positions.slice())
    return () => worker.terminate()
  }, [cloud])
  return sizes && sizes.cloud === cloud ? sizes.sizes : null
}
