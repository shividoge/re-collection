import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useRef, useState } from 'react';

import { captureFileUrl, fetchBytes, fetchText, guide } from '../api';
import type { CaptureDetail, EndReason, Moment, Reply } from '../api';
import { parseFrames, parseRoomBin } from '../capture';
import type { RoomCloud as Room, Timeline } from '../capture';
import { DepthReplay } from '../scene/DepthReplay';
import { RoomCloud } from '../scene/RoomCloud';
import { CameraRig, Clock } from './Viewer';

type Phase = 'loading' | 'welcome' | 'replay' | 'conversation' | 'goodbye' | 'error';
type Loaded = { detail: CaptureDetail; moment: Moment; room: Room | null; timeline: Timeline };

const SESSION_LIMIT_MS = 10 * 60 * 1000;
const GOODBYE = "Thank you for sharing this with me. I'll be here whenever you want to look again.";

type Recognition = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
const RecognitionCtor: (new () => Recognition) | undefined =
  (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
    .SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

/** Speaks each sentence in order; resolves when done or cancelled. */
function speak(sentences: string[], cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve();
    const next = (i: number) => {
      if (i >= sentences.length || cancelled()) return resolve();
      const u = new SpeechSynthesisUtterance(sentences[i]);
      u.rate = 0.85;
      u.onend = () => next(i + 1);
      u.onerror = () => next(i + 1);
      synth.speak(u);
    };
    next(0);
  });
}

