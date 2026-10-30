// One live `docker logs -f` per window; starting a new stream replaces the previous one.
// `spawn` and the window object are injected so the state machine can be chaos-tested without Electron.
class LogStreams {
  constructor(spawn) {
    this.spawn = spawn;
    this.streams = new Map();
  }

  stop(id) {
    const proc = this.streams.get(id);
    this.streams.delete(id);
    try { proc?.kill(); } catch { /* already gone */ }
  }

  stopAll() {
    for (const id of [...this.streams.keys()]) this.stop(id);
  }

  /** @param wc  { id, isDestroyed(), send(channel, ...args), once(event, fn) } */
  start(wc, args) {
    this.stop(wc.id);
    if (!args) return null;
    let proc;
    try { proc = this.spawn(args); } catch { return null; }
    this.streams.set(wc.id, proc);
    // Only the current stream for a live window may talk to it; late output from a replaced
    // or killed process is dropped.
    const live = () => !wc.isDestroyed() && this.streams.get(wc.id) === proc;
    const send = (stream) => (buf) => { if (live()) wc.send('logs:data', stream, buf.toString()); };
    proc.stdout?.on('data', send('out'));
    proc.stderr?.on('data', send('err'));
    proc.on('error', () => {}); // e.g. ENOENT: reported via 'close' instead of crashing the main process
    proc.on('close', () => {
      if (live()) { this.streams.delete(wc.id); wc.send('logs:end'); }
    });
    return proc;
  }
}

module.exports = { LogStreams };
