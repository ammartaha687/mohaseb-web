const { app, BrowserWindow } = require('electron');
const path = require('path');

const safeAppData = process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd();
const safeUserData = path.join(safeAppData, 'MohasebOfflineCloud');
const safeSessionData = path.join(safeUserData, 'SessionData');
const safeCache = path.join(safeUserData, 'Cache');
app.setPath('userData', safeUserData);
app.setPath('sessionData', safeSessionData);
app.setPath('cache', safeCache);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
