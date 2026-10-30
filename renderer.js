// Renderer for Colima Desktop. Loaded by index.html; talks to the main process only via window.cli (preload.js).
const { str, esc, jsonLines, short, toBytes, ansiToHtml, highlightJson } = window.Format;
// React/Motion islands (ui/islands.jsx). They own the nodes they're given; never write those nodes directly.
const I = window.Islands;
const setCount = (el, n) => I.count(el, n);
const setEngineLabel = (text, busy = false) => I.engineLabel($('engine-label'), text, busy);
const $ = (id) => document.getElementById(id);
// Only touch the DOM when markup changed, so a click landing mid-refresh isn't swallowed.
const setHTML = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };

const ICON = {
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7.5-4.5z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  restart: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/></svg>',
  logs: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M3 8h10M3 12h6"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3 5 8l5 5"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  spin: '<svg class="spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2a6 6 0 1 0 6 6"/></svg>',
};

const state = {
  view: 'containers', engine: null, containers: [], images: [], volumes: [], stats: {}, history: {},
  busy: new Set(), filter: '', detail: null, tab: 'logs',
};

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast' + (err ? ' err' : '')), err ? 5000 : 2000);
}
const copy = (text, what = 'Copied') => navigator.clipboard.writeText(text).then(() => toast(what));

const docker = (...args) => window.cli.run('docker', args);
const colima = (...args) => window.cli.run('colima', args);

// ---------- data ----------
async function refreshEngine() {
  const r = await colima('status', '--json');
  let info = {};
  if (r.ok) { try { info = JSON.parse(r.stdout); } catch {} }
  state.engine = r.ok ? { running: true, ...info } : { running: false, missing: /ENOENT|not found/i.test(r.stderr) };
  renderEngine();
}

async function refreshDocker() {
  if (!state.engine?.running) { state.containers = state.images = state.volumes = []; render(); return; }
  const [c, i, v] = await Promise.all([
    docker('ps', '-a', '--format', '{{json .}}'),
    docker('images', '--format', '{{json .}}'),
    docker('volume', 'ls', '--format', '{{json .}}'),
  ]);
  state.containers = c.ok ? jsonLines(c.stdout) : [];
  state.images = i.ok ? jsonLines(i.stdout) : [];
  state.volumes = v.ok ? jsonLines(v.stdout) : [];
  render();
}


async function refreshStats() {
  if (!state.engine?.running || !state.containers.some((c) => c.State === 'running')) return;
  const r = await docker('stats', '--no-stream', '--format', '{{json .}}');
  if (!r.ok) return;
  const now = Date.now();
  state.stats = {};
  for (const s of jsonLines(r.stdout)) {
    const id = short(s.ID);
    state.stats[id] = s;
    const h = (state.history[id] ||= []);
    h.push({ t: now, cpu: parseFloat(s.CPUPerc) || 0, mem: toBytes(str(s.MemUsage).split(' / ')[0]) });
    if (h.length > 60) h.shift();
  }
  if (state.view === 'containers' && !state.detail) render();
  if (state.detail && state.tab === 'stats') renderStats();
}

// ---------- actions ----------
async function act(key, fn, okMsg) {
  state.busy.add(key); render();
  const r = await fn();
  state.busy.delete(key);
  if (r.ok) { if (okMsg) toast(okMsg); } else toast(r.stderr.trim().split('\n').pop() || 'Command failed', true);
  await refreshDocker();
}

