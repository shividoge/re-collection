// How each room style looks: wall and floor materials, frames, and the color of the light.
// Pictures always show in their own colors; only the rooms around them change.

import type { RoomStyle } from './layout'

type RGB = [number, number, number]

export interface Look {
  label: string
  /** Wall paint, lower wall panel (wainscot) if any, trim, ceiling. */
  wall: RGB
  wainscot: RGB | null
  trim: string
  ceiling: string
  floor: { kind: 'planks' | 'herringbone' | 'stone'; light: RGB; dark: RGB; metersPerTile: number; mirror: number }
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
}

export const LOOKS: Record<RoomStyle, Look> = {
  gallery: {
    label: 'Sunlit gallery',
    wall: [243, 240, 233],
    wainscot: null,
    trim: '#e9e4da',
    ceiling: '#f6f4ef',
    floor: { kind: 'planks', light: [222, 196, 158], dark: [168, 132, 92], metersPerTile: 2.2, mirror: 0.35 },
    frame: { color: '#1b1b1d', metalness: 0.1, roughness: 0.45, border: 0.03, depth: 0.045 },
    mat: 0.11,
    matColor: '#fbfaf6',
    light: '#fff6ea',
    pool: '#fff1dc',
    poolStrength: 0.22,
    darkLabel: false,
    titleInk: '#2b2522',
    accent: '#ff9d5c',
    background: '#d9d5cd',
  },
  salon: {
    label: 'Warm salon',
    wall: [98, 44, 58],
    wainscot: [58, 28, 36],
    trim: '#d9b77a',
    ceiling: '#efe5d6',
    floor: { kind: 'herringbone', light: [164, 108, 66], dark: [82, 48, 28], metersPerTile: 1.6, mirror: 0.45 },
    frame: { color: '#c9a25a', metalness: 0.9, roughness: 0.32, border: 0.085, depth: 0.07 },
    mat: 0.05,
    matColor: '#efe6d3',
    light: '#ffd7a3',
    pool: '#ffcf8f',
    poolStrength: 0.42,
    darkLabel: true,
    titleInk: '#f6e7cf',
    accent: '#ffb35c',
    background: '#1a1013',
  },
  hall: {
    label: 'Grand hall',
    wall: [214, 203, 186],
    wainscot: null,
    trim: '#c8b9a2',
    ceiling: '#e8e0d2',
    floor: { kind: 'stone', light: [206, 199, 188], dark: [128, 118, 104], metersPerTile: 4, mirror: 0.6 },
    frame: { color: '#3b2a1f', metalness: 0.05, roughness: 0.5, border: 0.06, depth: 0.06 },
    mat: 0.12,
    matColor: '#f4efe4',
    light: '#fff0dc',
    pool: '#ffe6c2',
    poolStrength: 0.3,
    darkLabel: false,
    titleInk: '#3a2f27',
    accent: '#c8873e',
    background: '#cfc6b8',
  },
}
