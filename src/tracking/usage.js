'use strict';
// Usage tracker — turns ACTIVE window stretches into app-usage and (for browsers) website
// usage rows, and fires compliance callbacks when a blocked app/site is seen. Categorisation
// is authoritative on the server; the client mirror is only for instant blocked detection.
//
// NOTE: without the browser extension (enterprise phase) the exact URL/domain isn't available,
// so website matching is best-effort from the browser window title.

const { fmtDate } = require('./idle');

const BROWSERS = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'iexplore.exe'];
const COOLDOWN_MS = 60_000; // don't refire the same blocked item more than once a minute

class UsageTracker {
  constructor({ appPolicy, sitePolicy, onCompliance }) {
    this.appPolicy = appPolicy || {};
    this.sitePolicy = sitePolicy || {};
    this.onCompliance = onCompliance || (() => {});
    this.apps = [];
    this.sites = [];
    this._lastFired = new Map();
  }

  setPolicies(appPolicy, sitePolicy) {
    this.appPolicy = appPolicy || {};
    this.sitePolicy = sitePolicy || {};
  }

  // stretch: { active_app, window_title, started_at, ended_at, duration_seconds }
  ingestActive(stretch) {
    const app = stretch.active_app || '';
    if (!app || (stretch.duration_seconds || 0) <= 0) return;

    this.apps.push({
      app_name: app,
      process_name: app,
      window_title: stretch.window_title || null,
      start_at: stretch.started_at,
      end_at: stretch.ended_at,
      duration_seconds: stretch.duration_seconds,
    });

    if (this._isBlockedApp(app)) {
      this._fire('APP', `app:${this._normApp(app)}`, {
        event_type: 'BLOCKED_APP_OPENED', event_category: 'APP', severity: 'HIGH',
        detected_value: app, expected_value: 'Allowed work applications only',
      });
    }

    // Browser → best-effort website row from the window title.
    if (BROWSERS.includes(this._normApp(app) + '.exe') || BROWSERS.includes(app.toLowerCase())) {
      const title = stretch.window_title || '';
      const domain = this._domainFromTitle(title);
      this.sites.push({
        browser: app,
        domain: domain,
        full_url: null,
        page_title: title || null,
        start_at: stretch.started_at,
        end_at: stretch.ended_at,
        duration_seconds: stretch.duration_seconds,
      });

      if (this._isBlockedSite(domain, title)) {
        this._fire('WEBSITE', `site:${(domain || title).toLowerCase()}`, {
          event_type: 'BLOCKED_WEBSITE_OPENED', event_category: 'WEBSITE', severity: 'HIGH',
          detected_value: domain || title, expected_value: 'Allowed work websites only',
        });
      }
    }
  }

  flush() {
    const apps = this.apps.splice(0, this.apps.length);
    const sites = this.sites.splice(0, this.sites.length);
    return { apps, sites };
  }

  // ---- blocked detection (mirrors server ComplianceEvaluator) ----
  _isBlockedApp(app) {
    const n = this._normApp(app);
    return (this.appPolicy.blocked_apps || []).some((b) => n && n.includes(this._normApp(b)));
  }
  _isBlockedSite(domain, title) {
    const hay = `${domain || ''} ${title || ''}`.toLowerCase();
    return (this.sitePolicy.blocked_sites || []).some((b) => {
      const e = this._normSite(b);
      if (!e || !hay) return false;
      if (hay.includes(e)) return true;
      // Browser titles rarely contain the domain ("YouTube - Google Chrome"),
      // so also match the site's base name as a whole word. Min 4 chars to
      // avoid false positives from short entries like "x.com".
      const base = e.split('.')[0];
      if (base.length < 4) return false;
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('\\b' + esc + '\\b', 'i').test(hay);
    });
  }

  _fire(_cat, key, payload) {
    const now = Date.now();
    const last = this._lastFired.get(key) || 0;
    if (now - last < COOLDOWN_MS) return;
    this._lastFired.set(key, now);
    this.onCompliance({ ...payload, started_at: fmtDate(new Date()) });
  }

  _normApp(s) { return String(s || '').toLowerCase().replace(/\.exe$/, '').trim(); }
  _normSite(s) {
    return String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').trim();
  }
  _domainFromTitle(title) {
    const m = String(title || '').match(/([a-z0-9-]+\.)+[a-z]{2,}/i);
    return m ? m[0].toLowerCase() : null;
  }
}

module.exports = { UsageTracker, BROWSERS };
