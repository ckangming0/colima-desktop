// Pure parsing/formatting helpers shared by the renderer (as window.Format) and the Node test suite.
// Anything here that returns HTML must be safe for innerHTML with arbitrary container output as input.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Format = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // Coerce untrusted (JSON-parsed) values to text without throwing — `{"toString": []}` breaks String().
  const str = (v) => {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    try { return String(v); } catch { return ''; }
  };
  const esc = (s) => str(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

  // `docker … --format '{{json .}}'` output: one object per line. Anything else is skipped.
  const jsonLines = (out) => str(out).split('\n').filter(Boolean).map((l) => {
    try { const v = JSON.parse(l); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
  }).filter(Boolean);

  const short = (id) => str(id).replace('sha256:', '').slice(0, 12);

  const UNITS = { B: 1, kB: 1e3, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1024 ** 2, GB: 1e9, GiB: 1024 ** 3, TB: 1e12, TiB: 1024 ** 4 };
  const toBytes = (s) => {
    const m = str(s).trim().match(/^([\d.]+)\s*([kKMGT]?i?B)?$/);
    if (!m) return 0;
    const n = parseFloat(m[1]) * (UNITS[m[2] || 'B'] || 1);
    return Number.isFinite(n) ? n : 0;
  };

  const ANSI_RE = /\x1b\[([\d;]*)m/g;
  const OTHER_ESC = /\x1b\[[\d;?]*[A-Za-ln-z]|\x1b\][^\x07]*\x07|\r/g;

  // SGR colour/style codes → <span class="a-…">; every other escape sequence is dropped.
  function ansiToHtml(raw) {
    const s = str(raw).replace(OTHER_ESC, '');
    let out = '', last = 0, cls = new Set(), m;
    const open = () => (cls.size ? `<span class="${[...cls].join(' ')}">` : '');
    ANSI_RE.lastIndex = 0;
    let depth = 0;
    while ((m = ANSI_RE.exec(s))) {
      out += esc(s.slice(last, m.index));
      last = ANSI_RE.lastIndex;
      for (const code of (m[1] || '0').split(';').map(Number)) {
        if (code === 0) cls.clear();
        else if (code === 1) cls.add('a-b'); else if (code === 2) cls.add('a-d');
        else if (code === 3) cls.add('a-i'); else if (code === 4) cls.add('a-u');
        else if (code === 22) { cls.delete('a-b'); cls.delete('a-d'); }
        else if (code === 39) [...cls].filter((c) => /a-\d\d/.test(c)).forEach((c) => cls.delete(c));
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          [...cls].filter((c) => /a-\d\d/.test(c)).forEach((c) => cls.delete(c)); cls.add('a-' + code);
        }
      }
      out += '</span>'.repeat(depth); depth = 0;
      const o = open(); if (o) { out += o; depth = 1; }
    }
    return out + esc(s.slice(last)) + '</span>'.repeat(depth);
  }

  function highlightJson(json) {
    return esc(json).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/gi,
      (m, str, colon, lit, num) => str ? `<span class="${colon ? 'j-k' : 'j-s'}">${str}</span>${colon || ''}` : lit ? `<span class="j-l">${lit}</span>` : `<span class="j-n">${num}</span>`);
  }

  return { str, esc, jsonLines, short, toBytes, ansiToHtml, highlightJson, ANSI_RE, OTHER_ESC };
});
