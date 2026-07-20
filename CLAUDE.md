# BaatChiit.ai — project notes for Claude

Live any-to-any Indian language translator: two people share one phone (Host/Guest split screen, guest half rotated 180°), push-to-talk, auto language detect, subtitles with number chips, session history. Read README.md for deploy steps and model details.

## Stack (do not change without asking)

- Single-file vanilla-JS PWA: all UI + logic in `index.html` (no framework, no build step).
- One Vercel serverless function `api/pipeline.js`: Sarvam AI chain — STT `saaras:v3` (mode `transcribe`) → translate `mayura:v1` → TTS `bulbul:v3` (speaker `priya`). Key lives in Vercel env var `SARVAM_API_KEY`, never client-side.
- 11 languages only (the set mayura:v1 supports; picker + server both enforce it).
- Deploy: Vercel → then pwabuilder.com wraps the live URL into an Android APK.
- Demo mode is fully offline/scripted (Hindi↔Tamil negotiation, guest speaks first) — use it to verify UI changes without an API key.

## State as of 2026-07-20 (second session)

- Fixed earlier: `pipeline.js` moved from repo root into `api/` (Vercel only exposes functions under `/api`; the old layout 404'd `/api/pipeline`).
- **Built this session** (all verified in browser via local http-server + demo mode):
  - Phrase packs: 3 packs (Greetings/Bargaining/Help) × 14 phrases, hardcoded translations in all 11 languages in `PHRASE_PACKS` in index.html; drawer opens from strip, tap shows phrase on both halves in each side's language. Translations are Claude-authored — a native-speaker read-through wouldn't hurt, esp. Odia/Punjabi.
  - Open-mic mode: strip toggle; live-mode tap-to-talk with WebAudio RMS silence auto-stop (~1.5s quiet, thresholds 0.035/0.02 in `startSilenceWatch`). NOT yet tested with a real microphone — needs an on-device check.
  - Polish: bubble entrance animations, "Play again" replay button for received TTS, active-speaker half highlight, animated translating dots.
  - Fixed broken icon `<link>` paths (`/icons/…` → `/…`), manifest colors aligned to dark theme, sw.js cache bumped to v2 with `/api/` guard (old guard checked a Netlify path).
- Not yet deployed; no Vercel project linked. Vercel CLI installed globally. Remaining deploy steps are user-interactive: `vercel login`, `vercel`, `vercel env add SARVAM_API_KEY`, `vercel --prod`, then pwabuilder.com for the APK.

## Remaining roadmap

- **Accounts / payments** — blocked on a backend decision (nothing exists yet; user's MissionFauj project uses MSG91 OTP, ask before assuming that stack).
- On-device testing of open-mic thresholds and iPhone audio/mp4 path.

## Context

- The user is Divya (divyanec@gmail.com). Related but separate project: MissionFauj (`C:\Users\MOBIUS\Downloads\MissionFauj`) — React/Capacitor app with MSG91 OTP login; earlier sessions there fought OTP integration bugs.
- Divya once described the desired stack as "same as dhruva" — no local project by that name was found; unresolved. Current stack was kept. Ask what "dhruva" is if stack questions come up.
