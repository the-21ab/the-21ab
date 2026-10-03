import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS items (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT '',
    image_file   TEXT NOT NULL,
    image_type   TEXT NOT NULL,
    image_width  INTEGER,
    image_height INTEGER,
    image_bytes  INTEGER NOT NULL,
    thumb_file   TEXT,
    thumb_type   TEXT,
    thumb_width  INTEGER,
    thumb_height INTEGER,
    thumb_bytes  INTEGER,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS item_tags (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (item_id, tag)
  );
  CREATE INDEX IF NOT EXISTS item_tags_tag ON item_tags(tag);
  CREATE INDEX IF NOT EXISTS items_updated ON items(updated_at);
  CREATE INDEX IF NOT EXISTS items_created ON items(created_at);

  -- Tombstones, so anything syncing the closet can find out what was removed.
  CREATE TABLE IF NOT EXISTS deleted_items (
    id         TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deleted_items_at ON deleted_items(deleted_at);
`;

const SORTS = {
  newest: 'i.created_at DESC, i.id DESC',
  oldest: 'i.created_at ASC, i.id ASC',
  updated: 'i.updated_at DESC, i.id DESC',
  title: "i.title COLLATE NOCASE ASC, i.created_at DESC",
};

export const SORT_KEYS = Object.keys(SORTS);

// Escapes LIKE wildcards so a search for "100%" means the literal text.
function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const stmts = {
    get: db.prepare('SELECT * FROM items WHERE id = ?'),
    tagsFor: db.prepare('SELECT tag FROM item_tags WHERE item_id = ? ORDER BY tag'),
    insert: db.prepare(`
      INSERT INTO items (id, title, notes, image_file, image_type, image_width, image_height, image_bytes,
                         thumb_file, thumb_type, thumb_width, thumb_height, thumb_bytes, created_at, updated_at)
      VALUES ($id, $title, $notes, $image_file, $image_type, $image_width, $image_height, $image_bytes,
              $thumb_file, $thumb_type, $thumb_width, $thumb_height, $thumb_bytes, $created_at, $updated_at)`),
    insertTag: db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)'),
    clearTags: db.prepare('DELETE FROM item_tags WHERE item_id = ?'),
    remove: db.prepare('DELETE FROM items WHERE id = ?'),
    tombstone: db.prepare('INSERT OR REPLACE INTO deleted_items (id, deleted_at) VALUES (?, ?)'),
    tags: db.prepare('SELECT tag, COUNT(*) AS count FROM item_tags GROUP BY tag ORDER BY count DESC, tag ASC'),
    deletedSince: db.prepare('SELECT id, deleted_at FROM deleted_items WHERE deleted_at >= ? ORDER BY deleted_at ASC'),
    stats: db.prepare('SELECT COUNT(*) AS count, MAX(updated_at) AS last_updated FROM items'),
    lastDeleted: db.prepare('SELECT MAX(deleted_at) AS last_deleted FROM deleted_items'),
  };

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function hydrate(row) {
    if (!row) return null;
    return { ...row, tags: stmts.tagsFor.all(row.id).map((r) => r.tag) };
  }

  function writeTags(id, tags) {
    stmts.clearTags.run(id);
    for (const tag of tags) stmts.insertTag.run(id, tag);
  }

  return {
    close: () => db.close(),

    getItem: (id) => hydrate(stmts.get.get(id)),

    createItem(item) {
      transaction(() => {
        stmts.insert.run({
          $id: item.id,
          $title: item.title,
          $notes: item.notes,
          $image_file: item.image_file,
          $image_type: item.image_type,
          $image_width: item.image_width ?? null,
          $image_height: item.image_height ?? null,
          $image_bytes: item.image_bytes,
          $thumb_file: item.thumb_file ?? null,
          $thumb_type: item.thumb_type ?? null,
          $thumb_width: item.thumb_width ?? null,
          $thumb_height: item.thumb_height ?? null,
          $thumb_bytes: item.thumb_bytes ?? null,
          $created_at: item.created_at,
          $updated_at: item.updated_at,
        });
        writeTags(item.id, item.tags);
        // An id can only come back if someone recreates it, but keep the feed honest anyway.
        db.prepare('DELETE FROM deleted_items WHERE id = ?').run(item.id);
      });
      return hydrate(stmts.get.get(item.id));
    },

    // `changes` holds only the columns being changed (plus optional `tags`).
    updateItem(id, changes) {
      return transaction(() => {
        if (!stmts.get.get(id)) return null;
        const { tags, ...columns } = changes;
        const names = Object.keys(columns);
        if (names.length) {
          const sets = names.map((n) => `${n} = $${n}`).join(', ');
          const params = Object.fromEntries(names.map((n) => [`$${n}`, columns[n] ?? null]));
          db.prepare(`UPDATE items SET ${sets} WHERE id = $id`).run({ ...params, $id: id });
        }
        if (tags) writeTags(id, tags);
        return hydrate(stmts.get.get(id));
      });
    },

    deleteItem(id, deletedAt) {
      return transaction(() => {
        const row = hydrate(stmts.get.get(id));
        if (!row) return null;
        stmts.remove.run(id);
        stmts.tombstone.run(id, deletedAt);
        return row;
      });
    },

    listItems({ tags = [], q = '', updatedSince = null, sort = 'newest', limit = 100, offset = 0 }) {
      const where = [];
      const params = {};

      if (tags.length) {
        const names = tags.map((_, i) => `$tag${i}`);
        tags.forEach((t, i) => { params[`$tag${i}`] = t; });
        where.push(`i.id IN (
          SELECT item_id FROM item_tags WHERE tag IN (${names.join(', ')})
          GROUP BY item_id HAVING COUNT(DISTINCT tag) = ${tags.length})`);
      }

      if (q) {
        // Every word has to match somewhere: title, notes, or a tag.
        q.split(/\s+/).filter(Boolean).slice(0, 10).forEach((word, i) => {
          params[`$q${i}`] = likePattern(word.toLowerCase());
          where.push(`(lower(i.title) LIKE $q${i} ESCAPE '\\' OR lower(i.notes) LIKE $q${i} ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag LIKE $q${i} ESCAPE '\\'))`);
        });
      }

      if (updatedSince) {
        params.$since = updatedSince;
        where.push('i.updated_at >= $since');
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM items i ${whereSql}`).get(params).n;
      const rows = db
        .prepare(`SELECT i.* FROM items i ${whereSql} ORDER BY ${SORTS[sort] ?? SORTS.newest} LIMIT $limit OFFSET $offset`)
        .all({ ...params, $limit: limit, $offset: offset });

      return { total, items: rows.map(hydrate) };
    },

    listTags: () => stmts.tags.all().map((r) => ({ tag: r.tag, count: r.count })),

    deletedSince: (since) => stmts.deletedSince.all(since ?? ''),

    // Cheap fingerprint of the whole closet, used for ETags on feed responses.
    version() {
      const { count, last_updated } = stmts.stats.get();
      const { last_deleted } = stmts.lastDeleted.get();
      return `${count}:${last_updated ?? ''}:${last_deleted ?? ''}`;
    },
  };
}
