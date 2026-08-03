# BaatChiit.ai — project notes for Claude

Live any-to-any Indian language translator: two people share one phone (Host/Guest split screen, guest half rotated 180°), push-to-talk, auto language detect, subtitles with number chips, session history. Read README.md for deploy steps and model details.

## Stack (do not change without asking)

- Single-file vanilla-JS PWA: all UI + logic in `index.html` (no framework, no build step).
- One Vercel serverless function `api/pipeline.js`: Sarvam AI chain — STT `saaras:v3` (mode `transcribe`) → translate `mayura:v1` → TTS `bulbul:v3` (speaker `priya`). Key lives in Vercel env var `SARVAM_API_KEY`, never client-side.
- 11 languages only (the set mayura:v1 supports; picker + server both enforce it), plus **Hinglish** as a 12th *conversation* language: app code `hi-Latn-IN`, sent to Sarvam as `hi-IN` with `mode:"code-mixed"` + `output_script:"roman"`. It is deliberately NOT a UI language (no Hinglish screens — `renderUiLangChips` filters to codes that exist in `UI_STRINGS`). Because Sarvam documents nothing about romanised text going into bulbul, pipeline.js translates twice in parallel for Hinglish — roman to read, Devanagari to speak — and returns `speechText` alongside `translatedText`. **Verified on-device 2026-08-03**: mayura:v1 does accept `output_script` + `code-mixed`, so the roman path is the live one and the Devanagari fallback in pipeline.js has not had to fire.
- **Sanskrit is not possible** as a conversation language and the answer won't change without a new voice model: saaras:v3 can *hear* it (`sa-IN`) and `sarvam-translate:v1` can translate it, but bulbul:v3 (TTS) is 11 languages only, so the app could never speak it. Don't re-research this; the blocker is TTS.
- Deploy: Vercel → then pwabuilder.com wraps the live URL into an Android APK.
- Demo mode was removed 2026-07-21 (user's call, after live mode was verified on-device). To check UI changes without an API key, use the phrase packs (fully offline) or a local static server; the live pipeline needs the deployed function.

## State as of 2026-07-28 (sixth session): login works, app localized, usage visible

- **Login verified end-to-end on-device.** The whole MSG91 saga is resolved — see the credentials section below, which is the single most useful thing in this file if auth ever breaks again.
- **Back key** (`index.html`): every forward move pushes a history entry, every back path calls `history.back()`, and one `popstate` handler renders. Sheets are one entry above the screen they cover and are mutually exclusive; login screens are *replaced* so back never lands on the OTP screen while signed in; back on the setup screen exits the app (normal Android behaviour).
- **In-app help**: 8 explanations shown as a 4-card first-run tour (`bc_tour_seen`) when the first conversation opens, and any time from the **?** button on the setup screen and the conversation strip.
- **Localized to all 11 languages**: a native-script picker on the welcome screen (`bc_ui_lang`) drives *every* screen — welcome, OTP, setup, wallet, payment, success, conversation statuses, sheets. ~1,240 strings in `UI_STRINGS` in index.html, all Claude-authored: **a native check is still outstanding, Odia/Punjabi and the payment wording especially.** The choice also pre-selects that language as the host's speaking language. Data that used to hold English labels (phrase packs, top-up packs, payment methods) now holds translation keys.
- **Mic labels**: "↑ Press and speak" under each mic in the chosen language, switching to tap wording when open-mic is on.
- **Pair pill is editable**: tapping "Auto-detecting…" opens a Set-languages sheet (You speak / They speak + back-to-auto-detect). Picking marks that side `manual` so detection stops overriding it; the pill then reads e.g. "Tamil ⇄ Hindi".
- **Language detection, for the record**: each side locks independently the first time *that side* speaks. Before anyone speaks there's no confirmed target, so the opening utterance now targets the owner's chosen UI language when the listener is the phone's owner; a stranger still defaults to English.
- **Usage monitoring**: `api/stats.js` → `/api/stats?key=<STATS_KEY>` (env var; absent = endpoint disabled, wrong = 404). Plain-language dashboard + `&format=json`. Fed by `recordActivity()` in `_lib.js`: `user.lastSeen`, `user.exchanges`, `dau:<yyyymmdd>` sets (35-day TTL), `stats:exchanges` counter — two extra Redis writes per exchange, wrapped so a stats failure can never break a translation. Phones masked to last 4. **Tracking starts 2026-07-28**, so older accounts show blank until their next translation.

## State as of 2026-07-25 (fifth session): full redesign to the Claude Design handoff

- **UI rebuilt to the design bundle** at `..\baatchiit-ai-translator-prototype\` (read its `project/Sarvam Translator.dc.html` for the reference): cream/saffron/gold/indigo palette, Baloo 2 + Manrope, seven screens — phone login → 4-digit OTP → "New conversation" setup (auto-detect card + manual chip picker) → split-screen chat FEED (bubbles, mine/theirs, secondary line in the other language, number chips) → wallet → payment → success. Guest half still rotated 180°.
- **Divya's scope decisions (2026-07-25)**: login-first (no anonymous mode); phrase packs + open-mic kept (phrases = 💬 in strip, open-mic = switch on setup screen); payments = wallet UI + real metering now, Razorpay checkout later (Pay button disabled until `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` env vars exist → `paymentsEnabled` flag from server); history = localStorage (`bc_history`, cap 30, auto-named from first exchange preview).
- **Metering live**: `api/_lib.js` (shared Redis/session helpers; underscore = not an endpoint), user record gains `deciminutes` (1 exchange = 1 deciminute = "1 min per 10 exchanges"), 15 welcome minutes on first login (existing users topped up once). pipeline.js requires session token → 401 `LOGIN_REQUIRED` / 402 `NO_MINUTES` (client opens wallet); charges only successful exchanges; returns `minutesLeft`. If Redis isn't configured pipeline still works unmetered.
- Packs (from design): ₹99/60 min, ₹249/180 min (popular), ₹599/500 min. Client-side list only; real order flow per PAYMENTS.md still to build.
- Tapping a received bubble replays its TTS. Manifest colors now cream/indigo → **regenerate the APK** at pwabuilder.com when convenient.
- **Auth rewritten to Dhruva's proven pattern (2026-07-25, after Divya corrected the reference)**: the real reference app is **Dhruva** (`C:\1 PROJECTS\Dhruva\app` — the CoachYaar-lineage study companion, live at dhruva-dev.vercel.app), NOT MissionFauj. Dhruva's MSG91 login works in production on Vercel: OTP widget runs headless in the browser (`exposeMethods: true`, poll until `window.sendOtp` exists, resend via `retryOtp("11")`), server only calls `verifyAccessToken` with `MSG91_AUTH_KEY` and derives the phone from the VALIDATED token (never the request body). BaatChiit's api/auth.js + index.html now mirror this (auth.js `config` action serves widget creds from env). Server-side widget calls (my earlier attempt, modeled on MissionFauj) are a known dead end — MSG91's anti-abuse blocks server IPs intermittently.
- **MSG91 credentials — the thing that cost most of 2026-07-27.** BaatChiit has its OWN widget (dashboard → widget "BaatChiit", companyId 546059, same account as Dhruva). Three distinct values, two of which look nearly identical:
  - `MSG91_WIDGET_ID` — 24-char hex, client-side, from Client Side Integration.
  - `MSG91_TOKEN_AUTH` — `546059T…P1`, **client-side widget token**, from the same page.
  - `MSG91_AUTH_KEY` — `546059A…P1`, **server-side account authkey**, from profile menu → Authkey (or the widget's Server Side Integration → Get Authkey). *Not* the tokenAuth — pasting tokenAuth here was the root cause of days of "AuthenticationFailure".
- **Diagnosing MSG91 without burning an SMS** — `POST control.msg91.com/api/v5/widget/verifyAccessToken` with a junk `access-token` and the authkey; the error code identifies the fault: **401** authkey missing/empty · **201** authkey not recognised (wrong value, e.g. tokenAuth pasted in) · **207** authkey malformed (a trailing space does this) · **701** authkey GOOD, only the token was junk · **703** OTP already verified (a repeat verify tap). `api/auth.js` now trims all three env values because a pasted space is indistinguishable from a wrong key. The same probe works against our own endpoint: `POST /api/auth {"action":"verify","accessToken":"x.y.z"}` then read the function log.
- **Also verified 2026-07-27**: the widget is NOT domain-restricted (Dhruva's widget booted fine from baatchiit.vercel.app), and `vercel env pull` writes the literal string `[SENSITIVE]` for protected vars — never "measure" a secret that way, it's an 11-char placeholder, not the value.
- Client-side widget failures are POSTed to `/api/auth {action:"clientlog"}` so they land in the Vercel function log (the widget runs in the browser; its errors are otherwise invisible).

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

- **Native review of the UI translations** (~1,240 Claude-authored strings) before any real marketing push.
- **Razorpay checkout** per PAYMENTS.md — metering, wallet and packs are live; only the order + verified webhook remain, blocked on Divya's KYC.
- **Regenerate the APK** at pwabuilder.com — the manifest colours changed in the redesign, so the installed app's splash/theme are stale. Pure code deploys need no regeneration (the TWA wraps the live URL).
- Rotate `MSG91_AUTH_KEY` and `STATS_KEY` when convenient — both passed through chat during setup.
- Still untested: iPhone audio/mp4 path.

## Context

- The user is Divya (divyanec@gmail.com). Related but separate project: MissionFauj (`C:\Users\MOBIUS\Downloads\MissionFauj`) — React/Capacitor app with MSG91 OTP login; earlier sessions there fought OTP integration bugs.
- Divya once described the desired stack as "same as dhruva" — no local project by that name; there IS a `dhruva-dev` project in their Vercel team (spotted in `vercel project ls`), never clarified. For auth/storage Divya explicitly chose MSG91 + Upstash (2026-07-24), so the question only matters if it resurfaces.
