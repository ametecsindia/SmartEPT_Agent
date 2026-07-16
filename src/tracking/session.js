'use strict';
// Maps OS session events to SmartEPT attendance events. Lock/unlock and suspend/resume
// are surfaced honestly to the server (LOCK/UNLOCK), never hidden.

const { powerMonitor } = require('electron');
const { fmtDate } = require('./idle');

function wireSessionEvents(onAttendance, { onIdlePause, onIdleResume } = {}) {
  const now = () => fmtDate(new Date());

  powerMonitor.on('lock-screen', () => {
    onIdlePause && onIdlePause();
    onAttendance({ event_type: 'LOCK', occurred_at: now() });
  });

  powerMonitor.on('unlock-screen', () => {
    onIdleResume && onIdleResume();
    onAttendance({ event_type: 'UNLOCK', occurred_at: now() });
  });

  powerMonitor.on('suspend', () => {
    onIdlePause && onIdlePause();
    onAttendance({ event_type: 'LOCK', occurred_at: now() });
  });

  powerMonitor.on('resume', () => {
    onIdleResume && onIdleResume();
    onAttendance({ event_type: 'UNLOCK', occurred_at: now() });
  });
}

module.exports = { wireSessionEvents };
