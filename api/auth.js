// api/auth.js
//
// Phone-OTP login. One endpoint, action-based:
//
//   POST /api/auth  { action: "send",   phone: "9876543210" }
//   POST /api/auth  { action: "verify", phone: "9876543210", otp: "123456" }
//   POST /api/auth  { action: "me",     token: "<session token>" }
//   POST /api/auth  { action: "logout", token: "<session token>" }
//
// Two external services, both configured only through env vars:
//
//   MSG91 (OTP delivery + verification -- same account as the user's
//   MissionFauj project). MSG91 sells two OTP products with different
//   APIs: "OTP (classic)" (authkey + template_id) and "OTP Widget"
//   (widgetId + tokenAuth + a reqId that threads send->retry->verify).
//   THIS ACCOUNT USES THE WIDGET PRODUCT -- the classic API accepts
//   sends with type:"success" but never delivers (no DLT template
//   behind it), which cost a debugging round on MissionFauj and again
//   here. Integration below mirrors MissionFauj's proven one:
//     MSG91_WIDGET_ID    -- msg91.com dashboard -> OTP widget
//     MSG91_TOKEN_AUTH   -- the widget's auth token
//   MSG91 generates and verifies the code itself; this server only
//   forwards calls, so it never sees the OTP.
//
//   Upstash Redis (sessions + user records), via its REST API so there
//   are no npm dependencies. Install from the Vercel dashboard:
//   Storage -> Marketplace -> Upstash Redis (free tier); the KV_* env
//   vars are injected automatically.
//
// Keys used in Redis:
//   otp_rl:<phone>    -- send-rate counter, expires hourly   (rate limit)
//   otpreq:<phone>    -- MSG91 widget reqId, 5-min TTL       (send->verify thread)
//   session:<token>   -- JSON {phone, createdAt}, 90-day TTL (login state)
//   user:<phone>      -- JSON {phone, firstSeen, plan}       (permanent)

const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const MAX_SENDS_PER_HOUR = 5;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "This endpoint only accepts POST requests." });
  }

  const missing = ["MSG91_WIDGET_ID", "MSG91_TOKEN_AUTH"].filter((k) => !process.env[k]);
  if (!redisUrl()) missing.push("KV_REST_API_URL (or UPSTASH_REDIS_REST_URL)");
  if (!redisToken()) missing.push("KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN)");
  if (missing.length) {
    return res.status(500).json({
      error: `Login isn't configured on the server yet (missing: ${missing.join(", ")}). See README "Accounts" section.`,
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      return res.status(400).json({ error: "Request body must be JSON." });
    }
  }
  body = body || {};

  try {
    switch (body.action) {
      case "send":
        return await sendOtp(body, res);
      case "verify":
        return await verifyOtp(body, res);
      case "me":
        return await whoAmI(body, res);
      case "logout":
        return await logout(body, res);
      default:
        return res.status(400).json({ error: "action must be one of: send, verify, me, logout." });
    }
  } catch (err) {
    console.error("auth error:", err);
    return res.status(502).json({ error: err.message || "Login service failed." });
  }
};

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------

