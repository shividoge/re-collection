// Keyframe JPEGs → small RGBA copies at the depth grid's size, for the timeline's colors (the
// browser drew each keyframe into a canvas of that size; useRoomSurface.ts loadKeyframes).
import sharp from 'sharp'

/** RGBA rows, top first, `width`×`height`; throws a plain message when the file isn't a readable image. */
export async function smallKeyframe(name: string, jpeg: Uint8Array, width: number, height: number): Promise<Uint8ClampedArray> {
  try {
    // rotate(): honor EXIF orientation, as createImageBitmap does by default.
    const raw = await sharp(jpeg).rotate().resize(width, height, { fit: 'fill', kernel: 'linear' }).ensureAlpha().raw().toBuffer()
    return new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength)
  } catch {
    throw new Error(`The keyframe ${name} isn't a readable image.`)
  }
}
