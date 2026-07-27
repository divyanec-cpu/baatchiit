// api/auth.js
//
// Phone-OTP login, using the pattern proven in production by Dhruva
// (C:\1 PROJECTS\Dhruva\app) on the same MSG91 account:
//
//   - The MSG91 OTP Widget runs ENTIRELY in the browser, headless
//     (exposeMethods: true): send, retry, verify, anti-abuse all happen
//     client-side, so no server IP can get blocked by MSG91's widget
//     anti-abuse layer (which burned MissionFauj's server-side calls).
//   - On successful verify the widget hands the browser a JWT access
//     token. The ONLY thing this server trusts is MSG91's own
//     confirmation of that token (verifyAccessToken, server-to-server,
//     with the account authkey) — and the phone number is extracted
//     from the VALIDATED token, never from the request body: a token
//     proving "some number was verified" must not let a caller claim a
//     different number.
//
// Actions:
//   POST /api/auth  { action: "config" }                    -> widget creds for the client
//   POST /api/auth  { action: "verify", accessToken: "…" }  -> session + account
//   POST /api/auth  { action: "me",     token: "…" }        -> account
//   POST /api/auth  { action: "logout", token: "…" }
//
// Env vars:
//   MSG91_AUTH_KEY     -- account authkey (server-side token verification)
//   MSG91_WIDGET_ID    -- the OTP widget's id     (public, sent to client)
//   MSG91_TOKEN_AUTH   -- the OTP widget's token  (public, sent to client)
//   KV_REST_API_URL / KV_REST_API_TOKEN -- injected by the Upstash install
//
// Redis keys: session:<token> (90-day TTL), user:<phone> — see api/_lib.js.
//
// NOTE: the widget's hCaptcha refuses localhost, so this flow only works
// on a deployed HTTPS domain. There is no local dev mode here — test on
// the Vercel deployment (Dhruva added a dev-mode fallback; BaatChiit's
// workflow has always been deploy-and-test).

const {
  SESSION_TTL_SECONDS,
  WELCOME_DECIMINUTES,
  redis,
  redisConfigured,
  getSession,
  getUser,
  saveUser,
  randomToken,
  paymentsEnabled,
} = require("./_lib.js");

const VERIFY_URL = "https://control.msg91.com/api/v5/widget/verifyAccessToken";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "This endpoint only accepts POST requests." });
  }

  const missing = ["MSG91_AUTH_KEY", "MSG91_WIDGET_ID", "MSG91_TOKEN_AUTH"].filter((k) => !process.env[k]);
  if (!redisConfigured()) missing.push("KV_REST_API_URL/KV_REST_API_TOKEN");
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
      case "config":
        // Widget id + token are client-side values by design (Dhruva
        // exposes them as NEXT_PUBLIC_*); serving them from env keeps
        // them out of the repo and editable without a code deploy.
        return res.status(200).json({
          widgetId: process.env.MSG91_WIDGET_ID,
          tokenAuth: process.env.MSG91_TOKEN_AUTH,
        });
      case "clientlog":
        // Diagnostics only: the MSG91 widget runs in the browser, so its
        // send/verify failure reasons never reach these logs otherwise.
        // Nothing is stored; the payload is truncated and logged.
        console.log("client widget issue:", JSON.stringify({
          stage: String(body.stage || "").slice(0, 24),
          reason: String(body.reason || "").slice(0, 300),
        }));
        return res.status(200).json({ logged: true });
      case "verify":
        return await verify(body, res);
      case "me":
        return await whoAmI(body, res);
      case "logout":
        return await logout(body, res);
      default:
        return res.status(400).json({ error: "action must be one of: config, verify, me, logout." });
    }
  } catch (err) {
    console.error("auth error:", err);
    return res.status(502).json({ error: err.message || "Login service failed." });
  }
};

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------

