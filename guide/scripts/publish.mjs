// Marks a capture public (visitors can see it at the site's front page, no
// key) or private again. Only the family's choice makes a capture visible.
//
//   npm run publish -- <capture id>          make it public
//   npm run publish -- <capture id> --off    make it private again
//   npm run publish -- --list                show what is public now
import { loadConfig } from '../src/config.mjs';
import { Store, isCaptureId } from '../src/store.mjs';

const args = process.argv.slice(2);
const store = new Store(loadConfig().dataDir);

if (args.includes('--list')) {
  const ids = [];
  for (const id of await store.listIds()) if (await store.isPublic(id)) ids.push(id);
  console.log(ids.length ? ids.join('\n') : 'Nothing is public.');
  process.exit(0);
}

const id = args.find((a) => !a.startsWith('--'));
if (!id || !isCaptureId(id) || !(await store.exists(id))) {
  console.error('Usage: npm run publish -- <capture id> [--off]   (or --list)');
  process.exit(2);
}
const on = !args.includes('--off');
await store.setStatus(id, { public: on });
console.log(`${id} is now ${on ? 'PUBLIC' : 'private'}.`);
