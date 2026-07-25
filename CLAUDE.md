# BaatChiit.ai — project notes for Claude

Live any-to-any Indian language translator: two people share one phone (Host/Guest split screen, guest half rotated 180°), push-to-talk, auto language detect, subtitles with number chips, session history. Read README.md for deploy steps and model details.

## Stack (do not change without asking)

- Single-file vanilla-JS PWA: all UI + logic in `index.html` (no framework, no build step).
- One Vercel serverless function `api/pipeline.js`: Sarvam AI chain — STT `saaras:v3` (mode `transcribe`) → translate `mayura:v1` → TTS `bulbul:v3` (speaker `priya`). Key lives in Vercel env var `SARVAM_API_KEY`, never client-side.
- 11 languages only (the set mayura:v1 supports; picker + server both enforce it).
- Deploy: Vercel → then pwabuilder.com wraps the live URL into an Android APK.
- Demo mode was removed 2026-07-21 (user's call, after live mode was verified on-device). To check UI changes without an API key, use the phrase packs (fully offline) or a local static server; the live pipeline needs the deployed function.

## State as of 2026-07-25 (fifth session): full redesign to the Claude Design handoff

- **UI rebuilt to the design bundle** at `..\baatchiit-ai-translator-prototype\` (read its `project/Sarvam Translator.dc.html` for the reference): cream/saffron/gold/indigo palette, Baloo 2 + Manrope, seven screens — phone login → 4-digit OTP → "New conversation" setup (auto-detect card + manual chip picker) → split-screen chat FEED (bubbles, mine/theirs, secondary line in the other language, number chips) → wallet → payment → success. Guest half still rotated 180°.
- **Divya's scope decisions (2026-07-25)**: login-first (no anonymous mode); phrase packs + open-mic kept (phrases = 💬 in strip, open-mic = switch on setup screen); payments = wallet UI + real metering now, Razorpay checkout later (Pay button disabled until `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` env vars exist → `paymentsEnabled` flag from server); history = localStorage (`bc_history`, cap 30, auto-named from first exchange preview).
- **Metering live**: `api/_lib.js` (shared Redis/session helpers; underscore = not an endpoint), user record gains `deciminutes` (1 exchange = 1 deciminute = "1 min per 10 exchanges"), 15 welcome minutes on first login (existing users topped up once). pipeline.js requires session token → 401 `LOGIN_REQUIRED` / 402 `NO_MINUTES` (client opens wallet); charges only successful exchanges; returns `minutesLeft`. If Redis isn't configured pipeline still works unmetered.
- Packs (from design): ₹99/60 min, ₹249/180 min (popular), ₹599/500 min. Client-side list only; real order flow per PAYMENTS.md still to build.
- Tapping a received bubble replays its TTS. Manifest colors now cream/indigo → **regenerate the APK** at pwabuilder.com when convenient.
- **Auth rewritten to Dhruva's proven pattern (2026-07-25, after Divya corrected the reference)**: the real reference app is **Dhruva** (`C:\1 PROJECTS\Dhruva\app` — the CoachYaar-lineage study companion, live at dhruva-dev.vercel.app), NOT MissionFauj. Dhruva's MSG91 login works in production on Vercel: OTP widget runs headless in the browser (`exposeMethods: true`, poll until `window.sendOtp` exists, resend via `retryOtp("11")`), server only calls `verifyAccessToken` with `MSG91_AUTH_KEY` and derives the phone from the VALIDATED token (never the request body). BaatChiit's api/auth.js + index.html now mirror this (auth.js `config` action serves widget creds from env). Server-side widget calls (my earlier attempt, modeled on MissionFauj) are a known dead end — MSG91's anti-abuse blocks server IPs intermittently.
- **BLOCKER**: `MSG91_WIDGET_ID` + `MSG91_TOKEN_AUTH` still not set in Vercel (`MSG91_AUTH_KEY` already is). Values: Dhruva's Vercel project env, or MissionFauj's root `.env` (`VITE_MSG91_*`). Login-first means prod is unusable until added + OTP verified end-to-end. Widget refuses localhost — test on the deployed site.

## Previous state (2026-07-24, fourth session)

- **Live in production**: https://baatchiit.vercel.app (project `divya-puro-projects/baatchiit`, deployed via `vercel --prod` from this folder). `SARVAM_API_KEY` set for Production+Preview. Live mode verified end-to-end on Divya's Android phone.
- Two live-mode bugs were found on-device and fixed: Sarvam rejects mime types with codec params (server now strips `;codecs=…`), and the first-ever mic-permission prompt swallowed the push-to-talk hold (mic is now warmed up at page load).
- Features shipped: phrase packs (3 packs × 14 phrases, hardcoded in `PHRASE_PACKS`, Claude-authored translations — native check still wise), open-mic silence auto-stop (thresholds 0.035/0.02 in `startSilenceWatch`, verified working on-device), TTS replay button, bubble animations. Demo mode removed (see Stack note).
- **APK generated** via pwabuilder.com: `android-package/BaatChiit.ai.apk` (+ `.aab` for a future Play Store upload), package id `app.vercel.baatchiit.twa`. `/.well-known/assetlinks.json` is deployed and fingerprint-matched. `android-package/signing.keystore` is gitignored and exists ONLY on this PC — Divya was told to back it up; losing it breaks APK updates.
- sw.js is network-first for navigations (cache `baatchiit-v3`), so deploys show up without cache-version bumps; `/api/` never cached.
- **OTP login built this session** (Divya's picks: MSG91 SMS like MissionFauj, Upstash Redis via Vercel Marketplace, login optional-not-required): `api/auth.js` (send/verify/me/logout; MSG91 holds the OTP, Redis holds `session:<token>` 90-day TTL + `user:<phone>` with `plan` field, `otpreq:<phone>` threads the widget reqId) and an Account drawer in index.html (token in localStorage `bc_session`).
- **MSG91 gotcha (cost a debugging round here AND earlier in MissionFauj)**: this account uses MSG91's *OTP Widget* product (`/api/v5/widget/*`, `MSG91_WIDGET_ID`+`MSG91_TOKEN_AUTH`, reqId threads send→retry→verify). The classic `/api/v5/otp` authkey+template API **accepts sends with type:"success" but never delivers**. MissionFauj's `server/src/lib/msg91.ts` is the reference integration; auth.js mirrors it.
- **Payments: planned, not built** — see PAYMENTS.md (Razorpay; recommends one-time top-ups over subscriptions; usage metering in pipeline.js must come first; awaiting Divya's pricing/model decisions and Razorpay KYC).

## Remaining roadmap

- User setup for login (Upstash + MSG91 vars), then test the OTP flow on the deployed site.
- Payments per PAYMENTS.md, starting with usage metering.
- Regenerate the APK after any manifest change (not needed for pure code deploys — the TWA wraps the live URL).
- Still untested: iPhone audio/mp4 path.

## Context

- The user is Divya (divyanec@gmail.com). Related but separate project: MissionFauj (`C:\Users\MOBIUS\Downloads\MissionFauj`) — React/Capacitor app with MSG91 OTP login; earlier sessions there fought OTP integration bugs.
- Divya once described the desired stack as "same as dhruva" — no local project by that name; there IS a `dhruva-dev` project in their Vercel team (spotted in `vercel project ls`), never clarified. For auth/storage Divya explicitly chose MSG91 + Upstash (2026-07-24), so the question only matters if it resurfaces.
