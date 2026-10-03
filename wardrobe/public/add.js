import { api, upload, checkOwner, signIn, setToken, TagEditor, preparePhoto } from './common.js';

const $ = (id) => document.getElementById(id);

const els = {
  signedOut: $('signed-out'),
  form: $('form'),
  done: $('done'),
  camera: $('camera'),
  library: $('library'),
  empty: $('capture-empty'),
  previewBox: $('capture-preview'),
  preview: $('preview'),
  rotate: $('rotate'),
  title: $('title'),
  notes: $('notes'),
  keepTags: $('keep-tags'),
  error: $('error'),
  progress: $('progress'),
  save: $('save'),
};

const tags = new TagEditor({ id: 'tag-input', placeholder: 'e.g. shirt, blue, linen, summer' });
$('tags').append(tags.el);

let file = null;
let rotation = 0;
let previewUrl = null;

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

async function loadSuggestions() {
  try {
    const { tags: list } = await api('/api/tags');
    tags.setSuggestions(list.map((t) => t.tag));
  } catch { /* suggestions are a nice-to-have */ }
}

function setPreview(blob) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  els.preview.src = previewUrl;
  els.empty.hidden = true;
  els.previewBox.hidden = false;
}

async function refreshPreview() {
  try {
    // A small version is plenty for the preview and makes rotating instant.
    const { thumbnail } = await preparePhoto(file, rotation);
    setPreview(thumbnail);
    showError('');
  } catch (err) {
    file = null;
    showError(err.message);
  }
}

function onPick(e) {
  const picked = e.target.files[0];
  e.target.value = ''; // so picking the same file again still fires
  if (!picked) return;
  file = picked;
  rotation = 0;
  refreshPreview();
}

els.camera.addEventListener('change', onPick);
els.library.addEventListener('change', onPick);

els.rotate.addEventListener('click', () => {
  if (!file) return;
  rotation = (rotation + 90) % 360;
  refreshPreview();
});

function resetForm() {
  file = null;
  rotation = 0;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  els.preview.removeAttribute('src');
  els.empty.hidden = false;
  els.previewBox.hidden = true;
  els.title.value = '';
  els.notes.value = '';
  if (!els.keepTags.checked) tags.reset();
  showError('');
}

function setProgress(fraction) {
  els.progress.hidden = fraction == null;
  els.progress.firstElementChild.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!file) {
    showError('Take or choose a photo first.');
    return;
  }
  const tagList = tags.value();
  els.save.disabled = true;
  els.save.textContent = 'Preparing photo…';
  showError('');
  try {
    const { image, thumbnail } = await preparePhoto(file, rotation);
    const form = new FormData();
    form.set('image', image, 'photo.jpg');
    form.set('thumbnail', thumbnail, 'thumb.jpg');
    form.set('title', els.title.value);
    form.set('notes', els.notes.value);
    form.set('tags', tagList.join(','));

    els.save.textContent = 'Uploading…';
    setProgress(0);
    const item = await upload('/api/items', { form, onProgress: setProgress });

    $('done-photo').src = item.thumbnail.url;
    $('done-text').textContent = [item.title, item.tags.join(', ')].filter(Boolean).join(' · ') || 'Added to your closet.';
    $('view').href = `/?item=${item.id}`;
    els.form.hidden = true;
    els.done.hidden = false;
    resetForm();
    loadSuggestions();
  } catch (err) {
    showError(err.message);
    if (err.status === 401) {
      setToken('');
      showSignedOut();
    }
  } finally {
    els.save.disabled = false;
    els.save.textContent = 'Save to closet';
    setProgress(null);
  }
});

$('another').addEventListener('click', () => {
  els.done.hidden = true;
  els.form.hidden = false;
  window.scrollTo(0, 0);
  // Jump straight back into the camera; this runs inside the tap so browsers allow it.
  els.camera.click();
});

function showSignedOut() {
  els.signedOut.hidden = false;
  els.form.hidden = true;
  els.done.hidden = true;
}

function showForm() {
  els.signedOut.hidden = true;
  els.form.hidden = false;
  loadSuggestions();
}

$('signin').addEventListener('click', async () => {
  if (await signIn()) showForm();
});

(async () => {
  if (await checkOwner()) showForm();
  else showSignedOut();
})();
