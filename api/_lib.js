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
};
