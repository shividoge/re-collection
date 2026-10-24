// Browser speech: speaking replies (speechSynthesis) and push-to-talk (SpeechRecognition).

/**
 * Speaks each sentence in order; resolves when done or cancelled. Each sentence also has a
 * time limit, because some browsers never report the end of an utterance.
 */
export function speak(sentences: string[], cancelled: () => boolean): Promise<void> {
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
      setTimeout(advance, 2500 + sentences[i].split(/\s+/).length * 600)
      synth.speak(u)
    }
    next(0)
  })
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
