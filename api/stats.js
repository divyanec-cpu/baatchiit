// api/stats.js
//
// A private usage dashboard: who has signed up, who is actually using
// the app, and how much translation is happening.
//
//   https://baatchiit.vercel.app/api/stats?key=<STATS_KEY>
//
// Set STATS_KEY in Vercel (any long random string). Without it the
// endpoint refuses to run at all, so it can never be left open by
// accident. Add ?format=json for the raw numbers.
//
// Reads only — it never modifies user records. The data comes from
// what api/_lib.js records: user:<phone> documents, dau:<yyyymmdd>
// sets (5-week TTL), and the stats:exchanges counter.

const { redis, redisConfigured, dayKey } = require("./_lib.js");

const DAYS_SHOWN = 14;

module.exports = async function handler(req, res) {
  const expected = process.env.STATS_KEY;
  if (!expected) {
    return res.status(500).send("STATS_KEY is not set on the server, so this page is disabled.");
  }
  // Constant-ish comparison; the key is a bearer secret in a query
  // string, so also send no-store to keep it out of shared caches.
  const given = String((req.query && req.query.key) || "");
  res.setHeader("Cache-Control", "no-store");
  if (given.length !== expected.length || given !== expected) {
    return res.status(404).send("Not found");
  }
  if (!redisConfigured()) {
    return res.status(500).send("Storage isn't configured, so there are no stats yet.");
  }

  try {
    const data = await gather();
    if (req.query && req.query.format === "json") {
      return res.status(200).json(data);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderPage(data));
  } catch (err) {
    console.error("stats error:", err);
    return res.status(502).send("Couldn't read the stats: " + err.message);
  }
};

// ---------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------

// SCAN rather than KEYS: KEYS blocks Redis, and while this database is
// tiny today, a blocking call on the live store is a bad habit.
async function scanKeys(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const out = await redis(["SCAN", cursor, "MATCH", pattern, "COUNT", "500"]);
    cursor = out[0];
    keys.push(...out[1]);
  } while (cursor !== "0" && keys.length < 10000);
  return keys;
}

async function gather() {
  const userKeys = await scanKeys("user:*");
  const users = [];
  for (const key of userKeys) {
    const raw = await redis(["GET", key]);
    if (!raw) continue;
    try { users.push(JSON.parse(raw)); } catch { /* skip a corrupt record */ }
  }

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const since = (ms) => users.filter((u) => u.firstSeen && now - u.firstSeen < ms).length;
  const activeSince = (ms) => users.filter((u) => u.lastSeen && now - u.lastSeen < ms).length;

  // Daily active users for the last fortnight, oldest first.
  const daily = [];
  for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
    const day = dayKey(new Date(now - i * DAY));
    const count = await redis(["SCARD", `dau:${day}`]);
    daily.push({ day, count: Number(count) || 0 });
  }

  const totalExchanges = Number(await redis(["GET", "stats:exchanges"])) || 0;
  const minutesLeftTotal = users.reduce((sum, u) => sum + (u.deciminutes || 0), 0) / 10;
  const exchangesByUser = users.reduce((sum, u) => sum + (u.exchanges || 0), 0);

  const recent = users
    .slice()
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0))
    .slice(0, 15)
    .map((u) => ({
      phone: maskPhone(u.phone),
      joined: u.firstSeen || null,
      lastSeen: u.lastSeen || null,
      exchanges: u.exchanges || 0,
      minutesLeft: Math.floor((u.deciminutes || 0) / 10),
    }));

  return {
    generatedAt: now,
    totals: {
      users: users.length,
      newLast7d: since(7 * DAY),
      newLast30d: since(30 * DAY),
      activeLast24h: activeSince(DAY),
      activeLast7d: activeSince(7 * DAY),
      neverTranslated: users.filter((u) => !u.exchanges).length,
      exchanges: Math.max(totalExchanges, exchangesByUser),
      minutesUsed: Math.round((Math.max(totalExchanges, exchangesByUser) / 10) * 10) / 10,
      minutesOutstanding: Math.round(minutesLeftTotal * 10) / 10,
    },
    daily,
    recent,
  };
}

