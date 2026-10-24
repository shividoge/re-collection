import { SceneViewer } from '../scene/SceneViewer'
import { loadRoomFile, type LoadedCapture } from '../scene/loadCapture'

/** A room.bin opened from this computer. It lives only in this tab; nothing is uploaded. */
let opened: LoadedCapture | null = null

/** Reads a room.bin chosen on the captures page and opens it in the viewer. */
export async function openRoomFile(file: File): Promise<void> {
  opened = await loadRoomFile(file)
  location.hash = '#/room'
}

/** Just the scanned room, with no recording: orbit, fly and select. */
export function RoomFile() {
  if (!opened) {
    return (
      <div className="center-message">
        <p>
          No room file is open in this tab. <a href="#/">Choose one on the captures page.</a>
        </p>
      </div>
    )
  }
  return (
    <div className="page">
      <header className="bar">
        <a href="#/" className="back">
          ← Captures
        </a>
        <div className="bar-title">
          <strong>{opened.label}</strong>
          <span className="meta">{opened.cloud?.count.toLocaleString()} room points · a room scan on its own, with no recording</span>
        </div>
      </header>
      <main className="main">
        <div className="viewer-wrap">
          <SceneViewer capture={opened} showVideo={false} />
        </div>
      </main>
    </div>
  )
}
