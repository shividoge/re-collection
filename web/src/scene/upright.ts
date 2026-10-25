// Which way is up in a capture's stored pictures.
import { fetchText } from '../data'
import type { CaptureAssets } from '../data/assets'
import { parseFramesJsonl } from './formats'
import { dominantQuarterTurns, type QuarterTurns } from './pose'

/**
 * Quarter turns clockwise that stand a capture's stored pictures (video, thumbnail, keyframes)
 * upright. The phone stores them in the sensor's landscape orientation however it was held, and
 * its camera poses say how it was held (the viewer turns the video the same way). 0 when they're
 * stored upright already, or when there are no poses to tell.
 */
export async function uprightTurns(assets: CaptureAssets): Promise<QuarterTurns> {
  if (assets.manifest.imageOrientation === 'upright') return 0
  const url = assets.rawUrl('frames.jsonl')
  if (!url) return 0
  // Fetched once per page: stepping into the visit reads the same bytes.
  const { moment } = parseFramesJsonl(await fetchText(url))
  return moment.length ? dominantQuarterTurns(moment) : 0
}
