import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import type { RoomCloud as Room } from '../capture';
import { makeRoomPointMaterial, pointScale } from './pointMaterial';

/** The scanned room: every point exactly where the phone measured it. Gaps stay empty. */
export function RoomCloud({ room, dim }: { room: Room; dim: number }) {
  const size = useThree((state) => state.size);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(room.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(room.colors, 3, true));
    g.computeBoundingSphere();
    return g;
  }, [room]);
  const material = useMemo(makeRoomPointMaterial, []);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ camera }) => {
    material.uniforms.uScale.value = pointScale(camera, size.height);
    material.uniforms.uDim.value = THREE.MathUtils.lerp(material.uniforms.uDim.value, dim, 0.1);
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
