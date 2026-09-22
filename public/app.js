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

// ---- auth -----------------------------------------------------------------
// The backend guards its data routes with a single shared password over HTTP
// Basic Auth. We prompt for it, hold it in sessionStorage (so it dies with the
// tab rather than lingering on disk like localStorage would), and attach it to
// every request. The username half of Basic is meaningless here — the backend
// ignores it and compares only the password.
const AUTH_KEY = "tracker_password";
const AUTH_USER = "tracker";

function storedPassword() {
  const saved = sessionStorage.getItem(AUTH_KEY) || "";
  // Defend against a value left by an older version of this code.
  if (saved && !canEncode(saved)) {
    forgetPassword();
    return "";
  }
  return saved;
}

// Ask for the password, remember it, and hand it back. Resolves to "" if the
// user dismisses the dialog. Rejects anything Basic Auth can't encode rather
// than storing it, which would wedge every later reload on the same bad value.
async function askForPassword(message) {
  let prompt = message || "Password:";
  let isError = false;

  for (;;) {
    const entered = await showPasswordDialog(prompt, isError);
    if (!entered) return "";
    if (canEncode(entered)) {
      sessionStorage.setItem(AUTH_KEY, entered);
      return entered;
    }
    prompt = "The password can't contain emoji or non-Latin letters. Try again:";
    isError = true;
  }
}

// Renders the in-page modal and resolves with what the user typed, or "" if
// they cancelled (button or Escape). The overlay backdrop-blurs the live page.
function showPasswordDialog(message, isError) {
  const overlay = document.getElementById("pw-overlay");
  const form = document.getElementById("pw-form");
  const input = document.getElementById("pw-input");
  const msg = document.getElementById("pw-msg");
  const cancel = document.getElementById("pw-cancel");

  msg.textContent = message;
  msg.classList.toggle("is-error", !!isError);
  input.value = "";
  overlay.hidden = false;
  input.focus();

  return new Promise((resolve) => {
    // One resolve, one teardown — whichever path fires first wins.
    function finish(value) {
      form.removeEventListener("submit", onSubmit);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKeydown);
      overlay.hidden = true;
      resolve(value);
    }
    function onSubmit(e) { e.preventDefault(); finish(input.value); }
    function onCancel() { finish(""); }
    function onKeydown(e) { if (e.key === "Escape") finish(""); }

    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKeydown);
  });
}

// btoa only handles Latin-1, and Basic Auth has no agreed encoding for wider
// characters — so a password containing them could never succeed.
function canEncode(password) {
  try {
    btoa(AUTH_USER + ":" + password);
    return true;
  } catch (_) {
    return false;
  }
}

function forgetPassword() {
  sessionStorage.removeItem(AUTH_KEY);
}

// Safe to encode directly: every password reaching here passed canEncode().
function authHeader(password) {
  return "Basic " + btoa(AUTH_USER + ":" + password);
}

// ---- api ------------------------------------------------------------------
// Every request carries the shared password. A 401 means it was wrong (or the
// backend rotated it), so we drop the bad one, prompt again, and retry exactly
// once — a typo shouldn't leave the page permanently wedged, but we also must
// not loop forever against a backend that will never accept us.
async function api(path, opts = {}) {
  let password = storedPassword();
  if (!password) password = await askForPassword("Enter the tracker password:");
  if (!password) throw new Error("A password is required to load this page.");

  let res = await request(path, opts, password);

  if (res.status === 401) {
    forgetPassword();
    password = await askForPassword("That password was not accepted. Try again:");
    if (!password) throw new Error("A password is required to load this page.");
    res = await request(path, opts, password);
    if (res.status === 401) {
      forgetPassword();
      throw new Error("That password was not accepted.");
    }
  }

  if (!res.ok) throw new Error("Request failed (" + res.status + ").");
  return res;
}

