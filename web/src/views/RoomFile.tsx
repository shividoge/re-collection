import { RoomFileViewer } from '../scene'
import { parseRoomBin, type PointCloud } from '../scene/formats'

/** A room.bin opened from this computer. It lives only in this tab; nothing is uploaded. */
let opened: { label: string; cloud: PointCloud } | null = null

/** Reads a room.bin chosen on the captures page and opens it in the viewer. */
export async function openRoomFile(file: File): Promise<void> {
  opened = { label: file.name, cloud: parseRoomBin(await file.arrayBuffer()) }
  location.hash = '#/room'
}

/**
 * Just the scanned room, with no recording: orbit, fly and select. There is no bake for a local
 * file, so this is the one place the browser works out splat sizes and the selection index itself
 * (in a worker; see RoomFileViewer).
 */
export function RoomFile() {
  if (!opened) {
    return (
      <div className="center-message">
        <p>
          No room file is open in this tab. <a href="#/captures">Choose one on the captures page.</a>
        </p>
      </div>
    )
  }
  return (
    <div className="page">
      <header className="bar">
        <a href="#/captures" className="back">
          ← Captures
        </a>
        <div className="bar-title">
          <strong>{opened.label}</strong>
          <span className="meta">{opened.cloud.count.toLocaleString()} room points · a room scan on its own, with no recording</span>
        </div>
      </header>
      <main className="main">
        <div className="viewer-wrap">
          <RoomFileViewer cloud={opened.cloud} />
        </div>
      </main>
    </div>
  )
}
