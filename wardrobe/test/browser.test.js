// End-to-end check in a real (headless) phone-sized browser: sign in, snap a photo, tag it,
// find it in the closet, edit it, delete it. Skips itself when Playwright isn't installed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startApp, makePng, TOKEN } from './helpers.js';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}

const SHOTS = process.env.SCREENSHOT_DIR;

describe('in the browser', { skip: !chromium && 'playwright is not installed (npm i -D playwright to run this)' }, () => {
  let ctx;
  let browser;
  let page;
  let photo;

  async function shot(name) {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  }

  before(async () => {
    ctx = await startApp();
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
    page.on('pageerror', (err) => { throw err; });
    photo = path.join(ctx.dataDir, 'jacket.png');
    fs.writeFileSync(photo, makePng(600, 800, [170, 90, 60]));
  });

  after(async () => {
    await browser?.close();
    await ctx?.stop();
  });

  test('an empty closet invites the owner to sign in', async () => {
    await page.goto(ctx.base);
    await page.getByText('No clothes here yet').waitFor();
    assert.equal(await page.locator('#add-link').isHidden(), true);
    await shot('1-empty');
  });

  test('a wrong password is refused, the right one works', async () => {
    await page.goto(`${ctx.base}/add`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByPlaceholder('Owner password').fill('nope-nope');
    await page.getByRole('dialog').getByRole('button', { name: 'Sign in' }).click();
    await page.getByText("That password didn't work.").waitFor();
    await page.getByPlaceholder('Owner password').fill(TOKEN);
    await page.getByRole('dialog').getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Save to closet' }).waitFor();
  });

  test('takes a photo, tags it and saves it', async () => {
    await page.getByRole('button', { name: 'Save to closet' }).click();
    await page.getByText('Take or choose a photo first.').waitFor();

    await page.locator('#camera').setInputFiles(photo);
    await page.locator('#preview[src^="blob:"]').waitFor();
    await page.getByRole('button', { name: '↻ Rotate' }).click();

    const tagInput = page.locator('#tag-input');
    await tagInput.fill('Jacket');
    await tagInput.press('Enter');
    await tagInput.fill('#rust, suede');
    await tagInput.press('Enter');
    await tagInput.fill('autumn'); // left in the box, should still be saved
    await page.locator('#title').fill('Rust suede jacket');
    await page.locator('#notes').fill('Vintage, size M');
    await shot('2-add-filled');

    await page.getByRole('button', { name: 'Save to closet' }).click();
    await page.getByRole('heading', { name: 'Saved' }).waitFor();
    await shot('3-saved');

    const { items } = await (await fetch(`${ctx.base}/api/items`)).json();
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.title, 'Rust suede jacket');
    assert.deepEqual(item.tags, ['autumn', 'jacket', 'rust', 'suede']);
    assert.equal(item.notes, 'Vintage, size M');
    // Re-encoded in the browser: JPEG, rotated a quarter turn, with a small thumbnail.
    assert.equal(item.image.type, 'image/jpeg');
    assert.deepEqual([item.image.width, item.image.height], [800, 600]);
    assert.ok(item.thumbnail.width <= 512 && item.thumbnail.url !== item.image.url);
  });

  test('suggests existing tags for the next piece', async () => {
    await page.locator('#done').getByRole('button', { name: /Add another/ }).click();
    await page.getByRole('button', { name: '+ suede' }).click();
    assert.ok(await page.locator('.tag-editor .chip[data-tag="suede"]').isVisible());
    await page.locator('#tag-input').fill('ja');
    assert.equal(await page.getByRole('button', { name: '+ jacket' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '+ rust' }).count(), 0);
  });

  test('shows it in the closet with search and tag filters', async () => {
    await page.goto(ctx.base);
    await page.getByRole('button', { name: /Rust suede jacket/ }).waitFor();
    assert.match(await page.locator('#count').textContent(), /1 piece/);
    await shot('4-gallery');

    await page.locator('.tagbar').getByRole('button', { name: /^suede/ }).click();
    await page.getByText('1 piece tagged suede').waitFor();
    assert.match(page.url(), /tag=suede/);

    await page.locator('#search').fill('linen');
    await page.getByText('Nothing matches').waitFor();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('button', { name: /Rust suede jacket/ }).waitFor();
  });

  test('opens, edits and deletes a piece', async () => {
    await page.getByRole('button', { name: /Rust suede jacket/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Vintage, size M').waitFor();
    await shot('5-detail');

    await dialog.getByRole('button', { name: 'Edit' }).click();
    await dialog.locator('input.input').first().fill('Rust suede bomber');
    await dialog.getByRole('button', { name: 'Remove tag autumn' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.getByRole('heading', { name: 'Rust suede bomber' }).waitFor();

    const { items } = await (await fetch(`${ctx.base}/api/items`)).json();
    assert.equal(items[0].title, 'Rust suede bomber');
    assert.deepEqual(items[0].tags, ['jacket', 'rust', 'suede']);

    page.once('dialog', (d) => d.accept());
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await page.getByText('No clothes here yet').waitFor();
    assert.equal((await (await fetch(`${ctx.base}/api/items`)).json()).total, 0);
  });

  test('the share page lists working links', async () => {
    await page.goto(`${ctx.base}/share`);
    const csv = `${ctx.base}/api/items.csv`;
    await page.getByText(`=IMPORTDATA("${csv}")`).waitFor();
    await shot('6-share');
    assert.equal((await fetch(csv)).status, 200);
  });
});
