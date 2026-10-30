const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { esc, jsonLines, toBytes, ansiToHtml, highlightJson } = require('../lib/format');

const numRuns = Number(process.env.FC_NUM_RUNS) || 2000;
const opts = { numRuns };

// Container output: arbitrary text salted with ANSI sequences and HTML.
const ansi = fc.oneof(
  fc.integer({ min: 0, max: 120 }).map((n) => `\x1b[${n}m`),
  fc.array(fc.integer({ min: 0, max: 120 }), { maxLength: 4 }).map((ns) => `\x1b[${ns.join(';')}m`),
  fc.constantFrom('\x1b[2J', '\x1b[?25l', '\x1b]0;title\x07', '\r', '\x1b[', '\x1b', '\x1b[K'),
);
const html = fc.constantFrom('<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=x>', "'", '&amp;', '</span>', '<span class="x">');
const logText = fc.array(fc.oneof(fc.fullUnicodeString({ maxLength: 20 }), ansi, html), { maxLength: 30 }).map((p) => p.join(''));

// Our generated markup only ever contains these tags.
const ALLOWED_TAG = /^<\/?span(?: class="[a-z0-9 -]+")?>$/;
const tags = (s) => s.match(/<[^>]*>/g) || [];
const textOf = (s) => s.replace(/<[^>]*>/g, '').replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' }[e]));

test('esc never throws on any JSON-derived value', () => {
  fc.assert(fc.property(fc.jsonValue(), (v) => { assert.ok(!/[<>"']/.test(esc(v))); }), opts);
});

test('esc output contains no HTML-significant characters and round-trips', () => {
  fc.assert(fc.property(fc.fullUnicodeString(), (s) => {
    const e = esc(s);
    assert.ok(!/[<>"']/.test(e));
    assert.equal(textOf(e), s);
  }), opts);
});

test('ansiToHtml emits only balanced <span class> tags, whatever the container prints', () => {
  fc.assert(fc.property(logText, (s) => {
    const out = ansiToHtml(s);
    let depth = 0;
    for (const t of tags(out)) {
      assert.match(t, ALLOWED_TAG, `unexpected tag ${t} from ${JSON.stringify(s)}`);
      depth += t.startsWith('</') ? -1 : 1;
      assert.ok(depth >= 0 && depth <= 1);
    }
    assert.equal(depth, 0);
  }), opts);
});

test('ansiToHtml preserves visible text exactly (minus escape sequences)', () => {
  const plain = fc.fullUnicodeString().filter((s) => !/[\x1b\r]/.test(s));
  const sgr = ansi.filter((a) => /^\x1b\[[\d;]*m$/.test(a));
  fc.assert(fc.property(fc.array(fc.tuple(plain, fc.option(sgr, { nil: '' })), { maxLength: 8 }), (parts) => {
    const mixed = parts.map(([t, c]) => t + c).join('');
    assert.equal(textOf(ansiToHtml(mixed)), parts.map(([t]) => t).join(''));
  }), opts);
});

test('highlightJson output for any docker inspect JSON is safe and loses no text', () => {
  fc.assert(fc.property(fc.jsonValue(), (v) => {
    const json = JSON.stringify(v, null, 2) ?? 'null';
    const out = highlightJson(json);
    for (const t of tags(out)) assert.match(t, ALLOWED_TAG);
    assert.equal(textOf(out), json);
  }), opts);
  fc.assert(fc.property(logText, (s) => { for (const t of tags(highlightJson(s))) assert.match(t, ALLOWED_TAG); }), opts);
});

test('jsonLines never throws and returns only objects', () => {
  const line = fc.oneof(fc.json(), fc.string(), fc.constantFrom('{', 'null', '[]', '5', '"x"', '{"ID":"abc"}'));
  fc.assert(fc.property(fc.array(line, { maxLength: 20 }), (ls) => {
    const out = jsonLines(ls.join('\n'));
    assert.ok(out.every((o) => o && typeof o === 'object' && !Array.isArray(o)));
  }), opts);
  for (const junk of [undefined, null, 42, {}, { toString: [] }]) assert.deepEqual(jsonLines(junk), []);
});

test('toBytes is total, finite and non-negative', () => {
  const unit = fc.constantFrom('', 'B', 'kB', 'KB', 'KiB', 'MB', 'MiB', 'GB', 'GiB', 'TB', 'TiB', 'XB', 'iB');
  const size = fc.oneof(
    fc.tuple(fc.stringOf(fc.constantFrom('0', '1', '9', '.')), fc.constantFrom('', ' '), unit).map((p) => p.join('')),
    fc.string(), fc.jsonValue(), // values come from parsed `docker stats` JSON
  );
  fc.assert(fc.property(size, (s) => {
    const n = toBytes(s);
    assert.ok(Number.isFinite(n) && n >= 0, `${JSON.stringify(s)} -> ${n}`);
  }), opts);
  assert.equal(toBytes('1.5 MiB'), 1.5 * 1024 ** 2);
  assert.equal(toBytes('.'), 0); // regression: used to be NaN and poison the memory chart
  assert.equal(toBytes({ toString: [] }), 0); // regression: String() threw on this JSON shape
});
