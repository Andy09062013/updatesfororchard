const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aura', {
  getStore: () => ipcRenderer.invoke('store-get'),
  setStore: (d) => ipcRenderer.send('store-set', d),
  win: (a) => ipcRenderer.send('win', a),
  showFile: (p) => ipcRenderer.send('show-file', p),
  clearData: () => ipcRenderer.invoke('clear-data'),
  freeze: (id, f) => ipcRenderer.send('freeze', id, f),
  mail: {
    config: () => ipcRenderer.invoke('mail-config'),
    setConfig: (id, secret) => ipcRenderer.invoke('mail-config-set', id, secret),
    signIn: () => ipcRenderer.invoke('mail-signin'),
    signOut: () => ipcRenderer.invoke('mail-signout'),
    list: (q, page) => ipcRenderer.invoke('mail-list', q, page),
    get: (id) => ipcRenderer.invoke('mail-get', id),
    modify: (id, a) => ipcRenderer.invoke('mail-modify', id, a),
    send: (d) => ipcRenderer.invoke('mail-send', d),
    unread: () => ipcRenderer.invoke('mail-unread')
  },
  throttle: (w) => ipcRenderer.send('throttle-set', w),
  throttleStatus: () => ipcRenderer.invoke('throttle-status'),
  notify: (n) => ipcRenderer.send('native-note', n),
  nativeNote: (n) => ipcRenderer.send('chat-native-note', n),
  chatOpen: (id) => ipcRenderer.send('chat-open-id', id),
  ext: {
    catalog: () => ipcRenderer.invoke('ext-catalog'),
    list: () => ipcRenderer.invoke('ext-list'),
    install: (id) => ipcRenderer.invoke('ext-install', id),
    remove: (id) => ipcRenderer.invoke('ext-remove', id),
    url: (id) => ipcRenderer.invoke('ext-url', id)
  },
  openExternal: (u) => ipcRenderer.send('open-external', u),
  suggest: (engine, q) => ipcRenderer.invoke('suggest', engine, q),
  emulate: (id, o) => ipcRenderer.send('emulate', id, o),
  onBattery: () => ipcRenderer.invoke('on-battery'),
  profiles: () => ipcRenderer.invoke('profiles-list'),
  openProfile: (id) => ipcRenderer.invoke('profile-open', id),
  newWindow: () => ipcRenderer.invoke('profile-new-window'),
  addProfile: (n, c) => ipcRenderer.invoke('profile-add', n, c),
  editProfile: (id, n, c) => ipcRenderer.invoke('profile-edit', id, n, c),
  deleteProfile: (id) => ipcRenderer.invoke('profile-delete', id),
  openFile: (p) => ipcRenderer.send('open-file', p),
  dlAction: (id, a) => ipcRenderer.send('dl-action', id, a),
  metrics: (list) => ipcRenderer.invoke('metrics', list),
  speedStart: () => ipcRenderer.send('speed-start'),
  speedStop: () => ipcRenderer.send('speed-stop'),
  capture: (rect) => ipcRenderer.invoke('capture', rect),
  lens: (id, img) => ipcRenderer.invoke('lens', id, img),
  hashPw: (pw, salt) => ipcRenderer.invoke('hash-pw', pw, salt),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  restartUpdate: () => ipcRenderer.send('update-restart'),
  tearTab: (d) => ipcRenderer.invoke('tear-tab', d),
  initialTab: () => ipcRenderer.invoke('initial-tab'),
  bgImport: () => ipcRenderer.invoke('bg-import'),
  bgDelete: (u) => ipcRenderer.send('bg-delete', u),
  on: (ch, fn) => {
    const ok = ['open-tab', 'shortcut', 'blocked', 'download', 'max-state', 'power', 'profile-changed', 'dl', 'speed', 'attach-tab', 'win-blur', 'tool', 'update-ready', 'lock-sync', 'chat-event', 'chat-open', 'cal-due', 'note-click', 'throttle-status'];
    if (ok.includes(ch)) ipcRenderer.on(ch, (e, d) => fn(d));
  }
});
