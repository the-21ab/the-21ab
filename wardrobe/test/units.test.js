import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { inspectImage } from '../src/images.js';
import { toCsv } from '../src/csv.js';
import {
  normalizeTags, cleanTitle, cleanNotes, parseTimestamp, parseIntParam, HttpError,
} from '../src/validate.js';
import { makePng, makeJpeg } from './helpers.js';

function webp(chunk, payload) {
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from(chunk), Buffer.alloc(4), payload]);
  const head = Buffer.alloc(8);
  head.write('RIFF');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

describe('inspectImage', () => {
  test('reads PNG size', () => {
    assert.deepEqual(inspectImage(makePng(123, 45)), { type: 'image/png', ext: 'png', width: 123, height: 45, bytes: makePng(123, 45).length });
  });

  test('reads JPEG size past other segments and fill bytes', () => {
    const jpeg = makeJpeg(4032, 3024);
    const padded = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff]), jpeg.subarray(2)]);
    for (const buf of [jpeg, padded]) {
      const info = inspectImage(buf);
      assert.equal(info.type, 'image/jpeg');
      assert.equal(info.width, 4032);
      assert.equal(info.height, 3024);
    }
  });

  test('reads lossy, lossless and extended WebP sizes', () => {
    const lossy = Buffer.alloc(10);
    lossy.writeUInt16LE(640, 6);
    lossy.writeUInt16LE(480, 8);
    assert.deepEqual([inspectImage(webp('VP8 ', lossy)).width, inspectImage(webp('VP8 ', lossy)).height], [640, 480]);

    const lossless = Buffer.alloc(10);
    lossless[0] = 0x2f;
    lossless.writeUInt32LE(((300 - 1) | ((200 - 1) << 14)) >>> 0, 1);
    const ll = inspectImage(webp('VP8L', lossless));
    assert.deepEqual([ll.width, ll.height], [300, 200]);

    const extended = Buffer.alloc(10);
    extended.writeUIntLE(1920 - 1, 4, 3);
    extended.writeUIntLE(1080 - 1, 7, 3);
    const ex = inspectImage(webp('VP8X', extended));
    assert.deepEqual([ex.type, ex.width, ex.height], ['image/webp', 1920, 1080]);
  });

  test('still accepts an image whose size it cannot read', () => {
    const info = inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    assert.equal(info.type, 'image/jpeg');
    assert.equal(info.width, null);
  });

  test('rejects everything else', () => {
    for (const bad of ['', 'hello', 'GIF89a......', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'RIFF....WAVE']) {
      assert.equal(inspectImage(Buffer.from(bad)), null, bad);
    }
  });
});

describe('normalizeTags', () => {
  test('splits, trims, lowercases, strips # and de-duplicates', () => {
    assert.deepEqual(normalizeTags(['Blue, Navy  Blue', ' #Summer ', 'blue', '', ' , ']), ['blue', 'navy blue', 'summer']);
  });

  test('handles a single string, null and full-width characters', () => {
    assert.deepEqual(normalizeTags('ＡＢＣ'), ['abc']);
    assert.deepEqual(normalizeTags(null), []);
    assert.deepEqual(normalizeTags([null, undefined]), []);
  });

  test('enforces limits with a 400', () => {
    assert.throws(() => normalizeTags('x'.repeat(41)), (e) => e instanceof HttpError && e.status === 400);
    assert.throws(() => normalizeTags(Array.from({ length: 31 }, (_, i) => `t${i}`)), /at most 30/);
    assert.equal(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 30);
  });
});

describe('text fields', () => {
  test('titles collapse whitespace and lose control characters', () => {
    assert.equal(cleanTitle('  Red\u0000  \n scarf\u0007 '), 'Red scarf');
    assert.equal(cleanTitle(undefined), '');
  });

  test('notes keep line breaks', () => {
    assert.equal(cleanNotes('a\r\nb\rc\u0001'), 'a\nb\nc');
  });
});

describe('query params', () => {
  test('timestamps become canonical ISO strings', () => {
    assert.equal(parseTimestamp('2026-01-02', 'since'), '2026-01-02T00:00:00.000Z');
    assert.equal(parseTimestamp('2026-01-02T03:04:05+02:00', 'since'), '2026-01-02T01:04:05.000Z');
    assert.equal(parseTimestamp('', 'since'), null);
    assert.throws(() => parseTimestamp('last week', 'since'), /ISO 8601/);
    assert.throws(() => parseTimestamp('2026-02-31x', 'since'), /ISO 8601/);
  });

  test('integers are range checked', () => {
    const opts = { min: 1, max: 10, fallback: 5 };
    assert.equal(parseIntParam(null, 'limit', opts), 5);
    assert.equal(parseIntParam('7', 'limit', opts), 7);
    for (const bad of ['0', '11', '-1', '2.5', 'ten']) assert.throws(() => parseIntParam(bad, 'limit', opts), HttpError, bad);
  });
});

describe('toCsv', () => {
  test('quotes what needs quoting and defuses formulas only in user text', () => {
    const csv = toCsv(['a', 'b', 'url'], [
      { a: 'plain', b: 'has, comma', url: '=not user text' },
      { a: 'say "hi"', b: 'two\nlines', url: null },
      { a: '+1', b: '@me', url: 'x' },
    ], { userText: ['a', 'b'] });
    assert.equal(csv, [
      'a,b,url',
      'plain,"has, comma",=not user text',
      '"say ""hi""","two\nlines",',
      "'+1,'@me,x",
      '',
    ].join('\r\n'));
  });
});
