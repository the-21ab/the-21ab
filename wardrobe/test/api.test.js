import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createApp } from '../src/app.js';
import {
  startApp, addItem, auth, makePng, makeJpeg, imageFiles, tempDir,
} from './helpers.js';

async function json(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

describe('creating items', () => {
  let ctx;
  before(async () => { ctx = await startApp(); });
  after(() => ctx.stop());

  test('saves a photo with tags, name and notes', async () => {
    const res = await addItem(ctx.base, {
      image: makePng(300, 400),
      thumbnail: makePng(60, 80),
      title: '  Navy   overcoat ',
      tags: ['Wool, #Winter', 'navy', 'wool'],
      notes: 'Bought in Oslo\r\nsize 50',
    });
    assert.equal(res.status, 201);
    const item = await json(res);
    assert.match(item.id, /^[0-9a-z]{12}$/);
    assert.equal(item.title, 'Navy overcoat');
    assert.deepEqual(item.tags, ['navy', 'winter', 'wool']);
    assert.equal(item.notes, 'Bought in Oslo\nsize 50');
    assert.deepEqual(
      { type: item.image.type, width: item.image.width, height: item.image.height },
      { type: 'image/png', width: 300, height: 400 },
    );
    assert.equal(item.thumbnail.width, 60);
    assert.ok(item.image.url.startsWith(`${ctx.base}/images/`));
    assert.equal(item.url, `${ctx.base}/?item=${item.id}`);
    assert.equal(res.headers.get('location'), `${ctx.base}/api/items/${item.id}`);
    assert.equal(item.created_at, item.updated_at);

    const photo = await fetch(item.image.url);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.match(photo.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), makePng(300, 400));
  });

  test('uses the full photo as the thumbnail when none is sent', async () => {
    const item = await json(await addItem(ctx.base, { image: makeJpeg(1200, 900), type: 'image/jpeg' }));
    assert.equal(item.thumbnail.url, item.image.url);
    assert.equal(item.image.type, 'image/jpeg');
    assert.equal(item.image.width, 1200);
    assert.equal(item.title, '');
    assert.deepEqual(item.tags, []);
  });

  test('requires a photo', async () => {
    const res = await addItem(ctx.base, { image: null, title: 'x' });
    assert.equal(res.status, 400);
    assert.match((await json(res)).error, /photo is required/);
  });

  test('rejects files that are not images, whatever they claim to be', async () => {
    const res = await addItem(ctx.base, { image: Buffer.from('<script>alert(1)</script>'), type: 'image/png' });
    assert.equal(res.status, 415);
  });

  test('rejects JSON bodies on create (there is no photo in them)', async () => {
    const res = await fetch(`${ctx.base}/api/items`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: '{"title":"x"}',
    });
    assert.equal(res.status, 400);
  });

  test('validates lengths and tag counts', async () => {
    assert.equal((await addItem(ctx.base, { title: 'x'.repeat(141) })).status, 400);
    assert.equal((await addItem(ctx.base, { notes: 'x'.repeat(4001) })).status, 400);
    assert.equal((await addItem(ctx.base, { tags: 'y'.repeat(41) })).status, 400);
    const many = Array.from({ length: 31 }, (_, i) => `t${i}`).join(',');
    assert.equal((await addItem(ctx.base, { tags: many })).status, 400);
  });

  test('does not leave stray files behind when a request fails', async () => {
    const before = imageFiles(ctx.dataDir);
    await addItem(ctx.base, { title: 'x'.repeat(500) });
    await addItem(ctx.base, { image: Buffer.from('nope') });
    assert.deepEqual(imageFiles(ctx.dataDir), before);
  });
});

