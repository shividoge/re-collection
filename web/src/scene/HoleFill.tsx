import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

/**
 * Screen-space hole filling, as in point-cloud viewers like Potree. The scene is drawn to an
 * offscreen buffer; then every pixel that is empty, or shows a farther surface through a gap,
 * takes the color of the nearer surface around it, but only when that surface encloses it on
 * at least three of four axes (left/right, up/down and both diagonals) at a similar depth. So
 * pinholes and streaks inside a scanned surface close at any zoom, while outer edges, real
 * openings wider than `radius` pixels, and depth edges between objects stay as they are.
 */
export function HoleFill({ radius = 12 }: { radius?: number }) {
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)

  const target = useMemo(() => {
    const t = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, samples: 0 })
    t.depthTexture = new THREE.DepthTexture(1, 1)
    t.depthTexture.type = THREE.UnsignedIntType
    return t
  }, [])
  useEffect(() => {
    target.setSize(Math.max(1, Math.floor(size.width * dpr)), Math.max(1, Math.floor(size.height * dpr)))
  }, [target, size.width, size.height, dpr])
  useEffect(() => () => target.dispose(), [target])

  const pass = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: target.texture },
        tDepth: { value: target.depthTexture },
        uTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.01 },
        uFar: { value: 100 },
        uRadius: { value: radius },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 uTexel;
        uniform float uNear;
        uniform float uFar;
        uniform float uRadius;
        varying vec2 vUv;
        const int MAX_R = 24;
        const float EMPTY = 1e9;

        float viewDepth(float z) {
          if (z >= 0.999999) return EMPTY;
          float ndc = z * 2.0 - 1.0;
          return 2.0 * uNear * uFar / (uFar + uNear - ndc * (uFar - uNear));
        }

        // Walks from this pixel in one direction to the first surface nearer than d0.
        // Returns (depth, distance) or (EMPTY, 0) if there's none within the radius, or if a
        // surface at this pixel's own depth (or farther) comes first: then it isn't a hole.
        vec2 nearest(vec2 dir, float d0, out vec3 color) {
          color = vec3(0.0);
          for (int s = 1; s <= MAX_R; s++) {
            if (float(s) > uRadius) break;
            vec2 uv = vUv + dir * float(s) * uTexel;
            float d = viewDepth(texture2D(tDepth, uv).r);
            if (d == EMPTY) continue;
            if (d < d0 * 0.95) {
              color = texture2D(tColor, uv).rgb;
              return vec2(d, float(s));
            }
            return vec2(EMPTY, 0.0);
          }
          return vec2(EMPTY, 0.0);
        }

        void main() {
          vec4 here = texture2D(tColor, vUv);
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
          gl_FragColor = enclosed ? vec4(sum / wsum, 1.0) : here;
        }
      `,
      depthTest: false,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    mesh.frustumCulled = false
    const scene = new THREE.Scene()
    scene.add(mesh)
    return { scene, material, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) }
  }, [target, radius])
  useEffect(
    () => () => {
      pass.material.dispose()
      ;(pass.scene.children[0] as THREE.Mesh).geometry.dispose()
    },
    [pass],
  )

  // Priority 1: this takes over rendering from react-three-fiber.
  useFrame(({ scene, camera }) => {
    const cam = camera as THREE.PerspectiveCamera
    const u = pass.material.uniforms
    u.uTexel.value.set(1 / target.width, 1 / target.height)
    u.uNear.value = cam.near
    u.uFar.value = cam.far
    u.uRadius.value = radius * dpr
    gl.setRenderTarget(target)
    gl.render(scene, camera)
    gl.setRenderTarget(null)
    gl.render(pass.scene, pass.camera)
  }, 1)

  return null
}
