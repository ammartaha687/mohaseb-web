const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mohasebDesktop', {
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    enqueue: (operation) => ipcRenderer.invoke('sync:enqueue', operation),
    exportQueue: () => ipcRenderer.invoke('sync:export-queue'),
    now: () => ipcRenderer.invoke('sync:now'),
    test: () => ipcRenderer.invoke('sync:test')
  }
});