// Speech for the visit (VisitDock): Cartesia when it can be reached (Sonic speaks, Ink-2 listens,
// the same voice as the palace's AI guide), else the browser's own speechSynthesis and
// SpeechRecognition. The API key stays in Convex; the browser gets a short-lived token.
import { guide } from './data'
import { CartesiaVoice } from './museum/guide/cartesia'

let voice: CartesiaVoice | null = null
/** Cartesia failed (no token, no network): the browser's voice for the rest of this page. */
let fallback = false

/** The shared Cartesia voice, made on first use (after a tap, so sound may start); null if unavailable. */
function cartesia(): CartesiaVoice | null {
  if (fallback || !guide.available()) return null
  voice ??= new CartesiaVoice(guide.voiceToken)
  return voice
}

/** Whether the visit can listen at all (Cartesia, or the browser's recognition). */
export const canListen = () => Boolean(guide.available() || RecognitionCtor)

/** Stops whatever is being said, by either voice. */
export function stopSpeaking() {
  voice?.stop()
  window.speechSynthesis?.cancel()
}

/** The browser's voice, one sentence at a time (the fallback). */
function speakInBrowser(sentences: string[], cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth) return resolve()
    const next = (i: number) => {
      if (i >= sentences.length || cancelled()) return resolve()
      const u = new SpeechSynthesisUtterance(sentences[i])
      u.rate = 0.85
      let done = false
      const advance = () => {
        if (done) return
        done = true
        next(i + 1)
      }
      u.onend = advance
      u.onerror = advance
      // Some browsers never report the end of an utterance.
      setTimeout(advance, 2500 + sentences[i].split(/\s+/).length * 600)
      synth.speak(u)
    }
    next(0)
  })
}

/** Speaks each sentence in order; resolves when done or cancelled. */
export async function speak(sentences: string[], cancelled: () => boolean): Promise<void> {
  const v = cartesia()
  if (!v) return speakInBrowser(sentences, cancelled)
  for (const [i, sentence] of sentences.entries()) {
    if (cancelled()) return
    // Stop mid-sentence as soon as the caller cancels (the visit ended, the tour moved on).
    const watch = setInterval(() => cancelled() && v.stop(), 150)
    try {
      await v.say(sentence)
    } catch {
      fallback = true
      return speakInBrowser(sentences.slice(i), cancelled)
    } finally {
      clearInterval(watch)
    }
  }
}

export type Recognition = {
  lang: string
  interimResults: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}

/** The browser's speech recognition (webkitSpeechRecognition in Safari and Chrome), if any. */
export const RecognitionCtor: (new () => Recognition) | undefined =
  (window as unknown as { SpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition

/**
 * Push to talk: listens until the person finishes their turn (Cartesia Ink-2 detects it) or
 * `stop()` is called (a second press), then resolves with what they said ('' if nothing).
 */
export function listenOnce(onError: (message: string) => void): { done: Promise<string>; stop: () => void } {
  const v = cartesia()
  if (v) {
    let resolve: (text: string) => void = () => {}
    const done = new Promise<string>((r) => (resolve = r))
    let settled = false
    const finish = (text: string) => {
      if (settled) return
      settled = true
      v.unlisten()
      resolve(text)
    }
    void v.listen({
      onStart: () => v.stop(),
      onEnd: finish,
      onError: (message) => {
        onError(message)
        finish('')
      },
    })
    return {
      done,
      stop: () => {
        v.endTurn()
        // If Ink-2 has nothing to finish, give up after a moment.
        setTimeout(() => finish(''), 3000)
      },
    }
  }
  // The browser's recognition.
  if (!RecognitionCtor) {
    onError("Speech isn't available in this browser; type instead.")
    return { done: Promise.resolve(''), stop: () => {} }
  }
  const r = new RecognitionCtor()
  r.lang = 'en-US'
  r.interimResults = false
  let heard = ''
  const done = new Promise<string>((resolve) => {
    r.onresult = (e) => {
      heard = Array.from(e.results)
        .map((res) => res[0].transcript)
        .join(' ')
    }
    r.onerror = () => onError("I couldn't hear that. Please try again, or type it instead.")
    r.onend = () => resolve(heard)
  })
  r.start()
  return { done, stop: () => r.stop() }
}
