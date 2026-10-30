// React + Motion "islands" mounted into the otherwise vanilla renderer. Bundled by esbuild into
// gen/islands.js and exposed as window.Islands; renderer.js calls these instead of touching the DOM
// nodes they own.
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { animate, stagger } from 'motion';
import { MotionConfig, motion, AnimatePresence } from 'motion/react';
import CountUp from './reactbits/CountUp';
import SpotlightCard from './reactbits/SpotlightCard';
import ShinyText from './reactbits/ShinyText';
import { fmtBytes, splitAmount, str } from '../lib/format';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const SPRING = { type: 'spring', stiffness: 520, damping: 38 };

const roots = new WeakMap();
const mount = (el, node) => {
  let root = roots.get(el);
  if (!root) { el.replaceChildren(); root = createRoot(el); roots.set(el, root); }
  root.render(<MotionConfig reducedMotion="user">{node}</MotionConfig>);
};

// ---------- rolling numbers ----------
// CountUp animates from wherever it currently is to `to`, so re-rendering with a new value rolls the digits.
function Roll({ to, decimals = 0, duration = 0.8 }) {
  return <CountUp to={to} from={0} decimals={decimals} mode="roll" trigger="load" easing="spring" duration={duration} />;
}

// "45.3MiB" rolls the 45.3 and keeps the unit static; anything non-numeric renders as text.
function Amount({ text, unitClass }) {
  const a = splitAmount(text);
  if (!a) return <>{str(text)}</>;
  return <><Roll to={a.value} decimals={a.decimals} />{a.unit && <span className={unitClass}>{a.unit}</span>}</>;
}

// ---------- engine label ----------
function EngineLabel({ text, busy }) {
  if (!busy || reduced()) return <>{text}</>;
  const d = dark();
  return <ShinyText text={text} speed={1.4} color={d ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.45)'} shineColor={d ? '#fff' : '#000'} shineWidth={50} />;
}

// ---------- stats panel ----------
const W = 300, H = 56;

