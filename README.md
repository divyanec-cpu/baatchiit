# BaatChiit.ai — MVP

Live any-to-any Indian language translation between two people on one phone.
Host/Guest split screen · push-to-talk · auto language detect · subtitles with number chips · session history.

## What's in this folder

```
index.html            — the complete app (UI + logic, single file)
manifest.json, sw.js, icons — PWA installability (needed for the APK step)
api/pipeline.js        — serverless function: Saaras STT → Mayura translate → Bulbul TTS
vercel.json             — Vercel config (function timeout)
package.json            — pins the Node version Vercel runs the function on
```

## Deploy (10 minutes)

**Option A — GitHub (no local tools needed):**
1. Push this folder to a GitHub repo.
2. Go to **vercel.com → Add New… → Project** → import that repo. Vercel auto-detects this as a static site + serverless function ("Other" framework preset) — no build command needed.
3. Before the first deploy finishes (or right after, then redeploy): **Project Settings → Environment Variables** → add `SARVAM_API_KEY` = your Sarvam API key (from dashboard.sarvam.ai). Environment variables only apply to deployments made *after* they're saved, so redeploy if you added it late.
4. Deploy. Open the `*.vercel.app` URL on your phone — HTTPS is automatic, which the microphone requires.

**Option B — Vercel CLI (no GitHub needed):**
1. `npm install -g vercel`, then from inside this folder: `vercel login` then `vercel`.
2. Follow the prompts (defaults are fine — it'll detect the project automatically).
3. Add the API key once, from the same folder: `vercel env add SARVAM_API_KEY`, paste your key when asked.
4. `vercel --prod` to ship it to your permanent URL.

## Try it before wiring the API

Tap **Demo** in the top bar — the app fakes a Hindi↔Tamil price negotiation with no API calls, so you can feel the full UI flow (including number chips) immediately.

## Generate the APK

1. With the Vercel deployment live, go to **pwabuilder.com**, paste your site URL.
2. It validates the manifest/service worker (already included here) and generates an **Android package (APK/AAB)**.
3. Download, install on your phone (allow unknown sources), grant microphone permission on first use.

This is the same wrap-the-web-app route as a Lovable→APK flow — the web app *is* the app; the APK is a thin shell.

## Before field trials — verify against current Sarvam docs

Model names and endpoints evolve. In `api/pipeline.js`, confirm:
- STT model (`saarika:v2.5`) and the auto-detect behaviour of `language_code: "unknown"`
- Translate: `mayura:v1` + `mode: "modern-colloquial"` + `numerals_format` (drives the digits-only rule)
- TTS: `bulbul:v3` and the valid speaker list per language (currently set to `priya` everywhere)

## How direction logic works

- Whoever holds the mic is the **source**; the **other side's** language is the target.
- Both sides start on Auto-detect. The first time a side speaks, Saarika's language ID locks that side's language (shown as "Tamil detected" etc.).
- Host can tap either language tag to override — that override is also sent as a hint to STT.
- If the Guest speaks first and Host is still on auto, translation falls back to English until the Host speaks once or sets a language.

## Build notes (what's actually implemented)

- **Hosting:** deployed on Vercel, not Netlify. The serverless function lives at `api/pipeline.js` (Vercel treats any file under `/api` as an endpoint automatically) and the browser calls it at `/api/pipeline`.
- **Model versions:** Sarvam's docs now flag `saarika:v2.5` as being deprecated. `api/pipeline.js` uses `saaras:v3` with `mode: "transcribe"` for speech-to-text instead — same job (transcript in the speaker's own language + detected language code), current model. Translate (`mayura:v1`) and TTS (`bulbul:v3`, speaker `priya`) match the original plan.
- **Language list:** the app's language picker is limited to the 11 languages that `mayura:v1` (translate) supports — Hindi, Bengali, Gujarati, Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil, Telugu, English — since those are also the ones STT and TTS support in common, so every pairing works end to end.
- **Everything else** (host/guest split screen, push-to-talk, language auto-detect + lock + override, subtitles with number chips, session-only history, Demo mode with a Hindi↔Tamil negotiation) is implemented as described below.

## Known MVP limits (by design)

- Session-only history — clears on refresh (this is the free-tier behaviour anyway).
- No accounts, payments, phrase packs, open-mic, or offline mode yet — all roadmap.
- iOS Safari records audio/mp4 rather than webm; the function passes the mime type through, but test an iPhone once.
- A single push-to-talk clip auto-stops at 25 seconds. This isn't arbitrary: Sarvam's synchronous speech-to-text endpoint only accepts clips under 30 seconds, and Vercel caps a function's whole request body at 4.5MB — 25 seconds of compressed speech is nowhere near that, but a much longer hold could get there. If you need longer utterances later, that means Sarvam's batch STT API and chunked uploads, not this REST call.
