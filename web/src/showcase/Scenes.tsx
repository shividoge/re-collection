import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { publicGuide } from '../api';
import type { RoomCloud as Room } from '../capture';
import { CameraMarker, CameraPath } from '../scene/CameraPath';
import { DepthReplay } from '../scene/DepthReplay';
import { RoomCloud } from '../scene/RoomCloud';
import { CameraRig, Clock } from '../views/Viewer';
import { loadAssets } from './assets';
import type { Assets } from './assets';

function useAssets(id: string) {
  const [assets, setAssets] = useState<Assets | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAssets(null);
    setFailed(false);
    loadAssets(id).then((a) => !cancelled && setAssets(a)).catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id]);
  return { assets, failed };
}

/** Slowly circles the scanned room, like a dolly shot. */
function AutoOrbit({ room }: { room: Room }) {
  const camera = useThree((s) => s.camera);
  const frame = useMemo(() => {
    const box = new THREE.Box3().setFromArray(room.positions);
    const size = box.getSize(new THREE.Vector3());
    return { center: box.getCenter(new THREE.Vector3()), radius: Math.max(size.x, size.z) * 0.78, size };
  }, [room]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime * 0.07 + 0.6;
    const { center, radius } = frame;
    camera.position.set(center.x + Math.sin(t) * radius, center.y + frame.size.y * 0.55, center.z + Math.cos(t) * radius);
    camera.lookAt(center.x, center.y - frame.size.y * 0.1, center.z);
  });
  return null;
}

/** The hero's backdrop: a real scan of a real room, turning slowly. */
export function HeroCloud({ id }: { id: string }) {
  const { assets } = useAssets(id);
  return (
    <div className={`hero-cloud ${assets?.room ? 'ready' : ''}`} aria-hidden>
      {assets?.room && (
        <Canvas camera={{ fov: 52, near: 0.05, far: 100 }} dpr={[1, 1.5]} onCreated={({ gl }) => gl.setClearColor('#07080a')}>
          <AutoOrbit room={assets.room} />
          <RoomCloud room={assets.room} dim={1} />
        </Canvas>
      )}
    </div>
  );
}

export type Layers = { room: boolean; path: boolean; people: boolean; video: boolean };

/**
 * A compact version of the walk-in viewer for the page: which layers show,
 * and whether the camera orbits or rides the phone, is decided by the story
 * next to it. Zoom is off so the page keeps scrolling.
 */
export function MiniViewer({ id, layers, mode, label }: { id: string; layers: Layers; mode: 'orbit' | 'phone'; label: string }) {
  const { assets, failed } = useAssets(id);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [explore, setExplore] = useState(() => !window.matchMedia('(pointer: coarse)').matches);
  const frameRef = useRef(0);

  // The clip plays whenever a layer needs it, muted and looping.
  const needsVideo = layers.video || layers.people || mode === 'phone';
  useEffect(() => {
    if (!video) return;
    if (needsVideo) void video.play().catch(() => {});
    else video.pause();
  }, [video, needsVideo]);

  if (failed) return <div className="mini-viewer note">This scene couldn't load.</div>;
  if (!assets) return <div className="mini-viewer note">Loading the scan…</div>;
  const { detail, room, timeline } = assets;
  const { manifest } = detail;
  const hasPeople = manifest.depth.count > 0 && timeline.count > 0;

  return (
    <div className="mini-viewer">
      <Canvas camera={{ fov: 60, near: 0.02, far: 100 }} dpr={[1, 1.5]} onCreated={({ gl }) => gl.setClearColor('#07080a')} key={id}>
        <Clock video={video} timeline={timeline} frameRef={frameRef} />
        <CameraRig timeline={timeline} room={room} mode={mode} frameRef={frameRef} zoom={false} locked={!explore} />
        {room && layers.room && <RoomCloud room={room} dim={layers.people && playing ? 0.5 : 1} />}
        {layers.path && <CameraPath timeline={timeline} />}
        {layers.path && mode === 'orbit' && <CameraMarker timeline={timeline} frameRef={frameRef} />}
        {video && hasPeople && layers.people && (
          <DepthReplay captureId={id} manifest={manifest} timeline={timeline} video={video} frameRef={frameRef} />
        )}
      </Canvas>
      <video
        ref={setVideo}
        className={layers.video ? 'pip show' : 'pip'}
        src={publicGuide.file(id, manifest.video.file)}
        crossOrigin="anonymous"
        muted
        loop
        playsInline
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="mini-label">{label}</div>
      {!explore && (
        <button className="mini-explore" onClick={() => setExplore(true)}>
          Tap to explore
        </button>
      )}
      <a className="mini-open" href={`#/p/${id}`}>Open full viewer →</a>
    </div>
  );
}
