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
    const res = await api("/api/tracker");
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
    ? allRows.filter(r => clientName(r).toLowerCase().includes(term))
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
      <td class="name">${escapeHtml(clientName(r))}</td>
      <td class="flag grp-start">${checkmark(r.pettycash)}</td>
      <td class="flag">${checkmark(r.billing)}</td>
      <td class="derived grp-start">${dateCell(r.pc_latest_submitted)}</td>
      <td class="derived">${dateCell(r.pc_latest_published)}</td>
      <td class="num grp-start">${numCell(r.num_paid)}</td>
      <td class="num">${numCell(r.num_partialpaid)}</td>
      <td class="num">${numCell(r.num_unpaid)}</td>
      <td class="num">${numCell(r.num_published)}</td>
      <td class="derived">${datetimeCell(r.latest_bill_published)}</td>
      <td class="derived">${datetimeCell(r.latest_bill_update)}</td>`;
    // Use entity_id as a stable row key (not displayed).
    if (r.entity_id != null) tr.dataset.entityId = r.entity_id;
    tbody.appendChild(tr);
  }

  const total = allRows.length;
  const pcOn = allRows.filter(r => r.pettycash).length;
  const billOn = allRows.filter(r => r.billing).length;
  const shown = rows.length;
  el("status").textContent = term
    ? `${shown} of ${total} clients shown`
    : `${total} clients · ${pcOn} with Petty Cash · ${billOn} with Billing · live from the database`;
}

// ---- cell formatters ------------------------------------------------------
// The /api/tracker view aliases the client name column as the quoted string
// "entities.name", so it arrives as a flat key WITH A LITERAL DOT — not a
// nested object. It must be read with bracket notation. Fall back to a plain
// `name` in case the backend later re-aliases it to a clean key.
function clientName(r) {
  return String((r && (r["entities.name"] ?? r.name)) || "");
}

function checkmark(on) {
  return on
    ? '<span class="badge badge-yes">Active</span>'
    : '<span class="badge badge-no">Inactive</span>';
}

function numCell(n) {
  const v = Number(n || 0);
  return v === 0 ? '<span class="zero">0</span>' : String(v);
}

// Date-only field (YYYY-MM-DD). Blank/absent -> em dash.
function dateCell(v) {
  if (!v) return '<span class="none">—</span>';
  return escapeHtml(String(v).slice(0, 10));
}

// Datetime field: show the date, with the full timestamp + relative age on hover.
function datetimeCell(v) {
  if (!v) return '<span class="none">—</span>';
  const d = new Date(v);
  if (isNaN(d.getTime())) return escapeHtml(String(v));
  const date = d.toISOString().slice(0, 10);
  const rel = relativeTime(d);
  const full = escapeHtml(String(v));
  return `<span title="${full}${rel ? " · " + rel : ""}">${date}</span>`;
}

function relativeTime(d) {
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "";
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 30) return "";
  if (day >= 1) return `${day}d ago`;
  if (hr >= 1) return `${hr}h ago`;
  if (min >= 1) return `${min}m ago`;
  return "just now";
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

// Column titles toggle their description underneath when clicked.
document.querySelectorAll(".col-title").forEach((btn) => {
  btn.addEventListener("click", () => {
    const desc = btn.parentElement.querySelector(".col-desc");
    if (desc) desc.hidden = !desc.hidden;
  });
});

load();
