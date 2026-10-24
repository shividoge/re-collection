// Copies a capture folder (from AirDrop or the sample release) into the guide's
// data directory and validates it, exactly as if the phone had uploaded it.
//
//   npm run import -- ~/Downloads/capture-<uuid>
import { existsSync } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { validateCapture } from '../src/validate.mjs';

const source = process.argv[2];
if (!source) {
  console.error('Usage: npm run import -- <capture folder>');
  process.exit(2);
}
const folder = resolve(source);
const manifestPath = join(folder, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`${folder} has no manifest.json; point at the capture-<uuid> folder itself.`);
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const store = new Store(loadConfig().dataDir);
const id = manifest.id;
const target = store.captureDir(id);

// The guide's own files are never copied in from outside.
await cp(folder, target, {
  recursive: true,
  filter: (src) => !/(^|\/)(status|moment)\.json$/.test(src) && !src.endsWith('.DS_Store'),
});

const result = await validateCapture(store, id);
if (result.ok) {
  await store.setStatus(id, { upload: 'done', uploadErrors: [], warnings: result.warnings, facts: 'queued', factsError: null });
  console.log(`Imported ${id} into ${target}`);
} else {
  await store.setStatus(id, { upload: 'invalid', uploadErrors: result.errors, warnings: result.warnings });
  console.error(`Imported ${id}, but it isn't valid:`);
  for (const error of result.errors) console.error(`  - ${error}`);
}
for (const warning of result.warnings) console.log(`  warning: ${warning}`);
process.exit(result.ok ? 0 : 1);
