const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { checkCommand, buildLogsArgs, isAllowedExternalUrl, isRef, loadConfig, COMMANDS, REF } = require('../lib/policy');

const numRuns = Number(process.env.FC_NUM_RUNS) || 2000;
const opts = { numRuns };

// Arbitrary strings biased toward the characters that matter for CLI/flag injection.
const nasty = fc.oneof(
  fc.string(),
  fc.fullUnicodeString(),
  fc.stringOf(fc.constantFrom('-', '-', '=', ' ', ';', '|', '&', '$', '(', ')', '`', '\n', '\0', '/', ':', '@', '.', 'a', 'Z', '0', '*', '"', "'")),
  fc.constantFrom('--privileged', '-v', '/:/host', '--rm', 'run', 'exec', 'cp', '--help', '-f', '--format', '{{json .}}', '', '..', '../../etc/passwd'),
);
const validRef = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_.\-:/@]{0,40}$/);
const anyCmd = fc.oneof(fc.constantFrom('docker', 'colima', 'sh', 'bash', 'osascript', 'Docker', 'docker ', '/usr/local/bin/docker'), fc.string());

// Expand a rule into a concrete argv by substituting refs.
const instantiate = (rule) => fc.tuple(...rule.args.map((a) => (a === REF ? validRef : fc.constant(a))));

test('every allowlisted shape is accepted with any valid ref', () => {
  for (const rule of COMMANDS) {
    fc.assert(fc.property(instantiate(rule), (args) => {
      const v = checkCommand(rule.cmd, args);
      assert.equal(v.allowed, true);
      assert.equal(v.mutates, rule.mutates);
    }), { numRuns: 200 });
  }
});

test('arbitrary commands are allowed only if they exactly match an allowlisted shape', () => {
  fc.assert(fc.property(anyCmd, fc.array(nasty, { maxLength: 8 }), (cmd, args) => {
    const v = checkCommand(cmd, args);
    const expected = COMMANDS.some((r) => r.cmd === cmd && r.args.length === args.length &&
      r.args.every((a, i) => (a === REF ? isRef(args[i]) : a === args[i])));
    assert.equal(v.allowed, expected);
  }), opts);
});

test('an allowed command never contains an argument that is a dangerous docker verb or host mount', () => {
  const allArgs = fc.array(fc.oneof(nasty, validRef), { maxLength: 6 });
  fc.assert(fc.property(fc.constantFrom('docker', 'colima'), allArgs, (cmd, args) => {
    if (!checkCommand(cmd, args).allowed) return;
    for (const bad of ['run', 'exec', 'cp', 'build', 'login', 'compose', '--privileged', '-v', '--volume', 'ssh', 'delete', 'kubernetes']) {
      assert.ok(!args.includes(bad), `allowed args contained ${bad}: ${JSON.stringify(args)}`);
    }
  }), opts);
});

test('refs can never be parsed as flags', () => {
  fc.assert(fc.property(nasty, (s) => { if (isRef(s)) assert.ok(!s.startsWith('-') && s.length > 0 && !/\s|\0/.test(s)); }), opts);
});

test('injected refs in mutating commands are rejected', () => {
  const flaggy = fc.tuple(fc.constantFrom('-', '--'), fc.string()).map(([a, b]) => a + b);
  fc.assert(fc.property(fc.constantFrom('start', 'stop', 'restart', 'rmi', 'inspect'), flaggy, (verb, ref) => {
    assert.equal(checkCommand('docker', [verb, ref]).allowed, false);
  }), opts);
});

test('malformed IPC payloads are rejected, never thrown', () => {
  fc.assert(fc.property(fc.anything(), fc.anything(), (cmd, args) => {
    const v = checkCommand(cmd, args);
    if (!(typeof cmd === 'string' && Array.isArray(args))) assert.equal(v.allowed, false);
  }), opts);
});

test('read-only mode blocks every mutating command and nothing else', () => {
  for (const rule of COMMANDS) {
    fc.assert(fc.property(instantiate(rule), (args) => {
      assert.equal(checkCommand(rule.cmd, args, { readOnly: true }).allowed, !rule.mutates);
    }), { numRuns: 50 });
  }
});

test('docker logs args: container is always last, after `--`, and options are well formed', () => {
  fc.assert(fc.property(nasty, fc.anything(), (container, o) => {
    const args = buildLogsArgs(container, o);
    if (!isRef(container)) return assert.equal(args, null);
    assert.deepEqual(args.slice(0, 3), ['logs', '-f', '--timestamps']);
    assert.deepEqual(args.slice(-2), ['--', container]);
    const mid = args.slice(3, -2);
    assert.equal(mid.length, 2);
    if (mid[0] === '--tail') assert.match(mid[1], /^(all|[1-9]\d*)$/);
    else { assert.equal(mid[0], '--since'); assert.match(mid[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z$/); }
  }), opts);
});

test('external URLs: only localhost ports, no credentials, no other schemes or hosts', () => {
  const host = fc.constantFrom('localhost', '127.0.0.1', 'evil.com', 'localhost.evil.com', 'localhost:@evil.com', '[::1]', '0.0.0.0', 'LOCALHOST');
  const scheme = fc.constantFrom('http://', 'https://', 'file://', 'javascript:', 'data:', 'smb://', 'HTTP://', '');
  const url = fc.oneof(
    fc.tuple(scheme, fc.option(fc.constantFrom('user@', 'u:p@', 'localhost:80@'), { nil: '' }), host, fc.option(fc.integer({ min: 0, max: 70000 }).map((p) => ':' + p), { nil: '' }), fc.constantFrom('', '/', '/x?y#z', '\\@evil.com', '@evil.com'))
      .map((p) => p.join('')),
    fc.webUrl(), fc.string(),
  );
  fc.assert(fc.property(url, (raw) => {
    if (!isAllowedExternalUrl(raw)) return;
    const u = new URL(raw);
    assert.ok(['http:', 'https:'].includes(u.protocol));
    assert.ok(['localhost', '127.0.0.1'].includes(u.hostname), raw);
    assert.equal(u.username + u.password, '');
    assert.notEqual(u.port, '');
  }), opts);
  // Regression: the original `startsWith('http://localhost:')` check accepted this.
  assert.equal(isAllowedExternalUrl('http://localhost:@evil.com/'), false);
  assert.equal(isAllowedExternalUrl('http://localhost:8080/'), true);
});

test('config loader is total over arbitrary environments', () => {
  const envArb = fc.dictionary(fc.constantFrom('COLIMA_DESKTOP_READONLY', 'COLIMA_DESKTOP_AUDIT', 'COLIMA_DESKTOP_CMD_TIMEOUT_MS', 'COLIMA_DESKTOP_PATH', 'X'), fc.string());
  fc.assert(fc.property(envArb, (env) => {
    const c = loadConfig(env);
    assert.equal(typeof c.readOnly, 'boolean');
    assert.ok(Number.isFinite(c.timeoutMs) && c.timeoutMs > 0);
    assert.ok(c.extraPath.every((p) => p.startsWith('/')), 'relative PATH entries must be dropped');
  }), opts);
});
