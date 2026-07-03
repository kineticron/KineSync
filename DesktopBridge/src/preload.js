const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridgeStatus', {
  onStatus(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('bridge:status', listener);
    return () => ipcRenderer.off('bridge:status', listener);
  },
});

contextBridge.exposeInMainWorld('bridgeAPI', {
  getSettings() {
    return ipcRenderer.invoke('bridge:settings:get');
  },
  saveSettings(patch) {
    return ipcRenderer.invoke('bridge:settings:set', patch);
  },
  startNgrokRelay(options) {
    return ipcRenderer.invoke('ngrok:relay:start', options);
  },
  stopNgrokRelay() {
    return ipcRenderer.invoke('ngrok:relay:stop');
  },
  authenticateNgrok(token) {
    return ipcRenderer.invoke('ngrok:authenticate', token);
  },
});

contextBridge.exposeInMainWorld('bridgeSettings', {
  get() {
    return ipcRenderer.invoke('bridge:settings:get');
  },
  set(patch) {
    return ipcRenderer.invoke('bridge:settings:set', patch);
  },
});

contextBridge.exposeInMainWorld('spotifyAuth', {
  login() {
    return ipcRenderer.invoke('spotify:login');
  },
  logout() {
    return ipcRenderer.invoke('spotify:logout');
  },
  getStatus() {
    return ipcRenderer.invoke('spotify:status');
  },
});

contextBridge.exposeInMainWorld('bridgeLyrics', {
  exportTtml() {
    return ipcRenderer.invoke('bridge:lyrics:export-ttml');
  },
  saveToVault(options = {}) {
    return ipcRenderer.invoke('bridge:lyrics:vault:save', options);
  },
  importToVault(options = {}) {
    return ipcRenderer.invoke('bridge:lyrics:vault:import', options);
  },
  importTtmlToVault(options = {}) {
    return ipcRenderer.invoke('bridge:lyrics:vault:import', options);
  },
  listVaultEntries() {
    return ipcRenderer.invoke('bridge:lyrics:vault:list');
  },
  exportVaultEntry(vaultId, format = 'ttml') {
    return ipcRenderer.invoke('bridge:lyrics:vault:export', { vaultId, format });
  },
  openVaultFolder() {
    return ipcRenderer.invoke('bridge:lyrics:vault:open-folder');
  },
});

