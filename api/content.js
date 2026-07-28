// api/content.js
//
// Serves the admin panel's content overrides to the app.
//
//   GET /api/content            -> overrides only (small; the app merges
//                                  these over its built-in text)
//   GET /api/content?defaults=1 -> the app's OWN built-in text, so the
//                                  admin editor can show what it is
//                                  editing without keeping a second copy
//                                  that would drift out of date
//
// The defaults are read out of the deployed index.html rather than
// duplicated here: index.html is the single source of truth for the
// app's text (see CLAUDE.md — single-file PWA), and a copy in this file
// would silently rot the first time someone edits a string there.

const { getOverrides, redisConfigured } = require("./_lib.js");

// Warm lambdas reuse this, so the self-fetch below happens rarely.
let defaultsCache = null;
let defaultsCachedAt = 0;
const DEFAULTS_TTL_MS = 10 * 60 * 1000;

module.exports = async function handler(req, res) {
  try {
    if (req.query && req.query.defaults) {
      const defaults = await loadDefaults(req);
      res.setHeader("Cache-Control", "no-store"); // admin-only, keep it fresh
      return res.status(200).json(defaults);
    }

    // Short and bounded on purpose. A long stale-while-revalidate makes
    // the CDN keep serving a pre-edit copy for minutes, which reads as
    // "my change didn't save" — the app also asks per-minute (see the
    // ?m= cache key it sends), so this only has to cover that window.
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=30");
    if (!redisConfigured()) return res.status(200).json({ ui: {}, phrases: {}, packs: null });

    const o = await getOverrides();
    return res.status(200).json({ ui: o.ui || {}, phrases: o.phrases || {}, packs: o.packs || null, updatedAt: o.updatedAt || null });
  } catch (err) {
    console.error("content error:", err);
    // Never fail loudly: the app treats an error as "no overrides" and
    // carries on with its built-in text.
    return res.status(200).json({ ui: {}, phrases: {}, packs: null });
  }
};

// ---------------------------------------------------------------------
// Reading the app's built-in text
// ---------------------------------------------------------------------

async function loadDefaults(req) {
  if (defaultsCache && Date.now() - defaultsCachedAt < DEFAULTS_TTL_MS) return defaultsCache;

  const host = (req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "baatchiit.vercel.app";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const html = await fetch(`${proto}://${host}/index.html`, { headers: { "x-bc-internal": "1" } }).then((r) => r.text());

  const ui = evalLiteral(extractLiteral(html, "var UI_STRINGS = ", "{", "}")) || {};
  const packsRaw = evalLiteral(extractLiteral(html, "var PACKS = ", "[", "]")) || [];
  const phrasePacks = evalLiteral(extractLiteral(html, "var PHRASE_PACKS = ", "[", "]")) || [];

  // Flatten the phrase packs into {lang: {"pack:index": text}} — a
  // stable id the admin can edit and the app can look up.
  const phrases = {};
  phrasePacks.forEach((pack, pi) => {
    (pack.phrases || []).forEach((phrase, xi) => {
      Object.keys(phrase).forEach((lang) => {
        if (!phrases[lang]) phrases[lang] = {};
        phrases[lang][pi + ":" + xi] = phrase[lang];
      });
    });
  });

  defaultsCache = {
    ui,
    phrases,
    packs: packsRaw.map((p) => ({ id: p.id, price: p.price, minutes: p.minutes, key: p.key, popular: Boolean(p.popular) })),
  };
  defaultsCachedAt = Date.now();
  return defaultsCache;
}

// Pull a balanced {...} or [...] literal that follows a marker.
function extractLiteral(src, marker, open, close) {
  const at = src.indexOf(marker);
  if (at === -1) return null;
  let i = src.indexOf(open, at);
  if (i === -1) return null;
  const start = i;
  let depth = 0, inStr = null, escaped = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// The source is our own deployed file, and only these three data
// literals are ever evaluated — no app logic runs here.
function evalLiteral(text) {
  if (!text) return null;
  try {
    return new Function("return (" + text + ");")();
  } catch (err) {
    console.error("could not parse a defaults literal:", err.message);
    return null;
  }
}
