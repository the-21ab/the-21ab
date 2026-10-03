// Shared bits for every page: talking to the API, owner sign-in, the tag editor, toasts.

const TOKEN_KEY = 'wardrobe.ownerToken';
const SHARE_KEY = 'wardrobe.shareKey';

function storage(kind) {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function getToken() {
  try { return storage('local')?.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setToken(token) {
  try {
    if (token) storage('local')?.setItem(TOKEN_KEY, token);
    else storage('local')?.removeItem(TOKEN_KEY);
  } catch { /* private mode: the user just signs in again next time */ }
}

/** The read key for a private closet, taken from ?key= on the link and remembered for the tab. */
export function getShareKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  try {
    if (fromUrl) storage('session')?.setItem(SHARE_KEY, fromUrl);
    return fromUrl || storage('session')?.getItem(SHARE_KEY) || '';
  } catch {
    return fromUrl || '';
  }
}

export function withShareKey(href) {
  const key = getShareKey();
  if (!key) return href;
  const url = new URL(href, location.origin);
  url.searchParams.set('key', key);
  return url.pathname + url.search + url.hash;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function apiUrl(path) {
  const url = new URL(path, location.origin);
  const key = getShareKey();
  if (key && !url.searchParams.has('key')) url.searchParams.set('key', key);
  return url.toString();
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function errorFrom(res) {
  let message = `${res.status} ${res.statusText}`;
  try {
    const data = await res.json();
    if (data?.error) message = data.error;
  } catch { /* not JSON */ }
  return new ApiError(res.status, message);
}

export async function api(path, { method = 'GET', body, json } = {}) {
  const headers = { ...authHeaders() };
  let payload = body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(apiUrl(path), { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw await errorFrom(res);
  return res.status === 204 ? null : res.json();
}

/** Like api() but with upload progress, which fetch can't report. */
export function upload(path, { method = 'POST', form, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, apiUrl(path));
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response);
      reject(new ApiError(xhr.status, xhr.response?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "Can't reach the server. Check your connection and try again."));
    xhr.send(form);
  });
}

/** Checks the saved owner password. Returns the session info, or null if not signed in. */
export async function checkOwner() {
  if (!getToken()) return null;
  try {
    return await api('/api/session');
  } catch (err) {
    if (err.status === 401) setToken('');
    return null;
  }
}

// ---------- tiny DOM helpers ----------

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

let toastTimer;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { class: 'visually-hidden' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied');
}

export function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// ---------- owner sign-in dialog ----------

/** Asks for the owner password. Resolves true once signed in, false if cancelled. */
export function signIn() {
  return new Promise((resolve) => {
    const input = h('input', {
      class: 'input', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Owner password',
    });
    const error = h('div', { class: 'error', hidden: true });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const cancel = h('button', { class: 'btn ghost', type: 'button', onclick: () => dialog.close() }, 'Cancel');
    const form = h('form', { class: 'sheet-body', method: 'dialog' },
      h('p', { class: 'detail-dates' },
        'This is the password printed when the server first started (or the ADMIN_TOKEN you set). Only the owner can add or change clothes.'),
      input, error, h('div', { class: 'actions' }, submit, cancel));
    const dialog = h('dialog', {},
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Owner sign in')),
      form);

    let ok = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      setToken(input.value.trim());
      const session = await checkOwner();
      submit.disabled = false;
      if (session) {
        ok = true;
        dialog.close();
      } else {
        error.textContent = "That password didn't work.";
        error.hidden = false;
        input.select();
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(ok);
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

// ---------- tag editor ----------

export function normalizeTag(text) {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').slice(0, 40);
}

/**
 * A chip-style tag input. Type and press Enter or comma to add a tag, Backspace to remove the last one.
 * `suggestions` are known tags shown as one-tap chips underneath, filtered as you type.
 */
export class TagEditor {
  constructor({ tags = [], suggestions = [], placeholder = 'Add tags…', id } = {}) {
    this.tags = [];
    this.suggestions = suggestions;
    this.input = h('input', {
      type: 'text', placeholder, id, autocomplete: 'off', autocapitalize: 'none', enterkeyhint: 'enter', 'aria-label': 'Add a tag',
    });
    this.box = h('div', { class: 'tag-editor', onclick: (e) => { if (e.target === this.box) this.input.focus(); } }, this.input);
    this.suggestionBox = h('div', { class: 'chips suggestions', 'aria-label': 'Suggested tags' });
    this.el = h('div', {}, this.box, this.suggestionBox);

    this.input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) {
        e.preventDefault();
        this.commit();
      } else if (e.key === 'Backspace' && !this.input.value && this.tags.length) {
        this.remove(this.tags[this.tags.length - 1]);
      }
    });
    // Phones often skip keydown for commas, so catch them on input too.
    this.input.addEventListener('input', () => {
      if (this.input.value.includes(',')) this.commit();
      this.renderSuggestions();
    });
    this.input.addEventListener('blur', () => this.commit());

    tags.forEach((t) => this.add(t));
    this.renderSuggestions();
  }

  commit() {
    const parts = this.input.value.split(',');
    this.input.value = '';
    parts.forEach((p) => this.add(p));
    this.renderSuggestions();
  }

  add(raw) {
    const tag = normalizeTag(raw);
    if (!tag || this.tags.includes(tag) || this.tags.length >= 30) return;
    this.tags.push(tag);
    const chip = h('button', {
      type: 'button', class: 'chip', dataset: { tag }, 'aria-label': `Remove tag ${tag}`, onclick: () => this.remove(tag),
    }, tag, h('span', { 'aria-hidden': 'true' }, '×'));
    this.box.insertBefore(chip, this.input);
    this.renderSuggestions();
  }

  remove(tag) {
    this.tags = this.tags.filter((t) => t !== tag);
    this.box.querySelector(`.chip[data-tag="${CSS.escape(tag)}"]`)?.remove();
    this.renderSuggestions();
  }

  setSuggestions(list) {
    this.suggestions = list;
    this.renderSuggestions();
  }

  renderSuggestions() {
    const typed = normalizeTag(this.input.value);
    const list = this.suggestions
      .filter((t) => !this.tags.includes(t) && (!typed || t.includes(typed)))
      .slice(0, typed ? 12 : 18);
    this.suggestionBox.replaceChildren(...list.map((tag) => h('button', {
      type: 'button',
      class: 'chip',
      onmousedown: (e) => e.preventDefault(), // keep focus in the input on desktop
      onclick: () => {
        this.input.value = '';
        this.add(tag);
        this.input.focus();
      },
    }, `+ ${tag}`)));
  }

  value() {
    this.commit();
    return [...this.tags];
  }

  reset(tags = []) {
    [...this.tags].forEach((t) => this.remove(t));
    tags.forEach((t) => this.add(t));
  }
}

// ---------- photo handling ----------

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall back to <img>, which some browsers decode more formats with */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function render(source, maxSide, rotation, quality) {
  const sw = source.width;
  const sh = source.height;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h2 = Math.round(sh * scale);
  const turned = rotation % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = turned ? h2 : w;
  canvas.height = turned ? w : h2;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -w / 2, -h2 / 2, w, h2);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process the photo'))), 'image/jpeg', quality);
  });
}

/**
 * Turns whatever the camera gave us (often a huge HEIC/JPEG) into a sensible JPEG plus a
 * small thumbnail. Re-encoding also drops EXIF data, so GPS location never gets uploaded.
 */
export async function preparePhoto(file, rotation = 0) {
  let source;
  try {
    source = await decode(file);
  } catch {
    throw new Error("Couldn't open that photo. Try a JPEG or PNG, or take it again with the camera.");
  }
  try {
    const [image, thumbnail] = await Promise.all([
      render(source, 2048, rotation, 0.86),
      render(source, 512, rotation, 0.8),
    ]);
    return { image, thumbnail };
  } finally {
    source.close?.();
  }
}
