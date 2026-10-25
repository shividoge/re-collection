import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const VIEW_DEPTH = /* glsl */ `
  uniform float uNear;
  uniform float uFar;
  const float EMPTY = 1e9;
  float viewDepth(float z) {
    if (z >= 0.999999) return EMPTY;
    float ndc = z * 2.0 - 1.0;
    return 2.0 * uNear * uFar / (uFar + uNear - ndc * (uFar - uNear));
  }
`

/**
 * Pass 1, at half resolution: for each pixel, whether it is a hole enclosed by one nearer
 * surface, and if so the color to fill it with and that surface's depth (alpha; 0 = no fill).
 */
const FILL_FRAGMENT = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;     // one full-resolution pixel
  uniform float uRadius;   // in full-resolution pixels
  varying vec2 vUv;
  ${VIEW_DEPTH}
  const int MAX_STEPS = 16;

  // Walks from this pixel in one direction to the first surface nearer than d0, two
  // full-resolution pixels per step. Returns (depth, distance) or (EMPTY, 0) if there's none
  // within the radius, or if a surface at this pixel's own depth (or farther) comes first.
  vec2 nearest(vec2 dir, float d0, out vec3 color) {
    color = vec3(0.0);
    for (int s = 1; s <= MAX_STEPS; s++) {
      float dist = float(s) * 2.0;
      if (dist > uRadius) break;
      vec2 uv = vUv + dir * dist * uTexel;
      float d = viewDepth(texture2D(tDepth, uv).r);
      if (d == EMPTY) continue;
      if (d < d0 * 0.95) {
        color = texture2D(tColor, uv).rgb;
        return vec2(d, dist);
      }
      return vec2(EMPTY, 0.0);
    }
    return vec2(EMPTY, 0.0);
  }

  void main() {
    float d0 = viewDepth(texture2D(tDepth, vUv).r);
    vec2 dirs[8];
    dirs[0] = vec2(1.0, 0.0);  dirs[4] = vec2(-1.0, 0.0);
    dirs[1] = vec2(0.0, 1.0);  dirs[5] = vec2(0.0, -1.0);
    dirs[2] = vec2(0.7071, 0.7071);   dirs[6] = vec2(-0.7071, -0.7071);
    dirs[3] = vec2(0.7071, -0.7071);  dirs[7] = vec2(-0.7071, 0.7071);
    vec2 hit[8];
    vec3 col[8];
    for (int k = 0; k < 8; k++) hit[k] = nearest(dirs[k], d0, col[k]);

    int axes = 0;
    float lo = EMPTY;
    float hi = 0.0;
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int k = 0; k < 4; k++) {
      if (hit[k].x < EMPTY && hit[k + 4].x < EMPTY) axes++;
    }
    for (int k = 0; k < 8; k++) {
      if (hit[k].x == EMPTY) continue;
      lo = min(lo, hit[k].x);
      hi = max(hi, hit[k].x);
      float w = 1.0 / hit[k].y;
      sum += col[k] * w;
      wsum += w;
    }
    // Enclosed on three of four axes, by one surface (similar depths all round).
    bool enclosed = axes >= 3 && hi - lo <= 0.03 + 0.06 * lo;
    gl_FragColor = enclosed ? vec4(sum / wsum, hi) : vec4(0.0);
  }
`

/**
 * Pass 2, at full resolution: the scene as drawn, except pixels that are empty or show something
 * behind an enclosing surface, which take that surface's fill color. Sharp edges stay sharp.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tFill;
  varying vec2 vUv;
  ${VIEW_DEPTH}
  void main() {
    vec4 here = texture2D(tColor, vUv);
    vec4 fill = texture2D(tFill, vUv);
    float d0 = viewDepth(texture2D(tDepth, vUv).r);
    gl_FragColor = fill.a > 0.0 && d0 * 0.95 > fill.a ? vec4(fill.rgb, 1.0) : here;
  }
`

/** Highest device pixel ratio while hole filling runs: the post-pass reads many pixels each. */
export const HOLE_FILL_MAX_DPR = 1.5