const actions = {
  start: (id, name) => act(id, () => docker('start', id), `Started ${name}`),
  stop: (id, name) => act(id, () => docker('stop', id), `Stopped ${name}`),
  restart: (id, name) => act(id, () => docker('restart', id), `Restarted ${name}`),
  rm: async (id, name) => {
    if (!confirm(`Delete container “${name}”?`)) return;
    if (state.detail?.id === id) closeDetail();
    act(id, () => docker('rm', '-f', id), `Deleted ${name}`);
  },
  rmi: (id, name) => confirm(`Delete image “${name}”?`) && act(id, () => docker('rmi', id), `Deleted ${name}`),
  rmv: (id, name) => confirm(`Delete volume “${name}”? Its data cannot be recovered.`) && act(id, () => docker('volume', 'rm', id), `Deleted ${name}`),
  detail: (id) => openDetail(id),
  back: () => closeDetail(),
  open: (url) => window.open(url),
  copy: (text) => copy(text, 'Copied to clipboard'),
  engineToggle: () => $('engine-btn').click(),
};

$('engine-btn').addEventListener('click', async () => {
  const running = state.engine?.running;
  const btn = $('engine-btn');
  btn.disabled = true; btn.textContent = running ? 'Stopping…' : 'Starting…';
  $('engine-dot').className = 'dot busy';
  setEngineLabel(running ? 'Stopping' : 'Starting', true);
  const r = await colima(running ? 'stop' : 'start');
  if (!r.ok) toast(r.stderr.trim().split('\n').pop() || 'Colima failed', true);
  await refreshEngine(); await refreshDocker();
});

// ---------- logs ----------
const MAX_LINES = 20000;
const logs = { lines: [], partial: { out: '', err: '' }, lastTs: null, streaming: false, follow: true, unseen: 0, matches: [], cur: -1 };

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

function makeLine(stream, raw, sys = false) {
  let ts = '', msg = raw;
  const m = !sys && raw.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/s);
  if (m) { ts = m[1]; msg = m[2]; logs.lastTs = ts; }
  const el = document.createElement('div');
  el.className = 'ln' + (stream === 'err' ? ' err' : '') + (sys ? ' sys' : '');
  el.innerHTML = `<span class="ts" title="${esc(ts)}">${esc(ts ? fmtTime(ts) : '')}</span><span class="msg">${sys ? esc(msg) : ansiToHtml(msg)}</span>`;
  const text = el.lastChild.textContent;
  return { el, ts, text, lower: text.toLowerCase() };
}

