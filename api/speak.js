// api/speak.js
//
// Text-to-speech on its own, so the conversation screen doesn't have to
// wait for audio before showing words.
//
//   POST /api/speak { token, text, langCode } -> { audioBase64 }
//
// The exchange was already charged by api/pipeline.js when it produced
// the translation; this endpoint only voices text that was just
// returned, so it does not touch the minutes balance. It still requires
// a valid session, so it can't be used as a free TTS service.

const { redisConfigured, getSession } = require("./_lib.js");

const SARVAM_BASE = "https://api.sarvam.ai";
const MAX_TEXT = 1000;

const SUPPORTED_LANGUAGES = new Set([
  "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN",
  "od-IN", "pa-IN", "ta-IN", "te-IN", "en-IN",
]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "This endpoint only accepts POST requests." });
  }

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "SARVAM_API_KEY is not set on the server." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ error: "Request body must be JSON." }); }
  }
  body = body || {};

  // Warm-up poke from the client — see api/pipeline.js.
  if (body.warmup) return res.status(200).json({ awake: true });

  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
  const langCode = body.langCode;
  if (!text) return res.status(400).json({ error: "Nothing to say." });
  if (!SUPPORTED_LANGUAGES.has(langCode)) return res.status(400).json({ error: "Unsupported language." });

  // Same login gate as the pipeline; unmetered when storage isn't set up,
  // matching how the pipeline behaves in that state.
  if (redisConfigured()) {
    const session = await getSession(body.token).catch(() => null);
    if (!session) return res.status(401).json({ error: "Please log in.", code: "LOGIN_REQUIRED" });
  }

  try {
    const started = Date.now();
    const response = await fetch(`${SARVAM_BASE}/text-to-speech`, {
      method: "POST",
      headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        target_language_code: langCode,
        model: "bulbul:v3",
        speaker: "priya",
        speech_sample_rate: 16000,   // speech is clear at 16k; the reply is
        // uncompressed WAV over base64, so this is ~27% less to download
      }),
    });

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch {
      throw new Error(`Text-to-speech returned something that wasn't JSON (status ${response.status}).`);
    }
    if (!response.ok) {
      const message = (data && data.error && (data.error.message || data.error)) || raw || "Unknown error";
      throw new Error(`Text-to-speech failed (HTTP ${response.status}): ${message}`);
    }

    console.log("speak timing(ms):", Date.now() - started);
    return res.status(200).json({ audioBase64: (data.audios && data.audios[0]) || null });
  } catch (err) {
    console.error("speak error:", err);
    // The words are already on screen, so a failure here is a missing
    // voice, not a failed translation — say so gently.
    return res.status(502).json({ error: err.message || "Couldn't produce the audio." });
  }
};
