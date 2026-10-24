import * as THREE from 'three';

/**
 * Round, softly edged points whose size shrinks with distance, so the cloud
 * reads as surfaces up close and stays light far away.
 */
export function makeRoomPointMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 0.012 },          // world-space diameter in meters
      uScale: { value: 800 },           // viewport height in pixels / 2 / tan(fov/2); set per frame
      uOpacity: { value: 1 },
      uDim: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uScale;
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize * uScale / -mv.z, 1.0, 24.0);
        vColor = color;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform float uDim;
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = dot(c, c);
        if (r > 0.25) discard;
        float edge = smoothstep(0.25, 0.16, r);
        gl_FragColor = vec4(vColor * uDim, uOpacity * edge);
      }
    `,
    transparent: true,
    depthWrite: true,
  });
}

/** Keeps uScale right for the current camera and canvas size. */
export function pointScale(camera: THREE.Camera, heightPx: number): number {
  const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 60;
  return heightPx / 2 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
}
