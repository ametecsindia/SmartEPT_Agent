'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge — the renderer can only call these named channels.
contextBridge.exposeInMainWorld('smartept', {
  boot: () => ipcRenderer.invoke('boot'),
  login: (payload) => ipcRenderer.invoke('login', payload),
  testConnection: (payload) => ipcRenderer.invoke('test-connection', payload),
  resume: () => ipcRenderer.invoke('resume'),
  giveConsent: () => ipcRenderer.invoke('give-consent'),
  startTracking: () => ipcRenderer.invoke('start-tracking'),
  break: (payload) => ipcRenderer.invoke('break', payload),
  logout: () => ipcRenderer.invoke('logout'),
  getState: () => ipcRenderer.invoke('state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onToday: (cb) => ipcRenderer.on('today', (_e, t) => cb(t)),
  onAlert: (cb) => ipcRenderer.on('alert', (_e, a) => cb(a)),
});
