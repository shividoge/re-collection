// The museum draws only when something changes (walking, looking, a dive, a video frame). Between
// those, the candles still flicker, at a gentle rate, for a while after the last touch or key;
// after that the room holds perfectly still until the visitor does something.

/** Idle frames per second, for the candles and the fire. */
export const IDLE_HZ = 20
/** How long after the last touch or key the candles keep flickering (ms). */
export const IDLE_FOR_MS = 60_000

/** Should an idle frame be drawn now? */
export function idleFrameDue(now: number, lastActivity: number): boolean {
  return now - lastActivity < IDLE_FOR_MS
}
