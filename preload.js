const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('mohasebDesktop', { version: 'central-sync-v9' });
