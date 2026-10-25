// Exports the captures marked public (and their finished sessions) as plain
// files for a static host such as GitHub Pages. Nothing is uploaded here.
//
//   node scripts/export-static.mjs <output folder>
import { loadConfig } from '../src/config.mjs';
import { exportStatic } from '../src/export-static.mjs';

const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node scripts/export-static.mjs <output folder>');
  process.exit(2);
}

const summary = await exportStatic({ dataDir: loadConfig().dataDir, outDir });
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} MB`;
if (summary.captures.length === 0) console.log('Nothing is marked public, so nothing was exported.');
for (const c of summary.captures) console.log(`  ${c.id.slice(0, 8)}  ${c.title || '(untitled)'}  ${mb(c.bytes)}`);
console.log(`Exported ${summary.captures.length} capture(s), ${summary.sessions} finished session(s), ${mb(summary.totalBytes)} of files.`);
for (const w of summary.warnings) console.warn(`WARNING: ${w}`);
if (summary.warnings.length) process.exit(1);
