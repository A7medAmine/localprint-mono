// Platform super-admin console.
//
// Auth is a session cookie set by POST /api/admin/login; this file never sees
// or stores the password, and the cookie is httpOnly so script cannot read it.
// Mutating calls carry the CSRF token handed out at login (kept in memory only
// — a reload re-fetches it from /api/admin/me).

const $ = (id) => document.getElementById(id);
let csrfToken = null;
let shops = [];

// ── API ──
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Screens ──
function showLogin(message) {
  $("dashboard").hidden = true;
  $("loginScreen").hidden = false;
  const el = $("loginError");
  el.textContent = message || "";
  el.hidden = !message;
  $("username").focus();
}

function showDashboard(username) {
  $("loginScreen").hidden = true;
  $("dashboard").hidden = false;
  $("whoami").textContent = `Signed in as ${username}`;
}

function toast(text, isError) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (isError ? " err" : "");
  el.hidden = !text;
}

// A 401 mid-session means the cookie expired or the server restarted.
function handleError(err) {
  if (err.status === 401) {
    csrfToken = null;
    showLogin("Session expired. Sign in again.");
    return;
  }
  toast(err.message, true);
}

// ── Rendering ──
const money = (n) => Number(n || 0).toFixed(2);
const num = (n) => Number(n || 0).toLocaleString();

function renderStats(stats) {
  const cards = [
    [num(stats.totalShops), "stores"],
    [num(stats.activeShops), "active"],
    [num(stats.totalOrders), "orders"],
    [num(stats.ordersLast30d), "orders (30d)"],
    [num(stats.totalPages), "pages printed"],
    [money(stats.totalRevenue), "revenue"],
  ];
  const box = $("stats");
  box.textContent = "";
  for (const [n, l] of cards) {
    const div = document.createElement("div");
    div.className = "stat";
    const nEl = document.createElement("span");
    nEl.className = "n";
    nEl.textContent = n;
    const lEl = document.createElement("span");
    lEl.className = "l";
    lEl.textContent = l;
    div.append(nEl, lEl);
    box.append(div);
  }
}

function td(text, cls) {
  const el = document.createElement("td");
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function button(label, onClick, cls = "small ghost") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// Shop names/slugs are operator-supplied strings: every cell is built from text
// nodes, never innerHTML, so a store named `<img onerror=...>` cannot run.
function renderShops() {
  const filter = $("filter").value.trim().toLowerCase();
  const rows = shops.filter(
    (s) => !filter || s.name.toLowerCase().includes(filter) || s.slug.toLowerCase().includes(filter),
  );
  const tbody = $("shops").querySelector("tbody");
  tbody.textContent = "";
  $("empty").hidden = rows.length > 0;

  for (const shop of rows) {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = shop.name;
    const slug = document.createElement("a");
    slug.className = "slug";
    slug.href = `/s/${shop.slug}/upload`;
    slug.target = "_blank";
    slug.rel = "noopener";
    slug.textContent = `/s/${shop.slug}/upload`;
    nameCell.append(name, slug);

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge " + (shop.isActive ? "on" : "off");
    badge.textContent = shop.isActive ? "Active" : "Disabled";
    statusCell.append(badge);

    const actions = document.createElement("td");
    const box = document.createElement("div");
    box.className = "actions";
    box.append(
      button("Copy link", (ev) => copyStoreLink(shop, ev.currentTarget)),
      button("Rename", () => startRename(tr, shop)),
      button("Rotate token", () => rotateToken(shop)),
      button(shop.isActive ? "Deactivate" : "Activate", () => setActive(shop, !shop.isActive)),
    );
    actions.append(box);

    tr.append(
      nameCell,
      statusCell,
      td(num(shop.orderCount), "num"),
      td(num(shop.totalPages), "num"),
      actions,
    );
    tbody.append(tr);
  }
}

// Inline rename — keeps the flow out of blocking prompt() dialogs.
function startRename(tr, shop) {
  const cell = tr.firstChild;
  cell.textContent = "";
  const input = document.createElement("input");
  input.value = shop.name;
  const save = button("Save", async () => {
    const name = input.value.trim();
    if (!name || name === shop.name) return renderShops();
    try {
      await api(`/api/admin/shops/${shop.id}`, { method: "PATCH", body: { name } });
      toast(`Renamed to "${name}".`);
      await load();
    } catch (err) { handleError(err); }
  }, "small");
  cell.append(input, " ", save, " ", button("Cancel", renderShops));
  input.focus();
  input.select();
}

async function rotateToken(shop) {
  const ok = window.confirm(
    `Rotate the API token for "${shop.name}"?\n\n` +
    "The old token stops working immediately — the shop's desktop app will need the new one.",
  );
  if (!ok) return;
  try {
    const r = await api(`/api/admin/shops/${shop.id}/rotate-token`, { method: "POST" });
    revealToken(`New token — ${r.name}`, r.token, r.slug || shop.slug);
  } catch (err) { handleError(err); }
}

async function setActive(shop, isActive) {
  try {
    await api(`/api/admin/shops/${shop.id}`, { method: "PATCH", body: { isActive } });
    toast(`"${shop.name}" ${isActive ? "activated" : "deactivated"}.`);
    await load();
  } catch (err) { handleError(err); }
}

// ── Store link ──
// ONE link per store, built on this console's own origin. The desktop app
// splits it back into the API base URL and the storefront slug, so the shop
// never has to be told two separate values.
function storeLink(slug) {
  return `${window.location.origin}/s/${encodeURIComponent(slug)}`;
}

async function copyStoreLink(shop, btn) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(storeLink(shop.slug));
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = label; }, 1500);
  } catch {
    // Clipboard blocked (insecure origin / permission) — surface the link
    // so it can still be selected by hand.
    toast(`Copy manually: ${storeLink(shop.slug)}`);
  }
}

