import * as THREE from 'three'

/*
 * The museum's look for the family's photos and videos: an old oil painting. Snapshots and phone
 * videos look out of place in gilded frames on a red gallery wall, so every piece hangs as if
 * painted: soft brushwork (a Kuwahara filter, which flattens detail into strokes but keeps edges),
 * muted pigment under warm, slightly yellowed varnish, a canvas weave, and darkened edges. The
 * same look is laid over a piece as the visitor steps into it, then lifts away, leaving the
 * photo or video exactly as it was taken.
 */

/** How long the painting takes to lift away once the visitor is inside (ms). */
export const UNPAINT_MS = 2800
/** And how quickly it returns when they step back out (ms). */
export const REPAINT_MS = 650

/** One brush step, as a fraction of the picture's height: the same strokes at any resolution. */
const BRUSH = 1 / 300

/** The step between brush samples across and up a picture of this shape (width / height). */
export function brushStep(aspect: number): THREE.Vector2 {
  return new THREE.Vector2(BRUSH / Math.max(0.05, aspect), BRUSH)
}

/**
 * GLSL: `vec3 painting(vec2 uv)` and `vec3 shown(vec2 uv)` for a picture in `uPicture`, with
 * `uStep` (brushStep), `uAspect` (width / height) and `uAmount` (1: painted, 0: as taken).
 * Colors come out linear, like the texture's.
 */
export const PAINT_GLSL = /* glsl */ `
uniform sampler2D uPicture;
uniform vec2 uStep;
uniform float uAspect;
uniform float uAmount;

vec3 toGamma(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 at(vec2 uv) { return toGamma(texture2D(uPicture, uv).rgb); }

// Brushwork: of the four squares around a point, take the average color of the calmest one,
// so detail flattens into strokes while edges stay put.
vec3 strokes(vec2 uv) {
  vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
  vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
  for (int j = 0; j <= 3; j++) {
    for (int i = 0; i <= 3; i++) {
      vec2 o = vec2(float(i), float(j)) * uStep;
      vec3 a = at(uv + vec2(-o.x, -o.y));
      vec3 b = at(uv + vec2(o.x, -o.y));
      vec3 c = at(uv + vec2(-o.x, o.y));
      vec3 d = at(uv + o);
      m0 += a; s0 += a * a;
      m1 += b; s1 += b * b;
      m2 += c; s2 += c * c;
      m3 += d; s3 += d * d;
    }
  }
  m0 /= 16.0; m1 /= 16.0; m2 /= 16.0; m3 /= 16.0;
  vec3 v0 = s0 / 16.0 - m0 * m0;
  vec3 v1 = s1 / 16.0 - m1 * m1;
  vec3 v2 = s2 / 16.0 - m2 * m2;
  vec3 v3 = s3 / 16.0 - m3 * m3;
  float w0 = v0.r + v0.g + v0.b;
  float w1 = v1.r + v1.g + v1.b;
  float w2 = v2.r + v2.g + v2.b;
  float w3 = v3.r + v3.g + v3.b;
  vec3 best = m0;
  float least = w0;
  if (w1 < least) { least = w1; best = m1; }
  if (w2 < least) { least = w2; best = m2; }
  if (w3 < least) { best = m3; }
  return best;
}

vec3 painting(vec2 uv) {
  // Wobble where the brush samples, so the strokes don't fall on a grid.
  vec2 wobble = vec2(noise(uv * 900.0), noise(uv * 900.0 + 17.0)) - 0.5;
  vec3 c = strokes(uv + wobble * uStep * 2.0);
  // A little of the fine detail back, so faces stay readable.
  c = mix(c, at(uv), 0.12);

  // Brush marks: streaks of paint laid along the picture's contours (across its gradient), in
  // flat areas on a loose diagonal, lit from the top left like thick paint (impasto).
  vec2 d = uStep * 2.0;
  vec3 lum = vec3(0.299, 0.587, 0.114);
  vec2 g = vec2(dot(at(uv + vec2(d.x, 0.0)) - at(uv - vec2(d.x, 0.0)), lum), dot(at(uv + vec2(0.0, d.y)) - at(uv - vec2(0.0, d.y)), lum));
  vec2 along = mix(vec2(0.70710678), normalize(vec2(-g.y, g.x) + 1e-5), smoothstep(0.02, 0.12, length(g)));
  vec2 p = uv * vec2(uAspect, 1.0) / (uStep.y * 4.0);
  vec2 r = vec2(dot(p, along), dot(p, vec2(-along.y, along.x)));
  float paintH = noise(vec2(r.x * 0.55, r.y * 2.2)) * 0.7 + noise(vec2(r.x * 1.2, r.y * 5.0)) * 0.3;
  float paintH2 = noise(vec2(r.x * 0.55 + 0.15, r.y * 2.2 + 0.35)) * 0.7 + noise(vec2(r.x * 1.2 + 0.4, r.y * 5.0 + 0.8)) * 0.3;
  float relief = smoothstep(0.0, 1.0, (paintH - paintH2) * 3.0 + 0.5);
  float marks = clamp(1.4 - fwidth(r.y) * 0.9, 0.0, 1.0);
  c *= 1.0 + marks * (0.11 * (relief - 0.5) + 0.05 * (paintH - 0.5));

  // Old oil colours: rich but deep, under warm varnish that yellows the lights and keeps the
  // darks a warm brown rather than black.
  float l = dot(c, lum);
  c = mix(vec3(l), c, 1.1);
  c = pow(c, vec3(1.18));
  c *= vec3(1.06, 0.97, 0.78);
  c = mix(vec3(0.075, 0.045, 0.025), vec3(0.97, 0.9, 0.74), c);
  c = smoothstep(-0.03, 1.04, c);
  // The canvas weave, fading out where it would be finer than the screen can show.
  vec2 q = uv * vec2(uAspect, 1.0) * 300.0;
  float fine = clamp(1.6 - fwidth(q.y) * 2.2, 0.0, 1.0);
  float threads = (0.5 + 0.5 * sin(q.x * 3.14159 + 0.6 * sin(q.y * 0.9))) * (0.5 + 0.5 * sin(q.y * 3.14159));
  c *= 1.0 + fine * (0.07 * (threads - 0.5) + 0.02 * (hash(floor(q)) - 0.5));
  // Edges darkened by age and the frame's shadow.
  vec2 e = (uv - 0.5) * vec2(1.0, 1.0);
  c *= 1.0 - 0.42 * smoothstep(0.28, 0.75, length(e * vec2(1.0 + 0.2 * min(uAspect, 2.0), 1.2)));
  return c;
}

vec3 shown(vec2 uv) {
  vec3 base = texture2D(uPicture, uv).rgb;
  if (uAmount <= 0.001) return base;
  return toLinear(mix(toGamma(base), painting(uv), uAmount));
}
`

/** The material for a picture on a museum wall: painted, and shown in its own light (no shading). */
export function paintMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPicture: { value: null },
      uStep: { value: brushStep(4 / 3) },
      uAspect: { value: 4 / 3 },
      uAmount: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
  })
}

/** Points a painted material at a picture. */
export function setPicture(m: THREE.ShaderMaterial, texture: THREE.Texture | null, aspect: number) {
  m.uniforms.uPicture.value = texture
  m.uniforms.uAspect.value = aspect
  m.uniforms.uStep.value = brushStep(aspect)
}