export function Revisit({ id }: { id: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [detail, moment] = await Promise.all([guide.capture(id), guide.moment(id)]);
      const [roomBytes, framesText] = await Promise.all([
        detail.manifest.room ? fetchBytes(id, detail.manifest.room.bin) : Promise.resolve(null),
        fetchText(id, 'frames.jsonl'),
      ]);
      if (cancelled) return;
      setLoaded({ detail, moment, room: roomBytes ? parseRoomBin(roomBytes) : null, timeline: parseFrames(framesText) });
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <div className="center-message error">{error}</div>;
  if (!loaded) return <div className="center-message">Getting the moment ready…</div>;
  return <Session {...loaded} />;
}

function Session({ detail, moment, room, timeline }: Loaded) {
  const { manifest } = detail;
  const [phase, setPhase] = useState<Phase>('welcome');
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [caption, setCaption] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [caregiver, setCaregiver] = useState(false);
  const [typed, setTyped] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [dropped, setDropped] = useState<{ sentence: string; reason: string }[]>([]);
  const sid = useRef<string | null>(null);
  const ended = useRef(false);
  const frameRef = useRef(0);
  const recognition = useRef<Recognition | null>(null);
  const chapters = moment.chapters;
  const hasPeople = manifest.depth.count > 0 && timeline.count > 0;

  const say = useCallback(async (reply: Reply) => {
    setDropped((d) => [...d, ...reply.dropped]);
    for (const s of reply.sentences) {
      setCaption(s.sentence);
      await speak([s.sentence], () => ended.current);
    }
  }, []);

  const finish = useCallback(
    async (reason: EndReason) => {
      if (ended.current) return;
      ended.current = true;
      window.speechSynthesis?.cancel();
      recognition.current?.stop();
      video?.pause();
      setPhase('goodbye');
      setCaption(GOODBYE);
      void speak([GOODBYE], () => false);
      if (sid.current) {
        try {
          await guide.endSession(sid.current, reason);
        } catch (e) {
          setFailure(`Couldn't save this session: ${(e as Error).message}`);
        }
      }
    },
    [video],
  );

  // Hard stop after ten minutes.
  useEffect(() => {
    const timer = setTimeout(() => void finish('timeout'), SESSION_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [finish]);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const begin = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const [{ sessionId, welcome }, person] = await Promise.all([guide.startSession(detail.id), guide.person()]);
      sid.current = sessionId;
      setAddress(person.preferredAddress);
      setPhase('welcome');
      await say(welcome);
      setPhase('replay');
      await replay(sessionId);
    } catch (e) {
      setFailure((e as Error).message);
      setPhase('welcome');
    } finally {
      setBusy(false);
    }
  };

  /** Plays the video slowly, pausing at each chapter to hear its narration. */
  const replay = async (sessionId: string) => {
    if (!video) return;
    video.playbackRate = 0.75;
    for (let i = 0; i < chapters.length; i++) {
      if (ended.current) return;
      video.currentTime = chapters[i].tStart;
      video.pause();
      const { reply } = await guide.narrate(sessionId, i);
      await say(reply);
      if (ended.current) return;
      const stop = i + 1 < chapters.length ? chapters[i + 1].tStart : chapters[i].tEnd;
      await new Promise<void>((resolve) => {
        const check = () => {
          if (ended.current || video.currentTime >= stop || video.ended) {
            video.removeEventListener('timeupdate', check);
            video.pause();
            resolve();
          }
        };
        video.addEventListener('timeupdate', check);
        void video.play();
      });
    }
    if (ended.current) return;
    setPhase('conversation');
    setCaption('');
  };

  const send = async (text: string) => {
    if (!sid.current || !text.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const { reply, distress } = await guide.turn(sid.current, text.trim());
      await say(reply);
      if (distress) await finish('distress');
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const talk = () => {
    if (!RecognitionCtor || busy) return;
    if (listening) return recognition.current?.stop();
    window.speechSynthesis?.cancel();
    const r = new RecognitionCtor();
    r.lang = 'en-US';
    r.interimResults = false;
    let heard = '';
    r.onresult = (e) => {
      heard = Array.from(e.results as ArrayLike<ArrayLike<{ transcript: string }>>)
        .map((res) => res[0].transcript)
        .join(' ');
    };
    r.onerror = () => setFailure("I couldn't hear that. Please try again, or ask the caregiver to type.");
    r.onend = () => {
      setListening(false);
      if (heard) void send(heard);
    };
    recognition.current = r;
    setListening(true);
    r.start();
  };

  return (
    <div className="revisit">
      <Canvas
        className="revisit-canvas"
        camera={{ fov: 60, near: 0.02, far: 100 }}
        dpr={[1, 2]}
        onCreated={({ gl }) => gl.setClearColor('#0b0d12')}
      >
        <Clock video={video} timeline={timeline} frameRef={frameRef} />
        <CameraRig timeline={timeline} room={room} mode="phone" frameRef={frameRef} />
        {room && <RoomCloud room={room} dim={1} />}
        {video && hasPeople && (
          <DepthReplay captureId={detail.id} manifest={manifest} timeline={timeline} video={video} frameRef={frameRef} />
        )}
      </Canvas>
      <video
        ref={setVideo}
        src={captureFileUrl(detail.id, manifest.video.file)}
        crossOrigin="anonymous"
        playsInline
        preload="auto"
        muted
        style={{ display: 'none' }}
      />

      <div className="revisit-panel">
        {phase === 'welcome' && !busy && !sid.current && (
          <>
            <h1>{address ? `Hello, ${address}.` : 'Hello.'}</h1>
            <p className="revisit-sub">{moment.moment.title || 'A visit'}</p>
            <button className="big" onClick={begin}>Begin</button>
          </>
        )}
        {caption && <p className="revisit-caption" aria-live="polite">{caption}</p>}
        {phase === 'conversation' && (
          <button className={`big ${listening ? 'live' : ''}`} onClick={talk} disabled={busy || !RecognitionCtor}>
            {busy ? '…' : listening ? "I'm listening" : 'Talk'}
          </button>
        )}
        {phase === 'goodbye' && <p className="revisit-sub">This visit is finished.</p>}
        {failure && <p className="error">{failure}</p>}
        {phase === 'conversation' && !RecognitionCtor && (
          <p className="revisit-sub">Speech isn't available in this browser. Ask the caregiver to type.</p>
        )}
      </div>

      <div className="caregiver-corner">
        <button onClick={() => setCaregiver((c) => !c)}>{caregiver ? 'Hide' : 'Caregiver'}</button>
        {caregiver && (
          <div className="caregiver-box">
            <button onClick={() => void finish('caregiver')} disabled={phase === 'goodbye'}>End this visit</button>
            {phase === 'conversation' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(typed);
                  setTyped('');
                }}
              >
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type what they said" />
                <button disabled={busy}>Send</button>
              </form>
            )}
            {dropped.length > 0 && (
              <details open>
                <summary>{dropped.length} sentence(s) held back</summary>
                <ul>
                  {dropped.map((d, i) => (
                    <li key={i}>“{d.sentence}” — {d.reason}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
