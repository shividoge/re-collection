// The 3D code's public surface (docs/architecture-v3.md: the web reads baked files only).
export { SceneViewer, RoomFileViewer, type ViewerControls, type NavMode } from './SceneViewer'
export { useCaptureScene, useSceneNotes, type CaptureScene, type CaptureSceneState, type SceneNote } from './useCaptureScene'
export { SceneRoom, SceneReplay, type RoomView } from './SceneRoom'
export { Playback, usePlayback, usePlaybackState, PlaybackDriver, type PlaybackState } from './playback'
export { ProcessingStatus } from './ProcessingStatus'
export { HoleFill } from './HoleFill'
export type { Selection } from './useRoomIndex'
