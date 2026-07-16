'use strict';
// Active/Idle state machine driven by the OS idle timer (Electron powerMonitor).
// Emits completed ACTIVE/IDLE stretches; ACTIVE stretches are also split when the
// foreground application changes, giving per-app active durations.

const { powerMonitor } = require('electron');
const { getActiveWindow } = require('./activeWindow');

class IdleMonitor {
  constructor({ thresholdSeconds, pollMs, onEvent }) {
    this.threshold = thresholdSeconds;
    this.pollMs = pollMs;
    this.onEvent = onEvent;
    this.current = null;   // { type, startedAt, app, title }
    this.state = 'ACTIVE';
    this._timer = null;
    this._paused = false;
  }

  setThreshold(sec) { if (sec) this.threshold = sec; }
  pause() { this._paused = true; }
  resume() { this._paused = false; }

  start() {
    this._open('ACTIVE', null, null);
    this._timer = setInterval(() => this._tick().catch(() => {}), this.pollMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._close(new Date());
  }

  async _tick() {
    if (this._paused) return;
    const idleSec = powerMonitor.getSystemIdleTime();
    const nextState = idleSec >= this.threshold ? 'IDLE' : 'ACTIVE';

    if (nextState !== this.state) {
      this._close(new Date());
      this.state = nextState;
      if (nextState === 'ACTIVE') {
        const w = await getActiveWindow();
        this._open('ACTIVE', w.app, w.title);
      } else {
        this._open('IDLE', null, null);
      }
      return;
    }

    // Still ACTIVE — split the stretch if the foreground app changed.
    if (this.state === 'ACTIVE') {
      const w = await getActiveWindow();
      if (this.current && (w.app || null) !== (this.current.app || null)) {
        this._close(new Date());
        this._open('ACTIVE', w.app, w.title);
      }
    }
  }

  _open(type, app, title) {
    this.current = { type, startedAt: new Date(), app, title };
  }

  _close(endedAt) {
    const c = this.current;
    if (!c) return;
    const duration = Math.max(0, Math.round((endedAt - c.startedAt) / 1000));
    this.current = null;
    if (duration <= 0) return;
    this.onEvent({
      event_type: c.type,
      started_at: fmt(c.startedAt),
      ended_at: fmt(endedAt),
      duration_seconds: duration,
      active_app: c.app,
      window_title: c.title,
      keyboard_activity: c.type === 'ACTIVE',
      mouse_activity: c.type === 'ACTIVE',
    });
  }

  // Force-close the current stretch so partial active time is reported ~once a minute.
  flush() {
    if (this.current) {
      const type = this.state;
      const app = this.current.app;
      const title = this.current.title;
      this._close(new Date());
      this._open(type, app, title);
    }
  }
}

function fmt(d) {
  // "YYYY-MM-DD HH:MM:SS" in local time, matching the API's expected format.
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = { IdleMonitor, fmtDate: fmt };
