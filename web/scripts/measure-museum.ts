// Measures the museum at iPad-like settings in headless Chrome (DPR 2, 1180×820, iPad user
// agent so the handheld quality tier is on, touch, CPU throttled 4×): draw calls, frames drawn
// and main-thread time standing still and walking, time to interactive, texture memory, JS heap,
// and <video> elements / AudioContexts after enter → leave → enter. Saves screenshots.
//
//   bun web/scripts/measure-museum.ts http://127.0.0.1:5181/#/museum out-dir
//
// Needs google-chrome (or CHROME=path). Nothing is written anywhere but `out-dir`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const url = process.argv[2] ?? 'http://127.0.0.1:5181/#/museum'
const out = process.argv[3] ?? '/tmp/bd-measure'
const chrome = process.env.CHROME ?? 'google-chrome'
const PORT = 9300 + Math.floor(Math.random() * 500)
mkdirSync(out, { recursive: true })

// Injected before any page script: counts draw calls per animation frame, texture bytes on the
// GPU, media elements and audio contexts.
const PROBE = `(() => {
  const P = (window.__probe = { draws: 0, frames: [], textures: new Map(), videos: [], audios: [], contexts: [], longTasks: [] });
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const proto = C.prototype;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = proto[name];
      if (f) proto[name] = function (...a) { P.draws++; return f.apply(this, a) };
    }
    // Texture memory: track the texture bound to each unit and target.
    const bound = new Map();
    let unit = 0;
    const key = (t) => unit + ':' + t;
    const act = proto.activeTexture;
    proto.activeTexture = function (u) { unit = u; return act.call(this, u) };
    const bind = proto.bindTexture;
    proto.bindTexture = function (t, tex) { bound.set(key(t), tex); return bind.call(this, t, tex) };
    const del = proto.deleteTexture;
    proto.deleteTexture = function (tex) { P.textures.delete(tex); return del.call(this, tex) };
    const bpp = (type, format) => (type === 0x1406 ? 16 : type === 0x140b || type === 0x8d61 ? 8 : format === 0x1903 || format === 0x8229 ? 1 : 4);
    const record = (target, level, bytes) => {
      const tex = bound.get(key(target === 0x8513 || (target >= 0x8515 && target <= 0x851a) ? 0x8513 : target));
      if (!tex) return;
      const e = P.textures.get(tex) ?? { levels: new Map(), mips: false };
      e.levels.set(String(target) + ':' + level, bytes);
      P.textures.set(tex, e);
    };
    const ti = proto.texImage2D;
    proto.texImage2D = function (...a) {
      const [target, level] = a;
      let w = 0, h = 0, format = 0, type = 0;
      if (a.length >= 8) { w = a[3]; h = a[4]; format = a[6]; type = a[7]; }
      else { const src = a[5]; w = src.videoWidth || src.naturalWidth || src.width || 0; h = src.videoHeight || src.naturalHeight || src.height || 0; format = a[3]; type = a[4]; }
      record(target, level, w * h * bpp(type, format));
      return ti.apply(this, a);
    };
    const ts = proto.texStorage2D;
    if (ts) proto.texStorage2D = function (target, levels, fmt, w, h) {
      const per = fmt === 0x881a || fmt === 0x8814 ? 8 : fmt === 0x8229 ? 1 : 4;
      let bytes = 0; for (let l = 0, x = w, y = h; l < levels; l++, x = Math.max(1, x >> 1), y = Math.max(1, y >> 1)) bytes += x * y * per;
      record(target, 0, bytes * (target === 0x8513 ? 6 : 1));
      return ts.call(this, target, levels, fmt, w, h);
    };
    const ts3 = proto.texStorage3D;
    if (ts3) proto.texStorage3D = function (target, levels, fmt, w, h, d) {
      record(target, 0, w * h * d * 4 * (levels > 1 ? 1.34 : 1));
      return ts3.call(this, target, levels, fmt, w, h, d);
    };
    const cti = proto.compressedTexImage2D;
    if (cti) proto.compressedTexImage2D = function (...a) { record(a[0], a[1], a[6]?.byteLength ?? 0); return cti.apply(this, a) };
    const gm = proto.generateMipmap;
    proto.generateMipmap = function (target) { const tex = bound.get(key(target)); const e = tex && P.textures.get(tex); if (e) e.mips = true; return gm.call(this, target) };
  }
  const tick = (now) => { P.frames.push([now, P.draws]); P.draws = 0; requestAnimationFrame(tick) };
  requestAnimationFrame(tick);
  const ce = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...rest) { const el = ce.call(this, tag, ...rest); if (String(tag).toLowerCase() === 'video') P.videos.push(new WeakRef(el)); return el };
  const A = window.Audio;
  window.Audio = function (...a) { const el = new A(...a); P.audios.push(new WeakRef(el)); return el };
  window.Audio.prototype = A.prototype;
  const AC = window.AudioContext;
  window.AudioContext = class extends AC { constructor(...a) { super(...a); P.contexts.push(new WeakRef(this)) } };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push([e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: true });
  P.summary = () => {
    let tex = 0;
    for (const e of P.textures.values()) { let b = 0; for (const v of e.levels.values()) b += v; tex += e.mips && e.levels.size === 1 ? b * 4 / 3 : b }
    const domVideos = [...document.querySelectorAll('video')];
    const all = [...new Set([...P.videos.map((r) => r.deref()).filter(Boolean), ...domVideos])];
    const live = all.filter((v) => v.currentSrc || v.getAttribute('src'));
    return {
      textureMB: +(tex / 1048576).toFixed(1), textures: P.textures.size,
      videosLive: live.length, videosPlaying: live.filter((v) => !v.paused).length, videosPreloadAuto: live.filter((v) => v.preload === 'auto').length,
      musicPlaying: P.audios.map((r) => r.deref()).filter((a) => a && !a.paused).length,
      audioContextsOpen: P.contexts.map((r) => r.deref()).filter((c) => c && c.state !== 'closed').length,
      audioContextsRunning: P.contexts.map((r) => r.deref()).filter((c) => c && c.state === 'running').length,
      webglCanvases: [...document.querySelectorAll('canvas')].length,
    };
  };
})()`

