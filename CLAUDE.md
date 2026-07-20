# BaatChiit.ai — project notes for Claude

Live any-to-any Indian language translator: two people share one phone (Host/Guest split screen, guest half rotated 180°), push-to-talk, auto language detect, subtitles with number chips, session history. Read README.md for deploy steps and model details.

## Stack (do not change without asking)

- Single-file vanilla-JS PWA: all UI + logic in `index.html` (no framework, no build step).
- One Vercel serverless function `api/pipeline.js`: Sarvam AI chain — STT `saaras:v3` (mode `transcribe`) → translate `mayura:v1` → TTS `bulbul:v3` (speaker `priya`). Key lives in Vercel env var `SARVAM_API_KEY`, never client-side.
- 11 languages only (the set mayura:v1 supports; picker + server both enforce it).
- Deploy: Vercel → then pwabuilder.com wraps the live URL into an Android APK.
- Demo mode is fully offline/scripted (Hindi↔Tamil negotiation, guest speaks first) — use it to verify UI changes without an API key.

## State as of 2026-07-20

- Fixed: `pipeline.js` moved from repo root into `api/` (Vercel only exposes functions under `/api`; the old layout 404'd `/api/pipeline`).
- Verified in browser: demo mode works both directions (guest Hindi → Tamil, host Tamil → Hindi), language chips lock, history logs.
- `netlify.toml` is leftover from an abandoned Netlify plan (hosting is Vercel); user hasn't confirmed deleting it.
- Not yet deployed; no Vercel project linked yet.

## Agreed next work (user said "all three")

1. **Deploy prep** — get it onto Vercel (user adds `SARVAM_API_KEY` themselves), then PWABuilder APK.
2. **Roadmap features** — accounts, phrase packs, open-mic mode (from README roadmap). Note: real accounts need a backend decision (nothing exists yet); phrase packs and open-mic can be client-side.
3. **UI polish.**

## Context

- The user is Divya (divyanec@gmail.com). Related but separate project: MissionFauj (`C:\Users\MOBIUS\Downloads\MissionFauj`) — React/Capacitor app with MSG91 OTP login; earlier sessions there fought OTP integration bugs.
- Divya once described the desired stack as "same as dhruva" — no local project by that name was found; unresolved. Current stack was kept. Ask what "dhruva" is if stack questions come up.
