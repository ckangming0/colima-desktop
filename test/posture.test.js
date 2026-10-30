// Static checks that the Electron security posture doesn't regress.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const main = read('main.js');
const html = read('index.html');
const preload = read('preload.js');

test('BrowserWindow is sandboxed and isolated', () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.doesNotMatch(main, /webSecurity:\s*false|allowRunningInsecureContent:\s*true|enableRemoteModule/);
});

test('navigation, webviews, new windows and permissions are locked down', () => {
  assert.match(main, /will-navigate[\s\S]*preventDefault/);
  assert.match(main, /will-attach-webview[\s\S]*preventDefault/);
  assert.match(main, /setWindowOpenHandler[\s\S]*isAllowedExternalUrl[\s\S]*action: 'deny'/);
  assert.match(main, /setPermissionRequestHandler/);
});

test('every IPC entry point goes through policy', () => {
  assert.match(main, /checkCommand\(/);
  assert.match(main, /buildLogsArgs\(/);
  assert.doesNotMatch(main, /\bexec\(|shell:\s*true/);
});

test('CSP forbids inline and remote script', () => {
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const scriptSrc = csp.split(';').map((s) => s.trim()).find((d) => d.startsWith('script-src'));
  assert.equal(scriptSrc, "script-src 'self'");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)|<script(?![^>]*\bsrc=)[^>]*>/, 'inline <script> blocks are not allowed');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handlers are not allowed');
});

test('preload exposes only the narrow cli bridge', () => {
  assert.match(preload, /exposeInMainWorld\('cli'/);
  const exposed = preload.slice(preload.indexOf('exposeInMainWorld'));
  assert.doesNotMatch(exposed, /ipcRenderer(?!\.(invoke|send|on)\()/, 'raw ipcRenderer must not be exposed');
  assert.doesNotMatch(preload, /require\('(child_process|fs)'\)/);
});

test('UI island bundle stays CSP-safe (no eval / Function constructor / remote imports)', async () => {
  const esbuild = require('esbuild');
  const { options } = require('../build/build-ui');
  const out = await esbuild.build({ ...options, write: false, logLevel: 'silent' });
  const js = out.outputFiles.find((f) => f.path.endsWith('.js')).text;
  assert.doesNotMatch(js, /\beval\(|new Function\(|\bimport\(/);
  assert.doesNotMatch(js, /https?:\/\/(?!reactbits\.dev|react\.dev|www\.w3\.org|motion\.dev)[\w.-]+\.\w+\//, 'bundle references a remote host');
  assert.match(html, /<script src="gen\/islands\.js"><\/script>\s*<script src="renderer\.js">/, 'islands must load before the renderer');
});
