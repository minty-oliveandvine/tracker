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

// ---- column registry ------------------------------------------------------
// Single source of truth for the filterable / sortable columns. `key` is the
// JSON field on each row; `type` drives how it filters and sorts.
//   module -> boolean, Active/Inactive filter chips
//   date   -> YYYY-MM-DD (or datetime); sort latest/earliest, filter before/after
//   number -> integer; sort highest/lowest, filter >=, <=, =
const COLUMNS = [
  { key: "__name",                label: "Client",              type: "text"   },
  { key: "pettycash",             label: "Petty Cash",          type: "module" },
  { key: "billing",               label: "Billing",             type: "module" },
  { key: "pc_latest_submitted",   label: "Last Submitted",      type: "date"   },
  { key: "pc_latest_published",   label: "Last Published",      type: "date"   },
  { key: "num_paid",              label: "Paid",                type: "number" },
  { key: "num_partialpaid",       label: "Partially Paid",      type: "number" },
  { key: "num_unpaid",            label: "Unpaid",              type: "number" },
  { key: "num_published",         label: "Published Bills",     type: "number" },
  { key: "latest_bill_published", label: "Last Bill Published", type: "date"   },
  { key: "latest_bill_update",    label: "Last Bill Activity",  type: "date"   },
];
const COL_BY_KEY = Object.fromEntries(COLUMNS.map(c => [c.key, c]));

// ---- state ----------------------------------------------------------------
let allRows = [];
let filterText = "";
// Client multi-select: set of chosen client names. Empty = show all.
let selectedClients = new Set();
// Module filter: "all" | "on" | "off" per module column.
let moduleFilter = { pettycash: "all", billing: "all" };
// Range filter on one date/number column: { col, op, value }. op is
// ">=","<=","=" for numbers; "after","before","on" for dates. Empty col = off.
let rangeFilter = { col: "", op: "", value: "" };
// Multi-column sort: an ordered list of { key, dir } — first entry is the
// primary sort, the rest are tie-breakers (click order = priority). dir is
// "asc" | "desc" for every column type (see compareBy). Defaults to clients A→Z.
let sortKeys = [{ key: "__name", dir: "asc" }];

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
  el("controls").hidden = false;
  // Drop any selected clients that no longer exist in the refreshed data.
  if (selectedClients.size) {
    const present = new Set(clientNameList());
    for (const n of [...selectedClients]) if (!present.has(n)) selectedClients.delete(n);
  }
  renderClientTrigger();
  renderClientOptions();
  setLoading(false);
  render();
}

// Apply the search box, module chips, range filter, then sort. Pure function
// of the current state + allRows — returns the rows to render.
function applyFiltersAndSort() {
  let rows = allRows.slice();

  // 0. Client multi-select: if any clients are chosen, show only those.
  if (selectedClients.size) {
    rows = rows.filter(r => selectedClients.has(clientName(r)));
  }

  // 1. Client-name search.
  const term = filterText.trim().toLowerCase();
  if (term) rows = rows.filter(r => clientName(r).toLowerCase().includes(term));

  // 2. Module filters (Active/Inactive).
  for (const key of ["pettycash", "billing"]) {
    const sel = moduleFilter[key];
    if (sel === "on") rows = rows.filter(r => !!r[key]);
    else if (sel === "off") rows = rows.filter(r => !r[key]);
  }

  // 3. Range filter on one date/number column.
  const rf = rangeFilter;
  const rfCol = COL_BY_KEY[rf.col];
  if (rfCol && rf.op && rf.value !== "" && rf.value != null) {
    if (rfCol.type === "number") {
      const target = Number(rf.value);
      if (!isNaN(target)) {
        rows = rows.filter(r => {
          const v = Number(r[rfCol.key] || 0);
          if (rf.op === ">=") return v >= target;
          if (rf.op === "<=") return v <= target;
          if (rf.op === "=")  return v === target;
          return true;
        });
      }
    } else if (rfCol.type === "date") {
      // Compare on the YYYY-MM-DD prefix; rows with no date are excluded.
      const target = String(rf.value).slice(0, 10);
      rows = rows.filter(r => {
        const raw = r[rfCol.key];
        if (!raw) return false;
        const d = String(raw).slice(0, 10);
        if (rf.op === "after")  return d > target;
        if (rf.op === "before") return d < target;
        if (rf.op === "on")     return d === target;
        return true;
      });
    }
  }

  // 4. Multi-column sort: apply each key in priority order; earlier keys win,
  //    later keys break ties. Stable via a decorated index fallback.
  const active = sortKeys.filter(s => COL_BY_KEY[s.key]);
  if (active.length) {
    rows = rows
      .map((r, i) => [r, i])
      .sort((A, B) => {
        for (const s of active) {
          const c = compareBy(COL_BY_KEY[s.key], A[0], B[0], s.dir);
          if (c !== 0) return c;
        }
        return A[1] - B[1]; // stable tie-break on original order
      })
      .map(pair => pair[0]);
  }

  return rows;
}

