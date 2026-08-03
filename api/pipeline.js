// api/pipeline.js
//
// This file runs on Vercel's servers, NOT in the browser. That matters
// for one big reason: it's the only place your Sarvam API key is allowed
// to live. If we called Sarvam directly from index.html, anyone could
// open the browser dev tools and steal the key. So instead, the browser
// sends audio HERE, and this function does the talking to Sarvam.
//
// Anything in this project's /api folder automatically becomes a
// serverless endpoint on Vercel: this file is served at /api/pipeline.
//
// The trip has 3 steps, chained together:
//   1. Speech-to-Text  (model: saaras:v3)  audio  ->  text, in the
//      speaker's own language
//   2. Translate        (model: mayura:v1) text   ->  text, in the
//      other person's language
//   3. Text-to-Speech   (model: bulbul:v3) text   ->  audio, so the
//      other person can just listen instead of reading
//
// NOTE ON MODEL VERSIONS: the project README originally mentioned
// "saarika:v2.5" for step 1. Sarvam's docs (docs.sarvam.ai) now say
// saarika:v2.5 is being deprecated and point new integrations to
// "saaras:v3" with mode="transcribe" instead, so that's what's used
// below. Sarvam's docs can change the endpoint shapes over time --
// if this function starts failing, that's the first thing to re-check
// (see the README's "Before field trials" section).
//
// NOTE ON VERCEL LIMITS: Vercel caps a Function's request body at
// 4.5 MB (see vercel.com/docs/functions/limitations). A push-to-talk
// clip of a few seconds is only tens of KB, so this is comfortably
// under that -- but index.html also auto-stops recording after 25
// seconds as a safety net, partly for this reason and partly because
// Sarvam's synchronous speech-to-text endpoint itself only accepts
// clips under 30 seconds.

const SARVAM_BASE = "https://api.sarvam.ai";

const { DECIMINUTES_PER_EXCHANGE, redisConfigured, getSession, getUser, saveUser, recordActivity } = require("./_lib.js");

// Hinglish is not a language Sarvam knows -- it's Hindi asked for in a
// particular shape: English words left where people actually say them
// (mode "code-mixed") and written in Latin letters (output_script
// "roman"). The app carries it as its own code so it can be picked like
// any other language; everything sent to Sarvam is still hi-IN.
const HINGLISH = "hi-Latn-IN";
function sarvamLang(code) {
  return code === HINGLISH ? "hi-IN" : code;
}

