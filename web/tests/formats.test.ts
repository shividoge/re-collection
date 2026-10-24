import { describe, expect, it } from 'vitest'
import { encodeRoomBin, parseFramesJsonl, parseRoomBin } from '../src/scene/formats'

describe('room.bin', () => {
  it('round-trips count, xyz and rgb', () => {
    const positions = new Float32Array([0, 1, 2, -1.5, 0.25, -3])
    const colors = new Uint8Array([255, 0, 10, 1, 2, 3])
    const cloud = parseRoomBin(encodeRoomBin(positions, colors))
    expect(cloud.count).toBe(2)
    expect(Array.from(cloud.positions)).toEqual(Array.from(positions))
    expect(Array.from(cloud.colors)).toEqual(Array.from(colors))
  })

  it('reads the count as little-endian UInt32', () => {
    const buf = new ArrayBuffer(4 + 15)
    new Uint8Array(buf).set([1, 0, 0, 0])
    expect(parseRoomBin(buf).count).toBe(1)
  })

  it('rejects a file whose size does not match its count', () => {
    const buf = encodeRoomBin(new Float32Array(6), new Uint8Array(6))
    expect(() => parseRoomBin(buf.slice(0, buf.byteLength - 1))).toThrow(/expected 34 bytes for 2 points, got 33/)
  })

  it('rejects a file too short for the header', () => {
    expect(() => parseRoomBin(new ArrayBuffer(2))).toThrow(/too short/)
  })
})

describe('frames.jsonl', () => {
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1.5, -2, 1]
  const line = (o: object) => JSON.stringify(o)

  it('parses moment and scan frames and splits them by phase', () => {
    const text = [
      line({ t: -1.0, T, K: [1450, 1450, 960, 720], track: 'normal', d: 0, phase: 'scan' }),
      line({ i: 0, t: 0, T, K: [1450, 1450, 960, 720], track: 'normal', d: 1 }),
      '',
      line({ i: 1, t: 0.033, T, K: [1450, 1450, 960, 720], track: 'limited', d: null }),
    ].join('\n')
    const frames = parseFramesJsonl(text)
    expect(frames.moment.map((f) => f.t)).toEqual([0, 0.033])
    expect(frames.scan.map((f) => f.t)).toEqual([-1.0])
    expect(frames.moment[1].d).toBeNull()
    expect(frames.moment[0].T[12]).toBe(0.5)
  })

  it('sorts frames by time', () => {
    const text = [line({ i: 1, t: 0.2, T, K: [1, 1, 1, 1], d: null }), line({ i: 0, t: 0.1, T, K: [1, 1, 1, 1], d: null })].join('\n')
    expect(parseFramesJsonl(text).moment.map((f) => f.t)).toEqual([0.1, 0.2])
  })

  it('names the bad line when a pose is malformed', () => {
    const text = [line({ i: 0, t: 0, T, K: [1, 1, 1, 1], d: null }), line({ i: 1, t: 0.1, T: [1, 2, 3], K: [1, 1, 1, 1], d: null })].join('\n')
    expect(() => parseFramesJsonl(text)).toThrow(/line 2: T must be 16 numbers/)
  })

  it('names the bad line when JSON is invalid', () => {
    expect(() => parseFramesJsonl('{"t":0,')).toThrow(/line 1: invalid JSON/)
  })
})
