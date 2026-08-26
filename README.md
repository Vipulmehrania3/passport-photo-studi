# Passport Photo Studio

Crop, remove backgrounds, edit and print **35 × 45 mm** passport photos on **A4** sheets.

```
Upload multiple images
        ↓
Crop EACH image (35:45)          ← always before background removal
        ↓
ClearBackdrop background removal ← via our backend, never from the browser
        ↓
Transparent cutout → white background
        ↓
Photo library (select + copies)
        ↓
Per-photo editor
        ↓
A4 sheet (210 × 297 mm)
        ↓
Print / Download PNG / Download PDF
```

---

## 1. How the pieces talk to each other

The browser **never** calls ClearBackdrop and **never** holds a credential:

```
Browser (frontend/)
   │  POST /api/remove-background   (multipart field: "image")
   ▼
Our Node backend (backend/server.js)
   │  POST https://clearbackdrop.com/api/v1/remove-background
   ▼
ClearBackdrop  →  transparent PNG  →  back through our backend  →  browser
```

Why: it keeps any credential server-side, gives one place for timeouts, size
limits, error mapping and rate-limit handling, and avoids CORS entirely in the
default setup (the backend also serves the frontend, so it is all one origin).

---

## 2. Project structure

```text
passport-photo-studio/
├── frontend/
│   ├── index.html            application markup only
│   ├── css/
│   │   └── style.css         all styling, incl. @media print
│   ├── js/
│   │   ├── app.js            state + workflow (upload → crop → remove → library → A4)
│   │   ├── crop.js           35:45 crop: drag, zoom, rotate 90°, reset, export
│   │   ├── editor.js         per-photo editor: zoom, rotate, brightness, contrast,
│   │   │                     saturation, sharpness, background colour
│   │   ├── a4.js             A4 layout, render, PNG/PDF export, printing
│   │   └── api.js            talks to OUR backend only
│   └── vendor/
│       └── jspdf.umd.min.js  jsPDF 2.5.2 (MIT), vendored so the app works offline
├── backend/
│   ├── server.js             Express API + ClearBackdrop relay + static hosting
│   ├── package.json
│   ├── .env.example          placeholders only
│   └── test/
│       ├── smoke.test.js     backend HTTP tests (live + mock + error paths)
│       └── frontend.test.js  the real frontend driven in jsdom
├── README.md
└── .gitignore
```

---

## 3. Requirements

| Thing | Version |
| --- | --- |
| Node.js | **18.17+** (20 LTS recommended — the backend uses global `fetch`/`FormData`) |
| npm | 9+ |
| Browser | Any current Chrome, Edge, Firefox or Safari |
| ClearBackdrop account | **Not required.** The standard model is free, no API key, no signup. |

---

## 4. Installation

```bash
cd passport-photo-studio/backend
npm install            # express, cors, multer, dotenv (+ jsdom/canvas for tests)
cp .env.example .env   # optional — the defaults already work
```

That is the only install step. The frontend has **no build step** and no npm
dependencies; jsPDF is vendored under `frontend/vendor/`.

---

## 5. Configure `.env`

`backend/.env` is optional for the free tier. Everything has a working default:

```ini
PORT=8787
HOST=0.0.0.0

CLEARBACKDROP_BASE=https://clearbackdrop.com     # non-www host — required
CLEARBACKDROP_REMOVE_PATH=/api/v1/remove-background
CLEARBACKDROP_QUOTA_PATH=/api/v1/quota
CLEARBACKDROP_BRIA_KEY=                          # optional premium model key
CLEARBACKDROP_RESPONSE_MODE=binary               # binary | json
MAX_UPLOAD_MB=15
CLEARBACKDROP_TIMEOUT_MS=60000

FRONTEND_ORIGIN=                                 # CORS allow-list (see §11)
CLEARBACKDROP_MOCK=0                             # dev only
ALLOW_SIMULATE=0                                 # dev only
```

