import * as THREE from 'three'
import { brushStep, PAINT_GLSL } from './paint'

/*
 * Paints pictures as oil paintings (paint.ts) once, into a texture, instead of on every frame:
 * a photo is painted when it loads and then shown like any other picture (one texture read per
 * pixel, mipmapped, in the room and in the floor's reflection). A video is repainted only when
 * it has a new frame. Everything is drawn with the museum's own renderer.
 */

/** A painted photo is this many pixels tall at most (a picture fills about half an iPad's height when you stand at it). */
export const PHOTO_HEIGHT = 768
/** A playing video is repainted at this height. */
export const VIDEO_HEIGHT = 432

/** Pixel size to paint a `w` × `h` picture at, no taller than `maxH` and never enlarged. */
export function paintSize(w: number, h: number, maxH: number, maxW = Infinity): [number, number] {
  if (!(w > 0 && h > 0)) return [1, 1]
  const k = Math.min(1, maxH / h, maxW / w)
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]
}

/** A texture to paint into: stored as sRGB (no banding in the darks), with mipmaps for distance. */
export function paintTarget(w: number, h: number, mipmaps = true): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(w, h, {
    depthBuffer: false,
    generateMipmaps: mipmaps,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.SRGBColorSpace,
  })
  t.texture.anisotropy = 8
  return t
}

let quad: { scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial } | null = null

function paintQuad() {
  if (quad) return quad
  const material = new THREE.ShaderMaterial({
    uniforms: { uPicture: { value: null }, uStep: { value: brushStep(4 / 3) }, uAspect: { value: 4 / 3 }, uAmount: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${PAINT_GLSL}
      varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(shown(vUv), 1.0);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
  })
  const scene = new THREE.Scene()
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  mesh.frustumCulled = false
  scene.add(mesh)
  quad = { scene, camera: new THREE.Camera(), material }
  return quad
}

/** Paints `source` (a picture `aspect` wide per unit of height) into `target`, fully painted. */
export function paintInto(gl: THREE.WebGLRenderer, source: THREE.Texture, aspect: number, target: THREE.WebGLRenderTarget) {
  const { scene, camera, material } = paintQuad()
  material.uniforms.uPicture.value = source
  material.uniforms.uAspect.value = aspect
  material.uniforms.uStep.value = brushStep(aspect)
  const before = gl.getRenderTarget()
  gl.setRenderTarget(target)
  gl.clear(true, false, false)
  gl.render(scene, camera)
  gl.setRenderTarget(before)
  material.uniforms.uPicture.value = null
}

/** Decodes an image off the main thread into a texture (the right way up). */
export async function loadPicture(src: string): Promise<{ texture: THREE.Texture; width: number; height: number }> {
  const loader = new THREE.ImageBitmapLoader()
  loader.setOptions({ imageOrientation: 'flipY' })
  loader.setCrossOrigin('anonymous')
  const bitmap = await loader.loadAsync(src)
  const texture = new THREE.Texture(bitmap)
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  // Mipmapped, so painting a big photo smaller doesn't shimmer.
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.needsUpdate = true
  texture.addEventListener('dispose', () => bitmap.close())
  return { texture, width: bitmap.width, height: bitmap.height }
}

/**
 * The painting of a photo at up to `maxW` × `maxH` pixels, as a canvas for the page (stepping
 * into a picture lays it over the photo, then fades it to leave the photo as taken). Painted
 * with the museum's renderer and read back without stalling it.
 */
export async function paintToCanvas(gl: THREE.WebGLRenderer, src: string, maxW: number, maxH: number): Promise<HTMLCanvasElement> {
  const { texture, width, height } = await loadPicture(src)
  const [w, h] = paintSize(width, height, maxH, maxW)
  const target = paintTarget(w, h, false)
  try {
    paintInto(gl, texture, width / height, target)
    const pixels = new Uint8Array(w * h * 4)
    await gl.readRenderTargetPixelsAsync(target, 0, 0, w, h, pixels)
    // The target's rows run bottom-up; a canvas's top-down.
    const image = new ImageData(w, h)
    for (let y = 0; y < h; y++) image.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')!.putImageData(image, 0, 0)
    return canvas
  } finally {
    target.dispose()
    texture.dispose()
  }
}
