// Serverless function (Vercel) that exposes non-secret runtime config to the
// static frontend. The backend's public URL lives in a Vercel Environment
// Variable (API_BASE) — set it to the Render backend URL, e.g.
//   API_BASE = https://client-tracker.onrender.com
//
// The frontend fetches /api/config on load to learn where the backend is,
// so the URL is never hardcoded in the committed source.
export default function handler(req, res) {
  const apiBase = (process.env.API_BASE || "").replace(/\/+$/, "");
  // Cache briefly at the edge; it rarely changes.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
  res.status(200).json({ apiBase });
}
