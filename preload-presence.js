'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The presence window only ever sends numeric presence metadata to main — never frames.
contextBridge.exposeInMainWorld('presenceBridge', {
  report: (payload) => ipcRenderer.send('presence-status', payload),
});
