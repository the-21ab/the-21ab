import {
  api, upload, checkOwner, signIn, setToken, h, toast, copyText, formatDate, TagEditor, preparePhoto, withShareKey, ApiError,
} from './common.js';

const PAGE_SIZE = 60;

const els = {
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  more: document.getElementById('more'),
  summary: document.getElementById('summary'),
  tags: document.getElementById('tags'),
  search: document.getElementById('search'),
  sort: document.getElementById('sort'),
  count: document.getElementById('count'),
  signin: document.getElementById('signin'),
  add: document.getElementById('add-link'),
};

const params = new URLSearchParams(location.search);
const state = {
  q: params.get('q') || '',
  sort: params.get('sort') || 'newest',
  tags: new Set(params.getAll('tag')),
  items: [],
  total: 0,
  allTags: [],
  owner: null,
  request: 0,
};

els.search.value = state.q;
els.sort.value = state.sort;
document.getElementById('share-link').href = withShareKey('/share');
document.getElementById('home-link').href = withShareKey('/');

// ---------- URL <-> state ----------

function syncUrl() {
  const url = new URL(location.href);
  for (const k of ['q', 'sort', 'tag']) url.searchParams.delete(k);
  if (state.q) url.searchParams.set('q', state.q);
  if (state.sort !== 'newest') url.searchParams.set('sort', state.sort);
  state.tags.forEach((t) => url.searchParams.append('tag', t));
  history.replaceState(history.state, '', url);
}

function query(offset) {
  const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), sort: state.sort });
  if (state.q) p.set('q', state.q);
  state.tags.forEach((t) => p.append('tag', t));
  return `/api/items?${p}`;
}

// ---------- rendering ----------

function card(item) {
  return h('button', { class: 'card', type: 'button', onclick: () => openItem(item) },
    h('img', {
      class: 'photo', src: item.thumbnail.url, alt: item.title || item.tags.join(', ') || 'Clothing item', loading: 'lazy', decoding: 'async',
    }),
    h('div', { class: 'meta' },
      h('div', { class: `title${item.title ? '' : ' untitled'}` }, item.title || 'Untitled'),
      item.tags.length ? h('div', { class: 'tags' }, item.tags.map((t) => h('span', { class: 'tag' }, t))) : null));
}

function renderTags() {
  const selected = [...state.tags].filter((t) => !state.allTags.some((x) => x.tag === t)).map((tag) => ({ tag, count: 0 }));
  const list = [...selected, ...state.allTags];
  els.tags.replaceChildren(...list.map(({ tag, count }) => h('button', {
    type: 'button',
    class: 'chip',
    'aria-pressed': String(state.tags.has(tag)),
    onclick: () => {
      if (state.tags.has(tag)) state.tags.delete(tag);
      else state.tags.add(tag);
      renderTags();
      reload();
    },
  }, tag, count ? h('span', { class: 'count' }, count) : null)));
  els.tags.parentElement.hidden = list.length === 0;
}

function renderSummary() {
  const filtered = state.q || state.tags.size;
  if (!filtered) {
    els.summary.textContent = '';
    return;
  }
  const bits = [];
  if (state.tags.size) bits.push(`tagged ${[...state.tags].join(' + ')}`);
  if (state.q) bits.push(`matching “${state.q}”`);
  els.summary.textContent = `${state.total} ${state.total === 1 ? 'piece' : 'pieces'} ${bits.join(', ')}`;
}

function renderEmpty() {
  const filtered = state.q || state.tags.size;
  els.empty.hidden = state.items.length > 0;
  if (state.items.length) return;
  if (filtered) {
    els.empty.replaceChildren(
      h('h2', {}, 'Nothing matches'),
      h('p', {}, 'Try a different search or clear the tag filters.'),
      h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => {
          state.q = '';
          els.search.value = '';
          state.tags.clear();
          renderTags();
          reload();
        },
      }, 'Clear filters'),
    );
  } else {
    els.empty.replaceChildren(
      h('h2', {}, 'No clothes here yet'),
      h('p', {}, state.owner ? 'Snap a photo of something you own and give it a few tags.' : 'Check back soon.'),
      state.owner ? h('a', { class: 'btn primary big', href: '/add' }, '+ Add your first piece') : null,
    );
  }
}

function showError(err) {
  els.empty.hidden = false;
  els.empty.replaceChildren(h('h2', {}, "Couldn't load the closet"), h('p', {}, err.message));
}

// ---------- loading ----------

async function reload() {
  syncUrl();
  const request = ++state.request;
  try {
    const data = await api(query(0));
    if (request !== state.request) return; // a newer search started while this one was in flight
    state.items = data.items;
    state.total = data.total;
    els.grid.replaceChildren(...data.items.map(card));
    els.more.hidden = !data.next;
    renderSummary();
    renderEmpty();
  } catch (err) {
    if (request === state.request) showError(err);
  }
}

async function loadMore() {
  els.more.disabled = true;
  const request = state.request;
  try {
    const data = await api(query(state.items.length));
    if (request !== state.request) return;
    state.items.push(...data.items);
    els.grid.append(...data.items.map(card));
    els.more.hidden = !data.next;
  } catch (err) {
    toast(err.message);
  } finally {
    els.more.disabled = false;
  }
}

async function loadTags() {
  try {
    state.allTags = (await api('/api/tags')).tags;
    renderTags();
  } catch { /* the grid will show the real error */ }
}

async function loadCount() {
  try {
    const { total } = await api('/api/items?limit=1');
    els.count.textContent = `${total} ${total === 1 ? 'piece' : 'pieces'}`;
  } catch { /* not important */ }
}