// ── Token reveal (shown once, never stored) ──
// Paired with the store link so the whole desktop setup is one copy.
function revealToken(title, token, slug) {
  $("tokenTitle").textContent = title;
  $("tokenValue").textContent = token;
  $("cloudUrlValue").textContent = slug ? storeLink(slug) : window.location.origin;
  $("tokenModal").hidden = false;
}

// Clipboard can be blocked (insecure origin / permissions) — fall back to
// selecting the node so the value can still be copied by hand.
async function copyText(text, btnId, label, selectEl) {
  const btn = $(btnId);
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = label; }, 1500);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(selectEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

$("copyToken").addEventListener("click", () =>
  copyText($("tokenValue").textContent, "copyToken", "Copy token", $("tokenValue")));
$("copyCloudUrl").addEventListener("click", () =>
  copyText($("cloudUrlValue").textContent, "copyCloudUrl", "Copy link", $("cloudUrlValue")));
$("copyBoth").addEventListener("click", () =>
  copyText(
    `Store link: ${$("cloudUrlValue").textContent}
API token: ${$("tokenValue").textContent}`,
    "copyBoth",
    "Copy link + token",
    $("tokenModal").querySelector(".modal-card"),
  ));
$("closeToken").addEventListener("click", () => { $("tokenModal").hidden = true; });

// ── Data ──
async function load() {
  try {
    const stats = await api("/api/admin/stats");
    shops = stats.shops || [];
    renderStats(stats);
    renderShops();
  } catch (err) { handleError(err); }
}

// ── Events ──
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginBtn");
  btn.disabled = true;
  try {
    const r = await api("/api/admin/login", {
      method: "POST",
      body: { username: $("username").value.trim(), password: $("password").value },
    });
    csrfToken = r.csrfToken;
    $("password").value = "";
    $("loginError").hidden = true;
    showDashboard(r.username);
    toast("");
    await load();
  } catch (err) {
    showLogin(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/admin/logout", { method: "POST" }); } catch { /* log out locally regardless */ }
  csrfToken = null;
  showLogin("Signed out.");
});

$("refreshBtn").addEventListener("click", load);
$("filter").addEventListener("input", renderShops);

$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("newName").value.trim();
  if (!name) return;
  const btn = $("createBtn");
  btn.disabled = true;
  try {
    const r = await api("/api/admin/shops", { method: "POST", body: { name } });
    $("newName").value = "";
    revealToken(`Store created — ${r.name} (/s/${r.slug})`, r.token, r.slug);
    await load();
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
  }
});

// ── Boot ──
// /api/admin/me decides the screen: a live cookie lands on the dashboard, a
// 401 shows the login form.
(async function init() {
  try {
    const me = await api("/api/admin/me");
    csrfToken = me.csrfToken;
    showDashboard(me.username);
    await load();
  } catch {
    showLogin("");
  }
})();