// Comparator for a column, unified on dir = "asc" | "desc".
// "asc" means the natural low-to-high order for the type:
//   text   -> A→Z         number -> lowest→highest
//   date   -> earliest→latest (blanks always last)
//   module -> Inactive→Active
// Missing dates always sort to the bottom regardless of direction.
function compareBy(col, a, b, dir) {
  const flip = dir === "desc" ? -1 : 1;

  if (col.type === "text") {
    const cmp = clientName(a).localeCompare(clientName(b), undefined, { sensitivity: "base" });
    return flip * cmp;
  }
  if (col.type === "module") {
    const av = a[col.key] ? 1 : 0, bv = b[col.key] ? 1 : 0;
    return flip * (av - bv); // asc: Inactive first; desc: Active first
  }
  if (col.type === "number") {
    const av = Number(a[col.key] || 0), bv = Number(b[col.key] || 0);
    return flip * (av - bv);
  }
  // date: compare YYYY-MM-DD strings; blanks always sort to the bottom.
  const as = a[col.key] ? String(a[col.key]).slice(0, 10) : "";
  const bs = b[col.key] ? String(b[col.key]).slice(0, 10) : "";
  if (!as && !bs) return 0;
  if (!as) return 1;   // a is blank -> after b
  if (!bs) return -1;  // b is blank -> after a
  if (as === bs) return 0;
  return flip * (as < bs ? -1 : 1);
}

function render() {
  const tbody = el("rows");
  tbody.innerHTML = "";

  const rows = applyFiltersAndSort();
  const anyFilterActive = selectedClients.size > 0 || filterText.trim() !== "" ||
    moduleFilter.pettycash !== "all" || moduleFilter.billing !== "all" ||
    (rangeFilter.col && rangeFilter.op && rangeFilter.value !== "");

  if (rows.length === 0) {
    el("empty").hidden = false;
    el("empty").textContent = allRows.length === 0
      ? "No clients yet."
      : anyFilterActive
        ? "No clients match the current filters."
        : "No clients yet.";
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
  el("status").textContent = anyFilterActive
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Format a "YYYY-MM-DD..." string as "DD MMM YYYY" (e.g. "01 Jan 2026),
// parsing the parts straight from the string (no Date/UTC conversion). Returns
// the raw input unchanged if it doesn't look like an ISO date.
function formatDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (!m) return String(v);
  const [, y, mo, d] = m;
  const mon = MONTHS[Number(mo) - 1] || mo;
  return `${d} ${mon} ${y}`;
}

// Date-only field. Blank/absent -> em dash.
function dateCell(v) {
  if (!v) return '<span class="none">—</span>';
  return escapeHtml(formatDate(v));
}

// Datetime field: show date + 24-hour time as "DD MMM YYYY HH:MM" — date
// formatted via formatDate() and time sliced straight from the string (NOT via
// Date/toISOString(), which would shift the naive backend timestamps into UTC
// and could show the wrong day/time), with the full timestamp + relative age
// on hover.
function datetimeCell(v) {
  if (!v) return '<span class="none">—</span>';
  const s = String(v);
  const date = formatDate(s);
  const time = s.slice(11, 16); // "HH:MM" from the "...THH:MM:SS" portion
  const shown = time ? `${date} ${time}` : date;
  const d = new Date(v);
  const rel = isNaN(d.getTime()) ? "" : relativeTime(d);
  const full = escapeHtml(s);
  return `<span title="${full}${rel ? " · " + rel : ""}">${escapeHtml(shown)}</span>`;
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

// ---- controls: option builders --------------------------------------------
function opt(value, label, selected) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

// Populate the range-filter column dropdown from the registry.
function buildControlOptions() {
  const rfCol = el("rf-col");
  for (const c of COLUMNS) {
    // Range filter applies to dates & numbers only (not modules or the name).
    if (c.type === "date" || c.type === "number") rfCol.appendChild(opt(c.key, c.label));
  }
}

// ---- client multi-select --------------------------------------------------
// Sorted, de-duplicated list of client names present in the data.
function clientNameList() {
  const names = new Set();
  for (const r of allRows) {
    const n = clientName(r);
    if (n) names.add(n);
  }
  return [...names].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }));
}

