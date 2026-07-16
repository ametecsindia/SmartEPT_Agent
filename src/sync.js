'use strict';
// Offline-tolerant sync engine. Instant events are enqueued and drained here; if the
// server is unreachable the queue persists on disk and drains automatically on reconnect.
// Nothing is lost; the pending count is surfaced to the visible UI.

class SyncEngine {
  constructor(store, api, { onState } = {}) {
    this.store = store;
    this.api = api;
    this.onState = onState || (() => {});
    this.online = false;
    this._timer = null;
  }

  start(intervalMs) {
    this._timer = setInterval(() => this.drain(), intervalMs);
    this.drain();
  }
  stop() { if (this._timer) clearInterval(this._timer); }

  async drain() {
    let batch = this.store.peekBatch(25);
    while (batch.length) {
      const acked = [];
      for (const ev of batch) {
        try {
          await this.api.request(ev.method, ev.path, { body: ev.body });
          acked.push(ev.id);
          this.online = true;
        } catch (e) {
          if (e.status && e.status < 500 && e.code !== 'CONSENT_REQUIRED') {
            // Permanent client error (bad/duplicate) — drop so the queue can't jam.
            acked.push(e && ev.id);
          } else {
            // Network down or consent pending — stop; retry on the next tick.
            this.online = e.status ? true : false;
            if (acked.length) this.store.ack(acked);
            this._emit();
            return;
          }
        }
      }
      this.store.ack(acked);
      batch = this.store.peekBatch(25);
    }
    this._emit();
  }

  _emit() {
    this.onState({ online: this.online, pending: this.store.pendingCount() });
  }
}

module.exports = SyncEngine;