/**
 * Screen-space hole filling, as in point-cloud viewers like Potree, for the room drawn as points.
 * The scene is drawn (with MSAA) to an offscreen buffer; then every pixel that is empty, or shows
 * a farther surface through a gap, takes the color of the nearer surface around it, but only
 * when that surface encloses it on at least three of four axes (left/right, up/down and both
 * diagonals) at a similar depth. So pinholes and streaks inside a scanned surface close at any
 * zoom, while outer edges, real openings wider than `radius` pixels, and depth edges between
 * objects stay as they are. The search runs at half resolution; the result is applied per
 * full-resolution pixel.
 */
export class HoleFillPass {
  private target: THREE.WebGLRenderTarget
  private fillTarget: THREE.WebGLRenderTarget
  private fill: THREE.ShaderMaterial
  private composite: THREE.ShaderMaterial
  private quad: THREE.Mesh
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private viewport = new THREE.Vector4()
  private scissor = new THREE.Vector4()
  private radius: number

  constructor(radius = 12) {
    this.radius = radius
    // MSAA on the scene buffer: the canvas's own antialiasing would only smooth the final quad.
    this.target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, depthBuffer: true })
    this.target.depthTexture = new THREE.DepthTexture(1, 1)
    this.target.depthTexture.type = THREE.UnsignedIntType
    this.fillTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
    const depthUniforms = { uNear: { value: 0.01 }, uFar: { value: 100 } }
    this.fill = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: radius },
        ...depthUniforms,
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: FILL_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.composite = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: this.target.texture }, tDepth: { value: this.target.depthTexture }, tFill: { value: this.fillTarget.texture }, ...depthUniforms },
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fill)
    this.quad.frustumCulled = false
  }

  /** Draws `scene` hole-filled into the renderer's current viewport (the canvas, or one view of it). */
  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, dpr: number) {
    gl.getViewport(this.viewport)
    gl.getScissor(this.scissor)
    const scissorOn = gl.getScissorTest()
    const ratio = gl.getPixelRatio()
    const w = Math.max(1, Math.floor(this.viewport.z * ratio))
    const h = Math.max(1, Math.floor(this.viewport.w * ratio))
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h)
      this.fillTarget.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1))
    }
    const cam = camera as THREE.PerspectiveCamera
    const u = this.fill.uniforms
    u.uTexel.value.set(1 / w, 1 / h)
    u.uNear.value = cam.near
    u.uFar.value = cam.far
    u.uRadius.value = this.radius * dpr

    gl.setRenderTarget(this.target)
    gl.clear()
    gl.render(scene, camera)
    this.quad.material = this.fill
    gl.setRenderTarget(this.fillTarget)
    gl.render(this.quad, this.camera)
    gl.setRenderTarget(null)
    gl.setViewport(this.viewport)
    gl.setScissor(this.scissor)
    gl.setScissorTest(scissorOn)
    this.quad.material = this.composite
    gl.render(this.quad, this.camera)
  }

  dispose() {
    this.target.depthTexture?.dispose()
    this.target.dispose()
    this.fillTarget.dispose()
    this.fill.dispose()
    this.composite.dispose()
    this.quad.geometry.dispose()
  }
}

/**
 * Hole filling for a whole canvas: takes over rendering from react-three-fiber while mounted,
 * and caps the device pixel ratio at HOLE_FILL_MAX_DPR.
 */
export function HoleFill({ radius = 12 }: { radius?: number }) {
  const setDpr = useThree((s) => s.setDpr)
  const dpr = useThree((s) => s.viewport.dpr)
  const invalidate = useThree((s) => s.invalidate)
  const pass = useMemo(() => new HoleFillPass(radius), [radius])
  useEffect(() => () => pass.dispose(), [pass])
  useEffect(() => {
    const before = dpr
    if (before <= HOLE_FILL_MAX_DPR) return
    setDpr(HOLE_FILL_MAX_DPR)
    return () => setDpr(before)
    // Only on mount: `dpr` changes because of this effect.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [setDpr])
  useEffect(() => invalidate(), [invalidate, pass])

  // Priority 1: this takes over rendering from react-three-fiber.
  useFrame(({ gl, scene, camera, viewport }) => pass.render(gl, scene, camera, viewport.dpr), 1)
  return null
}
