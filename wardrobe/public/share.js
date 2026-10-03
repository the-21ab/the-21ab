import { checkOwner, getShareKey, withShareKey, h, copyText } from './common.js';

const $ = (id) => document.getElementById(id);

$('home-link').href = withShareKey('/');
$('closet-link').href = withShareKey('/');

function linkRow(label, note, url) {
  const code = h('code', {}, url);
  return h('div', { class: 'link-row' },
    h('div', { class: 'label' }, label, h('small', {}, note)),
    h('div', { class: 'copy' }, code, h('button', { class: 'btn', type: 'button', onclick: () => copyText(url) }, 'Copy')));
}

function render(key, isPrivate, owner) {
  const origin = location.origin;
  const withKey = (path) => {
    if (!key) return `${origin}${path}`;
    const url = new URL(path, origin);
    url.searchParams.set('key', key);
    return url.toString();
  };

  const csv = withKey('/api/items.csv');
  const json = withKey('/api/items');

  $('links').append(
    linkRow('Closet (for people)', 'photo grid with search and tags', withKey('/')),
    linkRow('JSON feed', 'for apps and scripts', json),
    linkRow('CSV', 'for spreadsheets', csv),
    linkRow('Tags', 'every tag with how many pieces use it', withKey('/api/tags')),
    linkRow('One piece', 'swap in an id', withKey('/api/items/ITEM_ID')),
  );

  if (isPrivate) {
    $('privacy').textContent = owner || key
      ? 'Your closet is private. These links include the share key, so anyone you give them to can read it (but never edit it). Change PUBLIC_KEY on the server to revoke them all.'
      : "This closet is private. Open the share link you were given (it ends in ?key=...) to see the working links.";
  } else {
    $('privacy').textContent = 'Your closet is public: anyone with the address can read it, nobody but you can change it. Set PUBLIC_KEY on the server to make the links secret.';
  }

  $('sheets-import').textContent = `=IMPORTDATA("${csv}")`;

  $('code-js').textContent = `// JavaScript (browser or Node 18+). CORS is open, so this works from any site.
const res = await fetch("${json}");
const { items, next } = await res.json();
for (const item of items) console.log(item.title, item.tags, item.image.url);`;

  $('code-curl').textContent = `# shell
curl -s "${json}" | jq '.items[] | {title, tags, photo: .image.url}'`;

  $('code-py').textContent = `# Python
import requests
url = "${json}"
while url:
    page = requests.get(url).json()
    for item in page["items"]:
        print(item["title"], item["tags"], item["image"]["url"])
    url = page["next"]`;

  const keyNote = key ? '&key=…' : '';
  $('code-params').textContent = `/api/items?tag=blue&tag=linen     pieces with ALL of these tags
/api/items?q=wool coat             search names, notes and tags
/api/items?sort=newest             newest | oldest | updated | title
/api/items?limit=50&offset=50      paging (limit up to 1000)
/api/items?updated_since=2026-01-01T00:00:00Z
/api/deleted?since=2026-01-01T00:00:00Z
/api/items.csv?tag=work            every filter works on the CSV too
${keyNote ? `(add ${keyNote} to each when the closet is private)` : ''}`.trim();

  $('code-upload').textContent = `curl -X POST "${origin}/api/items" \\
  -H "Authorization: Bearer YOUR_OWNER_PASSWORD" \\
  -F image=@shirt.jpg \\
  -F title="White oxford shirt" \\
  -F tags="shirt, white, cotton, work" \\
  -F notes="Uniqlo, size M"

# edit:   curl -X PATCH  .../api/items/ITEM_ID -H "Authorization: Bearer ..." -H "Content-Type: application/json" -d '{"tags":["shirt","white"]}'
# delete: curl -X DELETE .../api/items/ITEM_ID -H "Authorization: Bearer ..."`;
}

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyText($(btn.dataset.copy).textContent));
});

(async () => {
  const session = await checkOwner();
  let isPrivate = Boolean(session?.private);
  if (!session) {
    try {
      const info = await fetch('/api').then((r) => r.json());
      isPrivate = Boolean(info.private);
    } catch { /* assume public */ }
  }
  render(session?.key || getShareKey(), isPrivate, Boolean(session));
})();
