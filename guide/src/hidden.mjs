/**
 * "Hide from her": parts of a scene the family removes because they might upset or confuse
 * the person (a hospital bed, a photo of someone who has died, clutter). Each is a box in the
 * capture's world coordinates (meters, y up), taken from what the family selected in the 3D
 * viewer. Every view the person or a visitor sees leaves the points inside these boxes out of
 * both the room and the people replay. Stored as hidden.json next to the capture.
 */

export const MAX_REGIONS = 16;
const FILE = 'hidden.json';

/** Checks and normalizes what the web app sends; throws a plain-language error otherwise. */
export function validateRegions(regions) {
  if (!Array.isArray(regions)) throw Object.assign(new Error('Send { "regions": [...] }.'), { status: 400 });
  if (regions.length > MAX_REGIONS) {
    throw Object.assign(new Error(`At most ${MAX_REGIONS} hidden things per visit.`), { status: 400 });
  }
  const vec = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1000);
  return regions.map((r, k) => {
    if (!r || !vec(r.min) || !vec(r.max) || r.min.some((m, i) => m >= r.max[i])) {
      throw Object.assign(new Error(`Hidden thing ${k + 1} needs min and max corners (3 numbers each, min below max).`), { status: 400 });
    }
    return {
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : `h${k + 1}`,
      label: String(r.label ?? '').trim().slice(0, 80),
      min: r.min,
      max: r.max,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    };
  });
}

export async function readRegions(store, id) {
  return (await store.readJson(id, FILE))?.regions ?? [];
}

export async function writeRegions(store, id, regions) {
  const clean = validateRegions(regions);
  await store.writeJson(id, FILE, { regions: clean, updatedAt: new Date().toISOString() });
  return clean;
}
