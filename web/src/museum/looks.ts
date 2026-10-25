// How the rooms look: wall and floor materials, frames, and the color of the light. Pictures
// always show in their own colors.

type RGB = [number, number, number]

export interface Look {
  /** Wall fabric, lower wall panel (wainscot) and how high, trim, ceiling. */
  wall: RGB
  wainscot: RGB
  wainscotHeight: number
  trim: string
  ceiling: string
  /** A herringbone floor. `mirror` 0: matte, no reflections. */
  floor: { light: RGB; dark: RGB; metersPerTile: number; mirror: number }
  frame: { color: string; metalness: number; roughness: number; border: number; depth: number }
  /** Card around the picture inside the frame (passe-partout), 0 for none. */
  mat: number
  matColor: string
  /** Light: color, how bright the room's main light is, and how warm the pools on the walls are. */
  light: string
  pool: string
  poolStrength: number
  /** Labels as dark cards (on light walls) or light ones. */
  darkLabel: boolean
  titleInk: string
  accent: string
  background: string
  /** Darkened corners (a photographic look); off where the room should stay evenly lit. */
  vignette: boolean
  /** Ambient occlusion strength (contact shadows in corners and under furniture). */
  occlusion: number
}

// A classic picture gallery, after the old public galleries families know: rose-red fabric
// walls, varnished dark wood panelling, an ivory cornice touched with gold, a skylight, ornate
// gilded frames, a herringbone floor with a Persian rug, and furniture to walk around.
export const LOOK: Look = {
  wall: [170, 74, 68],
  wainscot: [64, 38, 26],
  wainscotHeight: 1.05,
  trim: '#efe3cc',
  ceiling: '#f1e6d4',
  // Herringbone with only a faint reflection, under the rug.
  floor: { light: [164, 108, 66], dark: [82, 48, 28], metersPerTile: 1.6, mirror: 0.2 },
  frame: { color: '#caa253', metalness: 0.9, roughness: 0.32, border: 0.13, depth: 0.07 },
  mat: 0.035,
  matColor: '#eee3cc',
  light: '#fff3e0',
  pool: '#ffe4c2',
  poolStrength: 0.16,
  darkLabel: false,
  titleInk: '#f7ecdb',
  accent: '#e2b664',
  background: '#2a1714',
  vignette: false,
  occlusion: 1.4,
}
