# Client Tracker — Frontend (Vercel)

Static frontend for the Client Tracker. This is **frontend only** —
`public/index.html` (markup + styles) plus `public/app.js` (logic) that talk to
the Minty backend API (`tracker_app.py`) over HTTP.

- **Backend / API** lives in the Minty repo (`tools/client_tracker/tracker_app.py`).
  It owns the database connection, the derived fields, and the shared-password
  gate.
- **This repo** is just the table UI, and it is read-only: it `fetch()`es
  `GET /api/tracker` from the backend and sends the shared password as HTTP
  Basic Auth on every request.

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

### Password

Access is gated by a **single shared password**, enforced by the backend. The
frontend prompts for it on first load, keeps it in `sessionStorage` (so it is
gone when the tab closes), and sends it as HTTP Basic Auth on every request. It
is never stored in this repo or in Vercel.

The password itself lives only in the **backend's** environment, as
`TRACKER_PASSWORD` on Render. To rotate it, change that variable and redeploy;
open tabs get a `401` on their next request and re-prompt.

The Basic Auth username is a fixed placeholder (`tracker`) that the backend
ignores — only the password is checked.

> **This is a lock, not an audit trail.** Because everyone shares one password,
> the logs can show that *someone* authorized loaded the data, never *who*. If
> that distinction ever matters for this client data, this design needs to
> change to per-user accounts.

### Backend must allow this origin (CORS)

Because the frontend and backend are on different domains, the **backend** must
allow this Vercel origin. In the Minty backend's environment, set:

```
TRACKER_ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

(comma-separate multiple origins). Without this, the browser will block the API
calls.

Two constraints come from sending a password on every request:

- The allowed origin **must be the exact URL** — `*` is not valid once
  credentials are involved, and the browser will reject the response.
- The backend must allow the `Authorization` request header, and must **not**
  require auth on the `OPTIONS` preflight (browsers send it without
  credentials, so gating it means the real request never fires).

## Making this a standalone repo

```bash
cd tools/client_tracker/vercel-frontend
git init
git add .
git commit -m "Client Tracker frontend"
git remote add origin git@github.com:YOU/client-tracker-frontend.git
git push -u origin main
```
