// api/_lib.js
//
// Shared helpers for the serverless functions. The leading underscore
// means Vercel does NOT expose this file as an endpoint -- it's only
// require()'d by api/auth.js and api/pipeline.js.
//
// Storage is Upstash Redis over its REST API (no npm dependencies).
// The Vercel Marketplace install injects KV_-prefixed env vars; a
// direct Upstash signup uses UPSTASH_-prefixed ones. Same API.

const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

// Minutes are stored as integer TENTHS of a minute ("deciminutes") to
// keep the math exact: 1 exchange = 1 deciminute (~"1 minute per 10
// exchanges", the rule shown in the wallet UI).
const WELCOME_DECIMINUTES = 150; // 15 free minutes for a new account
const DECIMINUTES_PER_EXCHANGE = 1;

function redisUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
}
function redisToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
}
function redisConfigured() {
  return Boolean(redisUrl() && redisToken());
}

// Single-command Upstash REST call: POST the command as a JSON array,
// e.g. ["SETEX", "key", "300", "value"] -> { result: ... }
async function redis(command) {
  const res = await fetch(redisUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Storage error: ${data.error || res.status}`);
  }
  return data.result;
}

async function getSession(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const raw = await redis(["GET", `session:${token}`]);
  return raw ? JSON.parse(raw) : null;
}

async function getUser(phone) {
  const raw = await redis(["GET", `user:${phone}`]);
  return raw ? JSON.parse(raw) : null;
}

async function saveUser(user) {
  await redis(["SET", `user:${user.phone}`, JSON.stringify(user)]);
}

function randomToken() {
  // 24 random bytes -> 48 hex chars. Node 18+ has webcrypto globally.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function paymentsEnabled() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

// ---------------------------------------------------------------------
// Usage tracking (feeds api/stats.js)
//
// Deliberately cheap: two extra Redis writes per exchange, no per-user
// event log, nothing that grows without bound. Daily-active sets expire
// after 5 weeks, which is all the stats page looks back.
// ---------------------------------------------------------------------
const DAU_TTL_SECONDS = 35 * 24 * 60 * 60;

// UTC day key. India is UTC+5:30, so a "day" here starts at 5:30am IST —
// close enough for a usage trend, and it avoids timezone maths in a
// serverless function that could run anywhere.
function dayKey(date) {
  const d = date || new Date();
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function recordActivity(phone, sourceLang, targetLang) {
  const day = dayKey();
  try {
    await redis(["SADD", `dau:${day}`, phone]);
    await redis(["EXPIRE", `dau:${day}`, String(DAU_TTL_SECONDS)]);
    await redis(["INCR", "stats:exchanges"]);
    await redis(["INCR", `stats:ex:${day}`]);
    await redis(["EXPIRE", `stats:ex:${day}`, String(DAU_TTL_SECONDS)]);
    // Which language pairs people actually use — the one number that
    // says where to focus translation quality and TTS voices.
    if (sourceLang && targetLang) {
      await redis(["ZINCRBY", "stats:pairs", "1", `${sourceLang}>${targetLang}`]);
    }
  } catch (err) {
    // Never let a stats write break a translation the user paid for.
    console.error("activity tracking failed:", err.message);
  }
}

// ---------------------------------------------------------------------
// Admin sessions (api/admin.js)
//
// A single password in ADMIN_PASSWORD, exchanged for a short-lived
// token held in Redis and sent back as an httpOnly cookie — so the
// password itself is never stored in the browser or in a URL.
// ---------------------------------------------------------------------
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const ADMIN_COOKIE = "bc_admin";

// Length-independent comparison so a wrong guess can't be timed.
function safeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= x.charCodeAt(i % (x.length || 1)) ^ y.charCodeAt(i % (y.length || 1));
  }
  return diff === 0;
}

async function createAdminSession() {
  const token = randomToken();
  await redis(["SETEX", `admin:${token}`, String(ADMIN_SESSION_TTL_SECONDS), String(Date.now())]);
  return token;
}

async function adminSessionValid(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return false;
  return Boolean(await redis(["GET", `admin:${token}`]));
}

function readCookie(req, name) {
  const raw = (req.headers && req.headers.cookie) || "";
  const hit = raw.split(";").map((s) => s.trim()).find((s) => s.indexOf(name + "=") === 0);
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

// ---------------------------------------------------------------------
// Editable content (api/admin.js writes, api/content.js serves)
//
// The app ships with built-in defaults; these are sparse OVERRIDES laid
// on top, so an empty store changes nothing and a bad edit can be
// deleted rather than repaired.
// ---------------------------------------------------------------------
async function getOverrides() {
  const raw = await redis(["GET", "cfg:overrides"]);
  if (!raw) return { ui: {}, phrases: {}, packs: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      ui: parsed.ui || {},
      phrases: parsed.phrases || {},
      packs: parsed.packs || null,
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { ui: {}, phrases: {}, packs: null };
  }
}

async function saveOverrides(next) {
  next.updatedAt = Date.now();
  await redis(["SET", "cfg:overrides", JSON.stringify(next)]);
}

// ---------------------------------------------------------------------
// Loudness. Sarvam's speech arrives quiet, and it cannot be fixed in the
// browser: iOS ignores the HTMLMediaElement volume property entirely
// (hardware volume only), so the samples themselves have to be louder.
//
// This normalises AVERAGE level (RMS), not peak. Peak normalisation was
// the first attempt and it barely moved: a clip with one brief transient
// already touches full scale, so peak-scaling decides it is "loud" and
// leaves the speech underneath just as quiet. Perceived loudness follows
// the average, which for speech sits far below the peaks.
//
// Gain is therefore set from RMS, and the peaks that overshoot are eased
// down with a soft knee rather than clipped square -- hard clipping on
// speech sounds like crackle, which is worse than quiet.
// ---------------------------------------------------------------------
// About -14 dBFS. Louder than the -16 that broadcast speech aims for,
// because this is a phone speaker on a table in a market rather than a
// pair of headphones, and Sarvam's own output measured 4% average (about
// -28 dBFS) on a real device. Going much past this makes the soft knee
// work hard enough to hear.
const TARGET_RMS = 0.20 * 32767;
const KNEE = 0.85;                 // above this fraction of full scale, ease off
const MAX_GAIN = 12;               // past this we would only amplify hiss

function softClip(x) {
  // x is -1..1. Below the knee it passes through untouched; above it,
  // the remaining headroom is compressed smoothly into what is left.
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  const over = (a - KNEE) / (1 - KNEE);
  const eased = KNEE + (1 - KNEE) * Math.tanh(over);
  return x < 0 ? -eased : eased;
}

function boostWavLoudness(base64) {
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
      return { base64, gain: 1, note: "not a WAV" };
    }

    // Walk the chunks rather than assuming a 44-byte header: WAVs in the
    // wild carry LIST/fact chunks before the data.
    let pos = 12, fmt = null, dataStart = 0, dataLength = 0;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === "fmt ") fmt = { format: buf.readUInt16LE(body), bits: buf.readUInt16LE(body + 14) };
      else if (id === "data") { dataStart = body; dataLength = Math.min(size, buf.length - body); break; }
      pos = body + size + (size % 2);   // chunks are word-aligned
    }
    if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || !dataLength) {
      return { base64, gain: 1, note: "unsupported WAV encoding" };
    }

    let sum = 0, peak = 0, n = 0;
    for (let i = dataStart; i + 1 < dataStart + dataLength; i += 2) {
      const v = buf.readInt16LE(i);
      sum += v * v; n++;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    if (!n || !peak) return { base64, gain: 1, note: "silent" };
    const rms = Math.sqrt(sum / n);

    const gain = Math.min(TARGET_RMS / rms, MAX_GAIN);
    if (gain <= 1.02) return { base64, gain: 1, rms: Math.round(rms / 327.67), peak, note: "already loud" };

    for (let i = dataStart; i + 1 < dataStart + dataLength; i += 2) {
      const scaled = softClip((buf.readInt16LE(i) * gain) / 32767) * 32767;
      const rounded = Math.round(scaled);
      buf.writeInt16LE(rounded > 32767 ? 32767 : rounded < -32768 ? -32768 : rounded, i);
    }
    return {
      base64: buf.toString("base64"),
      gain: Math.round(gain * 100) / 100,
      rms: Math.round(rms / 327.67),     // as a percentage of full scale
      peak,
    };
  } catch (err) {
    // A voice that is too quiet still beats no voice.
    return { base64, gain: 1, note: "boost failed: " + err.message };
  }
}

module.exports = {
  SESSION_TTL_SECONDS,
  WELCOME_DECIMINUTES,
  DECIMINUTES_PER_EXCHANGE,
  redis,
  redisConfigured,
  getSession,
  getUser,
  saveUser,
  randomToken,
  paymentsEnabled,
  dayKey,
  recordActivity,
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  safeEqual,
  createAdminSession,
  adminSessionValid,
  readCookie,
  getOverrides,
  saveOverrides,
  boostWavLoudness,
};