// These 11 codes are the ones Sarvam's translation model (mayura:v1)
// supports today, and every one of them also works with the
// speech-to-text and text-to-speech models used below -- so the app's
// language picker is limited to exactly this list.
const SUPPORTED_LANGUAGES = new Set([
  "hi-IN", // Hindi
  "bn-IN", // Bengali
  "gu-IN", // Gujarati
  "kn-IN", // Kannada
  "ml-IN", // Malayalam
  "mr-IN", // Marathi
  "od-IN", // Odia
  "pa-IN", // Punjabi
  "ta-IN", // Tamil
  "te-IN", // Telugu
  "en-IN", // English
  HINGLISH, // Hinglish -- see below; not a Sarvam language code
]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "This endpoint only accepts POST requests." });
  }

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "SARVAM_API_KEY is not set on the server. In Vercel: Project Settings -> Environment Variables -> add SARVAM_API_KEY, then redeploy.",
    });
  }

  // Vercel's Node.js runtime parses a JSON request body for you, so
  // req.body is normally already an object -- but we fall back to
  // parsing it ourselves just in case it arrives as a raw string.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      return res.status(400).json({ error: "Request body must be JSON." });
    }
  }
  body = body || {};

  // The client pokes this when a conversation opens so the function is
  // already booted by the time someone speaks. Answer immediately, before
  // any auth or storage work.
  if (body.warmup) return res.status(200).json({ awake: true });

  const { audioBase64, mimeType, sourceLangHint, targetLangCode, token } = body;
  // Older clients don't send the flag and still expect audio inline.
  const wantAudio = body.wantAudio !== false;

  // ---------- Metering gate (login-first + minutes wallet) ----------
  // Every successful exchange costs 1 deciminute ("~1 minute per 10
  // exchanges", as the wallet screen says). If Redis isn't configured
  // (fresh clone, no Marketplace install yet) translation still works,
  // unmetered -- the pipeline shouldn't be dead in that state.
  let user = null;
  if (redisConfigured()) {
    const session = await getSession(token).catch(() => null);
    if (!session) {
      return res.status(401).json({ error: "Please log in to translate.", code: "LOGIN_REQUIRED" });
    }
    user = await getUser(session.phone);
    if (user && user.blocked) {
      return res.status(403).json({ error: "This account has been paused. Please get in touch.", code: "ACCOUNT_BLOCKED" });
    }
    if (!user || (user.deciminutes || 0) < DECIMINUTES_PER_EXCHANGE) {
      return res.status(402).json({ error: "You're out of minutes. Top up to keep translating.", code: "NO_MINUTES" });
    }
  }

  if (!audioBase64) {
    return res.status(400).json({ error: "Missing audioBase64 (the recorded clip, base64-encoded)." });
  }
  if (!targetLangCode || !SUPPORTED_LANGUAGES.has(targetLangCode)) {
    return res.status(400).json({
      error: `targetLangCode is required and must be one of: ${[...SUPPORTED_LANGUAGES].join(", ")}`,
    });
  }

  // Timings are logged per stage: with three Sarvam calls chained, the
  // only way to know which one is slow is to measure each.
  const t0 = Date.now();
  const timings = {};

  try {
    // ---------- Step 1: Speech to Text ----------
    const stt = await speechToText({ apiKey, audioBase64, mimeType, sourceLangHint: sarvamLang(sourceLangHint) });
    timings.stt = Date.now() - t0;

    if (!stt.transcript || !stt.transcript.trim()) {
      // Nothing understandable was said (silence, noise, a very short tap).
      // This isn't an error -- just tell the browser there's nothing to show.
      return res.status(200).json({
        transcript: "",
        detectedLanguage: stt.languageCode || null,
        translatedText: "",
        ttsAudioBase64: null,
        note: "No speech was detected in that recording.",
      });
    }

    // The language to translate FROM: whatever Saaras detected. If
    // detection came back empty, fall back to the hint the browser sent
    // (e.g. a language the person had already locked in), or "auto" as
    // a last resort so the translate step can take its own guess.
    const detectedLang = stt.languageCode || sourceLangHint || "auto";
    const sourceForTranslate = detectedLang === "unknown" ? "auto" : detectedLang;

    // ---------- Step 2: Translate ----------
    const tTranslate = Date.now();
    let translation;
    let speechText;

    if (targetLangCode === HINGLISH) {
      // The same sentence twice: Latin letters to read, Devanagari to
      // speak. Sarvam documents no behaviour for feeding romanised text
      // to the voice model, and a mispronounced reply is worse than
      // none. Both calls go out together, so this costs a request but no
      // extra waiting.
      const [roman, native] = await Promise.all([
        translateText({
          apiKey,
          input: stt.transcript,
          sourceLangCode: sourceForTranslate,
          targetLangCode,
          outputScript: "roman",
        }).catch((err) => {
          // Losing the Latin letters is a disappointment; losing the
          // conversation is a failure. Fall back to Devanagari.
          console.error("Hinglish translate (roman) failed:", err.message);
          return null;
        }),
        translateText({
          apiKey,
          input: stt.transcript,
          sourceLangCode: sourceForTranslate,
          targetLangCode,
          outputScript: null,
        }),
      ]);
      translation = roman || native;
      speechText = native.translatedText;
    } else {
      translation = await translateText({
        apiKey,
        input: stt.transcript,
        sourceLangCode: sourceForTranslate,
        targetLangCode,
      });
      speechText = translation.translatedText;
    }
    timings.translate = Date.now() - tTranslate;

    // ---------- Step 3: Text to Speech ----------
    // Skippable: the client asks for the words first so the other person
    // can start reading, then fetches the audio from /api/speak. Waiting
    // for speech synthesis before showing anything was a large part of
    // the delay people noticed.
    let ttsAudioBase64 = null;
    if (wantAudio) {
      const tTts = Date.now();
      ttsAudioBase64 = await textToSpeech({
        apiKey,
        text: speechText,
        targetLangCode: sarvamLang(targetLangCode),
      });
      timings.tts = Date.now() - tTts;
    }

    // Charge only for exchanges that actually produced a translation.
    let minutesLeft = null;
    if (user) {
      user.deciminutes = Math.max(0, (user.deciminutes || 0) - DECIMINUTES_PER_EXCHANGE);
      user.lastSeen = Date.now();
      user.exchanges = (user.exchanges || 0) + 1;
      await saveUser(user);
      await recordActivity(user.phone, translation.sourceLangCode || detectedLang, targetLangCode);
      minutesLeft = Math.floor(user.deciminutes / 10);
    }

    timings.total = Date.now() - t0;
    console.log("pipeline timings(ms):", JSON.stringify(timings));

    return res.status(200).json({
      transcript: stt.transcript,
      detectedLanguage: translation.sourceLangCode || detectedLang,
      translatedText: translation.translatedText,
      // The client asks /api/speak for the audio separately, so it needs
      // to know which words to have spoken.
      speechText,
      ttsAudioBase64,
      minutesLeft,
      timings,
    });
  } catch (err) {
    console.error("pipeline error:", err);
    return res.status(502).json({ error: err.message || "The Sarvam pipeline failed." });
  }
};

