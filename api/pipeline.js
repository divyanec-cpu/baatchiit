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

  const { audioBase64, mimeType, sourceLangHint, targetLangCode } = body;

  if (!audioBase64) {
    return res.status(400).json({ error: "Missing audioBase64 (the recorded clip, base64-encoded)." });
  }
  if (!targetLangCode || !SUPPORTED_LANGUAGES.has(targetLangCode)) {
    return res.status(400).json({
      error: `targetLangCode is required and must be one of: ${[...SUPPORTED_LANGUAGES].join(", ")}`,
    });
  }

  try {
    // ---------- Step 1: Speech to Text ----------
    const stt = await speechToText({ apiKey, audioBase64, mimeType, sourceLangHint });

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
    const translation = await translateText({
      apiKey,
      input: stt.transcript,
      sourceLangCode: sourceForTranslate,
      targetLangCode,
    });

    // ---------- Step 3: Text to Speech ----------
    const ttsAudioBase64 = await textToSpeech({
      apiKey,
      text: translation.translatedText,
      targetLangCode,
    });

    return res.status(200).json({
      transcript: stt.transcript,
      detectedLanguage: translation.sourceLangCode || detectedLang,
      translatedText: translation.translatedText,
      ttsAudioBase64,
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
  const isMp4 = mimeType && mimeType.includes("mp4");
  const fileName = isMp4 ? "speech.mp4" : "speech.webm";

  // Vercel's Node.js runtime is on Node 18+, which has FormData/Blob
  // built in globally -- no extra npm package needed just to build
  // this request.
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType || "audio/webm" }), fileName);
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
async function translateText({ apiKey, input, sourceLangCode, targetLangCode }) {
  const res = await fetch(`${SARVAM_BASE}/translate`, {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input,
      source_language_code: sourceLangCode,
      target_language_code: targetLangCode,
      model: "mayura:v1",
      mode: "modern-colloquial", // natural, casual phrasing -- fits a live conversation better than "formal"
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
      speech_sample_rate: 22050,
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
