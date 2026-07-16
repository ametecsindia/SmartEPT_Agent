'use strict';
// SmartEPT Employee Agent — main process (Milestone M2 + R3-8 hardening).
// Visible, consent-based tracking: login -> consent -> live status, with idle/active-window
// tracking, attendance session events, heartbeat, and an offline-tolerant sync queue.
// R3-8: single-instance lock, tray + close-to-tray (closing the window no longer stops
// tracking or logs the employee out), autostart with Windows, DPAPI-encrypted tokens,
// HTTP (non-HTTPS) warning, queue-overflow counter reported on every heartbeat.

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// R3-8: exactly ONE agent per Windows session — a second launch just surfaces
// the existing window instead of double-tracking (or double-logging-in).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});

const cfg = require('./src/config');
const Store = require('./src/store');
const Api = require('./src/api');
const SyncEngine = require('./src/sync');
const { IdleMonitor, fmtDate } = require('./src/tracking/idle');
const { wireSessionEvents } = require('./src/tracking/session');
const { ScreenshotEngine } = require('./src/tracking/screenshot');
const { UsageTracker } = require('./src/tracking/usage');

let win = null;
let tray = null;
let trayCloseTipShown = false;
let presenceWin = null;
let store, api, sync, idle, shots, usage;
let policyBundle = null;
let tracking = false;
let activityBuffer = [];
let timers = [];
let lastSync = { online: false, pending: 0 };
let presenceCurrent = null; // { status, startedAt, meta }
let presenceFlushTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: false,
    title: 'SmartEPT Agent',
    backgroundColor: '#0E121A',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src/renderer/index.html'));

  // R3-8: closing the window HIDES to tray — tracking continues. (Before this,
  // the X button quit the app and silently ended the employee's attendance.)
  win.on('close', (e) => {
    if (app.isQuiting) return;
    e.preventDefault();
    win.hide();
    if (!trayCloseTipShown && Notification.isSupported()) {
      trayCloseTipShown = true;
      try {
        new Notification({
          title: 'SmartEPT keeps running',
          body: 'The agent is still tracking in the background. Find it in the tray near the clock.',
        }).show();
      } catch { /* notifications unavailable */ }
    }
  });
}

// R3-8: tray icon — the agent's permanent, visible home near the clock.
const TRAY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWUlEQVR4nGNkQAJ8Nf3/GYgAn1oKGWFsRlI0YjOIiRyNyIAR2faPzQVEaeKvnQBnU+wCig1gwSWB7EyyDMAWHtgMHfgwIMmAj80FGF4beC8MgryAzCEnOwMAbEAdHN+WjLIAAAAASUVORK5CYII='
);

function createTray() {
  if (tray) return;
  tray = new Tray(TRAY_ICON);
  tray.setToolTip('SmartEPT Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open SmartEPT Agent', click: () => { if (win) { win.show(); win.focus(); } } },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        // Deliberate exit stays possible (consent-based product) — but it is an
        // explicit tray action, never an accidental window close, and it books
        // the LOGOUT attendance event via before-quit.
        app.isQuiting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

function updateTray() {
  if (!tray) return;
  const pending = store ? store.pendingCount() : 0;
  tray.setToolTip('SmartEPT Agent — ' + (tracking ? 'tracking' : 'not tracking')
    + (pending ? ` · ${pending} events queued` : '')
    + (lastSync.online ? '' : ' · offline'));
}

// R3-8: warn (visibly, once per run) when the server connection is plain HTTP
// on a non-local address — monitoring data would travel unencrypted.
let httpWarned = false;
function isInsecureUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'http:') return false;
    const h = url.hostname;
    return !(h === 'localhost' || h === '127.0.0.1' || h.endsWith('.test')
      || h.startsWith('192.168.') || h.startsWith('10.') || h.endsWith('.local'));
  } catch { return false; }
}
function warnIfInsecure() {
  const url = store && store.get('server_url');
  if (!isInsecureUrl(url) || httpWarned) return;
  httpWarned = true;
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'SmartEPT — insecure connection',
        body: 'The server address uses http:// (not encrypted). Ask IT to switch it to https://.',
      }).show();
    }
  } catch { /* notifications unavailable */ }
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  // IT pre-provisioning: a server.json placed next to the executable (or in the
  // app folder for dev runs) pins the company's Admin Server URL so employees
  // never have to type it. Format: { "server_url": "https://ept.company.com" }
  let provisioned = null;
  for (const dir of [path.dirname(process.execPath), __dirname]) {
    try {
      const p = path.join(dir, 'server.json');
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j && j.server_url) { provisioned = String(j.server_url).trim(); break; }
      }
    } catch { /* malformed server.json is ignored */ }
  }
  if (provisioned) store.set('server_url', provisioned);
  if (!store.get('server_url')) store.set('server_url', cfg.DEFAULT_SERVER_URL);
  store.set('server_locked', !!provisioned);
  api = new Api(store);
  sync = new SyncEngine(store, api, { onState: (s) => { lastSync = s; pushState(); } });

  // Allow the hidden presence worker to use the webcam (local processing only).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media');
  });

  createWindow();
  createTray();

  // R3-8: start with Windows so monitoring begins at logon, not when someone
  // remembers to open the app. Packaged builds only (dev runs stay manual).
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch { /* not supported */ }
  }

  // Wire OS session events once; they only enqueue while tracking is on.
  wireSessionEvents(
    (att) => { if (tracking) enqueueAttendance(att); },
    { onIdlePause: () => idle && idle.pause(), onIdleResume: () => idle && idle.resume() }
  );
});

