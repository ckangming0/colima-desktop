const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { checkCommand, buildLogsArgs, isAllowedExternalUrl, loadConfig } = require('./lib/policy');
const { runCli } = require('./lib/runner');
const { LogStreams } = require('./lib/log-streams');
const { createAuditLog } = require('./lib/audit');

const config = loadConfig();
// Apps launched from Finder don't inherit the shell PATH, so add Homebrew (or COLIMA_DESKTOP_PATH) locations.
const env = { ...process.env, PATH: [...config.extraPath, process.env.PATH].filter(Boolean).join(':') };
const audit = config.auditLog ? createAuditLog(path.join(app.getPath('logs'), 'audit.jsonl')) : () => {};

if (!app.requestSingleInstanceLock()) app.quit();

// Only accept IPC from our own top-level page.
const trusted = (e) => e.senderFrame?.url?.startsWith('file://') && e.senderFrame === e.sender.mainFrame;

ipcMain.handle('run', async (e, cmd, args) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  const verdict = checkCommand(cmd, args, config);
  if (!verdict.allowed) {
    audit({ event: 'denied', cmd: String(cmd).slice(0, 64), args: Array.isArray(args) ? args.map((a) => String(a).slice(0, 256)) : null, reason: verdict.reason });
    return { ok: false, stdout: '', stderr: verdict.reason };
  }
  const r = await runCli(cmd, args, { env, timeoutMs: config.timeoutMs });
  if (verdict.mutates) audit({ event: 'exec', cmd, args, ok: r.ok, error: r.ok ? undefined : r.stderr.slice(0, 500) });
  return r;
});

const logStreams = new LogStreams((args) => spawn('docker', args, { env }));
ipcMain.on('logs:start', (e, container, opts) => {
  if (!trusted(e)) return;
  const wc = e.sender;
  logStreams.start(wc, buildLogsArgs(container, opts));
  if (!wc._logsCleanup) { wc._logsCleanup = true; wc.once('destroyed', () => logStreams.stop(wc.id)); }
});
ipcMain.on('logs:stop', (e) => logStreams.stop(e.sender.id));

app.on('web-contents-created', (_e, contents) => {
  // The UI never navigates or opens windows; links to published ports go to the default browser.
  contents.on('will-navigate', (ev) => ev.preventDefault());
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  // No camera, mic, notifications, geolocation, etc. — only clipboard writes for the Copy buttons.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
  createWindow();
});
app.on('before-quit', () => logStreams.stopAll());
app.on('window-all-closed', () => app.quit());