function appendLines(newLines) {
  if (!newLines.length) return;
  const body = $('log-body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  const frag = document.createDocumentFragment();
  const q = logQuery();
  for (const l of newLines) {
    if (q && $('log-only').getAttribute('aria-pressed') === 'true' && !l.lower.includes(q)) l.el.hidden = true;
    frag.appendChild(l.el);
    logs.lines.push(l);
  }
  body.appendChild(frag);
  if (logs.lines.length > MAX_LINES) logs.lines.splice(0, logs.lines.length - MAX_LINES).forEach((l) => l.el.remove());
  if (atBottom || logs.follow) { body.scrollTop = body.scrollHeight; logs.unseen = 0; }
  else { logs.unseen += newLines.length; }
  updateJump();
  if (q) scheduleSearch(false);
  $('log-lines').textContent = `${logs.lines.length.toLocaleString()} lines`;
}

window.cli.logs.onData((stream, text) => {
  if (!state.detail) return;
  const chunk = logs.partial[stream] + text;
  const parts = chunk.split('\n');
  logs.partial[stream] = parts.pop();
  appendLines(parts.map((p) => makeLine(stream, p)));
  setStreamStatus(true);
});
window.cli.logs.onEnd(() => {
  for (const s of ['out', 'err']) if (logs.partial[s]) { appendLines([makeLine(s, logs.partial[s])]); logs.partial[s] = ''; }
  setStreamStatus(false);
});

function setStreamStatus(on) {
  logs.streaming = on;
  $('log-dot').className = 'dot' + (on ? ' on' : '');
  $('log-status').textContent = on ? 'Streaming' : 'Not streaming — container stopped';
}

function startLogs(opts) {
  logs.partial = { out: '', err: '' };
  $('log-status').textContent = 'Connecting…';
  window.cli.logs.start(state.detail.id, opts);
  logs.streaming = true; // optimistic; corrected by onEnd if the container isn't running
}

function resetLogs() {
  logs.lines = []; logs.lastTs = null; logs.unseen = 0; logs.follow = true; logs.matches = []; logs.cur = -1;
  $('log-body').replaceChildren(); $('log-lines').textContent = ''; updateJump(); updateMatchCount();
  const t = $('log-tail').value;
  startLogs({ tail: t === 'all' ? 'all' : Number(t) });
}

function updateJump() {
  const show = !logs.follow;
  $('log-jump').classList.toggle('show', show);
  $('log-jump').textContent = logs.unseen ? `${logs.unseen.toLocaleString()} new line${logs.unseen === 1 ? '' : 's'} ↓` : 'Jump to latest ↓';
}

$('log-body').addEventListener('scroll', (e) => {
  const b = e.target;
  logs.follow = b.scrollHeight - b.scrollTop - b.clientHeight < 30;
  if (logs.follow) logs.unseen = 0;
  updateJump();
});
$('log-jump').addEventListener('click', () => {
  const b = $('log-body'); b.scrollTop = b.scrollHeight; logs.follow = true; logs.unseen = 0; updateJump();
});

// search: highlight with the CSS Custom Highlight API, optionally hide non-matching lines
const logQuery = () => $('log-search').value.trim().toLowerCase();
let searchRaf = 0;
function scheduleSearch(jump) { cancelAnimationFrame(searchRaf); searchRaf = requestAnimationFrame(() => runSearch(jump)); }

function runSearch(jump) {
  const q = logQuery(), only = $('log-only').getAttribute('aria-pressed') === 'true';
  const ranges = [];
  for (const l of logs.lines) {
    const hit = q && l.lower.includes(q);
    l.el.hidden = !!(q && only && !hit);
    if (!hit || ranges.length > 5000) continue;
    const walker = document.createTreeWalker(l.el.lastChild, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.data.toLowerCase();
      for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) {
        const r = new Range(); r.setStart(node, i); r.setEnd(node, i + q.length); ranges.push(r);
      }
    }
  }
  logs.matches = ranges;
  if (logs.cur >= ranges.length) logs.cur = ranges.length - 1;
  if (jump) logs.cur = ranges.length ? ranges.length - 1 : -1; // newest match first, like a terminal
  CSS.highlights.set('log-match', new Highlight(...ranges));
  paintCurrent(jump);
  updateMatchCount();
}

function paintCurrent(scroll) {
  const r = logs.matches[logs.cur];
  CSS.highlights.set('log-current', r ? new Highlight(r) : new Highlight());
  if (r && scroll) {
    const el = r.startContainer.parentElement.closest('.ln');
    el.scrollIntoView({ block: 'center' });
  }
}

function updateMatchCount() {
  const q = logQuery();
  $('log-count').textContent = q ? (logs.matches.length ? `${logs.cur + 1} of ${logs.matches.length.toLocaleString()}` : 'No matches') : '';
}

function step(dir) {
  if (!logs.matches.length) return;
  logs.cur = (logs.cur + dir + logs.matches.length) % logs.matches.length;
  paintCurrent(true); updateMatchCount();
}

$('log-search').addEventListener('input', () => scheduleSearch(true));
$('log-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? 1 : -1); }
  if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; scheduleSearch(false); }
});
$('log-prev').addEventListener('click', () => step(-1));
$('log-next').addEventListener('click', () => step(1));