function request(path, opts, password) {
  const headers = { ...(opts.headers || {}), Authorization: authHeader(password) };
  return fetch(API_BASE + path, { ...opts, headers });
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
  { key: "pc_latest_submitted_date", label: "Last Submission Time", type: "date" },
  { key: "pc_latest_published",   label: "Last Published",      type: "date"   },
  { key: "num_paid",              label: "Paid",                type: "number" },
  { key: "num_partialpaid",       label: "Partially Paid",      type: "number" },
  { key: "num_unpaid",            label: "Unpaid",              type: "number" },
  { key: "num_published",         label: "Published Bills",     type: "number" },
  { key: "latest_bill_published", label: "Last Bill Published", type: "date"   },
  { key: "latest_bill_update",    label: "Last Bill Created",   type: "date"   },
];
const COL_BY_KEY = Object.fromEntries(COLUMNS.map(c => [c.key, c]));

// ---- state ----------------------------------------------------------------
let allRows = [];
let filterText = "";
// Client multi-select: set of chosen client names. Empty = show all.
let selectedClients = new Set();
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

  // 2. Range filter on one date/number column.
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
        const d = dateKey(r[rfCol.key], entityZone(r));
        if (!d) return false;
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
  // date: compare YYYY-MM-DD keys (each entity's local day for datetimes);
  // blanks always sort to the bottom.
  const as = dateKey(a[col.key], entityZone(a));
  const bs = dateKey(b[col.key], entityZone(b));
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
    const tz = entityZone(r);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="name">${escapeHtml(clientName(r))}</td>
      <td class="flag grp-start">${checkmark(r.pettycash)}</td>
      <td class="flag">${checkmark(r.billing)}</td>
      <td class="derived grp-start">${dateCell(r.pc_latest_submitted)}</td>
      <td class="derived">${datetimeCell(r.pc_latest_submitted_date, tz)}</td>
      <td class="derived">${dateCell(r.pc_latest_published)}</td>
      <td class="num grp-start">${numCell(r.num_paid)}</td>
      <td class="num">${numCell(r.num_partialpaid)}</td>
      <td class="num">${numCell(r.num_unpaid)}</td>
      <td class="num">${numCell(r.num_published)}</td>
      <td class="derived">${datetimeCell(r.latest_bill_published, tz)}</td>
      <td class="derived">${datetimeCell(r.latest_bill_update, tz)}</td>`;
    // Use entity_id as a stable row key (not displayed).
    if (r.entity_id != null) tr.dataset.entityId = r.entity_id;
    tbody.appendChild(tr);
  }

  syncTopScrollWidth(); // row count changed -> table width may have too

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

// ---- time zone ------------------------------------------------------------
// Datetime columns are shown in each entity's own local time, converted here
// in the browser. The backend passes the DB's ISO strings through untouched
// (UTC), plus the entity's country_code and timezone columns.
//
// Zone resolution per row (entityZone):
//   1. row.timezone, if it is a valid IANA name -- an explicit per-entity
//      override (entities.timezone; nothing else writes it today).
//   2. COUNTRY_TZ[row.country_code] -- one representative zone per country.
//      Multi-zone countries (US, CA, AU, BR, RU, ...) get their capital /
//      most-populous zone; set entities.timezone for an exact one.
//   3. DEFAULT_TZ.
const DEFAULT_TZ = "Asia/Hong_Kong";

// ISO 3166-1 alpha-2 -> IANA zone. Matches the country_info seed list.
const COUNTRY_TZ = {
  AD: "Europe/Andorra", AE: "Asia/Dubai", AF: "Asia/Kabul", AG: "America/Antigua",
  AI: "America/Anguilla", AL: "Europe/Tirane", AM: "Asia/Yerevan", AO: "Africa/Luanda",
  AQ: "Antarctica/McMurdo", AR: "America/Argentina/Buenos_Aires", AS: "Pacific/Pago_Pago",
  AT: "Europe/Vienna", AU: "Australia/Sydney", AW: "America/Aruba", AX: "Europe/Mariehamn",
  AZ: "Asia/Baku", BA: "Europe/Sarajevo", BB: "America/Barbados", BD: "Asia/Dhaka",
  BE: "Europe/Brussels", BF: "Africa/Ouagadougou", BG: "Europe/Sofia", BH: "Asia/Bahrain",
  BI: "Africa/Bujumbura", BJ: "Africa/Porto-Novo", BL: "America/St_Barthelemy",
  BM: "Atlantic/Bermuda", BN: "Asia/Brunei", BO: "America/La_Paz", BQ: "America/Kralendijk",
  BR: "America/Sao_Paulo", BS: "America/Nassau", BT: "Asia/Thimphu", BV: "Europe/Oslo",
  BW: "Africa/Gaborone", BY: "Europe/Minsk", BZ: "America/Belize", CA: "America/Toronto",
  CC: "Indian/Cocos", CD: "Africa/Kinshasa", CF: "Africa/Bangui", CG: "Africa/Brazzaville",
  CH: "Europe/Zurich", CI: "Africa/Abidjan", CK: "Pacific/Rarotonga", CL: "America/Santiago",
  CM: "Africa/Douala", CN: "Asia/Shanghai", CO: "America/Bogota", CR: "America/Costa_Rica",
  CU: "America/Havana", CV: "Atlantic/Cape_Verde", CW: "America/Curacao",
  CX: "Indian/Christmas", CY: "Asia/Nicosia", CZ: "Europe/Prague", DE: "Europe/Berlin",
  DJ: "Africa/Djibouti", DK: "Europe/Copenhagen", DM: "America/Dominica",
  DO: "America/Santo_Domingo", DZ: "Africa/Algiers", EC: "America/Guayaquil",
  EE: "Europe/Tallinn", EG: "Africa/Cairo", EH: "Africa/El_Aaiun", ER: "Africa/Asmara",
  ES: "Europe/Madrid", ET: "Africa/Addis_Ababa", FI: "Europe/Helsinki", FJ: "Pacific/Fiji",
  FK: "Atlantic/Stanley", FM: "Pacific/Pohnpei", FO: "Atlantic/Faroe", FR: "Europe/Paris",
  GA: "Africa/Libreville", GB: "Europe/London", GD: "America/Grenada", GE: "Asia/Tbilisi",
  GF: "America/Cayenne", GG: "Europe/Guernsey", GH: "Africa/Accra", GI: "Europe/Gibraltar",
  GL: "America/Nuuk", GM: "Africa/Banjul", GN: "Africa/Conakry", GP: "America/Guadeloupe",
  GQ: "Africa/Malabo", GR: "Europe/Athens", GS: "Atlantic/South_Georgia",
  GT: "America/Guatemala", GU: "Pacific/Guam", GW: "Africa/Bissau", GY: "America/Guyana",
  HK: "Asia/Hong_Kong", HM: "Indian/Kerguelen", HN: "America/Tegucigalpa",
  HR: "Europe/Zagreb", HT: "America/Port-au-Prince", HU: "Europe/Budapest",
  ID: "Asia/Jakarta", IE: "Europe/Dublin", IL: "Asia/Jerusalem", IM: "Europe/Isle_of_Man",
  IN: "Asia/Kolkata", IO: "Indian/Chagos", IQ: "Asia/Baghdad", IR: "Asia/Tehran",
  IS: "Atlantic/Reykjavik", IT: "Europe/Rome", JE: "Europe/Jersey", JM: "America/Jamaica",
  JO: "Asia/Amman", JP: "Asia/Tokyo", KE: "Africa/Nairobi", KG: "Asia/Bishkek",
  KH: "Asia/Phnom_Penh", KI: "Pacific/Tarawa", KM: "Indian/Comoro", KN: "America/St_Kitts",
  KP: "Asia/Pyongyang", KR: "Asia/Seoul", KW: "Asia/Kuwait", KY: "America/Cayman",
  KZ: "Asia/Almaty", LA: "Asia/Vientiane", LB: "Asia/Beirut", LC: "America/St_Lucia",
  LI: "Europe/Vaduz", LK: "Asia/Colombo", LR: "Africa/Monrovia", LS: "Africa/Maseru",
  LT: "Europe/Vilnius", LU: "Europe/Luxembourg", LV: "Europe/Riga", LY: "Africa/Tripoli",
  MA: "Africa/Casablanca", MC: "Europe/Monaco", MD: "Europe/Chisinau", ME: "Europe/Podgorica",
  MF: "America/Marigot", MG: "Indian/Antananarivo", MH: "Pacific/Majuro", MK: "Europe/Skopje",
  ML: "Africa/Bamako", MM: "Asia/Yangon", MN: "Asia/Ulaanbaatar", MO: "Asia/Macau",
  MP: "Pacific/Saipan", MQ: "America/Martinique", MR: "Africa/Nouakchott",
  MS: "America/Montserrat", MT: "Europe/Malta", MU: "Indian/Mauritius", MV: "Indian/Maldives",
  MW: "Africa/Blantyre", MX: "America/Mexico_City", MY: "Asia/Kuala_Lumpur",
  MZ: "Africa/Maputo", NA: "Africa/Windhoek", NC: "Pacific/Noumea", NE: "Africa/Niamey",
  NF: "Pacific/Norfolk", NG: "Africa/Lagos", NI: "America/Managua", NL: "Europe/Amsterdam",
  NO: "Europe/Oslo", NP: "Asia/Kathmandu", NR: "Pacific/Nauru", NU: "Pacific/Niue",
  NZ: "Pacific/Auckland", OM: "Asia/Muscat", PA: "America/Panama", PE: "America/Lima",
  PF: "Pacific/Tahiti", PG: "Pacific/Port_Moresby", PH: "Asia/Manila", PK: "Asia/Karachi",
  PL: "Europe/Warsaw", PM: "America/Miquelon", PN: "Pacific/Pitcairn",
  PR: "America/Puerto_Rico", PS: "Asia/Gaza", PT: "Europe/Lisbon", PW: "Pacific/Palau",
  PY: "America/Asuncion", QA: "Asia/Qatar", RE: "Indian/Reunion", RO: "Europe/Bucharest",
  RS: "Europe/Belgrade", RU: "Europe/Moscow", RW: "Africa/Kigali", SA: "Asia/Riyadh",
  SB: "Pacific/Guadalcanal", SC: "Indian/Mahe", SD: "Africa/Khartoum", SE: "Europe/Stockholm",
  SG: "Asia/Singapore", SH: "Atlantic/St_Helena", SI: "Europe/Ljubljana",
  SJ: "Arctic/Longyearbyen", SK: "Europe/Bratislava", SL: "Africa/Freetown",
  SM: "Europe/San_Marino", SN: "Africa/Dakar", SO: "Africa/Mogadishu",
  SR: "America/Paramaribo", SS: "Africa/Juba", ST: "Africa/Sao_Tome", SV: "America/El_Salvador",
  SX: "America/Lower_Princes", SY: "Asia/Damascus", SZ: "Africa/Mbabane",
  TC: "America/Grand_Turk", TD: "Africa/Ndjamena", TF: "Indian/Kerguelen", TG: "Africa/Lome",
  TH: "Asia/Bangkok", TJ: "Asia/Dushanbe", TK: "Pacific/Fakaofo", TL: "Asia/Dili",
  TM: "Asia/Ashgabat", TN: "Africa/Tunis", TO: "Pacific/Tongatapu", TR: "Europe/Istanbul",
  TT: "America/Port_of_Spain", TV: "Pacific/Funafuti", TW: "Asia/Taipei",
  TZ: "Africa/Dar_es_Salaam", UA: "Europe/Kyiv", UG: "Africa/Kampala", UM: "Pacific/Wake",
  US: "America/New_York", UY: "America/Montevideo", UZ: "Asia/Tashkent",
  VA: "Europe/Vatican", VC: "America/St_Vincent", VE: "America/Caracas",
  VG: "America/Tortola", VI: "America/St_Thomas", VN: "Asia/Ho_Chi_Minh", VU: "Pacific/Efate",
  WF: "Pacific/Wallis", WS: "Pacific/Apia", YE: "Asia/Aden", YT: "Indian/Mayotte",
  ZA: "Africa/Johannesburg", ZM: "Africa/Lusaka", ZW: "Africa/Harare",
};

// One Intl.DateTimeFormat per zone, built lazily. An unknown/invalid zone
// name makes the constructor throw a RangeError; fall back to DEFAULT_TZ so a
// bad entities.timezone value never blanks the table.
const FMT_CACHE = new Map();
function fmtFor(tz) {
  let fmt = FMT_CACHE.get(tz);
  if (fmt) return fmt;
  const opts = {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  };
  try {
    fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tz });
  } catch (e) {
    fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: DEFAULT_TZ });
  }
  FMT_CACHE.set(tz, fmt);
  return fmt;
}

// Whether `tz` is a zone name Intl accepts. Cached: the probe constructs a
// formatter, and this runs once per row per render.
const VALID_TZ = new Map();
function isValidZone(tz) {
  if (!tz) return false;
  if (VALID_TZ.has(tz)) return VALID_TZ.get(tz);
  let ok = false;
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); ok = true; } catch (e) {}
  VALID_TZ.set(tz, ok);
  return ok;
}

// The IANA zone to display a row's datetimes in (see resolution order above).
function entityZone(row) {
  const explicit = String(row?.timezone ?? "").trim();
  if (isValidZone(explicit)) return explicit;
  const cc = String(row?.country_code ?? "").trim().toUpperCase();
  return COUNTRY_TZ[cc] || DEFAULT_TZ;
}

// Parse a backend ISO datetime string into a Date, or null if it isn't one
// (date-only "YYYY-MM-DD", blank, garbage). A datetime that carries no
// offset/Z is treated as UTC — never as browser-local, which is what a bare
// `new Date("2026-01-01T07:14:00")` would do.
function parseInstant(v) {
  // Python's isoformat() emits microseconds (.123456); Date.parse only
  // reliably accepts up to millisecond precision, so trim the fraction.
  const s = String(v ?? "").replace(/(\.\d{3})\d+/, "$1");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasOffset ? s : s + "Z");
  return isNaN(d.getTime()) ? null : d;
}

// Return "YYYY-MM-DDTHH:MM" in zone `tz` for a datetime string. Date-only or
// unparseable input is returned unchanged, so callers can slice the same
// positions regardless of which they were given.
function toDisplayIso(v, tz = DEFAULT_TZ) {
  const d = parseInstant(v);
  if (!d) return String(v ?? "");
  const p = {};
  for (const { type, value } of fmtFor(tz).formatToParts(d)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// The YYYY-MM-DD used for sorting and range-filtering a date/datetime column.
// Goes through toDisplayIso so a datetime's day boundary matches what the
// cell shows (a 20:00 UTC timestamp is the *next* day in Hong Kong).
function dateKey(v, tz = DEFAULT_TZ) {
  return v ? toDisplayIso(v, tz).slice(0, 10) : "";
}

// Format a "YYYY-MM-DD..." string as "DD MMM YYYY" (e.g. "01 Jan 2026),
// parsing the parts straight from the string. Returns the raw input unchanged
// if it doesn't look like an ISO date.
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

// Datetime field: show date + 24-hour time as "DD MMM YYYY HH:MM" in the
// entity's zone `tz` (see entityZone / toDisplayIso). The cell carries no
// zone label; the hover tooltip names the zone alongside the full converted
// timestamp + relative age.
function datetimeCell(v, tz) {
  if (!v) return '<span class="none">—</span>';
  const s = toDisplayIso(v, tz);
  const date = formatDate(s);
  const time = s.slice(11, 16); // "HH:MM" from the "...THH:MM" portion
  const shown = time ? `${date} ${time}` : date;
  const d = parseInstant(v);
  const rel = d ? relativeTime(d) : "";
  const title = [s, zoneLabel(tz), rel].filter(Boolean).join(" · ");
  return `<span title="${escapeHtml(title)}">${escapeHtml(shown)}</span>`;
}

// Human-readable zone name for tooltips, e.g. "Hong Kong Standard Time
// (Asia/Hong_Kong)"; falls back to the bare IANA id if Intl can't name it.
// Cached per zone.
const ZONE_LABEL = new Map();
function zoneLabel(tz) {
  if (!tz) return "";
  if (ZONE_LABEL.has(tz)) return ZONE_LABEL.get(tz);
  let label = tz;
  try {
    const part = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "long" })
      .formatToParts(new Date())
      .find(p => p.type === "timeZoneName");
    if (part && part.value) label = `${part.value} (${tz})`;
  } catch (e) { /* invalid zone -> plain id */ }
  ZONE_LABEL.set(tz, label);
  return label;
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

// ---- mirrored top scrollbar -----------------------------------------------
// The table's real scrollbar sits at its bottom edge, which on a long table is
// below the fold — a mouse user has to scroll down to find it before they can
// pan right. This mirrors it above the table: a dummy scroller whose inner
// spacer is kept as wide as the table, with scrollLeft synced both ways.
//
// Trackpad and keyboard users never needed this (two-finger swipe and the
// arrow keys scroll the container directly), so it's purely additive.

// Guard against the echo: setting scrollLeft on one element fires its scroll
// event, which would set it back on the other and start a feedback loop.
//
// A single shared "syncing" flag is NOT enough — it can't distinguish the echo
// it caused from a genuine new scroll on the other element, so dragging one bar
// right after the other leaves the two out of step. Instead we record which
// element is currently being driven and ignore only that one's echo.
// The positions-already-agree check below is what actually breaks the loop:
// an echo always arrives with the two sides equal, so it returns early and
// nothing bounces back. That needs no flag and cannot latch — if the browser
// coalesces or drops the echo event, the next real scroll still syncs.
function linkScroll(from, to) {
  from.addEventListener("scroll", () => {
    if (from.scrollLeft === to.scrollLeft) return;
    to.scrollLeft = from.scrollLeft;
  });
}

// Match the spacer to the table's real width, and hide the whole strip when
// there's nothing to scroll (a scrollbar over a table that fits reads as broken).
function syncTopScrollWidth() {
  const top = el("top-scroll");
  const spacer = el("top-scroll-spacer");
  const scroller = document.querySelector(".table-scroll");
  const table = scroller && scroller.querySelector("table");
  if (!top || !spacer || !scroller || !table) return;

  spacer.style.width = table.scrollWidth + "px";
  top.hidden = table.scrollWidth <= scroller.clientWidth;
}

function initTopScroll() {
  const top = el("top-scroll");
  const scroller = document.querySelector(".table-scroll");
  if (!top || !scroller) return;

  linkScroll(top, scroller);
  linkScroll(scroller, top);

  // The table reflows on viewport resize (and on column-visibility changes,
  // which resize the table without a re-render). ResizeObserver catches both;
  // the resize listener covers browsers where the observer misses a reflow.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(syncTopScrollWidth).observe(scroller);
  }
  window.addEventListener("resize", syncTopScrollWidth);
  syncTopScrollWidth();
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
  // Group the filterable fields so it's clear which are dates vs numbers.
  const groups = [
    { label: "Dates", type: "date" },
    { label: "Numbers", type: "number" },
  ];
  for (const g of groups) {
    const og = document.createElement("optgroup");
    og.label = g.label;
    for (const c of COLUMNS) {
      if (c.type === g.type) og.appendChild(opt(c.key, c.label));
    }
    if (og.children.length) rfCol.appendChild(og);
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
  // First option is a greyed "is…" placeholder (empty value = no operator yet).
  opSel.appendChild(opt("", "is…"));
  if (col.type === "number") {
    opSel.appendChild(opt(">=", "at least"));
    opSel.appendChild(opt("<=", "at most"));
    opSel.appendChild(opt("=", "equals"));
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
// All three arrows are STROKED chevrons (fill:none) — never solid fills, so
// they can't collapse into a filled square at small sizes. 14px, thick stroke.
const CHEV = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const ARROW_SVG = {
  // neutral: up chevron over down chevron — reads as "sortable both ways".
  neutral: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">'
    + '<path d="M3 5L6 2 9 5" ' + CHEV + '/>'
    + '<path d="M3 7L6 10 9 7" ' + CHEV + '/></svg>',
  // ascending: single up chevron
  up: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">'
    + '<path d="M2.5 8L6 4 9.5 8" ' + CHEV + '/></svg>',
  // descending: single down chevron
  down: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">'
    + '<path d="M2.5 4L6 8 9.5 4" ' + CHEV + '/></svg>',
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
    (rangeFilter.col && rangeFilter.op && rangeFilter.value !== "") ||
    !isDefaultSort();
  el("clear-controls").hidden = !active;
}

// ---- wiring ---------------------------------------------------------------
// (Client-name search was removed — the Clients multi-select covers filtering
// by client. filterText stays "" so the filter logic is a no-op.)
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

// Range filter: column -> operator/value, then apply on any change.
// Grey the field select while no field is chosen, and the date input while
// no date is picked (placeholder state). Real values render black.
function syncRfPlaceholder() {
  el("rf-col").classList.toggle("is-placeholder", !el("rf-col").value);
  el("rf-op").classList.toggle("is-placeholder", !el("rf-op").value);
  el("rf-date").classList.toggle("is-placeholder", !el("rf-date").value);
}

// Reset the range filter back to the empty editor state.
function clearRfFilter() {
  rangeFilter = { col: "", op: "", value: "" };
  el("rf-col").value = "";
  el("rf-val").value = "";
  el("rf-date").value = "";
  syncRangeInputs();
  syncRfPlaceholder();
}
el("rf-col").addEventListener("change", () => {
  syncRangeInputs();
  syncRfPlaceholder();
  // New field → no operator chosen yet (op select starts on the "is…" placeholder).
  rangeFilter = { col: el("rf-col").value, op: "", value: "" };
  updateClearVisibility();
  render();
});
el("rf-op").addEventListener("change", () => {
  rangeFilter.op = el("rf-op").value;
  syncRfPlaceholder(); // op turns black once a real operator is picked
  updateClearVisibility();
  render();
});
function onRangeValue() {
  const col = COL_BY_KEY[el("rf-col").value];
  rangeFilter.value = col && col.type === "date"
    ? el("rf-date").value
    : el("rf-val").value;
  syncRfPlaceholder(); // date turns black once picked, grey when cleared
  updateClearVisibility();
  render();
}
el("rf-val").addEventListener("input", onRangeValue);
el("rf-date").addEventListener("input", onRangeValue);

// (Sorting is driven by the SVG arrows in the column headers — see cycleSort.)

// Clear all filters + sort back to defaults.
el("clear-controls").addEventListener("click", () => {
  selectedClients.clear();
  el("client-ms-search").value = "";
  renderClientTrigger();
  renderClientOptions();
  clearRfFilter();
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
syncRfPlaceholder();
initTopScroll();
load();
