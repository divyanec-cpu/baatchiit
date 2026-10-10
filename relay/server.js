// relay/server.js
//
// BaatChiit realtime speech relay — runs on Google Cloud Run in Mumbai
// (asia-south1, project baatchiit-app), next door to Sarvam's own API.
//
// Why it exists: Sarvam can transcribe WHILE someone is still talking
// (saaras realtime, a WebSocket). Vercel functions can't hold an inbound
// WebSocket, and the browser can't talk to Sarvam directly without
// exposing the API key. So the phone streams its microphone here, this
// streams it on to Sarvam with the key, and transcripts flow back.
//
// It does ONE thing — speech to text — and holds no state. Translation,
// metering and voice stay on Vercel; the phone hands the final transcript
// to /api/pipeline exactly as if it had come from an upload.
//
// Phone -> relay (WebSocket, subprotocols ["bc.v1", "t.<ticket>"]):
//   binary frames   raw 16-bit little-endian PCM, mono, 16kHz
//   {"type":"end"}  the speaker has finished (mic released / silence)
// Relay -> phone:
//   {"type":"ready"}                      Sarvam is connected
//   {"type":"partial","text":"…"}         words so far
//   {"type":"final","text":"…","language":"hi-IN"|null}
//   {"type":"error","message":"…"}
//
// The ticket is issued by Vercel's /api/relay to a logged-in user with
// minutes left: base64url(JSON{phone,exp}) + "." + HMAC-SHA256 under
// RELAY_SECRET, which both sides share. It rides in the subprotocol
// header rather than the URL so it never lands in request logs.

const http = require("http");
const crypto = require("crypto");
// ws for both directions: the upstream needs a custom auth header, which
// ws has always supported, whereas Node's built-in WebSocket only grew it
// recently — and Cloud Run's build picks the Node version, not us.
const { WebSocketServer, WebSocket: Upstream } = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const SARVAM_KEY = process.env.SARVAM_API_KEY;
const SECRET = process.env.RELAY_SECRET;
// Upstream host is configurable only so the relay can be tested against a
// local stand-in; production always uses Sarvam.
const SARVAM_WS = process.env.SARVAM_WS_BASE || "wss://api.sarvam.ai";

// Same cap as the phone's own recorder: Sarvam's sync STT took clips
// under 30s, and nobody holds a mic longer than that in conversation.
const MAX_SESSION_MS = 30000;
// After the speaker finishes, how long to wait for Sarvam's final before
// forcing it with a flush, then before giving up.
const FLUSH_AFTER_MS = 1500;
const GIVE_UP_AFTER_MS = 4000;

// The app's codes are not quite Sarvam realtime's: Odia is od-IN in the
// app (and in Sarvam's other APIs) but or-IN on this endpoint, and
// Hinglish is the app's own code for Hindi.
const TO_SARVAM = { "od-IN": "or-IN", "hi-Latn-IN": "hi-IN" };
const FROM_SARVAM = { "or-IN": "od-IN" };
const LANGS = new Set(["auto", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN",
  "or-IN", "pa-IN", "ta-IN", "te-IN", "en-IN"]);

function verifyTicket(ticket) {
  const [payload, sig] = String(ticket || "").split(".");
  if (!payload || !sig || !SECRET) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!data || typeof data.exp !== "number" || Date.now() > data.exp) return null;
  return data;
}

function ticketFrom(req) {
  const offered = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  const t = offered.find((p) => p.indexOf("t.") === 0);
  return t ? t.slice(2) : null;
}

// Plain HTTP: a health check the app pokes when a conversation opens, so
// a cold instance is already booting before anyone presses a mic.
// Not "/healthz": Cloud Run's front end swallows paths ending in "z" and
// answers with Google's own 404 before the request ever reaches us.
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(SARVAM_KEY && SECRET ? "ok" : "misconfigured");
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({
  server,
  path: "/stt",
  maxPayload: 64 * 1024,
  // The browser offers two subprotocols; the ticket one must never be
  // echoed back, only the version marker.
  handleProtocols: (protocols) => (protocols.has("bc.v1") ? "bc.v1" : false),
  verifyClient: (info, done) => {
    if (!SARVAM_KEY || !SECRET) return done(false, 503, "relay not configured");
    if (!verifyTicket(ticketFrom(info.req))) return done(false, 401, "bad or expired ticket");
    done(true);
  },
});