// (Re)build the checkbox option list, honouring the search box; then refresh
// the trigger (chips / placeholder). Called after load and on search input.
function renderClientOptions() {
  const listEl = el("client-ms-list");
  const term = el("client-ms-search").value.trim().toLowerCase();
  listEl.innerHTML = "";
  const names = clientNameList()
    .filter(n => !term || n.toLowerCase().includes(term));

  if (names.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ms-empty";
    empty.textContent = term ? "No matching clients." : "No clients.";
    listEl.appendChild(empty);
  }
  for (const name of names) {
    const label = document.createElement("label");
    label.className = "ms-option";
    label.setAttribute("role", "option");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedClients.has(name);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedClients.add(name);
      else selectedClients.delete(name);
      renderClientTrigger();
      updateClearVisibility();
      render();
    });
    const span = document.createElement("span");
    span.className = "name";
    span.textContent = name;
    label.appendChild(cb);
    label.appendChild(span);
    listEl.appendChild(label);
  }
}

// Trigger button: show removable chips for chosen clients, else a placeholder.
function renderClientTrigger() {
  const chipsEl = el("client-ms-chips");
  const placeholder = el("client-ms-placeholder");
  chipsEl.innerHTML = "";
  const chosen = [...selectedClients];
  if (chosen.length === 0) {
    placeholder.hidden = false;
    return;
  }
  placeholder.hidden = true;
  // Show up to a few chips inline; summarise the rest to avoid overflow.
  const MAX = 3;
  chosen.slice(0, MAX).forEach(name => {
    const chip = document.createElement("span");
    chip.className = "ms-chip";
    chip.innerHTML = `<span class="lbl"></span><span class="x" title="Remove">×</span>`;
    chip.querySelector(".lbl").textContent = name;
    chip.querySelector(".x").addEventListener("click", (e) => {
      e.stopPropagation(); // don't toggle the dropdown open
      selectedClients.delete(name);
      renderClientTrigger();
      renderClientOptions();
      updateClearVisibility();
      render();
    });
    chipsEl.appendChild(chip);
  });
  if (chosen.length > MAX) {
    const more = document.createElement("span");
    more.className = "ms-chip";
    more.innerHTML = `<span class="lbl">+${chosen.length - MAX} more</span>`;
    chipsEl.appendChild(more);
  }
}

function openClientPanel(open) {
  const panel = el("client-ms-panel");
  const trigger = el("client-ms-trigger");
  panel.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
  if (open) {
    renderClientOptions();
    el("client-ms-search").focus();
  }
}

// Given the chosen range-filter column, show the right operator + input.
function syncRangeInputs() {
  const col = COL_BY_KEY[el("rf-col").value];
  const opSel = el("rf-op");
  const numIn = el("rf-val");
  const dateIn = el("rf-date");
  opSel.innerHTML = "";
  if (!col) {
    opSel.hidden = numIn.hidden = dateIn.hidden = true;
    return;
  }
  opSel.hidden = false;
  if (col.type === "number") {
    opSel.appendChild(opt(">=", "≥"));
    opSel.appendChild(opt("<=", "≤"));
    opSel.appendChild(opt("=", "="));
    numIn.hidden = false;
    dateIn.hidden = true;
  } else { // date
    opSel.appendChild(opt("after", "after"));
    opSel.appendChild(opt("before", "before"));
    opSel.appendChild(opt("on", "on"));
    numIn.hidden = true;
    dateIn.hidden = false;
  }
}