function normalizePhone(raw) {
  // Accept "9876543210", "+919876543210", "91 98765 43210" etc; return
  // bare 10-digit Indian mobile or null. Indian mobiles start 6-9.
  const digits = String(raw || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

async function sendOtp(body, res) {
  const phone = normalizePhone(body.phone);
  if (!phone) {
    return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
  }

  // Rate limit: protect the SMS balance from someone hammering "send".
  const sends = await redis(["INCR", `otp_rl:${phone}`]);
  if (sends === 1) await redis(["EXPIRE", `otp_rl:${phone}`, "3600"]);
  if (sends > MAX_SENDS_PER_HOUR) {
    return res.status(429).json({ error: "Too many OTP requests for this number. Try again in an hour." });
  }

  // If an OTP for this number is still in flight, resend it through the
  // widget retry call (a fresh sendOtp within the window is rejected).
  const inFlight = await redis(["GET", `otpreq:${phone}`]);
  if (inFlight) {
    const retry = await msg91("retryOtp", { reqId: inFlight, retryChannel: "text" });
    console.log("msg91 retry:", JSON.stringify(retry)); // responses never contain the OTP
    if (retry.type === "success") return res.status(200).json({ sent: true });
    await redis(["DEL", `otpreq:${phone}`]); // stale reqId -- fall through to a fresh send
  }

  const data = await msg91("sendOtp", { identifier: `91${phone}` });
  console.log("msg91 send:", JSON.stringify(data));
  if (data.type !== "success") {
    throw new Error(data.message || "Couldn't send the OTP SMS. Try again in a minute.");
  }
  // The reqId threads send -> retry -> verify. Live responses put it in
  // `message` (the documented reqId field is usually absent).
  const reqId = data.reqId || (data.data && data.data.reqId) || data.message;
  if (!reqId) throw new Error("MSG91 accepted the send but returned no request id.");
  await redis(["SETEX", `otpreq:${phone}`, "300", String(reqId)]);
  return res.status(200).json({ sent: true });
}

async function verifyOtp(body, res) {
  const phone = normalizePhone(body.phone);
  const otp = String(body.otp || "").trim();
  if (!phone || !/^\d{4,8}$/.test(otp)) {
    return res.status(400).json({ error: "Enter the OTP exactly as received." });
  }

  const reqId = await redis(["GET", `otpreq:${phone}`]);
  if (!reqId) {
    return res.status(401).json({ error: "That OTP expired. Tap Resend and try the new one." });
  }

  const data = await msg91("verifyOtp", { reqId, otp });
  console.log("msg91 verify:", JSON.stringify({ type: data.type, message: data.message }));
  if (data.type !== "success") {
    // MSG91 replies with type "error" for a wrong or expired OTP.
    return res.status(401).json({ error: "That OTP didn't match (or expired). Check the SMS and try again." });
  }
  await redis(["DEL", `otpreq:${phone}`]); // the reqId is single-use once verified

  // First login creates the user record; later logins keep it as-is.
  const userKey = `user:${phone}`;
  const existing = await redis(["GET", userKey]);
  let user = existing ? JSON.parse(existing) : null;
  if (!user) {
    user = { phone, firstSeen: Date.now(), plan: "free" };
    await redis(["SET", userKey, JSON.stringify(user)]);
  }

  const token = randomToken();
  await redis([
    "SETEX",
    `session:${token}`,
    String(SESSION_TTL_SECONDS),
    JSON.stringify({ phone, createdAt: Date.now() }),
  ]);

  return res.status(200).json({ token, phone, plan: user.plan });
}

async function whoAmI(body, res) {
  const session = await getSession(body.token);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  const raw = await redis(["GET", `user:${session.phone}`]);
  const user = raw ? JSON.parse(raw) : { phone: session.phone, plan: "free" };
  return res.status(200).json({ phone: user.phone, plan: user.plan });
}

async function logout(body, res) {
  if (body.token && /^[a-f0-9]{48}$/.test(body.token)) {
    await redis(["DEL", `session:${body.token}`]);
  }
  return res.status(200).json({ loggedOut: true });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function getSession(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const raw = await redis(["GET", `session:${token}`]);
  return raw ? JSON.parse(raw) : null;
}

function randomToken() {
  // 24 random bytes -> 48 hex chars. Node 18+ has webcrypto globally.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The Vercel Marketplace install injects KV_-prefixed names; a direct
// Upstash signup uses UPSTASH_-prefixed ones. Same REST API either way.
function redisUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
}
function redisToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
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

// Widget-API call. Non-2xx responses still carry a JSON body with
// type/message (e.g. a wrong OTP), so parse regardless of status and
// let the caller decide -- mirrors the behaviour proven in MissionFauj.
async function msg91(endpoint, payload) {
  const res = await fetch(`https://control.msg91.com/api/v5/widget/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      Object.assign(
        { widgetId: process.env.MSG91_WIDGET_ID, tokenAuth: process.env.MSG91_TOKEN_AUTH },
        payload
      )
    ),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MSG91 returned something that wasn't JSON (status ${res.status}). Check MSG91_WIDGET_ID/MSG91_TOKEN_AUTH.`);
  }
}
