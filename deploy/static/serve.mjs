// Serves a built static site on your Mac, with Range support like GitHub
// Pages has, so you can check it before publishing anything.
//
//   node deploy/static/serve.mjs <site folder> [port]
import { createServer } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';

import { sendFile } from '../../guide/src/http.mjs';

const root = resolve(process.argv[2] ?? '.static-site');
const port = Number(process.argv[3] ?? 8790);

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let path = join(root, normalize(pathname).replace(/^[/\\]+/, '') || 'index.html');
  if (!path.startsWith(root + sep) && path !== root) {
    res.writeHead(400).end('Bad path');
    return;
  }
  let info = await stat(path).catch(() => null);
  if (info?.isDirectory()) {
    path = join(path, 'index.html');
    info = await stat(path).catch(() => null);
  }
  if (!info) {
    res.writeHead(404).end('Not found');
    return;
  }
  sendFile(req, res, path, info.size, path);
}).listen(port, '127.0.0.1', () => console.log(`Static site on http://127.0.0.1:${port} (from ${root})`));
