const { execFile } = require('child_process');

const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Run an allowlisted CLI command. Never rejects: every outcome (non-zero exit, missing binary,
 * timeout, oversized output, signal) resolves to `{ ok, stdout, stderr }` so the UI can't wedge.
 */
function runCli(cmd, args, { env, timeoutMs = 120000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      exec(cmd, args, { env, maxBuffer: MAX_BUFFER, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
        (err, stdout, stderr) => {
          let msg = String(stderr || '');
          if (err?.killed && err.signal === 'SIGKILL') msg = `${cmd} timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}`;
          else if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') msg = `${cmd} produced too much output`;
          else if (!msg && err) msg = err.message || String(err);
          finish({ ok: !err, stdout: String(stdout ?? ''), stderr: msg });
        });
    } catch (err) {
      finish({ ok: false, stdout: '', stderr: err?.message || String(err) });
    }
  });
}

module.exports = { runCli, MAX_BUFFER };