const proc = spawn(chrome, [
  '--headless=new', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/bd-measure-profile-${PORT}`, '--no-first-run', '--mute-audio', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let wsUrl = ''
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200)
  try {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? ''
  } catch {
    /* not up yet */
  }
}
if (!wsUrl) throw new Error('Chrome did not start')

const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map<number, (v: unknown) => void>()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } }
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m.error ? { __error: m.error.message } : m.result)
    pending.delete(m.id)
  }
})
async function cdp<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  const r = (await new Promise((res) => pending.set(id, res))) as T & { __error?: string }
  if (r && r.__error) throw new Error(`${method}: ${r.__error}`)
  return r
}
async function evaluate<T>(expr: string): Promise<T> {
  const r = await cdp<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(r.exceptionDetails)}`)
  return r.result.value
}
async function metrics(): Promise<Record<string, number>> {
  const { metrics: m } = await cdp<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics')
  return Object.fromEntries(m.map((x) => [x.name, x.value]))
}
async function shot(name: string) {
  const { data } = await cdp<{ data: string }>('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${out}/${name}.png`, Buffer.from(data, 'base64'))
}
async function key(code: string, type: 'keyDown' | 'keyUp') {
  const k = code.replace(/^Key/, '').toLowerCase()
  await cdp('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) })
}
async function tap(x: number, y: number) {
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
}

/** Frames drawn, draw calls per drawn frame and main-thread busy time over `ms`. */
async function window_(ms: number, during?: () => Promise<void>) {
  await evaluate('window.__probe.frames.length = 0')
  const m0 = await metrics()
  const t0 = performance.now()
  if (during) await during()
  const left = ms - (performance.now() - t0)
  if (left > 0) await sleep(left)
  const m1 = await metrics()
  const frames = await evaluate<[number, number][]>('window.__probe.frames.slice()')
  const drawn = frames.filter(([, d]) => d > 0)
  const secs = ms / 1000
  const intervals = frames.slice(1).map(([t], i) => t - frames[i][0]).sort((a, b) => a - b)
  return {
    drawnFramesPerSec: +(drawn.length / secs).toFixed(1),
    drawCallsPerDrawnFrame: drawn.length ? Math.round(drawn.reduce((s, [, d]) => s + d, 0) / drawn.length) : 0,
    drawCallsMax: drawn.reduce((m, [, d]) => Math.max(m, d), 0),
    mainThreadMsPerSec: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / secs).toFixed(0),
    scriptMsPerSec: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / secs).toFixed(0),
    frameP50ms: +(intervals[Math.floor(intervals.length / 2)] ?? 0).toFixed(1),
    frameP95ms: +(intervals[Math.floor(intervals.length * 0.95)] ?? 0).toFixed(1),
  }
}

