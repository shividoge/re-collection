import { fetchBytes, fetchText, guide } from '../api';
import type { CaptureDetail } from '../api';
import { parseFrames, parseRoomBin } from '../capture';
import type { RoomCloud, Timeline } from '../capture';

export type Assets = { detail: CaptureDetail; room: RoomCloud | null; timeline: Timeline };

const cache = new Map<string, Promise<Assets>>();

/** Room cloud and camera timeline of a capture, loaded once and shared by every scene on the page. */
export function loadAssets(id: string): Promise<Assets> {
  let found = cache.get(id);
  if (!found) {
    found = (async () => {
      const detail = await guide.capture(id);
      const { manifest } = detail;
      const [roomBytes, frames] = await Promise.all([
        manifest.room ? fetchBytes(id, manifest.room.bin) : Promise.resolve(null),
        fetchText(id, 'frames.jsonl'),
      ]);
      return { detail, room: roomBytes ? parseRoomBin(roomBytes) : null, timeline: parseFrames(frames) };
    })();
    found.catch(() => cache.delete(id));
    cache.set(id, found);
  }
  return found;
}
