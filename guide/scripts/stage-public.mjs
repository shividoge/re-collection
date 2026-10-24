// Copies only what visitors may see into a staging folder, ready to rsync to
// the server: captures marked public, plus the sessions that belong to them.
// Private captures and everything else in guide/data never leave this Mac.
//
//   node scripts/stage-public.mjs <staging folder>
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';

const target = process.argv[2] && resolve(process.argv[2]);
if (!target) {
  console.error('Usage: node scripts/stage-public.mjs <staging folder>');
  process.exit(2);
}

// Only ever wipe a folder this script made, never an arbitrary one.
const MARKER = '.braindance-stage';
if (existsSync(target) && !existsSync(join(target, MARKER))) {
  console.error(`${target} exists and isn't a staging folder made by this script. Pick a new path.`);
  process.exit(2);
}
await rm(target, { recursive: true, force: true });
await mkdir(join(target, 'captures'), { recursive: true });
await writeFile(join(target, MARKER), 'staging folder for the Braindance public deploy\n');

const config = loadConfig();
const store = new Store(config.dataDir);
const publicIds = new Set();
for (const id of await store.listIds()) {
  if (!(await store.isPublic(id))) continue;
  publicIds.add(id);
  await cp(store.captureDir(id), join(target, 'captures', id), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    // room.ply is never served, so don't upload it.
    filter: (source) => !source.endsWith('.ply') && !source.endsWith('.part') && !source.endsWith('.tmp'),
  });
}

let sessionCount = 0;
const sessionsDir = join(config.dataDir, 'sessions');
if (existsSync(sessionsDir)) {
  await mkdir(join(target, 'sessions'), { recursive: true });
  for (const name of await readdir(sessionsDir)) {
    if (!name.endsWith('.json')) continue;
    const session = JSON.parse(await readFile(join(sessionsDir, name), 'utf8'));
    if (!publicIds.has(session.momentId) || !session.endedAt) continue;
    await cp(join(sessionsDir, name), join(target, 'sessions', name), { mode: constants.COPYFILE_FICLONE });
    sessionCount += 1;
  }
}

console.log(`Staged ${publicIds.size} public capture(s) and ${sessionCount} finished session(s) in ${target}`);