- **`CLEARBACKDROP_BRIA_KEY`** — leave empty. Set it only if ClearBackdrop
  granted you access to the premium BRIA RMBG-2.0 model; it is then sent as the
  `X-Bria-Key` request header **from the backend only**.
- **`CLEARBACKDROP_MOCK=1`** — answers `/api/remove-background` with a locally
  generated transparent PNG and never calls the internet. Useful for UI work.
- **`ALLOW_SIMULATE=1`** — lets a request carry
  `simulate=upstream_error|rate_limit|timeout|bad_response` so you can see the
  Retry/Cancel path. **Never enable in production.**

Never put any of these values into `index.html`, `app.js` or `api.js`.

---

## 6. Start the backend

```bash
cd passport-photo-studio/backend
npm start
```

```
  Passport Photo Studio backend
  -----------------------------
  http://localhost:8787
  frontend dir : .../passport-photo-studio/frontend
  clearbackdrop: https://clearbackdrop.com/api/v1/remove-background
  limits       : 15MB upload, 60000ms timeout
```

Useful endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Backend + upstream config, no secrets |
| `GET` | `/api/quota` | Current ClearBackdrop hourly quota |
| `POST` | `/api/remove-background` | multipart field `image` → `{ ok, image: "data:image/png;…" }` |
| `GET` | `/` | The frontend |

---

## 7. Open / run the frontend

**Option A — recommended.** The backend already serves the frontend, so just open:

```
http://localhost:8787
```

Same origin → no CORS at all.

**Option B — separate static server** (Live Server, `npx serve frontend`, etc.):

```bash
npx serve frontend            # e.g. http://localhost:3000
```

`js/api.js` probes `http://<host>:8787` automatically, so this works out of the
box on localhost. For any other port/host set `FRONTEND_ORIGIN` in `.env`
(§11) and/or `window.APP_CONFIG.apiBase` in `index.html`.

---

## 8. The workflow, and the two rules that matter

1. Select or drop **multiple** images (JPG, JPEG, PNG, WEBP, ≤ 15 MB each).
2. **Every** image opens the crop screen, one at a time —
   `Processing 3 of 10`. Nothing is sent to ClearBackdrop before you press
   **Crop & Continue**.
3. Only the cropped image goes to the backend, sequentially.
4. Successful cutouts land in the library, numbered, with **copies = 1**
   (0–99; `0` keeps the photo in the library but off the sheet).
5. **Edit** any photo: zoom, rotate, brightness, contrast, saturation,
   sharpness, background (white / light blue / light grey / custom).
   The cutout stays transparent internally; the colour is only composited.
6. **Regenerate** the A4 sheet, then **Print**, **Download PDF** or
   **Download PNG**.

### Rule 1 — crop always precedes background removal

An uncropped image is never sent upstream. Cancelling a crop drops that image
entirely instead of falling through to removal.

### Rule 2 — no original-image fallback

If background removal fails, the photo is **not** added to the library and the
original background is **never** used as a substitute. You get:

```
Background removal failed
[ Cancel ]  [ Retry ]
```

`Cancel` drops the photo; it also stays listed under **Needs attention**, where
you can retry or dismiss it later. On `429` the batch waits for the reset window
and retries automatically.

---

## 9. ClearBackdrop configuration (verified against the live docs)

Checked on **2026-08-27** against <https://clearbackdrop.com/api> and
<https://clearbackdrop.com/llms.txt>, and confirmed with real requests.

| Item | Value |
| --- | --- |
| Endpoint | `POST https://clearbackdrop.com/api/v1/remove-background` |
| Body | `multipart/form-data`, image under the field name **`image`** |
| Auth | **None** for the standard model (free, no signup) |
| Optional auth | `X-Bria-Key: <key>` header for the premium BRIA RMBG-2.0 model |
| Default response | `image/png` bytes, same width × height as the input, RGBA |
| JSON response | append `?response=json` → `{ success, result_url, image_size, processing_time, cached, quota }` |
| Upload limit | **15 MB** |
| Rate limit | **100 images/hour per IP** |
| Rate headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` |
| Quota check | `GET https://clearbackdrop.com/api/v1/quota` |
| Caching | Byte-identical images return instantly (`X-Cache: HIT`, `"cached": true`) |
| Errors | `400` no image · `413` too large · `415` bad type · `429` rate limited · `500` processing failed · `403` invalid BRIA key |
| CORS | Not applicable — the browser never calls it. Server-to-server only. |

