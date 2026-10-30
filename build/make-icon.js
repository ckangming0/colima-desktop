// Regenerate build/icon.png and build/icon.icns from build/icon.svg:
//   npx electron build/make-icon.js && sh build/make-icns.sh
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true, sandbox: true } });
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  await win.loadURL('data:text/html,' + encodeURIComponent(
    `<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="1024" height="1024">`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