const toggle = (btn, fn) => btn.addEventListener('click', () => {
  const on = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', on); fn(on);
});
toggle($('log-only'), () => scheduleSearch(false));
toggle($('log-ts'), (on) => $('log-body').classList.toggle('no-ts', !on));
toggle($('log-wrap'), (on) => $('log-body').classList.toggle('wrap', on));
$('log-tail').addEventListener('change', resetLogs);
$('log-clear').addEventListener('click', () => {
  logs.lines = []; logs.matches = []; logs.cur = -1; $('log-body').replaceChildren();
  $('log-lines').textContent = ''; CSS.highlights.clear(); updateMatchCount();
});
const visibleText = () => logs.lines.filter((l) => !l.el.hidden)
  .map((l) => ($('log-ts').getAttribute('aria-pressed') === 'true' && l.ts ? l.ts + ' ' : '') + l.text).join('\n');
$('log-copy').addEventListener('click', () => copy(visibleText(), 'Logs copied'));
$('log-save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([visibleText() + '\n'], { type: 'text/plain' }));
  a.download = `${state.detail.name}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- inspect ----------
let inspectJson = '';
async function loadInspect() {
  $('inspect-body').textContent = 'Loading…';
  const r = await docker('inspect', state.detail.id);
  if (!r.ok) { $('inspect-body').textContent = r.stderr; return; }
  try { inspectJson = JSON.stringify(JSON.parse(r.stdout)[0], null, 2); } catch { inspectJson = r.stdout; }
  $('inspect-body').innerHTML = highlightJson(inspectJson);
}
$('inspect-copy').addEventListener('click', () => copy(inspectJson, 'JSON copied'));

// ---------- stats ----------

function renderStats() {
  const id = short(state.detail.id), s = state.stats[id], h = state.history[id] || [];
  const c = state.containers.find((x) => x.ID === state.detail.id);
  const status = c?.State !== 'running' ? 'stopped' : s ? 'ok' : 'collecting';
  I.stats($('stats-body'), state.detail.id, { status, s, history: h });
}

// ---------- detail view ----------
function openDetail(id) {
  const c = state.containers.find((x) => x.ID === id); if (!c) return;
  state.detail = { id, name: c.Names, wasRunning: c.State === 'running' };
  $('log-search').value = ''; CSS.highlights.clear();
  setTab('logs');
  $('scroll').hidden = true; $('list-head').hidden = true;
  $('detail').hidden = false; $('detail-head').hidden = false;
  $('header').classList.add('scrolled');
  resetLogs();
  render();
  I.openDetail($('detail'));
  refreshStats();
}

function closeDetail() {
  if (!state.detail) return;
  window.cli.logs.stop();
  state.detail = null; CSS.highlights.clear();
  $('detail').hidden = true; $('detail-head').hidden = true;
  $('scroll').hidden = false; $('list-head').hidden = false;
  $('header').classList.toggle('scrolled', $('scroll').scrollTop > 0);
  render();
  I.closeDetail($('scroll'));
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
  for (const t of ['logs', 'inspect', 'stats']) $('panel-' + t).hidden = t !== tab;
  $('tools-logs').hidden = tab !== 'logs'; $('tools-inspect').hidden = tab !== 'inspect';
  if (tab === 'inspect') loadInspect();
  if (tab === 'stats') renderStats();
  I.tab($('panel-' + tab));
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });

function renderDetail() {
  const d = state.detail, c = state.containers.find((x) => x.ID === d.id);
  if (!c) { closeDetail(); return; }
  const on = c.State === 'running', busy = state.busy.has(c.ID), args = [c.ID, c.Names];
  const ab = (action, icon, label, cls = '') => `<button class="btn bordered ${cls}" data-action="${action}" data-args='${esc(JSON.stringify(args))}'>${icon}${label}</button>`;
  setHTML($('detail-head'), `
    <button class="btn icon" data-action="back" data-args="[]" title="Back to Containers (Esc)" aria-label="Back">${ICON.back}</button>
    <span class="dot ${busy ? 'busy' : on ? 'on' : ''}"></span>
    <h1>${esc(c.Names)}</h1><span class="sub">${esc(c.Image)}</span>
    <span class="spacer"></span>
    ${busy ? `<span class="btn">${ICON.spin}Working…</span>` :
      (on ? ab('stop', ICON.stop, 'Stop') + ab('restart', ICON.restart, 'Restart') : ab('start', ICON.play, 'Start')) +
      ab('rm', ICON.trash, 'Delete', 'danger')}`);
  setHTML($('d-meta'), `
    <span class="meta-item">${statusBadge(c)}<span class="muted">${esc(statusDetail(c.Status))}</span></span>
    <span class="meta-item"><span>ID</span><span class="mono copyable" title="Copy full ID" data-action="copy" data-args='${esc(JSON.stringify([c.ID]))}'>${esc(short(c.ID))}</span></span>
    <span class="meta-item"><span>Ports</span>${ports(c.Ports)}</span>
    <span class="meta-item"><span>Created</span><span class="muted">${esc(c.RunningFor)}</span></span>`);
  // Reconnect the stream when the container comes back (e.g. after Restart), picking up where we left off.
  if (on && !logs.streaming && !busy) {
    appendLines([makeLine('out', '— container started —', true)]);
    startLogs(logs.lastTs ? { since: logs.lastTs } : { tail: 200 });
  }
  if (!on && d.wasRunning) appendLines([makeLine('out', '— container stopped —', true)]);
  d.wasRunning = on;
}

// ---------- render ----------
function renderEngine() {
  const e = state.engine, dot = $('engine-dot'), btn = $('engine-btn');
  btn.disabled = !!e?.missing;
  if (e?.missing) {
    dot.className = 'dot'; setEngineLabel('Colima not found');
    $('engine-meta').textContent = 'brew install colima docker'; btn.textContent = 'Unavailable';
  } else if (e?.running) {
    dot.className = 'dot on'; setEngineLabel('Engine running');
    const mem = e.memory ? `${Math.round(e.memory / 1024 ** 3)} GB` : '';
    $('engine-meta').textContent = [e.cpu && `${e.cpu} CPU`, mem, e.arch].filter(Boolean).join(' · ') || ' ';
    btn.textContent = 'Stop'; btn.classList.remove('primary');
  } else {
    dot.className = 'dot'; setEngineLabel('Engine stopped');
    $('engine-meta').textContent = ' '; btn.textContent = 'Start'; btn.classList.add('primary');
  }
}

const btn = (action, args, icon, label, extra = '') =>
  `<button class="btn icon ${extra}" title="${label}" aria-label="${label}" data-action="${action}" data-args='${esc(JSON.stringify(args))}'>${icon}</button>`;

function ports(str) {
  // "0.0.0.0:8080->80/tcp, :::8080->80/tcp" -> unique clickable host ports
  const seen = new Set();
  return (str || '').split(',').map((p) => p.trim().match(/:(\d+)->(\d+)\/(\w+)/)).filter(Boolean)
    .filter((m) => !seen.has(m[1]) && seen.add(m[1]))
    .map((m) => `<a class="port" data-action="open" data-args='${esc(JSON.stringify([`http://localhost:${m[1]}`]))}'>${m[1]}:${m[2]}</a>`).join(', ') || '<span class="muted">—</span>';
}

function statusBadge(c) {
  const st = (c.State || '').toLowerCase();
  const label = st === 'exited' ? `Exited${(c.Status.match(/\((\d+)\)/) || [])[1] ? ` (${c.Status.match(/\((\d+)\)/)[1]})` : ''}` : st[0]?.toUpperCase() + st.slice(1);
  return `<span class="badge ${esc(st)}">${esc(label)}</span>`;
}
// "Up 59 minutes (healthy)" -> "59 minutes · healthy"; "Exited (0) 9 minutes ago" -> "9 minutes ago"
const statusDetail = (s) => s.replace(/^Up\s+/, '').replace(/^Exited \(\d+\)\s*/, '').replace(/\s*\((\w+)\)$/, ' · $1');

const match = (...fields) => !state.filter || fields.some((f) => str(f).toLowerCase().includes(state.filter));

function emptyView(title, text, withStart) {
  return `<div class="empty"><h2>${title}</h2><p>${text}</p>${withStart ? '<button class="btn primary" data-action="engineToggle" data-args="[]">Start Colima</button>' : ''}</div>`;
}

const VIEWS = {
  containers() {
    const rows = state.containers.filter((c) => match(c.Names, c.Image, c.ID));
    $('subtitle').textContent = `${state.containers.filter((c) => c.State === 'running').length} running · ${state.containers.length} total`;
    if (!rows.length) return emptyView(state.filter ? 'No matches' : 'No containers', state.filter ? 'Try a different search.' : 'Run <span class="mono">docker run</span> to create one.');
    return `<table><thead><tr><th style="width:22%">Name</th><th style="width:15%">Image</th><th style="width:11%">Port(s)</th><th style="width:8%">CPU</th><th style="width:9%">Memory</th><th>Status</th><th style="width:128px"></th></tr></thead><tbody>${rows.map((c) => {
      const on = c.State === 'running', busy = state.busy.has(c.ID), s = state.stats[short(c.ID)], a = [c.ID, c.Names];
      return `<tr class="clickable" data-action="detail" data-args='${esc(JSON.stringify([c.ID]))}'>
        <td><div class="name"><span class="dot ${busy ? 'busy' : on ? 'on' : ''}"></span><span class="name-text"><b title="${esc(c.Names)}">${esc(c.Names)}</b><small>${esc(short(c.ID))}</small></span></div></td>
        <td class="muted" title="${esc(c.Image)}">${esc(c.Image)}</td>
        <td>${ports(c.Ports)}</td>
        <td class="num muted">${on && s ? esc(s.CPUPerc) : '—'}</td>
        <td class="num muted">${on && s ? esc(s.MemUsage.split(' / ')[0]) : '—'}</td>
        <td><div class="status-cell">${statusBadge(c)}<small title="${esc(c.Status)}">${esc(statusDetail(c.Status))}</small></div></td>
        <td><span class="actions">${busy ? `<span class="btn icon">${ICON.spin}</span>` :
          (on ? btn('stop', a, ICON.stop, 'Stop') : btn('start', a, ICON.play, 'Start')) +
          (on ? btn('restart', a, ICON.restart, 'Restart') : '') +
          btn('detail', [c.ID], ICON.logs, 'Logs') +
          btn('rm', a, ICON.trash, 'Delete', 'danger')}</span></td></tr>`;
    }).join('')}</tbody></table>`;
  },
  images() {
    const rows = state.images.filter((i) => match(i.Repository, i.Tag, i.ID));
    $('subtitle').textContent = `${state.images.length} images`;
    if (!rows.length) return emptyView(state.filter ? 'No matches' : 'No images', state.filter ? 'Try a different search.' : 'Pull one with <span class="mono">docker pull</span>.');
    const used = new Set(state.containers.map((c) => c.Image));
    return `<table><thead><tr><th style="width:34%">Name</th><th style="width:14%">Tag</th><th style="width:16%">Image ID</th><th>Created</th><th style="width:10%">Size</th><th style="width:56px"></th></tr></thead><tbody>${rows.map((i) => {
      const ref = i.Repository === '<none>' || i.Tag === '<none>' ? i.ID : `${i.Repository}:${i.Tag}`, inUse = used.has(ref) || used.has(i.Repository);
      return `<tr>
        <td><div class="name"><span class="dot ${inUse ? 'on' : ''}" title="${inUse ? 'In use' : 'Unused'}"></span><span class="name-text"><b title="${esc(i.Repository)}">${esc(i.Repository)}</b></span></div></td>
        <td class="muted">${esc(i.Tag)}</td><td class="mono muted">${esc(short(i.ID))}</td>
        <td class="muted">${esc(i.CreatedSince)}</td><td class="num muted">${esc(i.Size)}</td>
        <td><span class="actions">${state.busy.has(ref) ? `<span class="btn icon">${ICON.spin}</span>` : btn('rmi', [ref, ref], ICON.trash, 'Delete', 'danger')}</span></td></tr>`;
    }).join('')}</tbody></table>`;
  },
  volumes() {
    const rows = state.volumes.filter((v) => match(v.Name));
    $('subtitle').textContent = `${state.volumes.length} volumes`;
    if (!rows.length) return emptyView(state.filter ? 'No matches' : 'No volumes', state.filter ? 'Try a different search.' : 'Volumes created by containers appear here.');
    return `<table><thead><tr><th style="width:38%">Name</th><th style="width:10%">Driver</th><th>Mountpoint</th><th style="width:56px"></th></tr></thead><tbody>${rows.map((v) => `<tr>
        <td><div class="name"><span class="name-text"><b title="${esc(v.Name)}">${esc(v.Name)}</b></span></div></td><td class="muted">${esc(v.Driver)}</td><td class="mono muted">${esc(v.Mountpoint)}</td>
        <td><span class="actions">${state.busy.has(v.Name) ? `<span class="btn icon">${ICON.spin}</span>` : btn('rmv', [v.Name, v.Name], ICON.trash, 'Delete', 'danger')}</span></td></tr>`).join('')}</tbody></table>`;
  },
};

function render() {
  setCount($('n-containers'), state.containers.length);
  setCount($('n-images'), state.images.length);
  setCount($('n-volumes'), state.volumes.length);
  if (state.detail) { renderDetail(); return; }
  $('title').textContent = state.view[0].toUpperCase() + state.view.slice(1);
  const e = state.engine;
  if (!e) { setHTML($('content'), ''); return; }
  if (!e.running) {
    $('subtitle').textContent = '';
    setHTML($('content'), e.missing
      ? emptyView('Colima isn’t installed', 'Install it with <span class="mono">brew install colima docker</span>, then reopen this app.')
      : emptyView('Engine stopped', 'Start Colima to see your containers, images and volumes.', true));
    return;
  }
  setHTML($('content'), VIEWS[state.view]());
  if (enterRows && $('content').querySelector('tbody tr, .empty')) { enterRows = false; I.rows($('content')); }
}
let enterRows = true; // stagger rows in on first load and after each view switch

// ---------- events ----------
$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  closeDetail();
  state.view = b.dataset.view;
  document.querySelectorAll('#nav button').forEach((x) => x.setAttribute('aria-current', x === b));
  I.navPill($('nav'), b);
  enterRows = true; $('scroll').scrollTop = 0; render();
});
// One delegated handler for every data-action in the page; buttons inside a clickable row win over the row.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]'); if (!el || el.closest('nav')) return;
  if (getSelection().toString() && el.tagName === 'TR') return;
  e.stopPropagation();
  actions[el.dataset.action](...JSON.parse(el.dataset.args));
});
$('search').addEventListener('input', (e) => { state.filter = e.target.value.trim().toLowerCase(); render(); });
$('scroll').addEventListener('scroll', (e) => $('header').classList.toggle('scrolled', e.target.scrollTop > 0));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.detail && document.activeElement !== $('log-search')) closeDetail();
  if (e.key === 'f' && e.metaKey) {
    e.preventDefault();
    const f = state.detail && state.tab === 'logs' ? $('log-search') : $('search');
    f.focus(); f.select();
  }
  if (e.key === 'k' && e.metaKey && state.detail) { e.preventDefault(); $('log-clear').click(); }
});

// Poll like Docker Desktop does; skip while the window is hidden.
async function tick() {
  if (document.hidden) return;
  await refreshEngine(); await refreshDocker();
}
I.navPill($('nav'), document.querySelector('#nav button[aria-current="true"]'));
tick().then(refreshStats);
setInterval(tick, 3000);
setInterval(refreshStats, 5000);
