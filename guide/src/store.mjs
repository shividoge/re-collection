import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/** Capture ids are the manifest's UUID. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** File names inside a capture: plain names, plus one folder level for keyframes/. */
const NAME_PATTERN = /^(?:keyframes\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Files the guide writes itself; the phone can't upload over them. */
const GUIDE_FILES = new Set(['status.json', 'moment.json', 'hidden.json']);

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function isCaptureId(id) {
  return ID_PATTERN.test(id);
}

/**
 * Captures on disk: <dataDir>/captures/<id>/ holds the package exactly as the
 * phone wrote it, plus status.json (and later moment.json) written here.
 */
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.capturesDir = join(dataDir, 'captures');
  }

  captureDir(id) {
    if (!isCaptureId(id)) throw new StoreError(400, `"${id}" isn't a capture id (expected a UUID).`);
    return join(this.capturesDir, id.toLowerCase());
  }

  /**
   * Absolute path of a file inside a capture. Rejects anything that could
   * escape the capture folder, such as "../" or an absolute path.
   */
  filePath(id, name, { forWrite = false } = {}) {
    const dir = this.captureDir(id);
    if (!NAME_PATTERN.test(name) || name.includes('..')) {
      throw new StoreError(400, `"${name}" isn't an allowed file name.`);
    }
    if (forWrite && GUIDE_FILES.has(name)) {
      throw new StoreError(400, `"${name}" is written by the guide and can't be uploaded.`);
    }
    const path = resolve(dir, name);
    if (!path.startsWith(dir + sep)) throw new StoreError(400, `"${name}" isn't an allowed file name.`);
    return path;
  }

  async exists(id) {
    return existsSync(this.captureDir(id));
  }

  async readJson(id, name) {
    try {
      return JSON.parse(await readFile(this.filePath(id, name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new StoreError(422, `${name} isn't valid JSON: ${error.message}`);
      throw error;
    }
  }

  /** Writes through a temp file so a crash never leaves half a JSON file. */
  async writeJson(id, name, value) {
    const path = join(this.captureDir(id), name);
    await mkdir(this.captureDir(id), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
    await rename(`${path}.tmp`, path);
  }

  async status(id) {
    return (await this.readJson(id, 'status.json')) ?? { upload: 'receiving', facts: 'not_started', factsError: null };
  }

  async setStatus(id, changes) {
    const status = { ...(await this.status(id)), ...changes, updatedAt: new Date().toISOString() };
    await this.writeJson(id, 'status.json', status);
    return status;
  }

  /** True when the family marked this capture public (visitors can see it without a key). */
  async isPublic(id) {
    return (await this.status(id)).public === true;
  }

  async listIds() {
    if (!existsSync(this.capturesDir)) return [];
    const entries = await readdir(this.capturesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && isCaptureId(e.name)).map((e) => e.name);
  }

  /** Every file in a capture, as names relative to the capture folder ("keyframes/k0001.jpg"). */
  async listFiles(id) {
    const dir = this.captureDir(id);
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.endsWith('.part') && !e.name.endsWith('.tmp'))
      .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
      .sort();
  }

  async size(path) {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
}
