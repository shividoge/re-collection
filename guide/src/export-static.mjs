import { constants, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { publicArrangement } from './arrangement.mjs';
import { createPublicViews } from './public-views.mjs';
import { createSessions } from './session.mjs';
import { Store } from './store.mjs';

/** GitHub rejects files over 100 MB and asks sites to stay under about 1 GB. */
const FILE_LIMIT = 95 * 1024 ** 2;
const SITE_LIMIT = 900 * 1024 ** 2;

export const EXPORT_MARKER = '.braindance-static-data';

/**
 * Writes everything the public front page reads as plain files under
 * <outDir>/data, so a static host can serve the site with no server. Built
 * from the same views as the live /public routes, so the same privacy rules
 * apply: public captures only, approved facts only, finished sessions only,
 * no internal files.
 *
 *   data/captures.json            data/captures/<id>.json
 *   data/moments/<id>.json        data/progress/<id>.json
 *   data/sessions/<sid>.json      data/files/<id>/<name>
 */
export async function exportStatic({ dataDir, outDir }) {
  outDir = resolve(outDir);
  const out = join(outDir, 'data');
  if (existsSync(out) && !existsSync(join(out, EXPORT_MARKER))) {
    throw new Error(`${out} exists and wasn't made by this exporter. Pick another folder.`);
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, EXPORT_MARKER), 'static export of the public Braindance captures\n');

  const store = new Store(dataDir);
  // Reading sessions never calls Claude, so no client or models are needed.
  const sessions = createSessions({ store, claude: null, models: {}, dataDir });
  const views = createPublicViews({ store, sessions });
  const FILES = 'data/files';

  const write = async (path, body) => {
    if (body === null) return false;
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), JSON.stringify(body));
    return true;
  };

  const summary = { captures: [], sessions: 0, totalBytes: 0, warnings: [] };
  await write('captures.json', await views.list(FILES));

  for (const id of await views.publicIds()) {
    await write(`captures/${id}.json`, await views.capture(id, FILES));
    await write(`moments/${id}.json`, await views.moment(id));
    await write(`progress/${id}.json`, await views.progress(id).catch(() => null));

    let bytes = 0;
    for (const name of await views.servedFiles(id)) {
      const target = join(out, 'files', id, name);
      await mkdir(dirname(target), { recursive: true });
      await cp(store.filePath(id, name), target, { mode: constants.COPYFILE_FICLONE });
      const size = (await stat(target)).size;
      bytes += size;
      if (size > FILE_LIMIT) summary.warnings.push(`${id}/${name} is ${(size / 1024 ** 2).toFixed(0)} MB; GitHub rejects files over 100 MB.`);
    }
    const manifest = await store.readJson(id, 'manifest.json');
    summary.captures.push({ id, title: manifest?.title ?? '', bytes });
    summary.totalBytes += bytes;
  }

  // The caretaker's museum (data/museum/arrangement.json), public pictures only.
  const museumFile = join(dataDir, 'museum.json');
  const arranged = existsSync(museumFile) ? JSON.parse(await readFile(museumFile, 'utf8')) : null;
  const shown = publicArrangement(arranged, await views.publicIds());
  if (shown) await write('museum/arrangement.json', { arrangement: shown });

  for (const sid of await views.sessionIds()) {
    if (await write(`sessions/${sid}.json`, await views.session(sid))) summary.sessions += 1;
  }

  if (summary.totalBytes > SITE_LIMIT) {
    summary.warnings.push(`The site is ${(summary.totalBytes / 1024 ** 2).toFixed(0)} MB; GitHub Pages sites should stay under about 1 GB.`);
  }
  return summary;
}
