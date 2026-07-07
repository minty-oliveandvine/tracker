# Client Tracker — Frontend (Vercel)

Static frontend for the Client Tracker. This is **frontend only** —
`public/index.html` (markup + styles) plus `public/app.js` (logic) that talk to
the Minty backend API (`tracker_app.py`) over HTTP.

- **Backend / API** lives in the Minty repo (`tools/client_tracker/tracker_app.py`).
  It owns the database connection, the derived fields, the shared-password gate,
  and the storage of the one editable field (`ov_published_until`).
- **This repo** is just the table UI. It `fetch()`es `/api/rows` from the backend
  and sends the shared password as HTTP Basic Auth on every request.

## Deploying to Vercel

1. Push this folder as its own git repo (see "Making this a standalone repo").
2. In Vercel: **New Project → import the repo**.
   - Framework preset: **Other** (it's plain static files).
   - Build command: _none_. Output directory: `public` (Vercel detects it
     automatically because the files live in `public/`).
3. Deploy. Vercel serves `public/index.html` at the root.

## Configuration

The only thing this frontend needs to know is **where the backend is** (it's
hosted on Render). The URL is **not** hardcoded — set it as a Vercel
Environment Variable:

- In Vercel: **Project → Settings → Environment Variables**, add
  `API_BASE` = your Render backend URL (no trailing slash), e.g.
  `https://client-tracker.onrender.com`. Redeploy so it takes effect.
- The static page can't read a Vercel env var directly, so a tiny serverless
  function [`api/config.js`](api/config.js) reads `process.env.API_BASE` and
  serves it at `/api/config`. `public/app.js` fetches that on load.
- **Per-visit override**: open the deployed page with `?api=` once —
  `https://your-frontend.vercel.app/?api=https://client-tracker.onrender.com` —
  and it is remembered in the browser's localStorage (takes priority over the
  env var).

The shared password is entered by the user in the browser (prompt on first load)
and kept in `sessionStorage` for the session — never stored in the repo or in
Vercel.

### Backend must allow this origin (CORS)

Because the frontend and backend are on different domains, the **backend** must
allow this Vercel origin. In the Minty backend's environment, set:

```
TRACKER_ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

(comma-separate multiple origins, or use `*` to allow any). Without this, the
browser will block the API calls.

## Making this a standalone repo

```bash
cd tools/client_tracker/vercel-frontend
git init
git add .
git commit -m "Client Tracker frontend"
git remote add origin git@github.com:YOU/client-tracker-frontend.git
git push -u origin main
```
