const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Append-only JSONL audit trail of state-changing commands (and policy denials).
 * Failures to write are swallowed: auditing must never break the app.
 */
function createAuditLog(file) {
  let ready = false;
  return (entry) => {
    try {
      if (!ready) { fs.mkdirSync(path.dirname(file), { recursive: true }); ready = true; }
      const line = JSON.stringify({ ts: new Date().toISOString(), user: os.userInfo().username, ...entry });
      fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    } catch { /* best effort */ }
  };
}

module.exports = { createAuditLog };
