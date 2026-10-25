import { useEffect, useRef, useState } from 'react'
import { guide, type GuideWords } from '../../data'
import type { Exhibition } from '../exhibitions'
import type { MuseumSound } from '../sound'
import { CartesiaVoice } from './cartesia'

/** How far the music fades while the guide speaks (of its level then), and how gently (s). */
const DUCK = 0.3
const DUCK_DOWN_S = 1.2
const DUCK_UP_S = 2.2
/** Inside a memory the paint lifts first; the story starts once it has (ms). */
const STORY_AFTER_MS = 2800
const NO_PICTURE = "Let's walk up to one of the pictures, and I'll tell you about it."

type Inside = { index: number; stage: string } | null

export type GuideState = {
  /** What the guide is saying now (shown large, as subtitles). */
  saying: string
  /** The microphone is open and Cartesia is listening. */
  listening: boolean
  /** Working out an answer. */
  thinking: boolean
  /** Something to tell the person gently (no microphone, can't reach the voice). */
  problem: string | null
}

/**
 * The AI guide while it's on: says a memory's short intro when the person arrives at its frame,
 * its fuller story once they've stepped inside (after the paint lifts), and answers whatever they
 * ask about the memory in front of them. It stops the moment they start talking. While it
 * speaks, the music fades down gradually (never off) and rises again after.
 */
export function useGuide({
  on,
  exhibition,
  focus,
  arrived,
  inside,
  sound,
}: {
  on: boolean
  exhibition: Exhibition | null | undefined
  focus: number
  arrived: boolean
  inside: Inside
  sound: MuseumSound
}): GuideState {
  const [state, setState] = useState<GuideState>({ saying: '', listening: false, thinking: false, problem: null })
  const voice = useRef<CartesiaVoice | null>(null)
  const words = useRef(new Map<string, GuideWords>())
  const lastIntro = useRef<string | null>(null)
  const now = useRef({ exhibition, focus, arrived, inside })
  useEffect(() => {
    now.current = { exhibition, focus, arrived, inside }
  }, [exhibition, focus, arrived, inside])

  const keyOf = (i: number) => (i >= 0 ? now.current.exhibition?.items[i]?.guideKey : undefined)
  const say = (text: string) => {
    const v = voice.current
    if (!v || !text) return
    setState((s) => ({ ...s, saying: text }))
    v.say(text)
      .catch((e: Error) => setState((s) => ({ ...s, problem: e.message })))
      .finally(() => setState((s) => (s.saying === text ? { ...s, saying: '' } : s)))
  }

  // Turning the guide on: the voice, the guide's words, and the microphone.
  useEffect(() => {
    if (!on || !guide.available()) return
    const v = new CartesiaVoice(guide.voiceToken)
    voice.current = v
    lastIntro.current = null
    // The music steps back while the guide talks: gradually, never to silence.
    v.onSpeaking = (speaking) => {
      // Back to wherever the music was (lower while family talk in a live visit; silent inside a memory).
      const base = now.current.inside ? 0 : sound.level
      sound.musicTo(speaking ? base * DUCK : base, speaking ? DUCK_DOWN_S : DUCK_UP_S)
    }
    const stopWords = guide.watch((all) => (words.current = new Map(all.map((w) => [w.key, w]))))
    void v.listen({
      onStart: () => v.stop(),
      onEnd: (text) => {
        const { inside: ins, arrived: at, focus: f } = now.current
        const key = ins ? keyOf(ins.index) : at ? keyOf(f) : undefined
        if (!key) return say(NO_PICTURE)
        setState((s) => ({ ...s, thinking: true }))
        guide
          .ask(key, text)
          .then((answer) => say(answer.say))
          .catch(() => say("I'm sorry, I didn't catch that."))
          .finally(() => setState((s) => ({ ...s, thinking: false })))
      },
      onError: (message) => setState((s) => ({ ...s, problem: message, listening: false })),
    }).then(() => setState((s) => ({ ...s, listening: s.problem === null })))
    return () => {
      stopWords()
      v.close()
      voice.current = null
      const base = now.current.inside ? 0 : sound.level
      sound.musicTo(base, DUCK_UP_S)
      setState({ saying: '', listening: false, thinking: false, problem: null })
    }
    // Only when the guide is turned on or off.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [on, sound])

  // Arriving at a frame: its short intro (once per arrival at a new picture).
  useEffect(() => {
    if (!on || inside || !arrived || focus < 0) return
    const key = exhibition?.items[focus]?.guideKey
    if (!key || key === lastIntro.current) return
    const intro = words.current.get(key)?.intro
    if (!intro) return
    lastIntro.current = key
    say(intro)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [on, arrived, focus, inside, exhibition])

  // Inside a memory: its story once the paint has lifted; leaving stops whatever's being said.
  const stage = inside?.stage
  const index = inside?.index
  useEffect(() => {
    if (!on) return
    if (stage === 'leaving') {
      voice.current?.stop()
      lastIntro.current = null
      return
    }
    if (stage !== 'here' || index === undefined) return
    const t = setTimeout(() => {
      const key = keyOf(index)
      const story = key ? words.current.get(key)?.story : undefined
      if (story) say(story)
    }, STORY_AFTER_MS)
    return () => clearTimeout(t)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [on, stage, index])

  return state
}
