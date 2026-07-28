# BaatChiit.ai — MVP

Live any-to-any Indian language translation between two people on one phone.
Phone-OTP login → conversation setup (auto-detect or manual languages) →
Host/Guest split-screen chat feed (guest half upside-down) · push-to-talk or
open-mic · number chips · minutes wallet · local history.

The UI follows the Claude Design handoff in
`..\baatchiit-ai-translator-prototype\` (cream/saffron/indigo, Baloo 2 +
Manrope, seven screens).

## What's in this folder

```
index.html            — the complete app (UI + logic, single file)
manifest.json, sw.js, icons — PWA installability (needed for the APK step)
api/pipeline.js        — serverless: Saaras STT → Mayura translate → Bulbul TTS, metered
api/auth.js            — serverless: phone-OTP login (MSG91 widget + Upstash Redis)
api/_lib.js            — shared Redis/session helpers (not an endpoint)
vercel.json             — Vercel config (function timeout)
package.json            — pins the Node version Vercel runs the function on
PAYMENTS.md             — Razorpay plan; metering + wallet UI are live, checkout isn't
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

## Phrase packs (works fully offline)

The 💬 icon in the conversation strip opens three packs — Greetings, Bargaining, Help — pre-translated into all 11 languages at build time (no API call, no minutes). Tapping a phrase drops it into *both* halves of the conversation feed, each in that side's current language with the English gloss beneath. The sheet previews each phrase in the guest's language.

## Open-mic mode

The **Open mic (hands-free)** switch on the "New conversation" screen changes hold-to-talk into tap-to-talk: tap once, and a WebAudio level watcher stops the recording after ~1.5s of silence (tap again to stop manually; the 25-second hard cap still applies). If WebAudio isn't available the watcher simply doesn't run and the manual stop paths still work. Silence thresholds live in `startSilenceWatch()` in index.html — worth a real-world check in a noisy market.

## History (on-device only)

The 🕐 icon opens past conversations — auto-named from the first thing said, with the language pair, date, and exchange count. Stored in this phone's localStorage (newest 30); nothing goes to a server.

## Accounts (phone-OTP login — required)

The app is login-first: 10-digit Indian mobile → 4-digit OTP by SMS → logged
in for 90 days. New accounts get 15 free minutes; each successful exchange
costs a tenth of a minute ("~1 minute per 10 exchanges"), and the wallet (₹
icon) shows the balance and top-up packs (payment itself launches later —
see PAYMENTS.md). Server side is `api/auth.js`; MSG91 generates and verifies
the OTP (this server never sees the code), Upstash Redis stores sessions,
user records, and minute balances.

One-time setup, both in the Vercel dashboard:

1. **Upstash Redis**: project → Storage → Marketplace → add Upstash Redis
   (free tier), connect it to this project. This injects the Redis env vars
   automatically (`KV_REST_API_URL`/`KV_REST_API_TOKEN`; a direct Upstash
   signup's `UPSTASH_REDIS_REST_*` names work too).
2. **MSG91** (three env vars): `MSG91_AUTH_KEY` (account authkey — used
   server-side to confirm access tokens), plus `MSG91_WIDGET_ID` and
   `MSG91_TOKEN_AUTH` (the OTP widget's credentials, served to the browser).
   The login flow is the one proven in production by Dhruva
   (`C:\1 PROJECTS\Dhruva\app`): the widget runs headless in the BROWSER
   (send/retry/verify + anti-abuse), and the server only verifies the
   resulting access token, deriving the phone from the validated token.
   Working widget values live in Dhruva's Vercel env or MissionFauj's
   `.env` (`VITE_MSG91_*`). Two gotchas inherited from Dhruva: hCaptcha
   must be disabled for exposeMethods mode in the MSG91 dashboard (already
   done if reusing the same widget), and the widget refuses localhost —
   test login on the deployed site only. Redeploy after adding vars.

Until both exist, the Login drawer shows a clear "isn't configured" error and
the rest of the app is unaffected.

## Monitoring usage

`/api/stats?key=<STATS_KEY>` serves a private dashboard: accounts total, new
this week, people active today and this week, translations ever, minutes used
and still owed, a 14-day bar chart of daily active users, and the newest
accounts (phone numbers masked to the last 4 digits). Add `&format=json` for
raw numbers.

`STATS_KEY` is a Vercel env var — any long random string. Without it the
endpoint disables itself, and a wrong key returns 404, so the page can't be
left open by accident. Rotate it by changing the env var and redeploying.

What it counts: logged-in activity only. Someone who opens the app and never
signs in doesn't appear (there's no analytics script). `lastSeen` and
per-user translation counts only exist from 2026-07-28 onward, so accounts
that used the app before then show blank until their next translation.

## How people get the app

Share **baatchiit.vercel.app** — that's the whole distribution story for
most users. Three routes, in the order to recommend them:

1. **Just use it in the browser.** Nothing to install; works on any phone.
2. **Install it from the browser.** The welcome screen shows an *Install
   app* button whenever Chrome offers installation (it appears only when
   the browser can actually do it, and vanishes once installed). Result
   is a home-screen icon, fullscreen, own splash — and it keeps updating
   itself on every deploy.
3. **Download the APK** from **baatchiit.vercel.app/download**, which
   also explains routes 1 and 2 in plain language. The APK is served with
   the right content-type so Android treats it as an installable package.
   It does **not** self-update: every rebuild has to be redistributed by
   hand, which is why the page steers people to the browser routes first.

Play Store is not set up. `android-package/BaatChiit.ai.aab` is signed
and ready to upload, but publishing needs a Play developer account ($25,
identity verification), a privacy-policy URL, and a data-safety
declaration covering the phone number and the voice audio. Note that
personal accounts opened since late 2023 must run a 14-day closed test
with 12 testers before production access — a company account avoids that.

## Rebuild the APK locally (Bubblewrap)

The APK is a thin TWA wrapper around the live URL, so **code and text
changes need no rebuild** — they arrive the next time the app opens. Only
`manifest.json` changes (splash colours, icons, name) require a new APK.

The rebuild must reuse `android-package/signing.keystore`, because Android
only installs an update signed with the same key, and
`/.well-known/assetlinks.json` pins that key's fingerprint. A fresh key
means users must uninstall first and the address bar reappears.

```bash
cd android-build                       # generated project, gitignored
export JAVA_HOME="C:/Program Files/Microsoft/jdk-17.0.19.10-hotspot"
export ANDROID_HOME="C:/Users/MOBIUS/android-sdk"
bubblewrap update --skipVersionUpgrade # re-reads twa-manifest.json
```

then build with Gradle from PowerShell (Bubblewrap's own `build` can't
find `gradlew.bat` when it is launched from Git Bash):

```bash
.\gradlew.bat assembleRelease --no-daemon
```

and sign with the existing key (passwords are in
`android-package/signing-key-info.txt`):

```bash
apksigner sign --ks android-package/signing.keystore --ks-key-alias baatchiit-key --out BaatChiit.ai.apk app/build/outputs/apk/release/app-release-unsigned.apk
```

Bump `appVersionCode` in `android-build/twa-manifest.json` for every
release — Android refuses an update whose versionCode isn't higher.
Afterwards **always** confirm the fingerprint still matches assetlinks:

```bash
keytool -printcert -jarfile BaatChiit.ai.apk
```

`android-build/` is gitignored: it is regenerated from
`twa-manifest.json`, which is the file worth keeping.

## Generate the APK (PWABuilder, the original route)

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
- **Everything else** (host/guest split screen, push-to-talk, language auto-detect + lock + override, subtitles with number chips, session-only history) is implemented as described below. (An offline scripted Demo mode existed pre-launch; it was removed once the live pipeline was verified working on-device.)

## Known MVP limits (by design)

- Session-only history — clears on refresh (this is the free-tier behaviour anyway).
- No accounts or payments yet — those need a backend decision (roadmap). Phrase packs and open-mic mode are in (see above).
- iOS Safari records audio/mp4 rather than webm; the function passes the mime type through, but test an iPhone once.
- A single push-to-talk clip auto-stops at 25 seconds. This isn't arbitrary: Sarvam's synchronous speech-to-text endpoint only accepts clips under 30 seconds, and Vercel caps a function's whole request body at 4.5MB — 25 seconds of compressed speech is nowhere near that, but a much longer hold could get there. If you need longer utterances later, that means Sarvam's batch STT API and chunked uploads, not this REST call.