// Never render a full number: this page is a convenience, not a reason
// to expose everyone's contact details in a browser tab.
function maskPhone(phone) {
  const p = String(phone || "");
  return p.length >= 4 ? "•••••• " + p.slice(-4) : "••••";
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ago(ts) {
  if (!ts) return "never";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
  const days = Math.floor(hrs / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

function renderPage(d) {
  const t = d.totals;
  const peak = Math.max(1, ...d.daily.map((x) => x.count));
  const bars = d.daily.map((x) => {
    const pct = Math.round((x.count / peak) * 100);
    const label = x.day.slice(6, 8) + "/" + x.day.slice(4, 6);
    return (
      '<div class="bar-row"><span class="bar-day">' + label + "</span>" +
      '<span class="bar"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
      '<span class="bar-n">' + x.count + "</span></div>"
    );
  }).join("");

  const rows = d.recent.map((u) =>
    "<tr><td>" + esc(u.phone) + "</td><td>" + ago(u.joined) + "</td><td>" +
    ago(u.lastSeen) + "</td><td>" + u.exchanges + "</td><td>" + u.minutesLeft + "</td></tr>"
  ).join("") || '<tr><td colspan="5" class="muted">Nobody has signed up yet.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>BaatChiit — usage</title>
<style>
  :root { --ink:#211A14; --muted:#9A8A79; --cream:#FFF7EA; --card:#fff; --saffron:#FF7A29; --line:rgba(33,26,20,.1); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--cream); color:var(--ink); font-family:-apple-system,"Segoe UI",Roboto,sans-serif; padding:22px 16px 40px; }
  .wrap { max-width:760px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 2px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:24px; }
  .card { background:var(--card); border:1.5px solid var(--line); border-radius:14px; padding:14px 16px; }
  .card .n { font-size:26px; font-weight:800; }
  .card .k { font-size:12px; color:var(--muted); font-weight:600; margin-top:2px; }
  h2 { font-size:15px; margin:22px 0 10px; }
  .bar-row { display:flex; align-items:center; gap:8px; margin-bottom:4px; font-size:12px; }
  .bar-day { color:var(--muted); width:44px; flex-shrink:0; }
  .bar { flex:1; background:rgba(33,26,20,.06); border-radius:999px; height:14px; overflow:hidden; }
  .bar-fill { display:block; height:100%; background:var(--saffron); border-radius:999px; }
  .bar-n { width:26px; text-align:right; font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1.5px solid var(--line); border-radius:14px; overflow:hidden; font-size:13px; }
  th,td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  .muted { color:var(--muted); }
  .note { font-size:12px; color:var(--muted); margin-top:18px; line-height:1.5; }
</style></head><body><div class="wrap">
  <h1>BaatChiit — usage</h1>
  <p class="sub">Generated ${new Date(d.generatedAt).toLocaleString("en-IN")}</p>

  <div class="grid">
    <div class="card"><div class="n">${t.users}</div><div class="k">Accounts total</div></div>
    <div class="card"><div class="n">${t.newLast7d}</div><div class="k">New this week</div></div>
    <div class="card"><div class="n">${t.activeLast24h}</div><div class="k">Active today</div></div>
    <div class="card"><div class="n">${t.activeLast7d}</div><div class="k">Active this week</div></div>
    <div class="card"><div class="n">${t.exchanges}</div><div class="k">Translations ever</div></div>
    <div class="card"><div class="n">${t.minutesUsed}</div><div class="k">Minutes used</div></div>
    <div class="card"><div class="n">${t.neverTranslated}</div><div class="k">Signed up, never spoke</div></div>
    <div class="card"><div class="n">${t.minutesOutstanding}</div><div class="k">Minutes still owed</div></div>
  </div>

  <h2>People translating each day</h2>
  ${bars}

  <h2>Newest accounts</h2>
  <table>
    <tr><th>Phone</th><th>Joined</th><th>Last used</th><th>Translations</th><th>Min left</th></tr>
    ${rows}
  </table>

  <p class="note">
    Numbers count logged-in use only — someone who opens the app and never signs in isn't here.
    "Active" means they translated something. Phone numbers show the last 4 digits only.
    Daily figures are kept for 5 weeks; the totals are permanent.
  </p>
</div></body></html>`;
}
