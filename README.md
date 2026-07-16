# SmartEPT Employee Agent — Milestone M2

The visible, consent-based Windows employee client for SmartEPT (by **Ametecs**). Built on
Electron with **no native modules**, so `npm install && npm start` just works.

## What the agent does (M2 + M3)

- **Login → device registration → consent → live status.** The window stays visible the
  whole time; there is no hidden mode.
- **Attendance session events** — LOGIN/LOGOUT and OS LOCK/UNLOCK/suspend/resume.
- **Active / idle tracking** — OS idle timer (Electron `powerMonitor`) decides ACTIVE vs
  IDLE against the policy threshold; ACTIVE stretches are split per foreground app.
- **Active window / process** — captured via a short PowerShell call (no native deps).
- **Screenshots (M3)** — policy-gated screen capture via `desktopCapturer`, JPEG-compressed
  and uploaded on the policy interval; captures taken while offline are stashed and retried.
  Nothing is captured unless the server policy enables screenshots.
- **Webcam presence (M3)** — a hidden worker samples the webcam **locally** and reports only
  a status + numbers (brightness, face count). No video is recorded, streamed, or uploaded;
  photos are never sent unless a photo policy is explicitly enabled. Brightness-based
  detector ships by default; face-api can drop in later without changing the contract.
- **App & website usage + enforcement (M4)** — foreground-app usage and (best-effort from the
  browser window title) website usage are batched to the server, which categorises them.
  A blocked app or website raises a **visible warning** (system notification + in-app banner),
  logs a compliance event, and captures a screenshot when the policy asks for one. Accurate URL
  tracking needs the browser extension (enterprise phase); M4 matches on the window title.
- **Heartbeat** every 30s; **today** totals pulled from the server (source of truth).
- **Offline-tolerant sync** — events persist to a local JSON queue (screenshots to a pending
  folder) and drain automatically on reconnect; the pending count is shown in the UI.
- **Policy-obeying** — everything is gated by the server policy bundle and by recorded
  consent (the server rejects tracking/media until consent exists where policy requires it).

## Run (development)

```bash
cd agent
npm install
npm start
```

Sign in with a seeded employee (`priya.raman@ametecs.io` / `password`) and point the Server
URL at your Laragon backend (`http://smartept.test`). Or use the scripts in
`deployment/agent/` (`install.bat`, `run.bat`, `build.bat`).

## Layout

```
agent/
├── main.js                 Electron main: orchestrates tracking + sync + IPC
├── preload.js              contextBridge API for the renderer
└── src/
    ├── config.js           cadences + defaults
    ├── store.js            settings + offline JSON queue (stable device UUID)
    ├── api.js              backend HTTP client (global fetch)
    ├── sync.js             offline-tolerant sync engine
    ├── tracking/
    │   ├── idle.js         active/idle state machine (powerMonitor)
    │   ├── activeWindow.js foreground window/process (PowerShell)
    │   ├── session.js      lock/unlock/suspend → attendance events
    │   ├── screenshot.js   desktopCapturer screen capture + upload + offline retry
    │   └── usage.js        app/website usage batches + blocked-app/site enforcement
    └── renderer/
        ├── index.html/renderer.js   login / consent / live-status UI (Ametecs brand)
        └── presence.html/presence.js  hidden local webcam presence worker (metadata only)
   preload-presence.js      bridge for the presence worker (numbers only, never frames)
```

## Notes

- SQLite is the enterprise-grade local store; the MVP uses a JSON queue to keep installation
  frictionless. Encrypted local storage and screenshots/webcam arrive in later milestones.
- Requires the M2 backend endpoints: `register-device`, `policy`, `consent`, `heartbeat`,
  `attendance-event`, `activity-events`, `idle-event`, `break-event`, `today`.
