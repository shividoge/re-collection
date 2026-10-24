// Computes room splat sizes off the main thread (about a second for a million points).
import { splatSizes } from './gaps'

self.onmessage = (e: MessageEvent<Float32Array>) => {
  const sizes = splatSizes(e.data)
  ;(self as unknown as Worker).postMessage(sizes, [sizes.buffer])
}