> **Always use the non-www host.** `www.clearbackdrop.com` 301-redirects and the
> POST body is dropped by the redirect.

Example (exactly what the backend does):

```bash
curl -X POST https://clearbackdrop.com/api/v1/remove-background \
  -F "image=@crop.png" -o result.png
```

Our backend maps upstream failures onto useful JSON, e.g.

```json
{ "error": "rate_limited", "message": "…", "upstream_status": 429,
  "retry_after_seconds": 60, "retryable": true }
```

| Our status | Meaning |
| --- | --- |
| `400 no_image` / `empty_image` / `bad_field_name` | Bad request from the client |
| `413 file_too_large` | Over `MAX_UPLOAD_MB` |
| `415 unsupported_image` | Not JPG/JPEG/PNG/WEBP |
| `429 rate_limited` | Hourly ClearBackdrop limit reached |
| `500 upstream_processing_failed` | ClearBackdrop could not process it |
| `502 invalid_upstream_response` / `network_error` | Unreachable or unreadable reply |
| `504 upstream_timeout` | Slower than `CLEARBACKDROP_TIMEOUT_MS` |

---

## 10. A4 geometry

| | |
| --- | --- |
| Page | 210 × 297 mm |
| Photo | 35 × 45 mm (ratio 7:9 — never stretched) |
| Margin / gutter | 5 mm default |
| Capacity | **25 per sheet** — 5 columns (195 mm ≤ 200 mm usable) × 5 rows (245 mm ≤ 287 mm usable). 6 rows would need 295 mm and do not fit. |
| Grid choice | Tightest grid closest to the page shape (e.g. 12 copies → 3 × 4) |
| Export | 300 DPI → 2480 × 3508 px; 600 DPI and 150 DPI also available |
| Print CSS | `@page { size: 210mm 297mm; margin: 0 }`, everything except `#printArea` hidden |

Copies are packed in photo order (`A A A A B B … C C`), spilling onto extra
sheets when they exceed 25.

---

## 11. Troubleshooting

### CORS errors

In the default setup there are none — the backend serves the frontend, so
everything is same-origin. If you serve the frontend separately:

1. Start the backend and check `GET http://localhost:8787/api/health`.
2. Allow your origin in `backend/.env`:
   ```ini
   FRONTEND_ORIGIN=http://localhost:3000
   ```
   (comma-separate several; leave empty to allow any origin during development)
3. Restart the backend.
4. If the frontend is not on `:8787`, point it at the API:
   ```html
   <script>window.APP_CONFIG = { apiBase: "http://localhost:8787" };</script>
   ```
5. Never "fix" CORS by calling ClearBackdrop from the browser — that is exactly
   what this architecture avoids.

### "Cannot reach the Passport Photo Studio backend"

- Is `npm start` running in `backend/`?
- Port in use? Change `PORT` in `.env`.
- Opening `index.html` via `file://`? Prefer `http://localhost:8787`.

### 429 rate limited

100 images/hour per IP. The batch waits out the reset window and retries; the
header quota is shown in the top bar. Byte-identical crops are served from
ClearBackdrop's cache and still count against the limit.

### 413 file too large

ClearBackdrop accepts 15 MB. Crop first (the crop re-encodes a PNG, usually much
smaller) or lower `MAX_UPLOAD_MB` to fail earlier.

### Poor cut-out quality

Shoot against a plain, contrasting background; keep the subject centred; avoid
hair-colour == background-colour. Re-crop tighter around the head and shoulders
and try again. The optional BRIA model (needs a key) is higher quality but takes
20–25 s per image.

