// api/speak.js
//
// Text-to-speech on its own, so the conversation screen doesn't have to
// wait for audio before showing words.
//
//   POST /api/speak { token, text, langCode, gender } -> { audioBase64 }
//
// gender is the SPEAKER's ("male" | "female", default female): their words
// come out in a voice that matches them. See VOICES in _lib.js.
//
// The exchange was already charged by api/pipeline.js when it produced
// the translation; this endpoint only voices text that was just
// returned, so it does not touch the minutes balance. It still requires
// a valid session, so it can't be used as a free TTS service.

const { redisConfigured, getSession, boostWavLoudness, createPcmBooster, voiceFor } = require("./_lib.js");

const SARVAM_BASE = "https://api.sarvam.ai";
const MAX_TEXT = 1000;

const SUPPORTED_LANGUAGES = new Set([
  "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN",
  "od-IN", "pa-IN", "ta-IN", "te-IN", "en-IN",
  "hi-Latn-IN", // Hinglish -- spoken as Hindi; see api/pipeline.js
]);

// The voice model only knows hi-IN. The pipeline sends Devanagari for a
// Hinglish listener, so only the code needs mapping here.
function sarvamLang(code) {
  return code === "hi-Latn-IN" ? "hi-IN" : code;
}

// ---------------------------------------------------------------------
// Streaming. The plain request below waits for Sarvam to synthesise the
// whole reply (~1.15s measured from Mumbai) before a byte comes back.
// Sarvam's WebSocket returns the first audio in ~0.2s and keeps going, so
// this relays it to the phone as it arrives: raw 16-bit PCM at 16kHz,
// boosted on the way through, played by the browser chunk by chunk.
//
//   POST /api/speak { token, text, langCode, stream: true }
//     -> 200 audio/L16 body, streamed; X-BC-Gain header for ?debug=1
//     -> 502 JSON if the voice failed before any audio was sent, so the
//        client can fall back to the plain request.
//
// PCM rather than MP3 (Sarvam's default) because the loudness boost has
// to see samples, and the boost is what makes the voice audible on an
// iPhone speaker. Sarvam's spec says the socket is MP3-only; it isn't —
// linear16 comes back as audio/pcm, verified 2026-10-10.
// ---------------------------------------------------------------------
function streamSpeech({ apiKey, text, langCode, speaker, req, res }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const booster = createPcmBooster();
    let firstAudioMs = null, bytesOut = 0, finished = false;

    const sock = new WebSocket("wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true",
      { headers: { "Api-Subscription-Key": apiKey } });

    const write = (buf) => {
      if (!buf || !buf.length || finished) return;
      if (!bytesOut) {
        // Headers go out with the first audio, by which point the gain is
        // known — so ?debug=1 can still report it.
        res.statusCode = 200;
        res.setHeader("Content-Type", "audio/L16; rate=16000; channels=1");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-BC-Gain", String(Math.round((booster.gain || 1) * 100) / 100));
        res.setHeader("X-BC-First-Ms", String(firstAudioMs));
      }
      bytesOut += buf.length;
      res.write(buf);
    };

    const finish = (error) => {
      if (finished) return;
      if (!error) write(booster.flush());
      finished = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      const total = Date.now() - started;
      if (bytesOut) {
        // Mid-stream failure: the audio already sent is still worth
        // hearing, so end cleanly rather than erroring.
        res.end();
        console.log("speak stream(ms): first", firstAudioMs, "total", total, "gain", booster.gain, error ? "ended early: " + error : "");
      } else {
        console.error("speak stream failed before any audio:", error);
        res.status(502).json({ error: error || "No audio came back." });
      }
      resolve();
    };

    const timer = setTimeout(() => finish("timed out"), 20000);
    // The phone gave up (navigated away, new utterance): stop paying for it.
    // Watch the RESPONSE, not the request — in current Node, req emits
    // "close" as soon as its body has been read, which would cancel every
    // stream before it started.
    res.on("close", () => { if (!finished) finish("client went away"); });

    sock.addEventListener("open", () => {
      sock.send(JSON.stringify({ type: "config", data: {
        language_code: sarvamLang(langCode),
        speaker,
        speech_sample_rate: 16000,
        output_audio_codec: "linear16",
      } }));
      sock.send(JSON.stringify({ type: "text", data: { text } }));
      sock.send(JSON.stringify({ type: "flush" }));
    });
    sock.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "audio" && m.data && m.data.audio) {
        if (firstAudioMs === null) firstAudioMs = Date.now() - started;
        write(booster.push(Buffer.from(m.data.audio, "base64")));
      } else if (m.type === "event" && m.data && m.data.event_type === "final") {
        finish();
      } else if (m.type === "error") {
        finish((m.data && m.data.message) || "voice error");
      }
    });
    sock.addEventListener("error", () => finish("socket error"));
    sock.addEventListener("close", () => finish(bytesOut ? null : "socket closed before any audio"));
  });
}

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

  const speaker = voiceFor(body.gender);
  if (body.stream === true) return streamSpeech({ apiKey, text, langCode, speaker, req, res });

  try {
    const started = Date.now();
    const response = await fetch(`${SARVAM_BASE}/text-to-speech`, {
      method: "POST",
      headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        target_language_code: sarvamLang(langCode),
        model: "bulbul:v3",
        speaker,
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

    const audio = (data.audios && data.audios[0]) || null;
    const boosted = audio ? boostWavLoudness(audio) : { base64: null, gain: 1 };
    console.log("speak timing(ms):", Date.now() - started, "gain:", boosted.gain, boosted.note || "");
    return res.status(200).json({
      audioBase64: boosted.base64,
      // Reported so ?debug=1 can show it: a gain near 1 would mean the
      // voice arrived loud and the quietness is somewhere else.
      gain: boosted.gain,
      srcPeak: boosted.peak ? Math.round(boosted.peak / 32767 * 100) : null,
      srcRms: boosted.rms == null ? null : boosted.rms,
    });
  } catch (err) {
    console.error("speak error:", err);
    // The words are already on screen, so a failure here is a missing
    // voice, not a failed translation — say so gently.
    return res.status(502).json({ error: err.message || "Couldn't produce the audio." });
  }
};