function refreshAll() {
  loadTags();
  loadCount();
  reload();
}

// ---------- item detail / edit ----------

function closeItemUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('item');
  history.replaceState(history.state, '', url);
}

function openItem(item) {
  const url = new URL(location.href);
  url.searchParams.set('item', item.id);
  history.replaceState(history.state, '', url);

  const body = h('div', { class: 'sheet-body' });
  const heading = h('h2', {}, item.title || 'Untitled');
  const close = h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕');
  const dialog = h('dialog', { 'aria-label': item.title || 'Clothing item' }, h('div', { class: 'sheet-head' }, heading, close), body);
  dialog.addEventListener('close', () => {
    dialog.remove();
    closeItemUrl();
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  function showView() {
    heading.textContent = item.title || 'Untitled';
    body.replaceChildren(
      h('a', { href: item.image.url, target: '_blank', rel: 'noopener' },
        h('img', { class: 'detail-photo', src: item.image.url, alt: item.title || 'Clothing item' })),
      item.tags.length ? h('div', { class: 'chips' }, item.tags.map((t) => h('button', {
        class: 'chip',
        type: 'button',
        onclick: () => {
          dialog.close();
          state.tags = new Set([t]);
          renderTags();
          reload();
        },
      }, t))) : null,
      item.notes ? h('p', { class: 'detail-notes' }, item.notes) : null,
      h('p', { class: 'detail-dates' },
        `Added ${formatDate(item.created_at)}`,
        item.updated_at !== item.created_at ? ` · edited ${formatDate(item.updated_at)}` : ''),
      h('div', { class: 'actions' },
        state.owner ? h('button', { class: 'btn primary', type: 'button', onclick: showEdit }, 'Edit') : null,
        h('button', { class: 'btn', type: 'button', onclick: () => copyText(item.url) }, 'Copy link'),
        h('a', { class: 'btn', href: withShareKey(`/api/items/${item.id}`), target: '_blank', rel: 'noopener' }, 'JSON'),
        state.owner ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Delete') : null),
    );
  }

  function showEdit() {
    const title = h('input', { class: 'input', value: item.title, maxlength: '140', placeholder: 'e.g. Navy wool overcoat' });
    const tags = new TagEditor({ tags: item.tags, suggestions: state.allTags.map((t) => t.tag) });
    const notes = h('textarea', { class: 'input', maxlength: '4000', placeholder: 'Brand, size, where it came from…' });
    notes.value = item.notes;
    const photo = h('input', { type: 'file', accept: 'image/*', class: 'input' });
    const error = h('div', { class: 'error', hidden: true });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');

    const form = h('form', { class: 'sheet-body' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), title),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Tags'), tags.el),
      h('label', { class: 'field' }, h('span', {}, 'Notes'), notes),
      h('label', { class: 'field' }, h('span', {}, 'Replace photo ', h('span', { class: 'hint' }, '(optional)')), photo),
      error,
      h('div', { class: 'actions' }, save, h('button', { class: 'btn ghost', type: 'button', onclick: showView }, 'Cancel')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      save.textContent = 'Saving…';
      error.hidden = true;
      try {
        const fields = { title: title.value, tags: tags.value(), notes: notes.value };
        if (photo.files[0]) {
          const prepared = await preparePhoto(photo.files[0]);
          const data = new FormData();
          data.set('title', fields.title);
          data.set('notes', fields.notes);
          data.set('tags', fields.tags.join(','));
          data.set('image', prepared.image, 'photo.jpg');
          data.set('thumbnail', prepared.thumbnail, 'thumb.jpg');
          item = await upload(`/api/items/${item.id}`, { method: 'PATCH', form: data });
        } else {
          item = await api(`/api/items/${item.id}`, { method: 'PATCH', json: fields });
        }
        toast('Saved');
        showView();
        refreshAll();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        if (err instanceof ApiError && err.status === 401) setToken('');
      } finally {
        save.disabled = false;
        save.textContent = 'Save';
      }
    });

    heading.textContent = 'Edit';
    body.replaceChildren(form);
    title.focus();
  }

  async function remove() {
    if (!confirm(`Delete “${item.title || 'this item'}”? This can't be undone.`)) return;
    try {
      await api(`/api/items/${item.id}`, { method: 'DELETE' });
      dialog.close();
      toast('Deleted');
      refreshAll();
    } catch (err) {
      toast(err.message);
    }
  }

  showView();
  document.body.append(dialog);
  dialog.showModal();
}

// ---------- owner state ----------

function renderOwner() {
  els.add.hidden = !state.owner;
  els.signin.hidden = false;
  els.signin.textContent = state.owner ? 'Sign out' : 'Sign in';
}

els.signin.addEventListener('click', async () => {
  if (state.owner) {
    setToken('');
    state.owner = null;
    renderOwner();
    renderEmpty();
    toast('Signed out');
    return;
  }
  if (await signIn()) {
    state.owner = await checkOwner();
    renderOwner();
    renderEmpty();
    toast('Signed in');
  }
});

// ---------- wiring ----------

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = els.search.value.trim();
    reload();
  }, 250);
});

els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  reload();
});

els.more.addEventListener('click', loadMore);

(async () => {
  state.owner = await checkOwner();
  renderOwner();
  refreshAll();

  const deepLink = params.get('item');
  if (deepLink) {
    try {
      openItem(await api(`/api/items/${encodeURIComponent(deepLink)}`));
    } catch (err) {
      closeItemUrl();
      toast(err.status === 404 ? 'That item has been removed' : err.message);
    }
  }
})();
