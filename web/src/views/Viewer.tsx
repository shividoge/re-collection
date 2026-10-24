import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import { captureFileUrl, fetchBytes, fetchText, guide } from '../api';
import type { CaptureDetail } from '../api';
import { frameAt, parseFrames, parseRoomBin } from '../capture';
import type { RoomCloud as Room, Timeline } from '../capture';
import { CameraMarker, CameraPath } from '../scene/CameraPath';
import { DepthReplay } from '../scene/DepthReplay';
import { FactsPanel } from './FactsPanel';
import { RoomCloud } from '../scene/RoomCloud';

export type Loaded = { detail: CaptureDetail; room: Room | null; timeline: Timeline };
export type ViewMode = 'orbit' | 'phone';

export function Viewer({ id, publicView = false }: { id: string; publicView?: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState('Loading the capture…');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const detail = await guide.capture(id);
      const { manifest } = detail;
      setProgress(manifest.room ? `Loading ${manifest.room.points.toLocaleString()} room points…` : 'Loading camera path…');
      const [roomBytes, framesText] = await Promise.all([
        manifest.room ? fetchBytes(id, manifest.room.bin) : Promise.resolve(null),
        fetchText(id, 'frames.jsonl'),
      ]);
      if (cancelled) return;
      setLoaded({ detail, room: roomBytes ? parseRoomBin(roomBytes) : null, timeline: parseFrames(framesText) });
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <div className="center-message error">{error}</div>;
  if (!loaded) return <div className="center-message">{progress}</div>;
  return <Stage {...loaded} publicView={publicView} />;
}

function Stage({ detail, room, timeline, publicView }: Loaded & { publicView: boolean }) {
  const { manifest } = detail;
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [mode, setMode] = useState<ViewMode>('orbit');
  const [showRoom, setShowRoom] = useState(true);
  const [showPeople, setShowPeople] = useState(true);
  const [showPath, setShowPath] = useState(true);
  const [videoError, setVideoError] = useState<string | null>(null);
  const frameRef = useRef(0);

  const duration = manifest.video.durationSec;
  const hasPeople = manifest.depth.count > 0 && timeline.count > 0;

  /** Jump the whole stage (video, 3D replay, camera) to `t` seconds. */
  const seek = (t: number, play = false) => {
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, t), duration);
    setTime(video.currentTime);
    if (play) void video.play();
    else video.pause();
  };

  const togglePlay = () => {
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="stage">
      <Canvas
        className="stage-canvas"
        camera={{ fov: 60, near: 0.02, far: 100 }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
        onCreated={({ gl }) => gl.setClearColor('#07080a')}
      >
        <Clock video={video} timeline={timeline} frameRef={frameRef} />
        <CameraRig timeline={timeline} room={room} mode={mode} frameRef={frameRef} />
        {room && showRoom && <RoomCloud room={room} dim={showPeople && playing ? 0.55 : 1} />}
        {showPath && <CameraPath timeline={timeline} />}
        {showPath && mode === 'orbit' && <CameraMarker timeline={timeline} frameRef={frameRef} />}
        {video && hasPeople && showPeople && (
          <DepthReplay captureId={detail.id} manifest={manifest} timeline={timeline} video={video} frameRef={frameRef} />
        )}
      </Canvas>

      <header className="stage-header">
        <a href={publicView ? '#/' : '#/captures'} className="back">{publicView ? '← Braindance' : '← Captures'}</a>
        {!publicView && (
          <nav className="stage-links">
            <a href={`#/revisit/${detail.id}`}>Revisit</a>
            <a href={`#/dashboard/${detail.id}`}>Dashboard</a>
            <PublicSwitch id={detail.id} initial={detail.status.public === true} />
          </nav>
        )}
        <div>
          <h1>{manifest.title || 'Untitled visit'}</h1>
          <p className="meta">
            {new Date(manifest.createdAt).toLocaleString()} · {formatTime(duration)}
            {manifest.attendees.length > 0 && ` · ${manifest.attendees.join(', ')}`}
            {room && ` · ${room.count.toLocaleString()} room points`}
          </p>
        </div>
      </header>

      <aside className="side">
        <div className="video-panel">
        <video
          ref={setVideo}
          src={captureFileUrl(detail.id, manifest.video.file)}
          crossOrigin="anonymous"
          playsInline
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onError={() =>
            setVideoError(`This browser can't play ${manifest.video.file}. Older captures are HEVC; try Safari, or a newer capture (H.264).`)
          }
        />
        {videoError && <p className="error small">{videoError}</p>}
        </div>
        <FactsPanel captureId={detail.id} onSeek={seek} readOnly={publicView} />
      </aside>

      <footer className="transport">
        <button className="play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="time">{formatTime(time)}</span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={duration}
          step={1 / 30}
          value={time}
          onChange={(e) => {
            const t = Number(e.target.value);
            if (video) video.currentTime = t;
            setTime(t);
          }}
          aria-label="Playback position"
        />
        <span className="time">{formatTime(duration)}</span>
        <div className="segmented" role="group" aria-label="View">
          <button className={mode === 'orbit' ? 'on' : ''} onClick={() => setMode('orbit')}>Orbit</button>
          <button className={mode === 'phone' ? 'on' : ''} onClick={() => setMode('phone')}>Phone's view</button>
        </div>
        <div className="toggles">
          <Toggle label="Room" on={showRoom} set={setShowRoom} disabled={!room} />
          <Toggle label="People" on={showPeople} set={setShowPeople} disabled={!hasPeople} />
          <Toggle label="Path" on={showPath} set={setShowPath} />
        </div>
      </footer>
    </div>
  );
}