// R3-8: the agent lives in the tray — no window does NOT mean quit any more.
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', () => {
  if (tracking) {
    enqueueAttendance({ event_type: 'LOGOUT', occurred_at: fmtDate(new Date()) });
    flushActivity();
  }
});

// ---------------- IPC ----------------

ipcMain.handle('boot', () => ({
  server_url: store.get('server_url'),
  server_locked: !!store.get('server_locked'),
  device_uuid: store.deviceUuid(),
  has_session: !!store.get('device_token'),
  employee: store.get('employee'),
}));

// Cheap reachability probe so a typo in the Server URL is caught BEFORE sign-in.
ipcMain.handle('test-connection', async (_e, { server_url }) => {
  const base = String(server_url || store.get('server_url') || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'Enter the server URL first.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(base + '/api/ping', { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: 'Server responded HTTP ' + r.status + ' — is this the SmartEPT server?' };
    const j = await r.json().catch(() => null);
    if (!j || j.app !== 'SmartEPT') return { ok: false, error: 'Reached a server, but it is not SmartEPT.' };
    return { ok: true, app: j.app, version: j.version || null, server_time: j.server_time || null };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? 'No response after 6 seconds — check the address and network.' : ('Cannot reach server: ' + e.message) };
  }
});

ipcMain.handle('login', async (_e, { server_url, email, password }) => {
  try {
    if (server_url) store.set('server_url', server_url.trim());

    const loginRes = await api.login(email, password);
    store.set('user_token', loginRes.token);

    const reg = await api.registerDevice({
      device_uuid: store.deviceUuid(),
      computer_name: os.hostname(),
      os_version: `${os.type()} ${os.release()}`,
      windows_username: os.userInfo().username,
      ram_gb: Math.round(os.totalmem() / (1024 ** 3)),
    }, loginRes.token);

    store.set('device_token', reg.device_token);
    store.set('employee', reg.employee);

    policyBundle = await api.policy(store.deviceUuid());
    const consent = await api.consentStatus();

    return { ok: true, employee: reg.employee, policy: summarizePolicy(policyBundle), consent };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
});

ipcMain.handle('give-consent', async () => {
  try {
    const hash = crypto.createHash('sha256').update(JSON.stringify(policyBundle?.policies || {})).digest('hex');
    await api.giveConsent(store.deviceUuid(), hash);
    startTracking();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('start-tracking', async () => { startTracking(); return { ok: true }; });

ipcMain.handle('resume', async () => {
  // Called on app restart when a device session already exists on disk.
  if (!store.get('device_token')) return { ok: false, error: 'No stored session.' };
  try {
    policyBundle = await api.policy(store.deviceUuid());
    const consent = await api.consentStatus();
    if (!consent.consent_required || consent.has_consented) {
      startTracking();
    }
    return { ok: true, employee: store.get('employee'), policy: summarizePolicy(policyBundle), consent };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
});

ipcMain.handle('break', (_e, { action, break_type }) => {
  if (!tracking) return { ok: false };
  store.enqueue('POST', '/agent/break-event', {
    device_uuid: store.deviceUuid(), action, break_type: break_type || 'CUSTOM',
    source: 'MANUAL', occurred_at: fmtDate(new Date()),
  });
  sync.drain();
  return { ok: true };
});

ipcMain.handle('logout', async () => {
  enqueueAttendance({ event_type: 'LOGOUT', occurred_at: fmtDate(new Date()) });
  flushActivity();
  await sync.drain();
  stopTracking();
  store.clearSession();
  return { ok: true };
});

ipcMain.handle('state', () => buildState());

// ---------------- tracking ----------------

function startTracking() {
  if (tracking) return;
  const mon = policyBundle?.policies?.monitoring || {};
  const threshold = mon.idle_threshold_seconds || cfg.DEFAULT_IDLE_THRESHOLD;

  enqueueAttendance({ event_type: 'LOGIN', occurred_at: fmtDate(new Date()) });

  // M4: usage tracker + enforcement (fed by ACTIVE window stretches).
  const pols = policyBundle?.policies || {};
  usage = new UsageTracker({
    appPolicy: pols.application || {},
    sitePolicy: pols.website || {},
    onCompliance: handleCompliance,
  });

  idle = new IdleMonitor({
    thresholdSeconds: threshold,
    pollMs: cfg.IDLE_POLL_MS,
    onEvent: (ev) => {
      activityBuffer.push(ev);
      if (ev.event_type === 'ACTIVE' && usage) usage.ingestActive(ev);
    },
  });
  idle.start();

  // M3: screenshots (policy-gated) + local presence detection (metadata only).
  const summary = summarizePolicy(policyBundle);
  shots = new ScreenshotEngine({
    store, api,
    getContext: () => ({ active_app: idle?.current?.app || null, window_title: idle?.current?.title || null }),
  });
  shots.start(summary);

  if (summary.webcam_presence) startPresence();

  timers.push(setInterval(() => sendHeartbeat(), cfg.HEARTBEAT_MS));
  timers.push(setInterval(() => flushActivity(), cfg.ACTIVITY_FLUSH_MS));
  timers.push(setInterval(() => refreshToday(), cfg.TODAY_REFRESH_MS));

  sync.start(cfg.SYNC_MS);
  tracking = true;
  warnIfInsecure(); // R3-8
  sendHeartbeat();
  refreshToday();
  pushState();
}

function stopTracking() {
  tracking = false;
  timers.forEach(clearInterval);
  timers = [];
  if (idle) { idle.stop(); idle = null; }
  if (shots) { shots.stop(); shots = null; }
  usage = null;
  stopPresence();
  sync.stop();
  pushState();
}

// ---- presence worker ----

function startPresence() {
  if (presenceWin) return;
  presenceWin = new BrowserWindow({
    width: 320, height: 240, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-presence.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  presenceWin.loadFile(path.join(__dirname, 'src/renderer/presence.html'));
  presenceCurrent = null;
  // Flush the ongoing stretch every 5 minutes so presence data reaches the
  // server continuously (and survives a crash) instead of only at logout.
  presenceFlushTimer = setInterval(() => {
    if (!presenceCurrent) return;
    const { status, meta } = presenceCurrent;
    closePresenceStretch(new Date());
    presenceCurrent = { status, startedAt: new Date(), meta };
  }, 5 * 60 * 1000);
}

function stopPresence() {
  if (presenceFlushTimer) { clearInterval(presenceFlushTimer); presenceFlushTimer = null; }
  closePresenceStretch(new Date());
  if (presenceWin && !presenceWin.isDestroyed()) presenceWin.destroy();
  presenceWin = null;
}

// Merge identical statuses into one event; enqueue a presence-event when the status changes.
ipcMain.on('presence-status', (_e, payload) => {
  if (!tracking) return;
  const status = payload.status || 'UNKNOWN';
  if (presenceCurrent && presenceCurrent.status === status) {
    presenceCurrent.meta = payload; // keep latest metadata
    return;
  }
  closePresenceStretch(new Date());
  presenceCurrent = { status, startedAt: new Date(), meta: payload };
});

function closePresenceStretch(endedAt) {
  const c = presenceCurrent;
  presenceCurrent = null;
  if (!c) return;
  const duration = Math.max(0, Math.round((endedAt - c.startedAt) / 1000));
  store.enqueue('POST', '/agent/presence-event', {
    device_uuid: store.deviceUuid(),
    event_type: c.status,
    confidence_score: null,
    started_at: fmtDate(c.startedAt),
    ended_at: fmtDate(endedAt),
    duration_seconds: duration,
    metadata: {
      brightness: c.meta?.brightness ?? null,
      face_count: c.meta?.face_count ?? null,
      mode: c.meta?.mode ?? 'brightness',
    },
  });
  sync.drain();
}

function enqueueAttendance(att) {
  store.enqueue('POST', '/agent/attendance-event', { device_uuid: store.deviceUuid(), ...att });
  sync.drain();
}

function flushActivity() {
  if (idle) idle.flush();

  if (activityBuffer.length) {
    const events = activityBuffer.splice(0, activityBuffer.length);
    store.enqueue('POST', '/agent/activity-events', { device_uuid: store.deviceUuid(), events });
  }

  // M4: flush app/website usage batches (only for the streams the policy enables).
  if (usage) {
    const summary = summarizePolicy(policyBundle);
    const { apps, sites } = usage.flush();
    if (summary.app_usage && apps.length) {
      store.enqueue('POST', '/agent/app-usage', { device_uuid: store.deviceUuid(), events: apps });
    }
    if (summary.website_usage && sites.length) {
      store.enqueue('POST', '/agent/website-usage', { device_uuid: store.deviceUuid(), events: sites });
    }
  }

  sync.drain();
}

// M4: a blocked app/site was detected — warn the employee visibly, log the violation,
// and capture a screenshot when the policy asks for one.
function handleCompliance(ev) {
  const shot = policyBundle?.policies?.screenshot || {};
  const wantShot = (ev.event_category === 'APP' && shot.on_blocked_app)
    || (ev.event_category === 'WEBSITE' && shot.on_blocked_website);

  // Visible warning (not hidden).
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'SmartEPT — Policy alert',
        body: `${ev.event_type.replace(/_/g, ' ')}: ${ev.detected_value}`,
      }).show();
    }
  } catch { /* notifications unavailable */ }

  if (wantShot && shots) {
    shots.capture(ev.event_category === 'APP' ? 'BLOCKED_APP' : 'BLOCKED_SITE').catch(() => {});
  }

  store.enqueue('POST', '/agent/compliance-event', {
    device_uuid: store.deviceUuid(),
    event_type: ev.event_type,
    event_category: ev.event_category,
    severity: ev.severity || 'HIGH',
    description: 'Detected by SmartEPT agent',
    detected_value: ev.detected_value,
    expected_value: ev.expected_value,
    action_taken: wantShot ? 'WARNING_SHOWN_AND_SCREENSHOT' : 'WARNING_SHOWN',
    screenshot_captured: !!wantShot,
    started_at: ev.started_at,
  });
  sync.drain();
  if (win && !win.isDestroyed()) win.webContents.send('alert', { message: `${ev.event_type.replace(/_/g, ' ')}: ${ev.detected_value}` });
}

async function sendHeartbeat() {
  try {
    await api.heartbeat({
      device_uuid: store.deviceUuid(),
      status: idle ? (idle.state === 'ACTIVE' ? 'ONLINE' : idle.state) : 'ONLINE',
      app_version: app.getVersion(),
      sync_pending: store.pendingCount(),
      // R3-8: how many queued events were dropped by the 5000-event overflow cap
      // since install — a non-zero, growing number = data loss IT must know about.
      events_dropped: store.droppedCount(),
    });
    lastSync.online = true;
  } catch { lastSync.online = false; }
  pushState();
}

async function refreshToday() {
  try {
    const t = await api.today();
    if (win) win.webContents.send('today', t);
  } catch { /* offline */ }
}

// ---------------- state to UI ----------------

function summarizePolicy(bundle) {
  const p = bundle?.policies || {};
  return {
    name: 'Standard Office Monitoring',
    consent_required: !!bundle?.consent_required,
    tracking_enabled: !!(p.monitoring && p.monitoring.tracking_enabled),
    screenshot_enabled: !!(p.screenshot && p.screenshot.enabled),
    screenshot_interval_seconds: (p.screenshot && p.screenshot.interval_seconds) || 600,
    webcam_presence: !!(p.webcam && p.webcam.presence_enabled),
    app_usage: !!(p.monitoring && p.monitoring.app_usage_enabled),
    website_usage: !!(p.monitoring && p.monitoring.website_usage_enabled),
    idle_threshold_seconds: (p.monitoring && p.monitoring.idle_threshold_seconds) || cfg.DEFAULT_IDLE_THRESHOLD,
  };
}

function buildState() {
  return {
    tracking,
    state: idle ? idle.state : 'IDLE',
    online: lastSync.online,
    pending: store.pendingCount(),
    dropped: store.droppedCount(), // R3-8 queue-overflow counter
    insecure: isInsecureUrl(store.get('server_url')), // R3-8 http:// warning flag
    employee: store.get('employee'),
    policy: policyBundle ? summarizePolicy(policyBundle) : null,
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', buildState());
  updateTray();
}