// ---- header sort buttons --------------------------------------------------
// Inject a clickable sort arrow next to each column title. The detail header
// row (#head-row) has one <th> per column in the same order as COLUMNS.
function buildSortButtons() {
  const ths = el("head-row").querySelectorAll("th");
  COLUMNS.forEach((col, i) => {
    const th = ths[i];
    if (!th) return;
    const title = th.querySelector(".col-title");
    if (!title) return;
    // Wrap the existing title + a new sort button in a flex row.
    const head = document.createElement("span");
    head.className = "col-head";
    title.parentNode.insertBefore(head, title);
    head.appendChild(title);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sort-btn";
    btn.dataset.key = col.key;
    btn.title = "Sort by " + col.label;
    btn.innerHTML = '<span class="arrow">' + ARROW_SVG.neutral + '</span>';
    btn.addEventListener("click", () => cycleSort(col.key));
    head.appendChild(btn);
  });
  renderSortIndicators();
}

// Sort-direction arrows drawn as inline SVG (not Unicode glyphs) so they can
// NEVER render as a missing-character box on any browser/font. `currentColor`
// makes them inherit the button's colour, so the primary/secondary CSS still
// controls black vs grey. viewBox 0 0 10 10.
const ARROW_SVG = {
  // faint UP-over-DOWN chevron for the unsorted/neutral state — points both
  // ways so it reads as "sortable", never mistaken for the down (desc) arrow.
  neutral: '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">'
    + '<path d="M2.5 4.2L5 1.7 7.5 4.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M2.5 5.8L5 8.3 7.5 5.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // solid up triangle — ascending
  up: '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">'
    + '<path d="M5 2L8.5 8H1.5Z" fill="currentColor"/></svg>',
  // solid down triangle — descending
  down: '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">'
    + '<path d="M5 8L1.5 2H8.5Z" fill="currentColor"/></svg>',
};

// Multi-column sort. Clicking a column cycles ITS state — desc → asc → off —
// and promotes it to PRIMARY (front of the list, shown black). Columns sorted
// earlier stay active as tie-breakers and are shown grey.
function cycleSort(key) {
  const idx = sortKeys.findIndex(s => s.key === key);
  if (idx === -1) {
    sortKeys.unshift({ key, dir: "desc" });   // first click: descending, becomes primary
  } else if (sortKeys[idx].dir === "desc") {
    const [entry] = sortKeys.splice(idx, 1);   // second click: ascending, re-promote
    entry.dir = "asc";
    sortKeys.unshift(entry);
  } else {
    sortKeys.splice(idx, 1);                    // third click: remove
  }
  renderSortIndicators();
  updateClearVisibility();
  render();
}

// Reflect the current sortKeys on the header arrows. Priority is shown by
// COLOUR (not badges): the primary sort (pos 0, newest click) is bold/black;
// lower-priority tie-breakers are greyed but still directional; unsorted
// columns show a faint neutral glyph.
function renderSortIndicators() {
  document.querySelectorAll(".sort-btn").forEach(btn => {
    const pos = sortKeys.findIndex(s => s.key === btn.dataset.key);
    const arrow = btn.querySelector(".arrow");
    btn.classList.remove("active", "primary", "secondary");
    if (pos === -1) {
      // Not sorted: faint neutral double-chevron (SVG, never a missing glyph).
      arrow.innerHTML = ARROW_SVG.neutral;
    } else {
      // Active: arrow points the way the data runs — up ascending, down descending.
      arrow.innerHTML = sortKeys[pos].dir === "asc" ? ARROW_SVG.up : ARROW_SVG.down;
      btn.classList.add("active", pos === 0 ? "primary" : "secondary");
    }
  });
}

// The default sort is exactly [Client asc]; anything else counts as active.
function isDefaultSort() {
  return sortKeys.length === 1 &&
    sortKeys[0].key === "__name" && sortKeys[0].dir === "asc";
}

