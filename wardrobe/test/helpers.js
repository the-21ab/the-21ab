import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp } from '../src/app.js';

export const TOKEN = 'test-owner-password';

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A real, decodable PNG of the given size filled with one colour. */
export function makePng(width, height, rgb = [40, 70, 120]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Just enough JPEG structure (SOI, an APP0 segment, SOF0) for type and size sniffing. */
export function makeJpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wardrobe-test-'));
}

export async function startApp(options = {}) {
  const dataDir = options.dataDir ?? tempDir();
  const app = createApp({ adminToken: TOKEN, ...options, dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    base,
    dataDir,
    async stop({ keepData = false } = {}) {
      await app.close();
      if (!keepData && !options.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function auth(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

/** POSTs a new item. `fields` values may be strings or arrays (repeated fields). */
export async function addItem(base, { image = makePng(40, 50), thumbnail, type = 'image/png', ...fields } = {}, headers = auth()) {
  const form = new FormData();
  if (image) form.set('image', new Blob([image], { type }), 'photo');
  if (thumbnail) form.set('thumbnail', new Blob([thumbnail], { type }), 'thumb');
  for (const [k, v] of Object.entries(fields)) {
    for (const value of [].concat(v)) form.append(k, value);
  }
  return fetch(`${base}/api/items`, { method: 'POST', headers, body: form });
}

export function imageFiles(dataDir) {
  return fs.readdirSync(path.join(dataDir, 'images')).filter((f) => !f.startsWith('.')).sort();
}
