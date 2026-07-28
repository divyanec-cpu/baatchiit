// api/admin.js
//
// The admin panel: usage dashboard, account management, and editors for
// the app's text and pricing. One endpoint serves both the page (GET)
// and its JSON actions (POST).
//
//   https://baatchiit.vercel.app/api/admin
//
// Login is a single password in the ADMIN_PASSWORD env var, exchanged
// for a 12-hour token held in Redis and returned as an httpOnly cookie.
// The password itself never reaches localStorage or a URL. Without
// ADMIN_PASSWORD set, the endpoint refuses to run at all — it cannot be
// left open by accident.
//
// Every mutating action re-checks the cookie, so a stale tab can't act
// after the session expires.

const {
  redis,
  redisConfigured,
  dayKey,
  getUser,
  saveUser,
  safeEqual,
  createAdminSession,
  adminSessionValid,
  readCookie,
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  getOverrides,
  saveOverrides,
} = require("./_lib.js");

const DAYS_SHOWN = 21;
const USER_PAGE_SIZE = 25;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!process.env.ADMIN_PASSWORD) {
    return send(res, 500, "text/plain", "ADMIN_PASSWORD is not set, so the admin panel is disabled.");
  }
  if (!redisConfigured()) {
    return send(res, 500, "text/plain", "Storage isn't configured.");
  }

  const authed = await adminSessionValid(readCookie(req, ADMIN_COOKIE));

  if (req.method === "GET") {
    return send(res, 200, "text/html; charset=utf-8", authed ? panelHtml() : loginHtml(""));
  }
  if (req.method !== "POST") {
    return send(res, 405, "text/plain", "Method not allowed");
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ error: "Bad JSON" }); }
  }
  body = body || {};

  try {
    // Login is the only action allowed without a session.
    if (body.action === "login") {
      if (!safeEqual(body.password, process.env.ADMIN_PASSWORD)) {
        // Slow a guessing loop down a little without holding the
        // function open long enough to matter for a real login.
        await new Promise((r) => setTimeout(r, 600));
        return res.status(401).json({ error: "Wrong password." });
      }
      const token = await createAdminSession();
      res.setHeader("Set-Cookie",
        `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`);
      return res.status(200).json({ ok: true });
    }

    if (!authed) return res.status(401).json({ error: "Please log in again." });

    switch (body.action) {
      case "logout": {
        const token = readCookie(req, ADMIN_COOKIE);
        if (token) await redis(["DEL", `admin:${token}`]);
        res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api/; Max-Age=0`);
        return res.status(200).json({ ok: true });
      }
      case "overview":   return res.status(200).json(await overview());
      case "users":      return res.status(200).json(await listUsers(body));
      case "user":       return res.status(200).json(await userDetail(body.phone));
      case "grant":      return res.status(200).json(await grantMinutes(body));
      case "setBlocked": return res.status(200).json(await setBlocked(body));
      case "delete":     return res.status(200).json(await deleteUser(body.phone));
      case "content":    return res.status(200).json(await getOverrides());
      case "saveContent":return res.status(200).json(await saveContent(body));
      default:           return res.status(400).json({ error: "Unknown action." });
    }
  } catch (err) {
    console.error("admin error:", err);
    return res.status(502).json({ error: err.message || "Something went wrong." });
  }
};

function send(res, code, type, body) {
  res.setHeader("Content-Type", type);
  return res.status(code).send(body);
}

// ---------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------

async function scanKeys(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const out = await redis(["SCAN", cursor, "MATCH", pattern, "COUNT", "500"]);
    cursor = out[0];
    keys.push(...out[1]);
  } while (cursor !== "0" && keys.length < 20000);
  return keys;
}

async function allUsers() {
  const keys = await scanKeys("user:*");
  const users = [];
  for (const key of keys) {
    const raw = await redis(["GET", key]);
    if (!raw) continue;
    try { users.push(JSON.parse(raw)); } catch { /* skip corrupt record */ }
  }
  return users;
}

async function overview() {
  const users = await allUsers();
  const now = Date.now();
  const DAY = 86400000;
  const newSince = (ms) => users.filter((u) => u.firstSeen && now - u.firstSeen < ms).length;
  const activeSince = (ms) => users.filter((u) => u.lastSeen && now - u.lastSeen < ms).length;

  const daily = [];
  for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
    const day = dayKey(new Date(now - i * DAY));
    const people = Number(await redis(["SCARD", `dau:${day}`])) || 0;
    const runs = Number(await redis(["GET", `stats:ex:${day}`])) || 0;
    daily.push({ day, people, runs });
  }

  // Top language pairs, most used first.
  let pairs = [];
  try {
    const flat = await redis(["ZRANGE", "stats:pairs", "0", "9", "REV", "WITHSCORES"]);
    for (let i = 0; i < flat.length; i += 2) pairs.push({ pair: flat[i], count: Number(flat[i + 1]) || 0 });
  } catch { pairs = []; }

  const totalExchanges = Number(await redis(["GET", "stats:exchanges"])) || 0;
  const byUser = users.reduce((s, u) => s + (u.exchanges || 0), 0);
  const exchanges = Math.max(totalExchanges, byUser);
  const activeWeek = activeSince(7 * DAY);

  return {
    generatedAt: now,
    totals: {
      users: users.length,
      blocked: users.filter((u) => u.blocked).length,
      newLast7d: newSince(7 * DAY),
      newLast30d: newSince(30 * DAY),
      activeLast24h: activeSince(DAY),
      activeLast7d: activeWeek,
      activeLast30d: activeSince(30 * DAY),
      neverTranslated: users.filter((u) => !u.exchanges).length,
      exchanges,
      minutesUsed: Math.round(exchanges / 10 * 10) / 10,
      minutesOutstanding: Math.round(users.reduce((s, u) => s + (u.deciminutes || 0), 0) / 10 * 10) / 10,
      // Of everyone who ever signed up, how many used it this week.
      weeklyRetentionPct: users.length ? Math.round((activeWeek / users.length) * 100) : 0,
      avgPerActiveUser: activeWeek ? Math.round((exchanges / activeWeek) * 10) / 10 : 0,
    },
    daily,
    pairs,
  };
}

async function listUsers(body) {
  const users = await allUsers();
  const q = String(body.q || "").replace(/\D/g, "");
  const sort = body.sort === "active" ? "active" : body.sort === "usage" ? "usage" : "joined";
  const page = Math.max(0, Number(body.page) || 0);

  let rows = q ? users.filter((u) => String(u.phone || "").includes(q)) : users;
  rows = rows.slice().sort((a, b) =>
    sort === "active" ? (b.lastSeen || 0) - (a.lastSeen || 0)
    : sort === "usage" ? (b.exchanges || 0) - (a.exchanges || 0)
    : (b.firstSeen || 0) - (a.firstSeen || 0));

  return {
    total: rows.length,
    page,
    pageSize: USER_PAGE_SIZE,
    rows: rows.slice(page * USER_PAGE_SIZE, (page + 1) * USER_PAGE_SIZE).map(publicUser),
  };
}

// The admin panel is the one place full numbers are shown — you cannot
// support or refund an account you can only identify by four digits.
function publicUser(u) {
  return {
    phone: u.phone,
    firstSeen: u.firstSeen || null,
    lastSeen: u.lastSeen || null,
    exchanges: u.exchanges || 0,
    minutes: Math.floor((u.deciminutes || 0) / 10),
    deciminutes: u.deciminutes || 0,
    plan: u.plan || "free",
    blocked: Boolean(u.blocked),
    note: u.note || "",
  };
}

async function userDetail(phone) {
  const user = await getUser(normalize(phone));
  if (!user) return { error: "No such account." };
  return { user: publicUser(user) };
}

async function grantMinutes(body) {
  const phone = normalize(body.phone);
  const user = await getUser(phone);
  if (!user) return { error: "No such account." };
  const minutes = Number(body.minutes);
  if (!isFinite(minutes) || minutes === 0) return { error: "Enter a number of minutes (negative to deduct)." };

  user.deciminutes = Math.max(0, (user.deciminutes || 0) + Math.round(minutes * 10));
  user.note = String(body.note || user.note || "").slice(0, 200);
  await saveUser(user);
  console.log(`admin: ${minutes > 0 ? "granted" : "deducted"} ${Math.abs(minutes)} min for ${phone}`);
  return { user: publicUser(user) };
}

async function setBlocked(body) {
  const phone = normalize(body.phone);
  const user = await getUser(phone);
  if (!user) return { error: "No such account." };
  user.blocked = Boolean(body.blocked);
  await saveUser(user);
  console.log(`admin: ${user.blocked ? "blocked" : "unblocked"} ${phone}`);
  return { user: publicUser(user) };
}

async function deleteUser(phoneRaw) {
  const phone = normalize(phoneRaw);
  if (!phone) return { error: "Bad phone number." };
  // Sessions are keyed by token, so find this person's by reading each
  // one. Fine at this scale; revisit if the user base gets large.
  const sessionKeys = await scanKeys("session:*");
  let killed = 0;
  for (const key of sessionKeys) {
    const raw = await redis(["GET", key]);
    if (!raw) continue;
    try {
      if (JSON.parse(raw).phone === phone) { await redis(["DEL", key]); killed++; }
    } catch { /* ignore */ }
  }
  await redis(["DEL", `user:${phone}`]);
  console.log(`admin: deleted ${phone} (+${killed} sessions)`);
  return { deleted: true, sessionsRemoved: killed };
}

function normalize(raw) {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits) ? digits : "";
}

// ---------------------------------------------------------------------
// Content overrides
// ---------------------------------------------------------------------

async function saveContent(body) {
  const current = await getOverrides();
  const next = { ui: current.ui || {}, phrases: current.phrases || {}, packs: current.packs || null };

  if (body.kind === "ui") {
    const lang = String(body.lang || "");
    if (!/^[a-z]{2}-IN$/.test(lang)) return { error: "Bad language code." };
    const clean = {};
    Object.keys(body.values || {}).forEach((k) => {
      const v = body.values[k];
      // An empty box means "use the built-in", not "make it blank".
      if (typeof v === "string" && v.trim() !== "") clean[k] = v.slice(0, 600);
    });
    if (Object.keys(clean).length) next.ui[lang] = clean; else delete next.ui[lang];
  } else if (body.kind === "phrases") {
    const lang = String(body.lang || "");
    if (!/^[a-z]{2}-IN$/.test(lang)) return { error: "Bad language code." };
    const clean = {};
    Object.keys(body.values || {}).forEach((k) => {
      const v = body.values[k];
      if (typeof v === "string" && v.trim() !== "") clean[k] = v.slice(0, 300);
    });
    if (Object.keys(clean).length) next.phrases[lang] = clean; else delete next.phrases[lang];
  } else if (body.kind === "packs") {
    const packs = Array.isArray(body.packs) ? body.packs : [];
    const clean = packs
      .filter((p) => p && isFinite(Number(p.price)) && isFinite(Number(p.minutes)))
      .slice(0, 6)
      .map((p, i) => ({
        id: String(p.id || "pack" + i).slice(0, 20),
        price: Math.max(1, Math.round(Number(p.price))),
        minutes: Math.max(1, Math.round(Number(p.minutes))),
        key: ["packStarter", "packPopular", "packValue"][i] || "packStarter",
        popular: Boolean(p.popular),
      }));
    next.packs = clean.length ? clean : null;
  } else {
    return { error: "Unknown content type." };
  }

  await saveOverrides(next);
  return { saved: true, updatedAt: next.updatedAt };
}

// ---------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------

const STYLE = `
  :root { --ink:#211A14; --muted:#9A8A79; --cream:#FFF7EA; --card:#fff; --saffron:#FF7A29; --line:rgba(33,26,20,.12); --green:#2E9E63; --red:#B5461E; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--cream); color:var(--ink); font-family:-apple-system,"Segoe UI",Roboto,sans-serif; padding:20px 14px 60px; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 18px; }
  .tabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:18px; }
  .tabs button { padding:8px 14px; border-radius:999px; border:1.5px solid var(--line); background:var(--card); font-size:13px; font-weight:700; cursor:pointer; color:var(--ink); }
  .tabs button[aria-pressed="true"] { background:var(--ink); color:var(--cream); border-color:var(--ink); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:22px; }
  .card { background:var(--card); border:1.5px solid var(--line); border-radius:14px; padding:13px 15px; }
  .card .n { font-size:24px; font-weight:800; }
  .card .k { font-size:11.5px; color:var(--muted); font-weight:600; margin-top:2px; }
  h2 { font-size:14px; margin:20px 0 9px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1.5px solid var(--line); border-radius:12px; overflow:hidden; font-size:13px; }
  th,td { text-align:left; padding:8px 11px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  .muted { color:var(--muted); }
  input,select,textarea { font:inherit; padding:8px 10px; border:1.5px solid var(--line); border-radius:9px; background:var(--card); color:var(--ink); width:100%; }
  textarea { resize:vertical; min-height:38px; }
  .btn { background:var(--saffron); color:#fff; border:none; border-radius:9px; padding:8px 14px; font-weight:700; font-size:13px; cursor:pointer; }
  .btn.ghost { background:var(--card); color:var(--ink); border:1.5px solid var(--line); }
  .btn.danger { background:var(--red); }
  .btn:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .bar-row { display:flex; align-items:center; gap:8px; margin-bottom:3px; font-size:12px; }
  .bar-day { color:var(--muted); width:42px; flex-shrink:0; }
  .bar { flex:1; background:rgba(33,26,20,.06); border-radius:999px; height:13px; overflow:hidden; }
  .bar-fill { display:block; height:100%; background:var(--saffron); border-radius:999px; }
  .bar-n { width:52px; text-align:right; font-variant-numeric:tabular-nums; color:var(--muted); }
  .pill { display:inline-block; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; }
  .pill.blocked { background:rgba(181,70,30,.12); color:var(--red); }
  .pill.ok { background:rgba(46,158,99,.12); color:var(--green); }
  .toast { position:fixed; left:50%; bottom:22px; transform:translateX(-50%); background:rgba(33,26,20,.92); color:var(--cream); font-size:13px; font-weight:600; padding:10px 16px; border-radius:999px; opacity:0; transition:opacity .2s; pointer-events:none; }
  .toast.show { opacity:1; }
  .hide { display:none; }
  .edit-row { display:grid; grid-template-columns:180px 1fr; gap:10px; align-items:start; padding:8px 0; border-bottom:1px solid var(--line); }
  .edit-row .k { font-size:12px; color:var(--muted); word-break:break-word; }
  .edit-row .en { font-size:11.5px; color:var(--muted); margin-top:3px; font-style:italic; }
  @media (max-width:560px) { .edit-row { grid-template-columns:1fr; } }
`;

function loginHtml(message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>BaatChiit admin</title><style>${STYLE}
  .login { max-width:320px; margin:12vh auto 0; text-align:center; }
  .login .card { padding:22px; }
</style></head><body><div class="login"><div class="card">
  <h1>BaatChiit admin</h1>
  <p class="sub">Enter the admin password.</p>
  <input id="pw" type="password" autocomplete="current-password" placeholder="Password" />
  <p id="err" class="sub" style="color:var(--red);min-height:16px;margin:8px 0;">${message || ""}</p>
  <button class="btn" id="go" style="width:100%;">Log in</button>
</div></div>
<script>
  var pw = document.getElementById("pw"), go = document.getElementById("go"), err = document.getElementById("err");
  function submit() {
    go.disabled = true; err.textContent = "";
    fetch("/api/admin", { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ action:"login", password: pw.value }) })
      .then(function(r){ return r.json().then(function(d){ if(!r.ok) throw new Error(d.error||"Failed"); return d; }); })
      .then(function(){ location.reload(); })
      .catch(function(e){ go.disabled = false; err.textContent = e.message; pw.select(); });
  }
  go.addEventListener("click", submit);
  pw.addEventListener("keydown", function(e){ if (e.key === "Enter") submit(); });
  pw.focus();
<\/script></body></html>`;
}

function panelHtml() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>BaatChiit admin</title><style>${STYLE}</style></head><body><div class="wrap">
  <div class="row" style="justify-content:space-between;">
    <div><h1>BaatChiit admin</h1><p class="sub" id="stamp">Loading…</p></div>
    <button class="btn ghost" id="logout">Log out</button>
  </div>

  <div class="tabs">
    <button data-tab="overview" aria-pressed="true">Overview</button>
    <button data-tab="accounts" aria-pressed="false">Accounts</button>
    <button data-tab="text" aria-pressed="false">App text</button>
    <button data-tab="phrases" aria-pressed="false">Phrases</button>
    <button data-tab="pricing" aria-pressed="false">Pricing</button>
  </div>

  <section id="tab-overview"></section>

  <section id="tab-accounts" class="hide">
    <div class="row" style="margin-bottom:10px;">
      <input id="q" placeholder="Search phone number" style="max-width:220px;" />
      <select id="sort" style="max-width:170px;">
        <option value="joined">Newest first</option>
        <option value="active">Recently active</option>
        <option value="usage">Most translations</option>
      </select>
      <button class="btn ghost" id="refresh">Refresh</button>
    </div>
    <div id="users"></div>
  </section>

  <section id="tab-text" class="hide">
    <p class="sub">Edit any wording the app shows. Leave a box empty to keep the built-in text. Changes reach phones within a minute.</p>
    <div class="row" style="margin-bottom:10px;">
      <select id="text-lang" style="max-width:220px;"></select>
      <button class="btn" id="text-save">Save text</button>
    </div>
    <div id="text-rows"></div>
  </section>

  <section id="tab-phrases" class="hide">
    <p class="sub">The offline phrase packs. Empty box = keep the built-in phrase.</p>
    <div class="row" style="margin-bottom:10px;">
      <select id="ph-lang" style="max-width:220px;"></select>
      <button class="btn" id="ph-save">Save phrases</button>
    </div>
    <div id="ph-rows"></div>
  </section>

  <section id="tab-pricing" class="hide">
    <p class="sub">Top-up packs shown on the payment screen. Prices are in rupees.</p>
    <div id="pricing-rows"></div>
    <div class="row" style="margin-top:12px;">
      <button class="btn" id="price-save">Save pricing</button>
      <button class="btn ghost" id="price-reset">Reset to built-in</button>
    </div>
  </section>
</div>
<div class="toast" id="toast"></div>
<script>${PANEL_JS}<\/script></body></html>`;
}

// Kept as a string constant so the template above stays readable.
const PANEL_JS = String.raw`
var LANGS = [["hi-IN","Hindi"],["bn-IN","Bengali"],["ta-IN","Tamil"],["te-IN","Telugu"],["kn-IN","Kannada"],
  ["ml-IN","Malayalam"],["mr-IN","Marathi"],["gu-IN","Gujarati"],["pa-IN","Punjabi"],["od-IN","Odia"],["en-IN","English"]];
var $ = function(id){ return document.getElementById(id); };
var state = { overview:null, content:null, defaults:null, page:0 };

function api(payload) {
  return fetch("/api/admin", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) })
    .then(function(r){
      if (r.status === 401) { location.reload(); throw new Error("Session expired"); }
      return r.json().then(function(d){ if (!r.ok || d.error) throw new Error(d.error || "Failed"); return d; });
    });
}
var toastTimer;
function toast(msg) {
  var el = $("toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(function(){ el.classList.remove("show"); }, 2200);
}
function ago(ts) {
  if (!ts) return "never";
  var m = Math.floor((Date.now()-ts)/60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  var h = Math.floor(m/60); if (h < 24) return h + "h ago";
  return Math.floor(h/24) + "d ago";
}
function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// ---- tabs ----
[].forEach.call(document.querySelectorAll(".tabs button"), function(b){
  b.addEventListener("click", function(){
    [].forEach.call(document.querySelectorAll(".tabs button"), function(o){ o.setAttribute("aria-pressed", String(o === b)); });
    ["overview","accounts","text","phrases","pricing"].forEach(function(t){
      $("tab-" + t).classList.toggle("hide", t !== b.dataset.tab);
    });
    if (b.dataset.tab === "accounts") loadUsers();
    if (b.dataset.tab === "text") ensureContent().then(renderText);
    if (b.dataset.tab === "phrases") ensureContent().then(renderPhrases);
    if (b.dataset.tab === "pricing") ensureContent().then(renderPricing);
  });
});
$("logout").addEventListener("click", function(){ api({action:"logout"}).then(function(){ location.reload(); }); });

// ---- overview ----
function loadOverview() {
  api({action:"overview"}).then(function(d){
    state.overview = d;
    $("stamp").textContent = "Updated " + new Date(d.generatedAt).toLocaleString("en-IN");
    var t = d.totals;
    var cards = [
      [t.users,"Accounts"],[t.newLast7d,"New this week"],[t.activeLast24h,"Active today"],
      [t.activeLast7d,"Active this week"],[t.exchanges,"Translations"],[t.minutesUsed,"Minutes used"],
      [t.weeklyRetentionPct + "%","Using it weekly"],[t.avgPerActiveUser,"Avg per active user"],
      [t.neverTranslated,"Never spoke"],[t.blocked,"Blocked"],[t.minutesOutstanding,"Minutes owed"],
      [t.newLast30d,"New this month"]
    ].map(function(c){ return '<div class="card"><div class="n">' + c[0] + '</div><div class="k">' + c[1] + '</div></div>'; }).join("");

    var peak = Math.max.apply(null, [1].concat(d.daily.map(function(x){ return x.people; })));
    var bars = d.daily.map(function(x){
      var pct = Math.round(x.people / peak * 100);
      return '<div class="bar-row"><span class="bar-day">' + x.day.slice(6,8) + "/" + x.day.slice(4,6) + '</span>' +
        '<span class="bar"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="bar-n">' + x.people + " / " + x.runs + '</span></div>';
    }).join("");

    var pairs = d.pairs.length
      ? '<table><tr><th>Language pair</th><th>Translations</th></tr>' + d.pairs.map(function(p){
          var s = p.pair.split(">");
          return "<tr><td>" + esc(name(s[0])) + " → " + esc(name(s[1])) + "</td><td>" + p.count + "</td></tr>";
        }).join("") + "</table>"
      : '<p class="muted" style="font-size:13px;">No pairs recorded yet.</p>';

    $("tab-overview").innerHTML =
      '<div class="grid">' + cards + '</div>' +
      '<h2>Each day — people / translations</h2>' + bars +
      '<h2>Most used language pairs</h2>' + pairs;
  }).catch(function(e){ $("tab-overview").innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
}
function name(code){ for (var i=0;i<LANGS.length;i++) if (LANGS[i][0] === code) return LANGS[i][1]; return code || "?"; }

// ---- accounts ----
function loadUsers() {
  api({action:"users", q:$("q").value, sort:$("sort").value, page:state.page}).then(function(d){
    var rows = d.rows.map(function(u){
      return "<tr>" +
        "<td><strong>" + esc(u.phone) + "</strong>" + (u.blocked ? ' <span class="pill blocked">blocked</span>' : "") +
          (u.note ? '<div class="muted" style="font-size:11px;">' + esc(u.note) + "</div>" : "") + "</td>" +
        "<td>" + ago(u.firstSeen) + "</td><td>" + ago(u.lastSeen) + "</td>" +
        "<td>" + u.exchanges + "</td><td>" + u.minutes + "</td>" +
        '<td class="row" style="gap:5px;">' +
          '<button class="btn ghost" data-act="grant" data-p="' + esc(u.phone) + '">Minutes</button>' +
          '<button class="btn ghost" data-act="block" data-p="' + esc(u.phone) + '" data-v="' + (u.blocked?"0":"1") + '">' + (u.blocked?"Unblock":"Block") + '</button>' +
          '<button class="btn danger" data-act="del" data-p="' + esc(u.phone) + '">Delete</button>' +
        "</td></tr>";
    }).join("") || '<tr><td colspan="6" class="muted">No accounts match.</td></tr>';

    var pages = Math.ceil(d.total / d.pageSize) || 1;
    $("users").innerHTML =
      "<table><tr><th>Phone</th><th>Joined</th><th>Last used</th><th>Translations</th><th>Min left</th><th></th></tr>" + rows + "</table>" +
      '<div class="row" style="margin-top:10px;justify-content:space-between;">' +
        '<span class="muted" style="font-size:12px;">' + d.total + " accounts · page " + (d.page+1) + " of " + pages + "</span>" +
        '<span class="row"><button class="btn ghost" id="prev"' + (d.page<=0?" disabled":"") + '>Previous</button>' +
        '<button class="btn ghost" id="next"' + (d.page>=pages-1?" disabled":"") + '>Next</button></span></div>';

    if ($("prev")) $("prev").addEventListener("click", function(){ state.page--; loadUsers(); });
    if ($("next")) $("next").addEventListener("click", function(){ state.page++; loadUsers(); });

    [].forEach.call($("users").querySelectorAll("button[data-act]"), function(b){
      b.addEventListener("click", function(){ userAction(b.dataset.act, b.dataset.p, b.dataset.v); });
    });
  }).catch(function(e){ $("users").innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; });
}

function userAction(act, phone, val) {
  if (act === "grant") {
    var mins = prompt("Minutes to add for " + phone + "?\nUse a negative number to take minutes away.", "30");
    if (mins === null || mins.trim() === "") return;
    var note = prompt("Reason (optional, kept on the account):", "") || "";
    api({action:"grant", phone:phone, minutes:Number(mins), note:note})
      .then(function(d){ toast("Now " + d.user.minutes + " min"); loadUsers(); })
      .catch(function(e){ toast(e.message); });
  } else if (act === "block") {
    api({action:"setBlocked", phone:phone, blocked: val === "1"})
      .then(function(d){ toast(d.user.blocked ? "Blocked" : "Unblocked"); loadUsers(); })
      .catch(function(e){ toast(e.message); });
  } else if (act === "del") {
    if (!confirm("Delete " + phone + " permanently?\n\nTheir account, minutes and logins are removed. This cannot be undone.")) return;
    if (prompt('Type DELETE to confirm.') !== "DELETE") return;
    api({action:"delete", phone:phone})
      .then(function(){ toast("Account deleted"); loadUsers(); })
      .catch(function(e){ toast(e.message); });
  }
}
$("refresh").addEventListener("click", function(){ state.page = 0; loadUsers(); });
$("q").addEventListener("keydown", function(e){ if (e.key === "Enter") { state.page = 0; loadUsers(); } });
$("sort").addEventListener("change", function(){ state.page = 0; loadUsers(); });

// ---- content: defaults come from the app itself, so this panel never
// holds a second copy of the text that could drift out of date ----
function ensureContent() {
  if (state.content && state.defaults) return Promise.resolve();
  return Promise.all([
    api({action:"content"}).then(function(d){ state.content = d; }),
    fetch("/api/content?defaults=1").then(function(r){ return r.json(); }).then(function(d){ state.defaults = d; })
  ]);
}

function langOptions(sel, chosen) {
  sel.innerHTML = LANGS.map(function(l){
    return '<option value="' + l[0] + '"' + (l[0] === chosen ? " selected" : "") + ">" + l[1] + "</option>";
  }).join("");
}

function renderText() {
  var sel = $("text-lang");
  if (!sel.options.length) { langOptions(sel, "hi-IN"); sel.addEventListener("change", renderText); }
  var lang = sel.value;
  var defs = (state.defaults.ui && state.defaults.ui[lang]) || {};
  var eng = (state.defaults.ui && state.defaults.ui["en-IN"]) || {};
  var over = (state.content.ui && state.content.ui[lang]) || {};
  var keys = Object.keys(defs).filter(function(k){ return typeof defs[k] === "string"; });

  $("text-rows").innerHTML = keys.map(function(k){
    var current = over[k] !== undefined ? over[k] : "";
    return '<div class="edit-row"><div><div class="k">' + esc(k) + '</div><div class="en">' + esc(eng[k] || "") + "</div></div>" +
      '<textarea data-k="' + esc(k) + '" placeholder="' + esc(defs[k]) + '">' + esc(current) + "</textarea></div>";
  }).join("");
}
$("text-save").addEventListener("click", function(){
  var lang = $("text-lang").value, values = {};
  [].forEach.call($("text-rows").querySelectorAll("textarea"), function(t){ values[t.dataset.k] = t.value; });
  api({action:"saveContent", kind:"ui", lang:lang, values:values}).then(function(){
    state.content = null; toast("Saved — phones update within a minute.");
    ensureContent().then(renderText);
  }).catch(function(e){ toast(e.message); });
});

function renderPhrases() {
  var sel = $("ph-lang");
  if (!sel.options.length) { langOptions(sel, "hi-IN"); sel.addEventListener("change", renderPhrases); }
  var lang = sel.value;
  var defs = state.defaults.phrases || {};
  var eng = defs["en-IN"] || {};
  var mine = defs[lang] || {};
  var over = (state.content.phrases && state.content.phrases[lang]) || {};

  $("ph-rows").innerHTML = Object.keys(eng).map(function(id){
    var current = over[id] !== undefined ? over[id] : "";
    return '<div class="edit-row"><div><div class="k">' + esc(eng[id]) + "</div></div>" +
      '<textarea data-k="' + esc(id) + '" placeholder="' + esc(mine[id] || "") + '">' + esc(current) + "</textarea></div>";
  }).join("");
}
$("ph-save").addEventListener("click", function(){
  var lang = $("ph-lang").value, values = {};
  [].forEach.call($("ph-rows").querySelectorAll("textarea"), function(t){ values[t.dataset.k] = t.value; });
  api({action:"saveContent", kind:"phrases", lang:lang, values:values}).then(function(){
    state.content = null; toast("Phrases saved.");
    ensureContent().then(renderPhrases);
  }).catch(function(e){ toast(e.message); });
});

function renderPricing() {
  var packs = state.content.packs || state.defaults.packs || [];
  $("pricing-rows").innerHTML = "<table><tr><th>Minutes</th><th>Price (₹)</th><th>Highlight</th></tr>" +
    packs.map(function(p, i){
      return "<tr>" +
        '<td><input type="number" min="1" data-i="' + i + '" data-f="minutes" value="' + esc(p.minutes) + '"></td>' +
        '<td><input type="number" min="1" data-i="' + i + '" data-f="price" value="' + esc(p.price) + '"></td>' +
        '<td><input type="checkbox" data-i="' + i + '" data-f="popular" style="width:auto;"' + (p.popular ? " checked" : "") + "></td></tr>";
    }).join("") + "</table>";
}
$("price-save").addEventListener("click", function(){
  var base = state.content.packs || state.defaults.packs || [];
  var packs = base.map(function(p){ return { id:p.id, price:p.price, minutes:p.minutes, popular:!!p.popular }; });
  [].forEach.call($("pricing-rows").querySelectorAll("input"), function(inp){
    var i = Number(inp.dataset.i), f = inp.dataset.f;
    if (!packs[i]) return;
    packs[i][f] = f === "popular" ? inp.checked : Number(inp.value);
  });
  api({action:"saveContent", kind:"packs", packs:packs}).then(function(){
    state.content = null; toast("Pricing saved.");
    ensureContent().then(renderPricing);
  }).catch(function(e){ toast(e.message); });
});
$("price-reset").addEventListener("click", function(){
  if (!confirm("Go back to the built-in ₹99 / ₹249 / ₹599 packs?")) return;
  api({action:"saveContent", kind:"packs", packs:[]}).then(function(){
    state.content = null; toast("Reset to built-in.");
    ensureContent().then(renderPricing);
  }).catch(function(e){ toast(e.message); });
});

loadOverview();
`;
