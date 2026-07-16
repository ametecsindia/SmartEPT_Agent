'use strict';
// Lightweight local store: settings + an offline event queue, persisted as JSON in the
// Electron userData directory. No native modules — keeps `npm install` friction-free.
// (SQLite is the enterprise-grade path; JSON is the reliable MVP path.)
//
// R3-8 hardening:
//  - device_token / user_token are encrypted at rest with Electron safeStorage
//    (Windows DPAPI — only this Windows user on this PC can decrypt). Existing
//    plaintext tokens are migrated to encrypted form on first run.
//  - The 5000-event overflow cap now COUNTS what it drops (dropped_events),
//    so silent data loss becomes a visible, reportable number.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Loaded lazily so this module stays requireable outside Electron (e.g. lint/tests).
let safeStorage = null;
try { safeStorage = require('electron').safeStorage; } catch { /* non-Electron context */ }

const SECRET_KEYS = new Set(['device_token', 'user_token']);
const ENC_PREFIX = 'enc:v1:';

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.settingsPath = path.join(this.dir, 'settings.json');
    this.queuePath = path.join(this.dir, 'queue.json');
    this._settings = this._read(this.settingsPath, {});
    this._queue = this._read(this.queuePath, []);

    // Stable device UUID, generated once per install.
    if (!this._settings.device_uuid) {
      this._settings.device_uuid = 'DEV-' + crypto.randomUUID().toUpperCase();
      this._saveSettings();
    }

    // R3-8 migration: encrypt any token still sitting in plaintext.
    if (this._canEncrypt()) {
      let migrated = false;
      for (const key of SECRET_KEYS) {
        const v = this._settings[key];
        if (typeof v === 'string' && v && !v.startsWith(ENC_PREFIX)) {
          this._settings[key] = this._encrypt(v);
          migrated = true;
        }
      }
      if (migrated) this._saveSettings();
    }
  }

  _read(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return fallback; }
  }
  _write(p, data) {
    try { fs.writeFileSync(p, JSON.stringify(data)); } catch (e) { /* disk full etc. */ }
  }
  _saveSettings() { this._write(this.settingsPath, this._settings); }
  _saveQueue() { this._write(this.queuePath, this._queue); }

  // ---- R3-8 secret handling (DPAPI via safeStorage) ----
  _canEncrypt() {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
  }
  _encrypt(plain) {
    return ENC_PREFIX + safeStorage.encryptString(String(plain)).toString('base64');
  }
  _decrypt(stored) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
    } catch {
      return null; // wrong user/machine or corrupted blob → treat as signed out
    }
  }

  // ---- settings ----
  get(key, def = null) {
    const v = this._settings[key] ?? def;
    if (SECRET_KEYS.has(key) && typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
      return this._canEncrypt() ? this._decrypt(v) : null;
    }
    return v;
  }
  set(key, val) {
    if (SECRET_KEYS.has(key) && typeof val === 'string' && val && this._canEncrypt()) {
      this._settings[key] = this._encrypt(val);
    } else {
      this._settings[key] = val;
    }
    this._saveSettings();
  }
  clearSession() {
    delete this._settings.device_token;
    delete this._settings.user_token;
    delete this._settings.employee;
    this._saveSettings();
  }
  deviceUuid() { return this._settings.device_uuid; }

  // ---- offline queue ----
  enqueue(method, path_, body) {
    if (this._queue.length >= 5000) {
      this._queue.shift(); // drop oldest under pressure…
      // …but never silently: count it and surface it on heartbeats/UI (R3-8).
      this._settings.dropped_events = (this._settings.dropped_events || 0) + 1;
      this._saveSettings();
    }
    this._queue.push({ id: crypto.randomUUID(), method, path: path_, body, ts: Date.now() });
    this._saveQueue();
  }
  pendingCount() { return this._queue.length; }
  droppedCount() { return this._settings.dropped_events || 0; }
  peekBatch(n = 25) { return this._queue.slice(0, n); }
  ack(ids) {
    const set = new Set(ids);
    this._queue = this._queue.filter((e) => !set.has(e.id));
    this._saveQueue();
  }
}

module.exports = Store;
