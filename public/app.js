// ---------------------------------------------------------------------------
// Where the backend (this project's tracker_app.py, hosted on Render) is
// reachable from the public internet. The URL is NOT hardcoded here — it comes
// from the Vercel Environment Variable API_BASE, served to the browser by the
// /api/config serverless function (see api/config.js).
//
// Resolution order (highest priority first):
//   1. ?api=... in the page URL (remembered in localStorage after first use)
//   2. a previously remembered value in localStorage
//   3. /api/config  ->  { apiBase }  (the Vercel env var)
// ---------------------------------------------------------------------------
let API_BASE = "";

async function resolveApiBase() {
  const fromQuery = new URLSearchParams(location.search).get("api");
  if (fromQuery) {
    localStorage.setItem("tracker_api_base", fromQuery.replace(/\/+$/, ""));
  }
  const remembered = localStorage.getItem("tracker_api_base");
  if (remembered) return remembered.replace(/\/+$/, "");

  // Fall back to the runtime config from the Vercel env var.
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const { apiBase } = await res.json();
      if (apiBase) return apiBase.replace(/\/+$/, "");
    }
  } catch (_) { /* ignore — handled as "not configured" below */ }
  return "";
}

// ---- api ------------------------------------------------------------------
// No credentials — the backend no longer requires auth. Plain fetch calls.
async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) throw new Error("Request failed (" + res.status + ").");
  return res;
}

// ---- state ----------------------------------------------------------------
let allRows = [];
let filterText = "";

// ---- rendering ------------------------------------------------------------
async function load() {
  const errorEl = el("error");
  const statusEl = el("status");
  errorEl.textContent = "";
  errorEl.hidden = true;

  if (!API_BASE) API_BASE = await resolveApiBase();

  if (!API_BASE) {
    showError(
      "Backend URL is not configured. Set the API_BASE environment variable " +
      "in Vercel (to the Render backend URL), or open this page with " +
      "?api=https://your-backend-url"
    );
    statusEl.textContent = "";
    setLoading(false);
    return;
  }

  setLoading(true);
  try {
    const res = await api("/api/rows");
    allRows = await res.json();
  } catch (e) {
    statusEl.textContent = "";
    showError("Could not load: " + e.message);
    setLoading(false);
    return;
  }

  el("toolbar").hidden = false;
  setLoading(false);
  render();
}

function render() {
  const tbody = el("rows");
  tbody.innerHTML = "";

  const term = filterText.trim().toLowerCase();
  const rows = term
    ? allRows.filter(r => (r.name || "").toLowerCase().includes(term))
    : allRows;

  if (rows.length === 0) {
    el("empty").hidden = false;
    el("empty").textContent = allRows.length === 0
      ? "No clients yet."
      : `No clients match “${filterText.trim()}”.`;
  } else {
    el("empty").hidden = true;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="name">${escapeHtml(r.name)}</td>
      <td>${r.bill_activated
          ? '<span class="badge badge-yes">Active</span>'
          : '<span class="badge badge-no">Inactive</span>'}</td>
      <td>${r.pettycash_activated
          ? '<span class="badge badge-yes">Active</span>'
          : '<span class="badge badge-no">Inactive</span>'}</td>
      <td class="derived">${r.client_input_until
          ? escapeHtml(r.client_input_until)
          : '<span class="none">—</span>'}</td>`;
    tbody.appendChild(tr);
  }

  const active = allRows.filter(r => r.bill_activated).length;
  const shown = rows.length;
  const total = allRows.length;
  el("status").textContent = term
    ? `${shown} of ${total} clients shown · ${active} active`
    : `${total} clients · ${active} active · bill status + input date live from the database`;
}

// ---- helpers --------------------------------------------------------------
function el(id) {
  return document.getElementById(id);
}

function setLoading(on) {
  el("loading").hidden = !on;
}

function showError(msg) {
  const e = el("error");
  e.textContent = msg;
  e.hidden = false;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- wiring ---------------------------------------------------------------
el("search").addEventListener("input", (e) => {
  filterText = e.target.value;
  render();
});
el("refresh").addEventListener("click", load);

load();