function Sparkline({ points, field, format, onHover }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  if (points.length < 2) return <div className="note">Collecting samples…</div>;
  const max = Math.max(...points.map((p) => p[field])) * 1.1 || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - (p[field] / max) * H]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const move = (e) => {
    const r = ref.current.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - r.left) / r.width) * (points.length - 1))));
    setHover(i);
    const p = points[i];
    onHover(`${new Date(p.t).toLocaleTimeString([], { hour12: false })} · ${format(p[field])}`);
  };
  const leave = () => { setHover(null); onHover(''); };
  const hx = hover === null ? 0 : (hover / (points.length - 1)) * W;
  return (
    <svg ref={ref} className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={move} onMouseLeave={leave}>
      <defs>
        <clipPath id={`reveal-${field}`}>
          <motion.rect x="0" y="0" height={H} initial={{ width: 0 }} animate={{ width: W }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
        </clipPath>
      </defs>
      <line className="grid" x1="0" x2={W} y1={H} y2={H} vectorEffect="non-scaling-stroke" />
      <g clipPath={`url(#reveal-${field})`}>
        <motion.path className="area" initial={false} animate={{ d: `${line}L${W},${H}L0,${H}Z` }} transition={{ duration: 0.5 }} />
        <motion.path className="line" initial={false} animate={{ d: line }} transition={{ duration: 0.5 }} vectorEffect="non-scaling-stroke" />
      </g>
      {hover !== null && <line className="cross" x1={hx} x2={hx} y1="0" y2={H} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function Tile({ wide, title, index, children, withTip }) {
  const [tip, setTip] = useState('');
  return (
    <motion.div className={wide ? 'tile-cell wide' : 'tile-cell'}
      initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...SPRING, delay: index * 0.05 }}>
      <SpotlightCard className="tile" theme={dark() ? 'dark' : 'light'} spotlightColor="#0a84ff" intensity={0.35}
        spotlightSize={220} borderGlow={0.9} proximity={60}
        style={{ '--spotlight-card-surface': 'var(--card)', '--spotlight-card-border': 'var(--sep)', '--spotlight-card-shadow': 'none' }}>
        <h4>{title}</h4>
        {withTip && <span className="tip">{tip}</span>}
        {typeof children === 'function' ? children(setTip) : children}
      </SpotlightCard>
    </motion.div>
  );
}

function Empty({ title, text }) {
  return (
    <motion.div className="empty" style={{ gridColumn: '1/-1' }} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <h2>{title}</h2><p>{text}</p>
    </motion.div>
  );
}

function Stats({ status, s, history }) {
  if (status !== 'ok') {
    return status === 'collecting'
      ? <Empty title="Collecting stats…" text="The first sample arrives within a few seconds." />
      : <Empty title="Container isn’t running" text="Start it to see live resource usage." />;
  }
  const pair = (v) => str(v).split(' / ');
  const [memUsed, memLimit] = pair(s.MemUsage), [netIn, netOut] = pair(s.NetIO), [blkIn, blkOut] = pair(s.BlockIO);
  const cpu = parseFloat(s.CPUPerc) || 0;
  return (
    <>
      <Tile wide title="CPU" index={0} withTip>{(tip) => <>
        <div className="big"><Roll to={Math.round(cpu * 10) / 10} decimals={1} /><small>%</small></div>
        <div className="note">Last {history.length} samples · 5 s interval</div>
        <Sparkline points={history} field="cpu" format={(v) => `${v.toFixed(1)}%`} onHover={tip} />
      </>}</Tile>
      <Tile wide title="Memory" index={1} withTip>{(tip) => <>
        <div className="big"><Amount text={memUsed} /><small>of {memLimit}</small></div>
        <div className="note">{str(s.MemPerc)} of limit</div>
        <Sparkline points={history} field="mem" format={fmtBytes} onHover={tip} />
      </>}</Tile>
      <Tile title="Network I/O" index={2}>
        <div className="big sm"><Amount text={netIn} /><small>in</small></div><div className="note">{netOut} out</div>
      </Tile>
      <Tile title="Disk I/O" index={3}>
        <div className="big sm"><Amount text={blkIn} /><small>read</small></div><div className="note">{blkOut} written</div>
      </Tile>
      <Tile title="Processes" index={4}>
        <div className="big sm"><Amount text={s.PIDs} /></div><div className="note">PIDs</div>
      </Tile>
    </>
  );
}

// ---------- vanilla-DOM motion helpers ----------
const slide = (el, x) => !reduced() && el && animate(el, { opacity: [0, 1], x: [x, 0] }, { duration: 0.28, ease: [0.22, 1, 0.36, 1] });

window.Islands = {
  /** Sidebar counts: roll to the new number; blank when zero. */
  count(el, n) { mount(el, n ? <Roll to={n} duration={0.6} /> : null); },

  engineLabel(el, text, busy) { mount(el, <EngineLabel text={text} busy={busy} />); },

  /** Stats tab. `key` (container id) restarts the entrance animation when switching containers. */
  stats(el, key, props) { mount(el, <AnimatePresence mode="wait"><Stats key={key + props.status} {...props} /></AnimatePresence>); },

  /** Stagger table rows in after a view switch. */
  rows(container) {
    if (reduced()) return;
    const rows = [...container.querySelectorAll('tbody tr, .empty')].slice(0, 40);
    if (rows.length) animate(rows, { opacity: [0, 1], y: [6, 0] }, { delay: stagger(0.018), duration: 0.3, ease: [0.22, 1, 0.36, 1] });
  },

  openDetail(el) { slide(el, 18); },
  closeDetail(el) { slide(el, -14); },

  /** Springy selection pill behind the active sidebar item. */
  navPill(nav, button) {
    let pill = nav.querySelector('.nav-pill');
    const target = { y: button.offsetTop, height: button.offsetHeight };
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'nav-pill';
      nav.prepend(pill); nav.classList.add('has-pill');
      Object.assign(pill.style, { transform: `translateY(${target.y}px)`, height: `${target.height}px` });
      return;
    }
    if (reduced()) { Object.assign(pill.style, { transform: `translateY(${target.y}px)` }); return; }
    animate(pill, { y: target.y, height: target.height }, { type: 'spring', stiffness: 600, damping: 40 });
  },

  tab(el) { !reduced() && el && animate(el, { opacity: [0, 1], y: [4, 0] }, { duration: 0.2 }); },
};
