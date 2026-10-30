// Security policy for everything the renderer can ask the main process to do.
// Pure functions only (no Electron imports) so it can be property-tested under plain Node.

// A container/image/volume reference: an ID, name, or image ref like `registry:5000/org/app:tag`
// or `app@sha256:…`. Must not start with `-`, so it can never be parsed as a CLI flag.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-:/@]{0,254}$/;
const isRef = (s) => typeof s === 'string' && REF_RE.test(s);

const JSON_FMT = '{{json .}}';

// Every command the UI is allowed to run, as exact argument shapes. `REF` matches one isRef() value.
// Anything not listed here is rejected, so a compromised renderer can't run e.g.
// `docker run --privileged -v /:/host …`.
const REF = Symbol('ref');
const COMMANDS = [
  { cmd: 'colima', args: ['status', '--json'], mutates: false },
  { cmd: 'colima', args: ['start'], mutates: true },
  { cmd: 'colima', args: ['stop'], mutates: true },
  { cmd: 'docker', args: ['ps', '-a', '--format', JSON_FMT], mutates: false },
  { cmd: 'docker', args: ['images', '--format', JSON_FMT], mutates: false },
  { cmd: 'docker', args: ['volume', 'ls', '--format', JSON_FMT], mutates: false },
  { cmd: 'docker', args: ['stats', '--no-stream', '--format', JSON_FMT], mutates: false },
  { cmd: 'docker', args: ['inspect', REF], mutates: false },
  { cmd: 'docker', args: ['start', REF], mutates: true },
  { cmd: 'docker', args: ['stop', REF], mutates: true },
  { cmd: 'docker', args: ['restart', REF], mutates: true },
  { cmd: 'docker', args: ['rm', '-f', REF], mutates: true },
  { cmd: 'docker', args: ['rmi', REF], mutates: true },
  { cmd: 'docker', args: ['volume', 'rm', REF], mutates: true },
];

const matches = (shape, args) =>
  shape.length === args.length && shape.every((s, i) => (s === REF ? isRef(args[i]) : s === args[i]));

/**
 * Check a renderer request against the allowlist.
 * @returns {{ allowed: true, mutates: boolean } | { allowed: false, reason: string }}
 */
function checkCommand(cmd, args, { readOnly = false } = {}) {
  if (typeof cmd !== 'string' || !Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    return { allowed: false, reason: 'malformed request' };
  }
  const rule = COMMANDS.find((c) => c.cmd === cmd && matches(c.args, args));
  if (!rule) return { allowed: false, reason: 'command not allowed' };
  if (readOnly && rule.mutates) return { allowed: false, reason: 'read-only mode: changes are disabled by policy' };
  return { allowed: true, mutates: rule.mutates };
}

const SINCE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
const MAX_TAIL = 100000;

/** Build `docker logs` args from renderer input, or null if the input is unacceptable. */
function buildLogsArgs(container, opts) {
  if (!isRef(container)) return null;
  const o = opts && typeof opts === 'object' ? opts : {};
  const args = ['logs', '-f', '--timestamps'];
  if (typeof o.since === 'string' && SINCE_RE.test(o.since)) args.push('--since', o.since);
  else if (o.tail === 'all') args.push('--tail', 'all');
  else args.push('--tail', String(Number.isInteger(o.tail) && o.tail > 0 && o.tail <= MAX_TAIL ? o.tail : 1000));
  args.push('--', container);
  return args;
}

/** Only plain http://localhost:<port>/… (or 127.0.0.1) links to published container ports may leave the app. */
function isAllowedExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  return (
    (u.protocol === 'http:' || u.protocol === 'https:') &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
    u.port !== '' &&
    u.username === '' && u.password === ''
  );
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/** Enterprise settings, all read from the environment so they can be pushed by MDM / launchd. */
function loadConfig(env = process.env) {
  const timeout = Number.parseInt(env.COLIMA_DESKTOP_CMD_TIMEOUT_MS, 10);
  const extraPath = (env.COLIMA_DESKTOP_PATH || '/opt/homebrew/bin:/usr/local/bin')
    .split(':').filter((p) => p.startsWith('/'));
  return {
    readOnly: truthy(env.COLIMA_DESKTOP_READONLY),
    auditLog: !/^(0|false|no|off)$/i.test(String(env.COLIMA_DESKTOP_AUDIT ?? '').trim()),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120000,
    extraPath,
  };
}

module.exports = { checkCommand, buildLogsArgs, isAllowedExternalUrl, isRef, loadConfig, COMMANDS, REF };
