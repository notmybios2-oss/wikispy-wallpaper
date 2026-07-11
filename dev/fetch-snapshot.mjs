/*
 * Builds wallpaper/snapshot/: the FULL Wiki Spy catalogue split into
 * ~3000-object chunks, used as the data source on platforms whose browsers
 * enforce CORS against the API (Plash/GitHub Pages on macOS). The wallpaper
 * rotates through chunks at runtime, so memory stays small while the whole
 * catalogue gets traversed.
 *
 * One full run = ~catalogue/150 requests (~300), spaced politely.
 * Usage: node dev/fetch-snapshot.mjs
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://wiki-spy-uaew8.ondigitalocean.app';
const CHUNK_SIZE = 3000;
const MAX_REQUESTS = 400;
const OUT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'wallpaper', 'snapshot');

const byId = new Map();
let cursor = 0;
let requests = 0;
let wrapped = false;
let lastSize = -1;
let stalls = 0;

while (requests < MAX_REQUESTS && !wrapped && stalls < 3) {
  const res = await fetch(`${API}/objects?cursor=${cursor}&limit=150`, {
    headers: { accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} at request ${requests}`);
  const data = await res.json();
  requests++;
  for (const o of data.objects || []) {
    if (!o || !o.url || !o.width || !o.height || byId.has(o.cutoutId)) continue;
    byId.set(o.cutoutId, {
      url: o.url,
      title: o.title,
      description: o.description || '',
      extract: (o.extract || '').slice(0, 360),
      artist: (o.artist || '').slice(0, 80),
      license: o.license || '',
      articleUrl: o.articleUrl || o.pageUrl || '',
      width: o.width,
      height: o.height,
      cutoutId: o.cutoutId,
      mask: o.mask
    });
  }
  if (data.wrap) wrapped = true;
  if (data.nextCursor !== undefined) cursor = data.nextCursor;
  stalls = byId.size === lastSize ? stalls + 1 : 0;
  lastSize = byId.size;
  if (requests % 25 === 0) console.log(`${byId.size} objects after ${requests} requests…`);
  await new Promise(r => setTimeout(r, 250));
}

const objects = [...byId.values()];
// deterministic shuffle-free write; runtime shuffles per session
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
const chunks = [];
for (let i = 0; i < objects.length; i += CHUNK_SIZE) {
  chunks.push(objects.slice(i, i + CHUNK_SIZE));
}
chunks.forEach((c, i) => {
  writeFileSync(join(OUT_DIR, `chunk-${String(i).padStart(3, '0')}.json`), JSON.stringify({ objects: c }));
});
writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify({
  v: 2,
  savedAt: new Date().toISOString(),
  total: objects.length,
  chunkCount: chunks.length,
  chunkSize: CHUNK_SIZE
}));
console.log(`snapshot: ${objects.length} objects in ${chunks.length} chunks (${requests} requests, wrapped=${wrapped})`);
