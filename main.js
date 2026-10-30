const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');

// Apps launched from Finder don't inherit the shell PATH, so add Homebrew locations.
const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
const ALLOWED = new Set(['docker', 'colima']);

ipcMain.handle('run', (_e, cmd, args) => {
  if (!ALLOWED.has(cmd) || !Array.isArray(args)) throw new Error('command not allowed');
  return new Promise((resolve) => {
    execFile(cmd, args, { env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr: stderr || (err && err.message) || '' });
    });
  });
});

// One live `docker logs -f` per window; restarting replaces the previous stream.
const streams = new Map();
function stopLogs(id) {
  streams.get(id)?.kill();
  streams.delete(id);
}
ipcMain.on('logs:start', (e, container, opts = {}) => {
  const wc = e.sender;
  stopLogs(wc.id);
  if (!/^[\w.-]+$/.test(container)) return;
  const args = ['logs', '-f', '--timestamps'];
  if (opts.since && /^[\dT:.Z-]+$/.test(opts.since)) args.push('--since', opts.since);
  else args.push('--tail', opts.tail === 'all' ? 'all' : String(Number.isInteger(opts.tail) && opts.tail > 0 ? opts.tail : 1000));
  const proc = spawn('docker', [...args, container], { env });
  streams.set(wc.id, proc);
  const send = (stream) => (buf) => !wc.isDestroyed() && streams.get(wc.id) === proc && wc.send('logs:data', stream, buf.toString());
  proc.stdout.on('data', send('out'));
  proc.stderr.on('data', send('err'));
  proc.on('close', () => !wc.isDestroyed() && streams.get(wc.id) === proc && wc.send('logs:end'));
  wc.once('destroyed', () => stopLogs(wc.id));
});
ipcMain.on('logs:stop', (e) => stopLogs(e.sender.id));

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 760,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
