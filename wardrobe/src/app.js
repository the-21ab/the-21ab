import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openDatabase, SORT_KEYS } from './db.js';
import { inspectImage, EXT_TYPES } from './images.js';
import { toCsv } from './csv.js';
import {
  HttpError, cleanTitle, cleanNotes, normalizeTags, parseTimestamp, parseIntParam,
} from './validate.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

// Friendly URLs for the pages.
const PAGES = { '/': 'index.html', '/add': 'add.html', '/share': 'share.html' };

const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
function randomId(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Uses ADMIN_TOKEN if given, else a token remembered in the data dir, else makes a new one. */
function resolveAdminToken(dataDir, configured) {
  if (configured) {
    if (configured.length < 8) throw new Error('ADMIN_TOKEN must be at least 8 characters long');
    return { token: configured, generated: false };
  }
  const file = path.join(dataDir, 'admin-token.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return { token: saved, generated: false, file };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { token, generated: true, file };
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, `upload is too big (max ${Math.round(limit / 1024 / 1024)} MB)`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `upload is too big (max ${Math.round(limit / 1024 / 1024)} MB)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads a request body as { fields: FormData-like getter, files }. Works for multipart, urlencoded and JSON. */
async function readForm(req, limit) {
  const type = req.headers['content-type'] || '';
  const body = await readBody(req, limit);

  if (type.startsWith('application/json')) {
    let data;
    try {
      data = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      throw new HttpError(400, 'body is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'JSON body must be an object');
    return {
      has: (k) => Object.hasOwn(data, k),
      get: (k) => data[k],
      getAll: (k) => (data[k] == null ? [] : [].concat(data[k])),
      file: () => null,
    };
  }

  if (type.startsWith('multipart/form-data') || type.startsWith('application/x-www-form-urlencoded')) {
    let form;
    try {
      form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': type }, body }).formData();
    } catch {
      throw new HttpError(400, 'could not read the form data');
    }
    return {
      has: (k) => form.has(k),
      get: (k) => {
        const v = form.get(k);
        return typeof v === 'string' ? v : null;
      },
      getAll: (k) => form.getAll(k).filter((v) => typeof v === 'string'),
      file: (k) => {
        const v = form.get(k);
        return v && typeof v === 'object' && v.size > 0 ? v : null;
      },
    };
  }

  throw new HttpError(415, 'send multipart/form-data (with a photo) or application/json');
}

async function readImageField(form, name) {
  const file = form.file(name);
  if (!file) return null;
  const buf = Buffer.from(await file.arrayBuffer());
  const info = inspectImage(buf);
  if (!info) throw new HttpError(415, `${name} must be a JPEG, PNG or WebP image`);
  return { buf, info };
}

export function createApp(options = {}) {
  const config = {
    dataDir: options.dataDir ?? path.resolve('data'),
    adminToken: options.adminToken || null,
    publicKey: options.publicKey || null,
    publicUrl: options.publicUrl ? options.publicUrl.replace(/\/+$/, '') : null,
    maxUploadBytes: options.maxUploadBytes ?? 25 * 1024 * 1024,
    siteName: options.siteName || 'Wardrobe',
  };

  const imageDir = path.join(config.dataDir, 'images');
  fs.mkdirSync(imageDir, { recursive: true });
  const db = openDatabase(path.join(config.dataDir, 'wardrobe.db'));
  const admin = resolveAdminToken(config.dataDir, config.adminToken);

  // Slows down anyone guessing the admin token: 20 misses per IP per 15 minutes.
  const failures = new Map();
  const FAIL_WINDOW = 15 * 60 * 1000;
  const FAIL_LIMIT = 20;

  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  }

  function bearer(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  }

  function isAdmin(req) {
    const token = bearer(req);
    return Boolean(token) && safeEqual(token, admin.token);
  }

  function requireAdmin(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const record = failures.get(ip);
    if (record && record.resetAt < now) failures.delete(ip);
    if (failures.get(ip)?.count >= FAIL_LIMIT) throw new HttpError(429, 'too many wrong passwords, try again in a few minutes');

    if (isAdmin(req)) return;
    if (bearer(req)) {
      const current = failures.get(ip) ?? { count: 0, resetAt: now + FAIL_WINDOW };
      current.count += 1;
      failures.set(ip, current);
      if (failures.size > 10_000) failures.clear(); // never let this grow without bound
    }
    throw new HttpError(401, 'you need to be signed in as the owner to do that');
  }

  function requireRead(req, url) {
    if (!config.publicKey) return;
    const key = url.searchParams.get('key') || req.headers['x-wardrobe-key'];
    if ((key && safeEqual(key, config.publicKey)) || isAdmin(req)) return;
    throw new HttpError(401, 'this closet is private: add ?key=... from the share link');
  }

  function baseUrl(req) {
    if (config.publicUrl) return config.publicUrl;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
      || (req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }

  function withKey(link) {
    return config.publicKey ? `${link}${link.includes('?') ? '&' : '?'}key=${encodeURIComponent(config.publicKey)}` : link;
  }

  function serialize(row, base) {
    const image = {
      url: withKey(`${base}/images/${row.image_file}`),
      type: row.image_type,
      width: row.image_width,
      height: row.image_height,
      bytes: row.image_bytes,
    };
    const thumbnail = row.thumb_file
      ? {
        url: withKey(`${base}/images/${row.thumb_file}`),
        type: row.thumb_type,
        width: row.thumb_width,
        height: row.thumb_height,
        bytes: row.thumb_bytes,
      }
      : image;
    return {
      id: row.id,
      title: row.title,
      tags: row.tags,
      notes: row.notes,
      image,
      thumbnail,
      url: withKey(`${base}/?item=${row.id}`),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ---------- responses ----------

  function setCommonHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'ETag, X-Total-Count, Link');
  }

  function send(req, res, status, body, headers = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { 'Content-Length': buf.length, ...headers });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  function sendJson(req, res, status, data, headers = {}) {
    send(req, res, status, `${JSON.stringify(data, null, 2)}\n`, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...headers,
    });
  }

  /** Sends a read-only feed with an ETag so crawlers can poll cheaply (they get a 304 when nothing changed). */
  function sendFeed(req, res, url, type, render) {
    const etag = `W/"${crypto.createHash('sha1').update(`${db.version()}|${url.search}|${baseUrl(req)}|${type}`).digest('base64url')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    const { body, headers = {} } = render();
    send(req, res, 200, body, { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, ...headers });
  }

  // ---------- image files ----------

  async function storeImage(id, image, suffix = '') {
    const name = `${id}-${randomId(6)}${suffix}.${image.info.ext}`;
    const tmp = path.join(imageDir, `.${name}.tmp`);
    await fsp.writeFile(tmp, image.buf);
    await fsp.rename(tmp, path.join(imageDir, name));
    return name;
  }

  async function removeImages(...names) {
    await Promise.all(names.filter(Boolean).map((n) => fsp.rm(path.join(imageDir, n), { force: true })));
  }

  function imageColumns(prefix, name, info) {
    return {
      [`${prefix}_file`]: name,
      [`${prefix}_type`]: info.type,
      [`${prefix}_width`]: info.width,
      [`${prefix}_height`]: info.height,
      [`${prefix}_bytes`]: info.bytes,
    };
  }

  // ---------- query parsing ----------

  function listQuery(url, { maxLimit, defaultLimit }) {
    const p = url.searchParams;
    const sort = p.get('sort') || 'newest';
    if (!SORT_KEYS.includes(sort)) throw new HttpError(400, `sort must be one of: ${SORT_KEYS.join(', ')}`);
    return {
      tags: normalizeTags(p.getAll('tag').concat(p.getAll('tags'))),
      q: (p.get('q') || '').trim().slice(0, 200),
      updatedSince: parseTimestamp(p.get('updated_since') ?? p.get('since'), 'updated_since'),
      sort,
      limit: parseIntParam(p.get('limit'), 'limit', { min: 1, max: maxLimit, fallback: defaultLimit }),
      offset: parseIntParam(p.get('offset'), 'offset', { min: 0, max: 1_000_000, fallback: 0 }),
    };
  }

  // ---------- route handlers ----------

  async function listItems(req, res, url) {
    requireRead(req, url);
    const query = listQuery(url, { maxLimit: 1000, defaultLimit: 100 });
    sendFeed(req, res, url, 'application/json; charset=utf-8', () => {
      const base = baseUrl(req);
      const { total, items } = db.listItems(query);
      const nextOffset = query.offset + items.length;
      let next = null;
      if (nextOffset < total) {
        const nextUrl = new URL(url.pathname + url.search, base);
        nextUrl.searchParams.set('offset', String(nextOffset));
        nextUrl.searchParams.set('limit', String(query.limit));
        next = nextUrl.toString();
      }
      const data = {
        total,
        count: items.length,
        offset: query.offset,
        limit: query.limit,
        next,
        generated_at: new Date().toISOString(),
        items: items.map((row) => serialize(row, base)),
      };
      const headers = { 'X-Total-Count': String(total) };
      if (next) headers.Link = `<${next}>; rel="next"`;
      return { body: `${JSON.stringify(data, null, 2)}\n`, headers };
    });
  }

  async function listItemsCsv(req, res, url) {
    requireRead(req, url);
    const query = listQuery(url, { maxLimit: 100_000, defaultLimit: 100_000 });
    sendFeed(req, res, url, 'text/csv; charset=utf-8', () => {
      const base = baseUrl(req);
      const { items } = db.listItems(query);
      const rows = items.map((row) => {
        const item = serialize(row, base);
        return {
          id: item.id,
          title: item.title,
          tags: item.tags.join(', '),
          notes: item.notes,
          image_url: item.image.url,
          thumbnail_url: item.thumbnail.url,
          image_width: item.image.width,
          image_height: item.image.height,
          page_url: item.url,
          created_at: item.created_at,
          updated_at: item.updated_at,
        };
      });
      const columns = ['id', 'title', 'tags', 'notes', 'image_url', 'thumbnail_url', 'image_width', 'image_height', 'page_url', 'created_at', 'updated_at'];
      return {
        body: toCsv(columns, rows, { userText: ['title', 'tags', 'notes'] }),
        headers: { 'Content-Disposition': 'inline; filename="wardrobe.csv"' },
      };
    });
  }

  async function getItem(req, res, url, id) {
    requireRead(req, url);
    const row = db.getItem(id);
    if (!row) throw new HttpError(404, 'no item with that id');
    sendJson(req, res, 200, serialize(row, baseUrl(req)));
  }

  async function createItem(req, res) {
    requireAdmin(req);
    const form = await readForm(req, config.maxUploadBytes);
    const image = await readImageField(form, 'image');
    if (!image) throw new HttpError(400, 'a photo is required (form field "image")');
    const thumb = await readImageField(form, 'thumbnail') ?? await readImageField(form, 'thumb');

    const fields = {
      title: cleanTitle(form.get('title')),
      notes: cleanNotes(form.get('notes')),
      tags: normalizeTags(form.getAll('tags').concat(form.getAll('tag'))),
    };

    const id = randomId(12);
    const now = new Date().toISOString();
    const imageName = await storeImage(id, image);
    let thumbName = null;
    try {
      if (thumb) thumbName = await storeImage(id, thumb, '-thumb');
      const row = db.createItem({
        id,
        ...fields,
        ...imageColumns('image', imageName, image.info),
        ...(thumb ? imageColumns('thumb', thumbName, thumb.info) : {}),
        created_at: now,
        updated_at: now,
      });
      const item = serialize(row, baseUrl(req));
      sendJson(req, res, 201, item, { Location: `${baseUrl(req)}/api/items/${id}` });
    } catch (err) {
      await removeImages(imageName, thumbName);
      throw err;
    }
  }

  async function updateItem(req, res, id) {
    requireAdmin(req);
    const existing = db.getItem(id);
    if (!existing) throw new HttpError(404, 'no item with that id');

    const form = await readForm(req, config.maxUploadBytes);
    const changes = {};
    if (form.has('title')) changes.title = cleanTitle(form.get('title'));
    if (form.has('notes')) changes.notes = cleanNotes(form.get('notes'));
    if (form.has('tags') || form.has('tag')) changes.tags = normalizeTags(form.getAll('tags').concat(form.getAll('tag')));

    const image = await readImageField(form, 'image');
    const thumb = await readImageField(form, 'thumbnail') ?? await readImageField(form, 'thumb');
    const written = [];
    const replaced = [];
    try {
      if (image) {
        const name = await storeImage(id, image);
        written.push(name);
        Object.assign(changes, imageColumns('image', name, image.info));
        replaced.push(existing.image_file);
        // A new photo makes the old thumbnail wrong, so drop it unless a new one came along.
        if (!thumb) {
          Object.assign(changes, { thumb_file: null, thumb_type: null, thumb_width: null, thumb_height: null, thumb_bytes: null });
          replaced.push(existing.thumb_file);
        }
      }
      if (thumb) {
        const name = await storeImage(id, thumb, '-thumb');
        written.push(name);
        Object.assign(changes, imageColumns('thumb', name, thumb.info));
        replaced.push(existing.thumb_file);
      }

      if (!Object.keys(changes).length) throw new HttpError(400, 'nothing to change: send title, notes, tags, image or thumbnail');
      changes.updated_at = new Date().toISOString();
      const row = db.updateItem(id, changes);
      if (!row) throw new HttpError(404, 'no item with that id');
      await removeImages(...replaced);
      sendJson(req, res, 200, serialize(row, baseUrl(req)));
    } catch (err) {
      await removeImages(...written);
      throw err;
    }
  }

  async function deleteItem(req, res, id) {
    requireAdmin(req);
    const row = db.deleteItem(id, new Date().toISOString());
    if (!row) throw new HttpError(404, 'no item with that id');
    await removeImages(row.image_file, row.thumb_file);
    res.writeHead(204);
    res.end();
  }

  async function serveImage(req, res, url, name) {
    requireRead(req, url);
    if (!/^[a-z0-9-]+\.(jpg|png|webp)$/.test(name)) throw new HttpError(404, 'not found');
    const file = path.join(imageDir, name);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    // File names change whenever a photo changes, so they can be cached forever.
    res.writeHead(200, {
      'Content-Type': EXT_TYPES[path.extname(name).slice(1)],
      'Content-Length': stat.size,
      'Cache-Control': config.publicKey ? 'private, max-age=31536000, immutable' : 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return res.end();
    await new Promise((resolve, reject) => {
      fs.createReadStream(file).on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
    });
  }

  async function serveStatic(req, res, pathname) {
    const rel = PAGES[pathname] ?? pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || rel.includes('\0')) throw new HttpError(404, 'not found');
    let data;
    try {
      data = await fsp.readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const ext = path.extname(file);
    const headers = {
      'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = CSP;
      headers['X-Frame-Options'] = 'DENY';
    }
    send(req, res, 200, data, headers);
  }

  function apiIndex(req, res) {
    const base = baseUrl(req);
    sendJson(req, res, 200, {
      name: config.siteName,
      docs: `${base}/share`,
      private: Boolean(config.publicKey),
      endpoints: {
        items: `GET ${base}/api/items?tag=&q=&sort=newest|oldest|updated|title&updated_since=&limit=&offset=`,
        item: `GET ${base}/api/items/{id}`,
        csv: `GET ${base}/api/items.csv`,
        tags: `GET ${base}/api/tags`,
        deleted: `GET ${base}/api/deleted?since=`,
        create: `POST ${base}/api/items (owner only, multipart: image, thumbnail?, title?, tags?, notes?)`,
        update: `PATCH ${base}/api/items/{id} (owner only)`,
        remove: `DELETE ${base}/api/items/{id} (owner only)`,
      },
    });
  }

  // ---------- router ----------

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let m;

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, X-Wardrobe-Key',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    if (pathname === '/api' || pathname === '/api/') {
      if (method === 'GET') return apiIndex(req, res);
    } else if (pathname === '/api/health') {
      if (method === 'GET') return sendJson(req, res, 200, { ok: true });
    } else if (pathname === '/api/session') {
      if (method === 'GET') {
        requireAdmin(req);
        return sendJson(req, res, 200, { owner: true, private: Boolean(config.publicKey), key: config.publicKey });
      }
    } else if (pathname === '/api/items' || pathname === '/api/items.json') {
      if (method === 'GET') return listItems(req, res, url);
      if (method === 'POST' && pathname === '/api/items') return createItem(req, res);
    } else if (pathname === '/api/items.csv') {
      if (method === 'GET') return listItemsCsv(req, res, url);
    } else if ((m = pathname.match(/^\/api\/items\/([a-z0-9]{1,40})$/))) {
      if (method === 'GET') return getItem(req, res, url, m[1]);
      if (method === 'PATCH' || method === 'PUT') return updateItem(req, res, m[1]);
      if (method === 'DELETE') return deleteItem(req, res, m[1]);
    } else if (pathname === '/api/tags') {
      if (method === 'GET') {
        requireRead(req, url);
        return sendFeed(req, res, url, 'application/json; charset=utf-8', () => ({
          body: `${JSON.stringify({ tags: db.listTags() }, null, 2)}\n`,
        }));
      }
    } else if (pathname === '/api/deleted') {
      if (method === 'GET') {
        requireRead(req, url);
        const since = parseTimestamp(url.searchParams.get('since'), 'since');
        return sendJson(req, res, 200, { deleted: db.deletedSince(since) });
      }
    } else if ((m = pathname.match(/^\/images\/([^/]+)$/))) {
      if (method === 'GET') return serveImage(req, res, url, m[1]);
    } else if (pathname.startsWith('/api/')) {
      throw new HttpError(404, 'no such endpoint, see /api');
    } else if (method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    throw new HttpError(405, `${req.method} is not allowed here`);
  }

  const server = http.createServer(async (req, res) => {
    setCommonHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(req, res, 400, { error: 'bad url' });
    }
    try {
      await route(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      // Drain whatever the client is still sending so it actually sees the error.
      req.resume();
      sendJson(req, res, status, { error: status === 500 ? 'something went wrong on the server' : err.message }, {
        Connection: status === 413 ? 'close' : 'keep-alive',
      });
    }
  });

  return {
    server,
    db,
    adminToken: admin.token,
    adminTokenGenerated: admin.generated,
    adminTokenFile: admin.file ?? null,
    config,
    close: () => new Promise((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
      server.closeIdleConnections?.();
    }),
  };
}