describe('owner access', () => {
  let ctx;
  before(async () => { ctx = await startApp(); });
  after(() => ctx.stop());

  test('writes need the owner password', async () => {
    assert.equal((await addItem(ctx.base, {}, {})).status, 401);
    assert.equal((await addItem(ctx.base, {}, auth('wrong-password'))).status, 401);
    const item = await json(await addItem(ctx.base, {}));
    assert.equal((await fetch(`${ctx.base}/api/items/${item.id}`, { method: 'DELETE' })).status, 401);
    const patch = await fetch(`${ctx.base}/api/items/${item.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"hacked"}',
    });
    assert.equal(patch.status, 401);
    assert.equal((await json(await fetch(`${ctx.base}/api/items/${item.id}`))).title, '');
  });

  test('session endpoint confirms the password', async () => {
    assert.equal((await fetch(`${ctx.base}/api/session`, { headers: auth() })).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/session`)).status, 401);
  });

  test('locks out an address after too many wrong passwords', async () => {
    let last;
    for (let i = 0; i < 21; i++) {
      last = await fetch(`${ctx.base}/api/session`, { headers: { ...auth('guess'), 'X-Forwarded-For': '203.0.113.9' } });
    }
    assert.equal(last.status, 429);
    // Even the right password is refused from that address for now...
    const locked = await fetch(`${ctx.base}/api/session`, { headers: { ...auth(), 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(locked.status, 429);
    // ...but other people are unaffected.
    const other = await fetch(`${ctx.base}/api/session`, { headers: { ...auth(), 'X-Forwarded-For': '198.51.100.1' } });
    assert.equal(other.status, 200);
  });

  test('makes up an owner password when none is configured, and keeps it', async () => {
    const dir = tempDir();
    const first = await startApp({ dataDir: dir, adminToken: '' });
    const token = first.app.adminToken;
    assert.ok(first.app.adminTokenGenerated);
    assert.ok(token.length >= 20);
    assert.equal(fs.statSync(path.join(dir, 'admin-token.txt')).mode & 0o777, 0o600);
    await first.stop();

    const second = await startApp({ dataDir: dir, adminToken: '' });
    assert.equal(second.app.adminToken, token);
    assert.equal(second.app.adminTokenGenerated, false);
    assert.equal((await fetch(`${second.base}/api/session`, { headers: auth(token) })).status, 200);
    await second.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses a too-short ADMIN_TOKEN', () => {
    const dir = tempDir();
    assert.throws(() => createApp({ dataDir: dir, adminToken: 'short' }), /at least 8/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('reading the closet', () => {
  let ctx;
  const ids = {};
  before(async () => {
    ctx = await startApp();
    const add = async (key, fields) => {
      ids[key] = (await json(await addItem(ctx.base, fields))).id;
      await new Promise((r) => setTimeout(r, 5)); // distinct timestamps for sorting
    };
    await add('shirt', { title: 'Oxford shirt', tags: 'shirt, white, cotton, work' });
    await add('jeans', { title: 'Selvedge jeans', tags: 'jeans, blue, denim', notes: 'Raw 100% cotton' });
    await add('tee', { title: 'Blue tee', tags: 'shirt, blue, cotton' });
    await add('coat', { title: 'Wool coat', tags: 'coat, navy, wool, work', notes: '=HYPERLINK("http://evil")' });
  });
  after(() => ctx.stop());

  test('lists everything, newest first, with totals', async () => {
    const res = await fetch(`${ctx.base}/api/items`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-total-count'), '4');
    const data = await json(res);
    assert.equal(data.total, 4);
    assert.equal(data.next, null);
    assert.deepEqual(data.items.map((i) => i.title), ['Wool coat', 'Blue tee', 'Selvedge jeans', 'Oxford shirt']);
  });

  test('sorts other ways', async () => {
    const titles = async (sort) => (await json(await fetch(`${ctx.base}/api/items?sort=${sort}`))).items.map((i) => i.title);
    assert.deepEqual(await titles('oldest'), ['Oxford shirt', 'Selvedge jeans', 'Blue tee', 'Wool coat']);
    assert.deepEqual(await titles('title'), ['Blue tee', 'Oxford shirt', 'Selvedge jeans', 'Wool coat']);
    assert.equal((await fetch(`${ctx.base}/api/items?sort=random`)).status, 400);
  });

  test('filters by tags (must have all of them)', async () => {
    const titles = async (qs) => (await json(await fetch(`${ctx.base}/api/items?${qs}`))).items.map((i) => i.title).sort();
    assert.deepEqual(await titles('tag=shirt'), ['Blue tee', 'Oxford shirt']);
    assert.deepEqual(await titles('tag=shirt&tag=blue'), ['Blue tee']);
    assert.deepEqual(await titles('tag=Work'), ['Oxford shirt', 'Wool coat']);
    assert.deepEqual(await titles('tags=cotton,blue'), ['Blue tee']);
    assert.deepEqual(await titles('tag=nothing'), []);
  });

  test('searches names, notes and tags, word by word', async () => {
    const titles = async (q) => (await json(await fetch(`${ctx.base}/api/items?q=${encodeURIComponent(q)}`))).items.map((i) => i.title).sort();
    assert.deepEqual(await titles('jeans'), ['Selvedge jeans']);
    assert.deepEqual(await titles('denim'), ['Selvedge jeans']);
    assert.deepEqual(await titles('100%'), ['Selvedge jeans']);
    assert.deepEqual(await titles('cotton blue'), ['Blue tee', 'Selvedge jeans']);
    assert.deepEqual(await titles('WOOL'), ['Wool coat']);
    assert.deepEqual(await titles('_'), []);
  });

  test('pages through results with a next link', async () => {
    const first = await fetch(`${ctx.base}/api/items?limit=3`);
    const page1 = await json(first);
    assert.equal(page1.count, 3);
    assert.ok(page1.next);
    assert.match(first.headers.get('link'), /rel="next"/);
    const page2 = await json(await fetch(page1.next));
    assert.equal(page2.count, 1);
    assert.equal(page2.next, null);
    const all = [...page1.items, ...page2.items].map((i) => i.id);
    assert.equal(new Set(all).size, 4);
    assert.equal((await fetch(`${ctx.base}/api/items?limit=0`)).status, 400);
    assert.equal((await fetch(`${ctx.base}/api/items?limit=abc`)).status, 400);
  });

  test('gets one item', async () => {
    const item = await json(await fetch(`${ctx.base}/api/items/${ids.jeans}`));
    assert.equal(item.title, 'Selvedge jeans');
    assert.deepEqual(item.tags, ['blue', 'denim', 'jeans']);
    assert.equal((await fetch(`${ctx.base}/api/items/doesnotexist`)).status, 404);
  });

  test('counts tags', async () => {
    const { tags } = await json(await fetch(`${ctx.base}/api/tags`));
    assert.deepEqual(tags.slice(0, 4), [
      { tag: 'blue', count: 2 }, { tag: 'cotton', count: 2 }, { tag: 'shirt', count: 2 }, { tag: 'work', count: 2 },
    ]);
    assert.equal(tags.length, 10);
  });

  test('exports CSV for spreadsheets', async () => {
    const res = await fetch(`${ctx.base}/api/items.csv?sort=oldest`);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    const lines = (await res.text()).trimEnd().split('\r\n');
    assert.equal(lines[0], 'id,title,tags,notes,image_url,thumbnail_url,image_width,image_height,page_url,created_at,updated_at');
    assert.equal(lines.length, 5);
    assert.ok(lines[1].startsWith(`${ids.shirt},Oxford shirt,"cotton, shirt, white, work",,${ctx.base}/images/`));
    // A note that looks like a formula is defused and quoted properly.
    assert.ok(lines[4].includes(`"'=HYPERLINK(""http://evil"")"`));
    const filtered = (await (await fetch(`${ctx.base}/api/items.csv?tag=jeans`)).text()).trimEnd().split('\r\n');
    assert.equal(filtered.length, 2);
  });

  test('answers 304 when nothing changed, so polling is cheap', async () => {
    const first = await fetch(`${ctx.base}/api/items`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const again = await fetch(`${ctx.base}/api/items`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');

    // Different query, different ETag.
    const other = await fetch(`${ctx.base}/api/items?tag=shirt`, { headers: { 'If-None-Match': etag } });
    assert.equal(other.status, 200);

    await fetch(`${ctx.base}/api/items/${ids.tee}`, {
      method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' }, body: '{"notes":"faded"}',
    });
    const changed = await fetch(`${ctx.base}/api/items`, { headers: { 'If-None-Match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
  });

  test('supports HEAD and CORS preflight', async () => {
    const head = await fetch(`${ctx.base}/api/items`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const pre = await fetch(`${ctx.base}/api/items`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  });

  test('rejects bad timestamps', async () => {
    assert.equal((await fetch(`${ctx.base}/api/items?updated_since=yesterday`)).status, 400);
    assert.equal((await fetch(`${ctx.base}/api/deleted?since=2026-13-45`)).status, 400);
  });
});

describe('editing and deleting', () => {
  let ctx;
  before(async () => { ctx = await startApp(); });
  after(() => ctx.stop());

  const patch = (base, id, body, headers = {}) => fetch(`${base}/api/items/${id}`, {
    method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  test('changes only the fields sent', async () => {
    const item = await json(await addItem(ctx.base, { title: 'Linen shirt', tags: 'shirt, linen', notes: 'M' }));
    await new Promise((r) => setTimeout(r, 5));
    const res = await patch(ctx.base, item.id, { tags: ['Shirt', 'linen', 'summer'] });
    assert.equal(res.status, 200);
    const updated = await json(res);
    assert.equal(updated.title, 'Linen shirt');
    assert.equal(updated.notes, 'M');
    assert.deepEqual(updated.tags, ['linen', 'shirt', 'summer']);
    assert.equal(updated.created_at, item.created_at);
    assert.ok(updated.updated_at > item.updated_at);

    const cleared = await json(await patch(ctx.base, item.id, { tags: [], notes: '' }));
    assert.deepEqual(cleared.tags, []);
    assert.equal(cleared.notes, '');
  });

  test('says so when there is nothing to change or the item is gone', async () => {
    const item = await json(await addItem(ctx.base, {}));
    assert.equal((await patch(ctx.base, item.id, {})).status, 400);
    assert.equal((await patch(ctx.base, 'missing', { title: 'x' })).status, 404);
    const bad = await fetch(`${ctx.base}/api/items/${item.id}`, {
      method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' }, body: '{oops',
    });
    assert.equal(bad.status, 400);
  });

  test('replacing the photo swaps files on disk and drops the stale thumbnail', async () => {
    const item = await json(await addItem(ctx.base, { image: makePng(100, 100), thumbnail: makePng(10, 10) }));
    const before = imageFiles(ctx.dataDir).filter((f) => f.startsWith(item.id));
    assert.equal(before.length, 2);

    const form = new FormData();
    form.set('image', new Blob([makePng(200, 150)], { type: 'image/png' }), 'new');
    const res = await fetch(`${ctx.base}/api/items/${item.id}`, { method: 'PATCH', headers: auth(), body: form });
    assert.equal(res.status, 200);
    const updated = await json(res);
    assert.equal(updated.image.width, 200);
    assert.notEqual(updated.image.url, item.image.url);
    assert.equal(updated.thumbnail.url, updated.image.url);

    const after = imageFiles(ctx.dataDir).filter((f) => f.startsWith(item.id));
    assert.equal(after.length, 1);
    assert.equal((await fetch(item.image.url)).status, 404);
    assert.equal((await fetch(updated.image.url)).status, 200);
  });

  test('delete removes the photos and leaves a tombstone for syncing apps', async () => {
    const start = new Date().toISOString();
    const item = await json(await addItem(ctx.base, { image: makePng(20, 20), thumbnail: makePng(5, 5), tags: 'gone' }));
    const res = await fetch(`${ctx.base}/api/items/${item.id}`, { method: 'DELETE', headers: auth() });
    assert.equal(res.status, 204);
    assert.equal((await fetch(`${ctx.base}/api/items/${item.id}`)).status, 404);
    assert.equal(imageFiles(ctx.dataDir).filter((f) => f.startsWith(item.id)).length, 0);
    assert.equal((await fetch(`${ctx.base}/api/items/${item.id}`, { method: 'DELETE', headers: auth() })).status, 404);

    const { deleted } = await json(await fetch(`${ctx.base}/api/deleted?since=${encodeURIComponent(start)}`));
    assert.deepEqual(deleted.map((d) => d.id), [item.id]);
    const { tags } = await json(await fetch(`${ctx.base}/api/tags`));
    assert.ok(!tags.some((t) => t.tag === 'gone'));
  });

  test('updated_since returns only what changed', async () => {
    await addItem(ctx.base, { title: 'old one' });
    await new Promise((r) => setTimeout(r, 10));
    const mark = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    const fresh = await json(await addItem(ctx.base, { title: 'new one' }));
    const data = await json(await fetch(`${ctx.base}/api/items?updated_since=${encodeURIComponent(mark)}`));
    assert.deepEqual(data.items.map((i) => i.id), [fresh.id]);
  });
});

describe('private closet (PUBLIC_KEY set)', () => {
  let ctx;
  let item;
  before(async () => {
    ctx = await startApp({ publicKey: 's3cret-key' });
    item = await json(await addItem(ctx.base, { title: 'Secret jacket' }));
  });
  after(() => ctx.stop());

  test('hides everything without the key', async () => {
    for (const p of ['/api/items', '/api/items.csv', '/api/tags', `/api/items/${item.id}`, '/api/deleted']) {
      assert.equal((await fetch(`${ctx.base}${p}`)).status, 401, p);
    }
    assert.equal((await fetch(`${ctx.base}/api/items?key=wrong`)).status, 401);
    const photo = new URL(item.image.url);
    photo.searchParams.delete('key');
    assert.equal((await fetch(photo)).status, 401);
  });

  test('opens up with the key in the link or a header, and links carry the key', async () => {
    const data = await json(await fetch(`${ctx.base}/api/items?key=s3cret-key`));
    assert.equal(data.items[0].title, 'Secret jacket');
    assert.match(data.items[0].image.url, /\?key=s3cret-key$/);
    assert.equal((await fetch(data.items[0].image.url)).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/items`, { headers: { 'X-Wardrobe-Key': 's3cret-key' } })).status, 200);
  });

  test('the owner can read without the key and sees it in the session', async () => {
    assert.equal((await fetch(`${ctx.base}/api/items`, { headers: auth() })).status, 200);
    const session = await json(await fetch(`${ctx.base}/api/session`, { headers: auth() }));
    assert.deepEqual(session, { owner: true, private: true, key: 's3cret-key' });
  });

  test('the API index says the closet is private but shows nothing else', async () => {
    const info = await json(await fetch(`${ctx.base}/api`));
    assert.equal(info.private, true);
    assert.ok(!JSON.stringify(info).includes('s3cret-key'));
  });
});

describe('pages, limits and odd requests', () => {
  let ctx;
  before(async () => { ctx = await startApp({ maxUploadBytes: 64 * 1024, publicUrl: 'https://closet.example.com/' }); });
  after(() => ctx.stop());

  test('serves the app pages with a strict content security policy', async () => {
    for (const [p, marker] of [['/', 'gallery.js'], ['/add', 'add.js'], ['/share', 'share.js']]) {
      const res = await fetch(`${ctx.base}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
      assert.ok((await res.text()).includes(marker));
    }
    assert.equal((await fetch(`${ctx.base}/app.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await fetch(`${ctx.base}/manifest.webmanifest`)).status, 200);
  });

  test('blocks path tricks', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/%2e%2e%2fsrc/app.js', '/images/..%2fwardrobe.db', '/images/x.db']) {
      assert.equal((await fetch(`${ctx.base}${p}`)).status, 404, p);
    }
  });

  test('uses PUBLIC_URL for links when set', async () => {
    const item = await json(await addItem(ctx.base, {}));
    assert.ok(item.image.url.startsWith('https://closet.example.com/images/'));
    assert.equal(item.url, `https://closet.example.com/?item=${item.id}`);
  });

  test('refuses uploads over the size limit', async () => {
    const res = await addItem(ctx.base, { title: 'big', padding: 'z'.repeat(70 * 1024) });
    assert.equal(res.status, 413);
    assert.match((await json(res)).error, /too big/);
  });

  test('unknown endpoints and methods get clear errors', async () => {
    assert.equal((await fetch(`${ctx.base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/api/tags`, { method: 'POST', headers: auth() })).status, 405);
    assert.equal((await fetch(`${ctx.base}/api/health`)).status, 200);
  });
});
