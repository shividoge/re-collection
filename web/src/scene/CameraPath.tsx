import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

import type { Timeline } from '../capture';

const scratch = new THREE.Matrix4();

/** Where the phone went: the scan path faintly, the moment's path brighter. */
export function CameraPath({ timeline }: { timeline: Timeline }) {
  const moment = useMemo(() => {
    const points: [number, number, number][] = [];
    for (let k = 0; k < timeline.count; k += 2) {
      const o = k * 16;
      points.push([timeline.transforms[o + 12], timeline.transforms[o + 13], timeline.transforms[o + 14]]);
    }
    return points;
  }, [timeline]);

  const scan = useMemo(() => {
    const points: [number, number, number][] = [];
    for (let k = 0; k < timeline.scanPath.length; k += 3 * 3) {
      points.push([timeline.scanPath[k], timeline.scanPath[k + 1], timeline.scanPath[k + 2]]);
    }
    return points;
  }, [timeline]);

  return (
    <group>
      {scan.length > 1 && <Line points={scan} color="#5b6b7f" lineWidth={1} transparent opacity={0.35} />}
      {moment.length > 1 && <Line points={moment} color="#ff5c3a" lineWidth={1.5} transparent opacity={0.8} />}
    </group>
  );
}

/** A small frustum showing where the phone was at the current video frame. */
export function CameraMarker({ timeline, frameRef }: { timeline: Timeline; frameRef: React.RefObject<number> }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const frame = frameRef.current;
    if (!group.current || frame < 0) return;
    scratch.fromArray(timeline.transforms, frame * 16);
    group.current.matrix.copy(scratch);
    group.current.matrixWorldNeedsUpdate = true;
  });

  // A 4:3 pyramid looking down -z, like the ARKit camera.
  const s = 0.08;
  const corners: [number, number, number][] = [
    [-s, -0.75 * s, -1.5 * s],
    [s, -0.75 * s, -1.5 * s],
    [s, 0.75 * s, -1.5 * s],
    [-s, 0.75 * s, -1.5 * s],
  ];
  const lines: [number, number, number][] = [];
  for (const c of corners) lines.push([0, 0, 0], c);
  lines.push(...corners, corners[0]);

  return (
    <group ref={group} matrixAutoUpdate={false}>
      <Line points={lines} segments={false} color="#ffb347" lineWidth={2} />
    </group>
  );
}
