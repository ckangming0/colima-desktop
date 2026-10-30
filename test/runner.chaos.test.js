// Chaos tests: replace `docker` with fake binaries that misbehave in every way we can think of
// (crash, hang, flood, garbage, orphaned children) and check the IPC runner always settles promptly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('fast-check');
const { runCli } = require('../lib/runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colima-desktop-chaos-'));
const env = { PATH: `${dir}:/usr/bin:/bin` };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function fake(body) {
  const name = `fake${n++}`;
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return name;
}

async function timed(p) {
  const t = Date.now();
  const r = await p;
  return { r, ms: Date.now() - t };
}

const shape = (r) => {
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.stdout, 'string');
  assert.equal(typeof r.stderr, 'string');
};

test('non-zero exit surfaces stderr', async () => {
  const r = await runCli(fake('echo "Cannot connect to the Docker daemon" >&2; exit 1'), [], { env });
  shape(r);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /Cannot connect/);
});

test('missing binary resolves with an ENOENT-style error', async () => {
  const r = await runCli('definitely-not-installed', [], { env });
  shape(r);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /ENOENT/);
});

test('hung command is killed at the timeout', async () => {
  const { r, ms } = await timed(runCli(fake('sleep 30'), [], { env, timeoutMs: 300 }));
  shape(r);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /timed out/);
  assert.ok(ms < 3000, `took ${ms}ms`);
});

test('orphaned grandchild holding stdout open cannot wedge the UI', async () => {
  // e.g. a CLI that daemonises a helper without redirecting its stdio.
  const { r, ms } = await timed(runCli(fake('echo started; sleep 30 & exit 0'), [], { env, timeoutMs: 400 }));
  shape(r);
  assert.ok(ms < 3000, `took ${ms}ms`);
});

test('output flood beyond the buffer limit fails cleanly', async () => {
  const r = await runCli(fake('head -c 40000000 /dev/zero'), [], { env });
  shape(r);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /too much output/);
});

test('self-kill by signal', async () => {
  const r = await runCli(fake('echo partial; kill -9 $$'), [], { env });
  shape(r);
  assert.equal(r.ok, false);
});

test('a throwing exec implementation still resolves', async () => {
  const r = await runCli('docker', [], { exec: () => { throw new Error('EMFILE: too many open files'); } });
  assert.deepEqual(r, { ok: false, stdout: '', stderr: 'EMFILE: too many open files' });
});

test('an exec that calls back twice only resolves once', async () => {
  const r = await runCli('docker', [], { exec: (_c, _a, _o, cb) => { cb(null, 'first', ''); cb(new Error('x'), '', 'second'); } });
  assert.deepEqual(r, { ok: true, stdout: 'first', stderr: '' });
});

test('randomised misbehaviour: every run settles within timeout + grace with a well-formed result', async () => {
  const behaviour = fc.record({
    out: fc.constantFrom('', 'ok', '{"ID":"abc"}', '\\377\\376garbage', 'x'.repeat(5000)),
    err: fc.constantFrom('', 'warning', 'Error response from daemon: conflict'),
    sleep: fc.constantFrom(0, 0, 0.1, 5),
    exit: fc.constantFrom(0, 1, 2, 125, 137, 255),
    orphan: fc.boolean(),
    selfKill: fc.constantFrom(null, 'TERM', 'KILL', 'SEGV'),
  });
  await fc.assert(fc.asyncProperty(behaviour, async (b) => {
    const body = [
      b.orphan ? 'sleep 20 &' : '',
      `printf '${b.out}'`,
      b.err ? `echo '${b.err}' >&2` : '',
      b.sleep ? `sleep ${b.sleep}` : '',
      b.selfKill ? `kill -${b.selfKill} $$` : '',
      `exit ${b.exit}`,
    ].filter(Boolean).join('\n');
    const timeoutMs = 500;
    const { r, ms } = await timed(runCli(fake(body), ['ps'], { env, timeoutMs }));
    shape(r);
    assert.ok(ms < timeoutMs + 2500, `took ${ms}ms for ${JSON.stringify(b)}`);
    if (r.ok) assert.equal(b.exit, 0);
  }), { numRuns: Number(process.env.FC_CHAOS_RUNS) || 40 });
});
