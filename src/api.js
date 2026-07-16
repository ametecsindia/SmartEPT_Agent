'use strict';
// Thin HTTP client for the SmartEPT backend. Uses Node's global fetch (Electron 28+/Node 18+).

class Api {
  constructor(store) {
    this.store = store;
  }

  base() {
    return (this.store.get('server_url') || '').replace(/\/+$/, '');
  }

  async request(method, path, { body = null, token = null, auth = 'device' } = {}) {
    const url = this.base() + '/api' + path;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };

    const bearer = token
      || (auth === 'device' ? this.store.get('device_token') : this.store.get('user_token'));
    if (bearer) headers.Authorization = 'Bearer ' + bearer;

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }

    if (!res.ok) {
      const err = new Error(data?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data?.error?.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---- auth + bootstrap ----
  login(email, password) {
    return this.request('POST', '/auth/login', { body: { email, password }, auth: 'user', token: null });
  }
  registerDevice(payload, userToken) {
    return this.request('POST', '/agent/register-device', { body: payload, token: userToken });
  }
  policy(deviceUuid) {
    return this.request('GET', '/agent/policy?device_uuid=' + encodeURIComponent(deviceUuid));
  }
  consentStatus() { return this.request('GET', '/agent/consent/status'); }
  giveConsent(deviceUuid, hash) {
    return this.request('POST', '/agent/consent', { body: { device_uuid: deviceUuid, acknowledged: true, consent_text_hash: hash } });
  }
  heartbeat(body) { return this.request('POST', '/agent/heartbeat', { body }); }
  today() { return this.request('GET', '/agent/today'); }

  // Multipart upload (screenshots / webcam photos). Uses global FormData + Blob (Node 18+).
  async upload(path, jpegBuffer, fields = {}) {
    const url = this.base() + '/api' + path;
    const token = this.store.get('device_token');
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    form.append('image', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'capture.jpg');

    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      body: form,
    });
    if (!res.ok) {
      let data = null; try { data = await res.json(); } catch {}
      const err = new Error(data?.error?.message || `HTTP ${res.status}`);
      err.status = res.status; err.code = data?.error?.code;
      throw err;
    }
    return res.json();
  }
}

module.exports = Api;