async function verify(body, res) {
  const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (!accessToken) {
    return res.status(400).json({ error: "Missing the OTP access token." });
  }
  // Shape only (never the token): a real JWT is eyJ…, two dots, ~200+ chars.
  console.log("verify token shape:", JSON.stringify({
    length: accessToken.length,
    dots: accessToken.split(".").length - 1,
    looksJwt: accessToken.slice(0, 3) === "eyJ",
  }));

  const phone = await verifyWidgetAccessToken(accessToken);
  if (!phone) {
    return res.status(401).json({ error: "OTP verification didn't hold up. Try logging in again." });
  }

  // First login creates the user record (with the welcome minutes);
  // later logins keep it as-is. Pre-metering accounts get topped up
  // to the welcome credit once.
  let user = await getUser(phone);
  if (!user) {
    user = { phone, firstSeen: Date.now(), plan: "free", deciminutes: WELCOME_DECIMINUTES };
    await saveUser(user);
  } else if (typeof user.deciminutes !== "number") {
    user.deciminutes = WELCOME_DECIMINUTES;
    await saveUser(user);
  }

  const token = randomToken();
  await redis([
    "SETEX",
    `session:${token}`,
    String(SESSION_TTL_SECONDS),
    JSON.stringify({ phone, createdAt: Date.now() }),
  ]);

  return res.status(200).json(accountPayload(user, { token }));
}

async function whoAmI(body, res) {
  const session = await getSession(body.token);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  const user = (await getUser(session.phone)) || { phone: session.phone, plan: "free", deciminutes: 0 };
  return res.status(200).json(accountPayload(user));
}

async function logout(body, res) {
  if (body.token && /^[a-f0-9]{48}$/.test(body.token)) {
    await redis(["DEL", `session:${body.token}`]);
  }
  return res.status(200).json({ loggedOut: true });
}

// The client renders whole minutes; deciminutes stay server-side.
function accountPayload(user, extra) {
  return Object.assign(
    {
      phone: user.phone,
      plan: user.plan,
      minutes: Math.floor((user.deciminutes || 0) / 10),
      paymentsEnabled: paymentsEnabled(),
    },
    extra || {}
  );
}

// ---------------------------------------------------------------------
// MSG91 access-token verification (ported from Dhruva's msg91.ts)
// ---------------------------------------------------------------------

// Decode a JWT's payload without signature verification — safe here ONLY
// because MSG91 has just confirmed the token's validity server-to-server.
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractIdentifier(payload) {
  const keys = ["identifier", "mobile", "phone", "identity"];
  for (let i = 0; i < keys.length; i++) {
    const value = payload[keys[i]];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (value && typeof value === "object") {
      const nested = extractIdentifier(value);
      if (nested) return nested;
    }
  }
  return null;
}

// "919876543210" / "+91 98765 43210" / … -> bare 10-digit Indian mobile.
function normalizeIndianPhone(identifier) {
  let digits = identifier.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

async function verifyWidgetAccessToken(accessToken) {
  let response;
  try {
    response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authkey: process.env.MSG91_AUTH_KEY, "access-token": accessToken }),
    });
  } catch (err) {
    console.error("msg91 verifyAccessToken request failed:", err);
    return null;
  }

  let data = null;
  try {
    data = await response.json();
  } catch { /* treated as failure below */ }
  if (!response.ok || !data || data.type !== "success") {
    // data.message/code are MSG91's reason -- never contain the OTP or
    // any credential, safe to log verbatim. The code disambiguates what
    // the shared "AuthenticationFailure" message hides.
    console.log("msg91 verifyAccessToken rejected:", JSON.stringify({ status: response.status, type: data && data.type, message: data && data.message, code: data && data.code }));
    return null;
  }

  // Identifier: prefer the validated token's own payload; fall back to
  // the response message (sometimes a JWT, sometimes the identifier).
  let identifier = null;
  const tokenPayload = decodeJwtPayload(accessToken);
  if (tokenPayload) identifier = extractIdentifier(tokenPayload);
  if (!identifier && typeof data.message === "string") {
    const messagePayload = decodeJwtPayload(data.message);
    if (messagePayload) identifier = extractIdentifier(messagePayload);
    else identifier = data.message;
  }
  if (!identifier) {
    console.error(
      "msg91 token valid but no identifier found; payload keys:",
      tokenPayload ? Object.keys(tokenPayload) : "(undecodable token)"
    );
    return null;
  }

  return normalizeIndianPhone(identifier);
}