// ---------------------------------------------------------------------
// Step 1: Speech to Text  --  POST https://api.sarvam.ai/speech-to-text
// ---------------------------------------------------------------------
async function speechToText({ apiKey, audioBase64, mimeType, sourceLangHint }) {
  const audioBuffer = Buffer.from(audioBase64, "base64");

  // Sarvam validates the file's Content-Type as an exact string against
  // an allow-list of bare mime types (e.g. "audio/webm"). Browsers'
  // MediaRecorder.mimeType always includes a codec parameter (e.g.
  // "audio/webm;codecs=opus"), which isn't on that list and gets
  // rejected outright -- strip everything from the first ";" on.
  const baseMimeType = (mimeType || "audio/webm").split(";")[0].trim();
  const isMp4 = baseMimeType.includes("mp4");
  const fileName = isMp4 ? "speech.mp4" : "speech.webm";

  // Vercel's Node.js runtime is on Node 18+, which has FormData/Blob
  // built in globally -- no extra npm package needed just to build
  // this request.
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: baseMimeType }), fileName);
  form.append("model", "saaras:v3");
  form.append("mode", "transcribe"); // transcribe in the speaker's OWN language (not translate-to-English)
  form.append("language_code", sourceLangHint || "unknown"); // "unknown" = auto-detect

  const res = await fetch(`${SARVAM_BASE}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey },
    body: form,
  });

  const data = await parseJsonOrThrow(res, "Speech-to-text");
  return { transcript: data.transcript, languageCode: data.language_code };
}

// ---------------------------------------------------------------------
// Step 2: Translate  --  POST https://api.sarvam.ai/translate
// ---------------------------------------------------------------------
async function translateText({ apiKey, input, sourceLangCode, targetLangCode, outputScript }) {
  const res = await fetch(`${SARVAM_BASE}/translate`, {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input,
      source_language_code: sarvamLang(sourceLangCode),
      target_language_code: sarvamLang(targetLangCode),
      model: "mayura:v1",
      // "code-mixed" keeps the English words Hinglish speakers actually
      // use; everyone else gets natural casual phrasing, which fits a
      // live conversation better than "formal".
      mode: targetLangCode === HINGLISH ? "code-mixed" : "modern-colloquial",
      ...(outputScript ? { output_script: outputScript } : {}),
      numerals_format: "international", // plain 0-9 digits, so the app's on-screen "number chips" can spot them
    }),
  });

  const data = await parseJsonOrThrow(res, "Translate");
  return { translatedText: data.translated_text, sourceLangCode: data.source_language_code };
}

// ---------------------------------------------------------------------
// Step 3: Text to Speech  --  POST https://api.sarvam.ai/text-to-speech
// ---------------------------------------------------------------------
async function textToSpeech({ apiKey, text, targetLangCode }) {
  const res = await fetch(`${SARVAM_BASE}/text-to-speech`, {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      target_language_code: targetLangCode,
      model: "bulbul:v3",
      speaker: "priya",
      speech_sample_rate: 16000,   // speech is clear at 16k; the reply is
        // uncompressed WAV over base64, so this is ~27% less to download
    }),
  });

  const data = await parseJsonOrThrow(res, "Text-to-speech");
  return data.audios && data.audios[0] ? data.audios[0] : null;
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
async function parseJsonOrThrow(res, stepName) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `${stepName} step returned something that wasn't JSON (status ${res.status}). Double-check SARVAM_API_KEY and that your Sarvam plan has this API enabled.`
    );
  }
  if (!res.ok) {
    const message = (data && data.error && (data.error.message || data.error)) || text || "Unknown error";
    throw new Error(`${stepName} step failed (HTTP ${res.status}): ${message}`);
  }
  return data;
}
