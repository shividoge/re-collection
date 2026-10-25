import { createReadStream } from 'node:fs';
import { extname } from 'node:path';

const CONTENT_TYPES = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.bin': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, X-Braindance-Key',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
};

export function contentType(name) {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

export async function readJsonBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error("Request body isn't valid JSON."), { status: 400 });
  }
}

/**
 * Parses a single-range "bytes=" header against a file of `size` bytes.
 * Returns { start, end } (inclusive), null for "send the whole file", or
 * "unsatisfiable". Multi-range requests get the whole file, which is allowed.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, a, b] = match;
  if (a === '' && b === '') return 'unsatisfiable';

  let start;
  let end;
  if (a === '') {
    // Suffix range: the last b bytes.
    const length = Number(b);
    if (length === 0) return 'unsatisfiable';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Streams a file, honoring Range so video seeking and chunked depth reads work. */
export function sendFile(req, res, path, size, name) {
  const headers = {
    ...CORS_HEADERS,
    'Content-Type': contentType(name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = parseRange(req.headers.range, size);

  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': range.end - range.start + 1,
    });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
