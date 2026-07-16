'use strict';
// Static agent configuration. Runtime values (server URL, tokens, device id) live in
// the on-disk settings store; these are the defaults + tunables.

module.exports = {
  // Default backend for local Laragon testing. Overridable on the login screen.
  DEFAULT_SERVER_URL: 'http://smartept.test',

  // Cadences (ms).
  HEARTBEAT_MS: 30_000,      // liveness ping
  IDLE_POLL_MS: 5_000,       // how often we sample OS idle time
  ACTIVITY_FLUSH_MS: 60_000, // batch activity events roughly once a minute
  SYNC_MS: 15_000,           // drain the offline queue
  TODAY_REFRESH_MS: 30_000,  // refresh the server-side "today" totals

  // Fallback idle threshold (seconds) if the policy bundle does not specify one.
  DEFAULT_IDLE_THRESHOLD: 120,

  // Offline queue guard.
  MAX_QUEUE: 5000,
};
