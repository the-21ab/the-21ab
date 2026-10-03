# Wardrobe

Take a photo of a piece of clothing on your phone, give it a few tags, and it lands in one place. Then share one link and any other app, spreadsheet or person can read your whole closet, live, with pictures.

- **Phone first.** Tap "Take photo", type a few tags (or tap ones you've used before), save. "Add another" jumps straight back into the camera.
- **A closet you can browse.** Photo grid, search, filter by tags, sort, edit, delete.
- **Live feeds for other apps.** JSON, CSV and per-item links that always reflect what's in the closet right now. Works in Google Sheets with real images.
- **Only you can change it.** Everyone else gets read-only access. You can make even reading secret with a share key.
- **Small and boring to run.** Plain Node.js, zero runtime dependencies, one SQLite file plus a folder of photos.

## Run it on your computer

Needs Node.js 22.5 or newer.

```sh
cd wardrobe
npm start
```

Open http://localhost:3000. The first time it starts it prints an **owner password** (also saved in `data/admin-token.txt`). Tap "Sign in", paste it, and you can start adding clothes.

To use it from your phone on the same Wi-Fi, open `http://<your computer's IP>:3000`. For the camera to work everywhere and for other apps to reach it, put it online (below).

## Put it online

It needs a server that keeps files between restarts (photos and the database live in one folder, `DATA_DIR`). Any of these work:

**Fly.io** (free allowance covers this easily)

```sh
cd wardrobe
fly launch --copy-config --no-deploy      # pick an app name and region
fly volumes create wardrobe_data --size 1
fly secrets set ADMIN_TOKEN="pick-a-long-password"
fly deploy
```

**Railway / Render / any Docker host:** deploy the `wardrobe/` folder with its Dockerfile, attach a persistent volume at `/data`, and set `ADMIN_TOKEN`.

**A VPS:** `docker build -t wardrobe . && docker run -d -p 80:3000 -v wardrobe:/data -e ADMIN_TOKEN=... wardrobe`

On your phone, open the site and use "Add to Home Screen". It then opens like a normal app.

### Settings

| Variable | What it does | Default |
| --- | --- | --- |
| `ADMIN_TOKEN` | Owner password (8+ characters). Needed to add, edit or delete. | Generated on first run, saved in `DATA_DIR/admin-token.txt` |
| `PUBLIC_KEY` | If set, reading the closet needs `?key=<this>`. Share links include it automatically. Change it to revoke every link you've handed out. | unset (anyone with the address can read) |
| `PUBLIC_URL` | The address used in links, e.g. `https://closet.example.com`. Set it if you're behind a proxy that hides the real host. | worked out from each request |
| `DATA_DIR` | Where the database and photos are kept. Back this folder up and you've backed up everything. | `./data` (`/data` in Docker) |
| `PORT` | Port to listen on. | `3000` |
| `MAX_UPLOAD_MB` | Biggest upload accepted. | `25` |

## Sharing with other apps

The **Share** page in the app has every link ready to copy, with your real address filled in. In short:

| Link | Gives you |
| --- | --- |
| `/` | The photo grid, for people |
| `/api/items` | JSON: every piece with title, tags, notes, photo and thumbnail URLs (with sizes) and timestamps |
| `/api/items.csv` | The same as a spreadsheet |
| `/api/items/{id}` | One piece |
| `/api/tags` | Every tag and how many pieces use it |
| `/api/deleted?since=…` | Pieces removed since a time, for apps that keep a copy |

One item looks like this:

```json
{
  "id": "k3m9xq2vbd7a",
  "title": "Navy wool overcoat",
  "tags": ["coat", "navy", "winter", "wool"],
  "notes": "Size 50, bought in Oslo",
  "image":     { "url": "https://…/images/k3m9xq2vbd7a-a1b2c3.jpg", "type": "image/jpeg", "width": 1536, "height": 2048, "bytes": 412883 },
  "thumbnail": { "url": "https://…/images/k3m9xq2vbd7a-d4e5f6-thumb.jpg", "type": "image/jpeg", "width": 384, "height": 512, "bytes": 31207 },
  "url": "https://…/?item=k3m9xq2vbd7a",
  "created_at": "2026-10-03T12:00:00.000Z",
  "updated_at": "2026-10-03T12:00:00.000Z"
}
```

**Filters** work on both JSON and CSV:

```
?tag=blue&tag=linen        has ALL of these tags (or tags=blue,linen)
?q=wool coat               every word must appear in the name, notes or tags
?sort=newest               newest | oldest | updated | title
?limit=100&offset=0        JSON pages (limit up to 1000); follow "next" until it's null
?updated_since=2026-01-01T00:00:00Z
```

**Crawling live.** Lists send an `ETag`. Send it back as `If-None-Match` and you get an empty `304 Not Modified` when nothing changed, so polling often costs almost nothing. To mirror the closet, poll `updated_since` for new and edited pieces and `/api/deleted?since=` for removed ones (both include the boundary, so overlap your windows a little and treat repeats as updates). Photo URLs never change content (a new photo gets a new URL), so they can be cached forever. CORS is open, so browsers on any site can read the feed.

**Google Sheets.** In cell A1: `=IMPORTDATA("https://your-site/api/items.csv")`. In the first empty column on row 2: `=IMAGE(F2)`, then fill down to see each photo. Sheets refreshes imported data roughly every hour.

### Adding clothes from code

Writes use the owner password as a bearer token:

```sh
curl -X POST https://your-site/api/items \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F image=@shirt.jpg -F title="White oxford" -F tags="shirt, white, work" -F notes="Size M"

curl -X PATCH https://your-site/api/items/ID -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"tags": ["shirt", "white"]}'

curl -X DELETE https://your-site/api/items/ID -H "Authorization: Bearer $ADMIN_TOKEN"
```

`POST` takes multipart form data with `image` (required, JPEG/PNG/WebP), and optionally `thumbnail`, `title`, `tags` (comma separated or repeated) and `notes`. `PATCH` takes the same fields as multipart or JSON and changes only what you send.

## Good to know

- **Privacy:** photos taken in the app are resized (2048px max, plus a 512px thumbnail) and re-encoded in your browser before upload, which strips EXIF data like GPS location. Photos uploaded through the API are stored exactly as sent.
- **Tags** are lowercased, trimmed and de-duplicated, and a leading `#` is dropped, so `#Summer`, `summer` and ` SUMMER ` are the same tag. Up to 30 per piece.
- **Security:** the owner password is checked in constant time and an address gets locked out for 15 minutes after 20 wrong guesses. Pages ship with a strict Content Security Policy. Uploaded files are checked by their actual bytes, not their name or claimed type.
- **Backups:** copy `DATA_DIR`. It holds `wardrobe.db` (SQLite) and `images/`.

## Development

```sh
npm run dev     # restarts on file changes
npm test        # API, unit and real-browser tests
```

The browser tests drive headless Chromium through the whole flow (sign in, photo, tags, save, filter, edit, delete). They need Playwright's browser: `npx playwright install chromium`.

```
server.js          starts the server from environment variables
src/app.js         HTTP routes, auth, uploads, feeds
src/db.js          SQLite schema and queries (node:sqlite)
src/images.js      image type and size detection from file bytes
src/validate.js    input cleaning and limits
src/csv.js         CSV export
public/            the web app (no build step)
test/              node:test suites
```