await cdp('Page.enable')
await cdp('Performance.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true })
await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPad' })
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await cdp('Emulation.setCPUThrottlingRate', { rate: 4 })
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })

const result: Record<string, unknown> = { url, settings: 'DPR 2, 1180x820, iPad UA, touch, CPU 4x throttled, RTX 5060 Ti (Vulkan ANGLE)' }
const navStart = Date.now()
await cdp('Page.navigate', { url })
// Interactive: the museum has drawn a full frame and the main thread has had no long task for 1.5 s.
let firstFrame = 0
for (let i = 0; i < 600; i++) {
  await sleep(100)
  const f = await evaluate<{ first: number | null; lastLong: number; now: number }>(
    `(() => { const P = window.__probe; const f = P.frames.find(([, d]) => d > 40); const lt = P.longTasks.at(-1); return { first: f ? f[0] : null, lastLong: lt ? lt[0] + lt[1] : 0, now: performance.now() } })()`,
  ).catch(() => null)
  if (!f || f.first === null) continue
  firstFrame ||= f.first
  if (f.now - Math.max(f.lastLong, f.first) > 1500) {
    result.firstMuseumFrameMs = Math.round(firstFrame)
    result.timeToInteractiveMs = Math.round(Math.max(f.lastLong, f.first))
    break
  }
}
result.wallClockToInteractiveMs = Date.now() - navStart
result.longTasksDuringLoad = await evaluate<number>('Math.round(window.__probe.longTasks.reduce((s, [, d]) => s + d, 0))')
await sleep(1500)
await shot('1-entrance')

// Wake the sound (a tap on the floor) and stand still.
await tap(590, 700)
await sleep(2500)
result.standingStill = await window_(4000)
// Walk forward for 2 s.
result.walking = await window_(2500, async () => {
  await key('KeyW', 'keyDown')
  await sleep(2000)
  await key('KeyW', 'keyUp')
})
await sleep(1000)
await shot('2-walked')
// Guided walk to the first piece (N), then stand at it.
await key('KeyN', 'keyDown')
await key('KeyN', 'keyUp')
await sleep(9000)
await shot('3-at-piece')
if (process.env.PROFILE) {
  await cdp('Profiler.enable')
  await cdp('Profiler.start')
}
result.atPieceStill = await window_(3000)
if (process.env.PROFILE) {
  type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount: number }
  const { profile } = await cdp<{ profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } }>('Profiler.stop')
  const self = new Map<string, number>()
  const total = profile.nodes.reduce((s, n) => s + n.hitCount, 0)
  for (const n of profile.nodes) {
    const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber}`
    self.set(k, (self.get(k) ?? 0) + n.hitCount)
  }
  result.profileTop = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${((v / total) * 100).toFixed(1)}% ${k}`)
}

await cdp('HeapProfiler.enable')
await cdp('HeapProfiler.collectGarbage')
const m = await metrics()
result.jsHeapMB = +(m.JSHeapUsedSize / 1048576).toFixed(1)
result.inMuseum = await evaluate('window.__probe.summary()')

// Leave (to the front page) and come back, twice.
// Leave for a page with no 3D or media of its own, so what's left is what the museum left.
await evaluate(`location.hash = '#/room'`)
await sleep(3000)
result.afterLeave = await evaluate('window.__probe.summary()')
await evaluate(`location.hash = '${new URL(url).hash}'`)
await sleep(8000)
await tap(590, 700)
await sleep(2000)
result.afterReturn = await evaluate('window.__probe.summary()')
await cdp('HeapProfiler.collectGarbage')
result.jsHeapAfterReturnMB = +((await metrics()).JSHeapUsedSize / 1048576).toFixed(1)

writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
ws.close()
proc.kill()
process.exit(0)