/** The family's switch for the public front page. Off unless they turn it on. */
function PublicSwitch({ id, initial }: { id: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <label className="toggle public-switch" title="When on, anyone with the site's link can see this capture, its approved facts and its finished sessions.">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          const next = e.target.checked;
          setError(null);
          guide.setPublic(id, next).then(() => setOn(next)).catch((err: Error) => setError(err.message));
        }}
      />
      Public{error && <span className="error small"> {error}</span>}
    </label>
  );
}

function Toggle({ label, on, set, disabled }: { label: string; on: boolean; set: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={on && !disabled} disabled={disabled} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
}

/** Maps the video's current time to a frame index every render frame. */
export function Clock({ video, timeline, frameRef }: { video: HTMLVideoElement | null; timeline: Timeline; frameRef: React.RefObject<number> }) {
  useFrame(() => {
    frameRef.current = frameAt(timeline, video?.currentTime ?? 0);
  });
  return null;
}

const pose = new THREE.Matrix4();
const targetPosition = new THREE.Vector3();
const targetQuaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

/**
 * Orbit: free camera around the room. Phone's view: the camera rides the
 * recorded pose (smoothed), with the phone's vertical field of view, so the
 * replay lines up with the video.
 */
export function CameraRig({ timeline, room, mode, frameRef }: { timeline: Timeline; room: Room | null; mode: ViewMode; frameRef: React.RefObject<number> }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const controls = useRef<OrbitControlsImpl>(null);

  // Start behind and above where the phone began the moment, looking at the room.
  const start = useMemo(() => {
    pose.fromArray(timeline.transforms, 0);
    const eye = new THREE.Vector3().setFromMatrixPosition(pose);
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(pose).setY(0).normalize();
    let target = eye.clone().addScaledVector(forward, 1.8);
    if (room && room.count > 0) {
      const box = new THREE.Box3().setFromArray(room.positions);
      target = box.getCenter(new THREE.Vector3());
      target.y = Math.min(target.y, eye.y - 0.4);
    }
    const position = eye.clone().addScaledVector(forward, -1.6).add(new THREE.Vector3(0, 0.9, 0));
    return { position, target };
  }, [timeline, room]);

  useEffect(() => {
    if (mode === 'orbit') {
      camera.fov = 60;
      camera.position.copy(start.position);
      camera.updateProjectionMatrix();
      controls.current?.target.copy(start.target);
      controls.current?.update();
    }
  }, [mode, camera, start]);

  useFrame(() => {
    if (mode !== 'phone' || frameRef.current < 0) return;
    const k = frameRef.current;
    pose.fromArray(timeline.transforms, k * 16);
    pose.decompose(targetPosition, targetQuaternion, scale);
    camera.position.lerp(targetPosition, 0.25);
    camera.quaternion.slerp(targetQuaternion, 0.25);
    const fy = timeline.intrinsics[k * 4 + 1];
    const cy = timeline.intrinsics[k * 4 + 3];
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(cy / fy));
    if (Math.abs(camera.fov - fov) > 0.1) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  });

  return <OrbitControls ref={controls} enabled={mode === 'orbit'} enableDamping makeDefault />;
}

function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
