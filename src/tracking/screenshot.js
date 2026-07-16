'use strict';
// Screenshot engine — captures the screen via Electron's desktopCapturer (no native deps),
// compresses to JPEG, and uploads per policy. Offline captures are written to a pending
// folder and retried, so nothing is lost.

const { desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { fmtDate } = require('./idle');

class ScreenshotEngine {
  constructor({ store, api, getContext }) {
    this.store = store;
    this.api = api;
    this.getContext = getContext || (() => ({ active_app: null, window_title: null }));
    this.pendingDir = path.join(store.dir, 'pending-shots');
    try { fs.mkdirSync(this.pendingDir, { recursive: true }); } catch {}
    this._timer = null;
    this._retryTimer = null;
  }

  start(policy) {
    if (!policy || !policy.screenshot_enabled) return;
    const intervalMs = Math.max(30, (policy.screenshot_interval_seconds || 600)) * 1000;
    this._timer = setInterval(() => this.capture('INTERVAL').catch(() => {}), intervalMs);
    this._retryTimer = setInterval(() => this.flushPending().catch(() => {}), 60_000);
    // A first capture shortly after start so the timeline is populated promptly.
    setTimeout(() => this.capture('INTERVAL').catch(() => {}), 8000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._retryTimer) clearInterval(this._retryTimer);
  }

  async _grabJpeg() {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    if (!sources.length) throw new Error('no screen source');
    // Quality ~60 keeps files small; the server compresses/optimises further if configured.
    return sources[0].thumbnail.toJPEG(60);
  }

  async capture(reason) {
    const ctx = this.getContext();
    let buf;
    try { buf = await this._grabJpeg(); } catch { return; }

    const fields = {
      device_uuid: this.store.deviceUuid(),
      captured_at: fmtDate(new Date()),
      active_app: ctx.active_app || null,
      window_title: ctx.window_title || null,
      trigger_reason: reason || 'INTERVAL',
    };

    try {
      await this.api.upload('/agent/screenshot-upload', buf, fields);
    } catch (e) {
      // Policy off or permanent client error → drop silently; otherwise stash for retry.
      if (e.status && e.status < 500 && e.code !== 'CONSENT_REQUIRED') return;
      this._stash(buf, fields);
    }
  }

  _stash(buf, fields) {
    try {
      const base = path.join(this.pendingDir, `${Date.now()}-${Math.round(Math.random() * 1e6)}`);
      fs.writeFileSync(base + '.jpg', buf);
      fs.writeFileSync(base + '.json', JSON.stringify(fields));
    } catch {}
  }

  async flushPending() {
    let files;
    try { files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith('.jpg')); } catch { return; }
    for (const jpg of files) {
      const base = path.join(this.pendingDir, jpg.replace(/\.jpg$/, ''));
      try {
        const buf = fs.readFileSync(base + '.jpg');
        const fields = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
        await this.api.upload('/agent/screenshot-upload', buf, fields);
        fs.unlinkSync(base + '.jpg');
        try { fs.unlinkSync(base + '.json'); } catch {}
      } catch (e) {
        if (e.status && e.status < 500 && e.code !== 'CONSENT_REQUIRED') {
          try { fs.unlinkSync(base + '.jpg'); fs.unlinkSync(base + '.json'); } catch {}
        }
        return; // stop on first network failure; retry next tick
      }
    }
  }

  pendingCount() {
    try { return fs.readdirSync(this.pendingDir).filter((f) => f.endsWith('.jpg')).length; }
    catch { return 0; }
  }
}

module.exports = { ScreenshotEngine };
