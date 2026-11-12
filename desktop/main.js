const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');

const PORT = 43117;
let win = null;
let clients = new Set();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && req.url === '/state') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (win) win.webContents.send('state', data);
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(404); res.end();
});

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 560, frame: false, alwaysOnTop: true, skipTaskbar: false,
    transparent: true, resizable: true, hasShadow: false,
    webPreferences: { preload: __dirname + '/preload.js', contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  server.listen(PORT, '127.0.0.1');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
