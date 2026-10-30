// Chaos test for the log-stream state machine: random interleavings of start/stop/window-destroy,
// process output, process exit and spawn failures across several windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fc = require('fast-check');
const { LogStreams } = require('../lib/log-streams');

class FakeProc extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.killed = false; this.closed = false; }
  kill() { if (this.killed) throw new Error('ESRCH'); this.killed = true; }
}

class FakeWindow {
  constructor(id) { this.id = id; this.destroyed = false; this.inbox = []; }
  isDestroyed() { return this.destroyed; }
  send(...m) { if (this.destroyed) throw new Error('Object has been destroyed'); this.inbox.push(m); }
}

const WINDOWS = 3;
const op = fc.oneof(
  fc.record({ t: fc.constant('start'), w: fc.nat(WINDOWS - 1), valid: fc.boolean(), spawnThrows: fc.boolean() }),
  fc.record({ t: fc.constant('stop'), w: fc.nat(WINDOWS - 1) }),
  fc.record({ t: fc.constant('destroy'), w: fc.nat(WINDOWS - 1) }),
  fc.record({ t: fc.constantFrom('out', 'err', 'close', 'error'), p: fc.nat(50) }),
);

test('log streams: no cross-talk, no sends to dead windows, no leaked processes', () => {
  fc.assert(fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
    const procs = [];
    let throwNext = false;
    const ls = new LogStreams(() => {
      if (throwNext) throw new Error('spawn EAGAIN');
      const p = new FakeProc(); procs.push(p); return p;
    });
    const wins = Array.from({ length: WINDOWS }, (_, i) => new FakeWindow(i));
    const owner = new Map(); // proc -> window it was started for

    for (const o of ops) {
      if (o.t === 'start') {
        const w = wins[o.w]; if (w.destroyed) continue;
        throwNext = o.spawnThrows;
        const p = ls.start(w, o.valid ? ['logs', '-f', '--', 'c1'] : null);
        if (p) owner.set(p, w);
      } else if (o.t === 'stop') ls.stop(o.w);
      else if (o.t === 'destroy') { wins[o.w].destroyed = true; ls.stop(o.w); }
      else {
        const p = procs[o.p % Math.max(procs.length, 1)]; if (!p || p.closed) continue;
        const w = owner.get(p);
        const before = w.inbox.length;
        const current = ls.streams.get(w.id) === p && !w.destroyed;
        if (o.t === 'out') p.stdout.emit('data', Buffer.from('line\n'));
        else if (o.t === 'err') p.stderr.emit('data', Buffer.from('oops\n'));
        else if (o.t === 'error') p.emit('error', new Error('ENOENT'));
        else { p.closed = true; p.emit('close', 0); }
        // Only the window's current stream may produce messages.
        if (!current) assert.equal(w.inbox.length, before, 'stale process talked to a window');
      }
      // Invariant: every registered proc is alive and belongs to that window; every other proc was killed or closed.
      const live = new Set(ls.streams.values());
      for (const [id, p] of ls.streams) { assert.equal(owner.get(p).id, id); assert.ok(!p.killed && !p.closed); }
      for (const p of procs) if (!live.has(p)) assert.ok(p.killed || p.closed, 'leaked log process');
    }
    ls.stopAll();
    assert.equal(ls.streams.size, 0);
    for (const p of procs) assert.ok(p.killed || p.closed);
  }), { numRuns: Number(process.env.FC_NUM_RUNS) || 2000 });
});
