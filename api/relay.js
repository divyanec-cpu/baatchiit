// api/relay.js
//
// Issues short-lived tickets for the realtime speech relay (relay/ in this
// repo, on Google Cloud Run in Mumbai). The relay can't see our Redis, so
// instead of checking sessions itself it trusts a ticket signed with a
// secret both sides share (RELAY_SECRET).
//
//   POST /api/relay { token } -> { url, ticket, exp }
//                             -> 404 { enabled:false } when the relay isn't
//                                configured, and the app simply records and
//                                uploads as it always has.
//
// A ticket is only issued to a logged-in, unblocked user with minutes
// left — the relay streams audio to Sarvam, which costs money, and this
// is the one place that knows who may spend it.

const crypto = require("crypto");
const { DECIMINUTES_PER_EXCHANGE, redisConfigured, getSession, getUser } = require("./_lib.js");

// Long enough to cover a conversation's worth of mic presses without a
// refetch on every one, short enough that a leaked ticket is soon useless.
const TICKET_TTL_MS = 5 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only." });

  const url = (process.env.RELAY_URL || "").trim();
  const secret = (process.env.RELAY_SECRET || "").trim();
  if (!url || !secret) return res.status(404).json({ enabled: false });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { body = {}; } }
  body = body || {};

  let phone = "anonymous";
  if (redisConfigured()) {
    const session = await getSession(body.token).catch(() => null);
    if (!session) return res.status(401).json({ error: "Please log in.", code: "LOGIN_REQUIRED" });
    const user = await getUser(session.phone);
    if (!user || user.blocked) return res.status(403).json({ error: "Not available for this account." });
    if ((user.deciminutes || 0) < DECIMINUTES_PER_EXCHANGE) {
      return res.status(402).json({ error: "Out of minutes.", code: "NO_MINUTES" });
    }
    phone = session.phone;
  }

  const exp = Date.now() + TICKET_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ phone, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ url, ticket: `${payload}.${sig}`, exp });
};