wss.on("connection", (phone, req) => {
  const user = verifyTicket(ticketFrom(req));   // already checked; re-read for logs
  const url = new URL(req.url, "http://relay");
  let lang = url.searchParams.get("lang") || "auto";
  lang = TO_SARVAM[lang] || lang;
  if (!LANGS.has(lang)) lang = "auto";

  const started = Date.now();
  let endedAt = null, finalSent = false, closed = false, bytesIn = 0;
  let pending = [];        // audio that arrived before Sarvam was ready
  let upstreamOpen = false;
  let flushTimer = null, giveUpTimer = null;

  const send = (obj) => { if (phone.readyState === 1) phone.send(JSON.stringify(obj)); };

  const qs = new URLSearchParams({
    language_code: lang,
    model: "saaras:v3-realtime",
    // "fast" trades a little accuracy for the earliest possible final,
    // which is the whole point of this server.
    stream_type: "fast",
    // We know exactly when a turn ends — the mic is released, or the
    // app's own silence detector fires — so Sarvam's VAD isn't asked to
    // guess, and can't split one sentence into two.
    endpointing: "manual",
    encoding: "linear16",
    sample_rate: "16000",
  });
  const upstream = new Upstream(`${SARVAM_WS}/speech-to-text-realtime/ws?${qs}`,
    { headers: { "api-subscription-key": SARVAM_KEY } });

  const toSarvam = (obj) => { if (upstream.readyState === 1) upstream.send(JSON.stringify(obj)); };
  const sendAudio = (buf) => toSarvam({ event: "audio_input", audio: buf.toString("base64") });

  const finish = (why) => {
    if (closed) return;
    closed = true;
    clearTimeout(flushTimer); clearTimeout(giveUpTimer); clearTimeout(capTimer);
    try { toSarvam({ event: "end" }); } catch {}
    try { upstream.close(); } catch {}
    try { phone.close(1000, "done"); } catch {}
    console.log(JSON.stringify({
      evt: "session", why, lang, user: user && String(user.phone).slice(-4),
      secs: Math.round((Date.now() - started) / 100) / 10,
      audioKB: Math.round(bytesIn / 1024),
      finalAfterEndMs: endedAt && finalSent ? finalSent - endedAt : null,
    }));
  };

  const capTimer = setTimeout(() => {
    send({ type: "error", message: "session too long" });
    finish("cap");
  }, MAX_SESSION_MS);

  upstream.addEventListener("open", () => {
    upstreamOpen = true;
    toSarvam({ event: "speech_start" });
    pending.forEach(sendAudio);
    pending = [];
    send({ type: "ready" });
    if (endedAt) toSarvam({ event: "speech_end" });   // they finished before we connected
  });

  upstream.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    // Field names checked against a live session; tolerate both spellings
    // of the event key in case the shape shifts.
    const kind = m.type || m.event;
    const d = m.data && typeof m.data === "object" ? m.data : m;
    const text = typeof d.text === "string" ? d.text : (typeof d.transcript === "string" ? d.transcript : "");
    if (kind === "transcript.partial") {
      send({ type: "partial", text });
    } else if (kind === "transcript.final") {
      if (finalSent) return;
      finalSent = Date.now();
      const language = d.language ? (FROM_SARVAM[d.language] || d.language) : null;
      send({ type: "final", text, language });
      finish("final");
    } else if (kind === "error") {
      console.error("sarvam error:", JSON.stringify(m).slice(0, 300));
      if (d.is_fatal !== false) { send({ type: "error", message: d.message || "speech service error" }); finish("upstream-error"); }
    }
  });

  upstream.addEventListener("close", (e) => {
    if (closed) return;
    if (!finalSent) send({ type: "error", message: `speech service closed (${e.code})` });
    finish("upstream-closed " + e.code);
  });
  upstream.addEventListener("error", () => {
    if (closed) return;
    send({ type: "error", message: "could not reach the speech service" });
    finish("upstream-error");
  });

  phone.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bytesIn += buf.length;
      if (upstreamOpen) sendAudio(buf); else pending.push(buf);
      return;
    }
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    if (m.type === "end" && !endedAt) {
      endedAt = Date.now();
      if (upstreamOpen) toSarvam({ event: "speech_end" });
      flushTimer = setTimeout(() => toSarvam({ event: "flush" }), FLUSH_AFTER_MS);
      giveUpTimer = setTimeout(() => {
        send({ type: "error", message: "no transcript in time" });
        finish("timeout");
      }, GIVE_UP_AFTER_MS);
    }
  });
  phone.on("close", () => finish("phone-closed"));
  phone.on("error", () => finish("phone-error"));
});

server.listen(PORT, () => console.log(`relay listening on ${PORT}`));

module.exports = { verifyTicket };
