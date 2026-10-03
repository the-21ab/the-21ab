export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const LIMITS = {
  title: 140,
  notes: 4000,
  tag: 40,
  tags: 30,
};

// Drops control characters (keeping newlines and tabs) so nothing weird ends up in CSVs or the UI.
function clean(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n');
}

export function cleanTitle(value) {
  const title = clean(value).replace(/\s+/g, ' ').trim();
  if (title.length > LIMITS.title) throw new HttpError(400, `title must be at most ${LIMITS.title} characters`);
  return title;
}

export function cleanNotes(value) {
  const notes = clean(value).trim();
  if (notes.length > LIMITS.notes) throw new HttpError(400, `notes must be at most ${LIMITS.notes} characters`);
  return notes;
}

/**
 * Accepts tags as an array and/or comma separated strings ("blue, Denim, #summer")
 * and returns a clean, de-duplicated, lowercase list in the order given.
 */
export function normalizeTags(values) {
  const list = Array.isArray(values) ? values : [values];
  const seen = new Set();
  for (const value of list) {
    if (value == null) continue;
    for (const piece of String(value).split(',')) {
      const tag = clean(piece).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '');
      if (!tag) continue;
      if (tag.length > LIMITS.tag) throw new HttpError(400, `tags must be at most ${LIMITS.tag} characters ("${tag.slice(0, 20)}...")`);
      seen.add(tag);
    }
  }
  if (seen.size > LIMITS.tags) throw new HttpError(400, `an item can have at most ${LIMITS.tags} tags`);
  return [...seen];
}

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Parses a ?since=/updated_since= value into a canonical ISO string, or throws a 400. */
export function parseTimestamp(value, name) {
  if (value == null || value === '') return null;
  const date = ISO_PREFIX.test(value) ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${name} must be an ISO 8601 timestamp, e.g. 2026-01-31T12:00:00Z`);
  }
  return date.toISOString();
}

export function parseIntParam(value, name, { min, max, fallback }) {
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new HttpError(400, `${name} must be a whole number`);
  const n = Number(value);
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}