### Print comes out scaled or with margins

In the print dialog choose **A4**, scale **100%**, margins **None/Default**, and
disable "headers and footers". The artwork carries its own 5 mm safety margin.

---

## 12. Production deployment

**Single VM / VPS (simplest)**

```bash
cd backend && npm ci --omit=dev
cp .env.example .env         # set FRONTEND_ORIGIN to your real domain
npm start                    # or: pm2 start server.js --name passport-studio
```

Put nginx or Caddy in front for TLS:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  client_max_body_size 20m;      # > MAX_UPLOAD_MB
}
```

**Split hosting** — frontend on any static host (Netlify, Vercel, S3, GitHub
Pages), backend on Render/Railway/Fly/EC2. Set `FRONTEND_ORIGIN` to the exact
static origin and `window.APP_CONFIG.apiBase` to the backend URL.

**Serverless** — `server.js` exports the Express app, so it can be wrapped by
`@vercel/node` or a Lambda adapter. Watch the platform body-size limit
(≥ 15 MB) and function timeout (≥ 60 s).

Production checklist:

- [ ] `CLEARBACKDROP_MOCK=0` and `ALLOW_SIMULATE=0`
- [ ] `FRONTEND_ORIGIN` pinned to your domain(s)
- [ ] HTTPS in front of the backend
- [ ] `npm ci --omit=dev` (no jsdom/canvas in production)
- [ ] `.env` present and **not** committed
- [ ] Body limit ≥ 15 MB at the proxy

---

## 13. Security

- All ClearBackdrop communication happens in `backend/server.js`.
- `index.html`, `app.js` and `api.js` contain no credentials and no
  ClearBackdrop URL (there is a test asserting exactly this).
- `.env` and `node_modules/` are git-ignored; `.env.example` has placeholders only.
- Uploads are validated by MIME type **and** extension, capped at 15 MB, and are
  never written to disk — they are relayed from memory.
- `redirect: 'error'` on the upstream call so a redirect can never silently drop
  the image body.

---

## 14. Tests

```bash
cd backend

npm test                      # backend HTTP tests against the LIVE ClearBackdrop API
CLEARBACKDROP_MOCK=1 npm test # same suite, upstream mocked (offline)
ALLOW_SIMULATE=1 npm test     # adds the 429 / 500 / 504 error paths

npm run test:frontend         # the real frontend, driven in jsdom + node-canvas
```

What they cover:

- **backend** — health/config, no secret leakage, `400/413/415` validation,
  `429/500/504` mapping, a real PNG in → transparent PNG out at identical
  dimensions, JPEG input, quota proxy, static hosting, and a scan of every
  frontend file for credentials or direct ClearBackdrop calls.
- **frontend** — multi-upload crops **each** image before **any** removal call,
  crop output is exactly 35:45 and high resolution, failure shows Retry/Cancel
  and leaves the library empty (no original-image fallback), retry recovers,
  copies clamp to 0–99 with 0 excluded, A4 geometry and multi-page packing,
  2480 × 3508 px export at 300 DPI, valid PDF output, print writes only to
  `#printArea`, and the editor applies live.

---

## 15. Dependencies

**Backend (npm)**

| Package | Why |
| --- | --- |
| `express` | HTTP server, routing, static hosting |
| `multer` | `multipart/form-data` upload handling (memory storage) |
| `cors` | CORS when the frontend is on another origin |
| `dotenv` | `.env` loading |
| `jsdom`, `canvas` *(dev)* | Frontend test harness |

**Frontend**

| Library | Version | License | Why |
| --- | --- | --- | --- |
| jsPDF | 2.5.2 | MIT | PDF export — vendored at `frontend/vendor/jspdf.umd.min.js`, no CDN needed |

Nothing else. No framework, no bundler, no build step. If the vendored jsPDF is
missing, PDF export falls back to a PNG download with a warning instead of
failing.

---

## 16. License

MIT. ClearBackdrop is a third-party service with its own terms — see
<https://clearbackdrop.com>.