function updateClearVisibility() {
  const active = selectedClients.size > 0 || filterText.trim() !== "" ||
    moduleFilter.pettycash !== "all" || moduleFilter.billing !== "all" ||
    (rangeFilter.col && rangeFilter.op && rangeFilter.value !== "") ||
    !isDefaultSort();
  el("clear-controls").hidden = !active;
}

// ---- wiring ---------------------------------------------------------------
el("search").addEventListener("input", (e) => {
  filterText = e.target.value;
  updateClearVisibility();
  render();
});
el("refresh").addEventListener("click", load);

// Client multi-select dropdown.
el("client-ms-trigger").addEventListener("click", () => {
  const isOpen = el("client-ms-trigger").getAttribute("aria-expanded") === "true";
  openClientPanel(!isOpen);
});
el("client-ms-search").addEventListener("input", renderClientOptions);
el("client-ms-all").addEventListener("click", () => {
  // Select all clients currently matching the search filter.
  const term = el("client-ms-search").value.trim().toLowerCase();
  clientNameList()
    .filter(n => !term || n.toLowerCase().includes(term))
    .forEach(n => selectedClients.add(n));
  renderClientOptions();
  renderClientTrigger();
  updateClearVisibility();
  render();
});
el("client-ms-none").addEventListener("click", () => {
  selectedClients.clear();
  renderClientOptions();
  renderClientTrigger();
  updateClearVisibility();
  render();
});
// Close the panel when clicking outside it.
document.addEventListener("click", (e) => {
  if (!el("client-ms").contains(e.target)) openClientPanel(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") openClientPanel(false);
});

// Module filter chips (Petty Cash, Billing): single-select within each group.
for (const key of ["pettycash", "billing"]) {
  const group = el("filter-" + key);
  group.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    moduleFilter[key] = chip.dataset.val;
    group.querySelectorAll(".chip").forEach(c =>
      c.setAttribute("aria-pressed", String(c === chip)));
    updateClearVisibility();
    render();
  });
}

// Range filter: column -> operator/value, then apply on any change.
el("rf-col").addEventListener("change", () => {
  syncRangeInputs();
  rangeFilter = { col: el("rf-col").value, op: "", value: "" };
  // Seed op with the first available option so a value alone filters.
  if (!el("rf-op").hidden) rangeFilter.op = el("rf-op").value;
  updateClearVisibility();
  render();
});
el("rf-op").addEventListener("change", () => {
  rangeFilter.op = el("rf-op").value;
  render();
});
function onRangeValue() {
  const col = COL_BY_KEY[el("rf-col").value];
  rangeFilter.value = col && col.type === "date"
    ? el("rf-date").value
    : el("rf-val").value;
  updateClearVisibility();
  render();
}
el("rf-val").addEventListener("input", onRangeValue);
el("rf-date").addEventListener("input", onRangeValue);

// (Sorting is driven by the SVG arrows in the column headers — see cycleSort.)

// Clear all filters + sort back to defaults.
el("clear-controls").addEventListener("click", () => {
  filterText = "";
  el("search").value = "";
  selectedClients.clear();
  el("client-ms-search").value = "";
  renderClientTrigger();
  renderClientOptions();
  moduleFilter = { pettycash: "all", billing: "all" };
  for (const key of ["pettycash", "billing"]) {
    el("filter-" + key).querySelectorAll(".chip").forEach(c =>
      c.setAttribute("aria-pressed", String(c.dataset.val === "all")));
  }
  rangeFilter = { col: "", op: "", value: "" };
  el("rf-col").value = ""; syncRangeInputs();
  el("rf-val").value = ""; el("rf-date").value = "";
  // Reset sort to the default (clients A→Z), not "no sort".
  sortKeys = [{ key: "__name", dir: "asc" }];
  renderSortIndicators();
  updateClearVisibility();
  render();
});

// Column titles toggle their description underneath when clicked. The desc
// lives in the <th> (closest), not necessarily as a direct sibling — the title
// is wrapped in .col-head once sort buttons are injected.
document.querySelectorAll(".col-title").forEach((btn) => {
  btn.addEventListener("click", () => {
    const th = btn.closest("th");
    const desc = th && th.querySelector(".col-desc");
    if (desc) desc.hidden = !desc.hidden;
  });
});

buildControlOptions();
buildSortButtons();
load();
