// Minimal analytics primitives: seeded series, LineChart w/ comparison tooltip, MetricCard, ListCard, FilterPills, SetupGuide
const { useState: useStateCh, useRef: useRefCh, useEffect: useEffectCh, useMemo: useMemoCh } = React;

const TODAY = new Date(2026, 8, 29);
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtDay = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Build current + previous series for a period. shape: 'grow' | 'spiky' | 'flat' | 'down'
function makeSeries({ seed = 1, period = '30d', gran = 'day', base = 100, growth = 0.6, noise = 0.25, shape = 'grow' }) {
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 180;
  const step = gran === 'week' ? 7 : 1;
  const n = Math.max(2, Math.floor(days / step));
  const r = rng(seed * 97 + days + step);
  const gen = (scale, g) => Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    let trend = shape === 'down' ? 1 - g * t * 0.5 : shape === 'flat' ? 1 : 1 + g * Math.pow(t, 1.4);
    let v = base * scale * trend * (1 + (r() - 0.5) * noise * 2);
    if (shape === 'spiky' && r() > 0.82) v *= 1.6 + r();
    return Math.max(0, v * step);
  });
  const cur = gen(1, growth);
  const prev = gen(0.62, growth * 0.5);
  const dates = Array.from({ length: n }, (_, i) => { const d = new Date(TODAY); d.setDate(d.getDate() - (n - 1 - i) * step); return d; });
  const prevDates = dates.map(d => { const x = new Date(d); x.setDate(x.getDate() - days); return x; });
  return { cur, prev, dates, prevDates };
}

const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
const fmtCompact = (v, money) => (money ? 'USD ' : '') + (v >= 1e6 ? (v / 1e6).toFixed(1).replace('.0', '') + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace('.0', '') + 'K' : Math.round(v));

function LineChart({ series, money, compare = true, height = 200, label, format }) {
  const wrap = useRefCh(null);
  const [w, setW] = useStateCh(480);
  const [hover, setHover] = useStateCh(null);
  React.useLayoutEffect(() => { if (!wrap.current) return; setW(Math.max(200, wrap.current.getBoundingClientRect().width)); const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width))); ro.observe(wrap.current); return () => ro.disconnect(); }, []);
  const { cur, prev, dates, prevDates } = series;
  const axisW = 48, padT = 8, padB = 24, H = height, plotW = w - axisW, plotH = H - padT - padB;
  const max = niceMax(Math.max(...cur, ...(compare ? prev : [0])) * 1.05);
  const x = (i) => (i / (cur.length - 1)) * (plotW - 4) + 2;
  const y = (v) => padT + plotH - (v / max) * plotH;
  const path = (arr) => arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => t * max);
  const fmt = format || ((v) => money && window.GovKit ? window.GovKit.usd(v) : Math.round(v).toLocaleString('es-ES'));
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - 2) / (plotW - 4)) * (cur.length - 1));
    setHover(Math.max(0, Math.min(cur.length - 1, i)));
  };
  const hv = hover != null ? { i: hover, c: cur[hover], p: prev[hover] } : null;
  const delta = hv && hv.p ? ((hv.c - hv.p) / hv.p) * 100 : 0;
  return (
    <div ref={wrap} style={{ position: 'relative', width: '100%' }}>
      <svg width={w} height={H} role="img" aria-label={label || 'Gráfico de línea'} style={{ display: 'block', overflow: 'visible' }}>
        {ticks.map((t, k) => (
          <g key={k}>
            <line x1={0} x2={plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={k === 0 ? '0' : '0'} />
            <text x={w} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(t, money)}</text>
          </g>
        ))}
        {compare && <path d={path(prev)} fill="none" stroke="var(--chart-muted)" strokeWidth="1.5" strokeDasharray="2 4" strokeLinecap="round" />}
        <path d={path(cur)} fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinejoin="round" />
        {hv && <>
          <line x1={x(hv.i)} x2={x(hv.i)} y1={padT} y2={padT + plotH} stroke="var(--text-muted)" strokeDasharray="2 3" />
          {compare && <circle cx={x(hv.i)} cy={y(hv.p)} r="4" fill="var(--chart-muted)" stroke="var(--card)" strokeWidth="2" />}
          <circle cx={x(hv.i)} cy={y(hv.c)} r="4.5" fill="var(--accent)" stroke="var(--card)" strokeWidth="2" />
        </>}
        <text x={2} y={H - 4} fontSize="11" fill="var(--text-muted)">{fmtDay(dates[0])}</text>
        <text x={plotW - 2} y={H - 4} fontSize="11" fill="var(--text-muted)" textAnchor="end">{fmtDay(dates[dates.length - 1])}</text>
        <rect x={0} y={0} width={plotW} height={padT + plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hv && (
        <div role="tooltip" style={{ position: 'absolute', top: Math.max(0, Math.min(y(hv.c) - 20, H - 110)), left: x(hv.i) > plotW * 0.55 ? undefined : x(hv.i) + 14, right: x(hv.i) > plotW * 0.55 ? w - x(hv.i) + 14 : undefined, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow)', padding: '10px 12px', fontSize: 12.5, pointerEvents: 'none', minWidth: 190, zIndex: 5 }}>
          <div className="row between" style={{ marginBottom: 6, gap: 16 }}>
            <span style={{ fontWeight: 500 }}>{label}</span>
            {compare && <span style={{ color: delta >= 0 ? 'var(--green)' : 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}%</span>}
          </div>
          <div className="row between" style={{ gap: 16 }}><span className="row gap-2"><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--accent)' }} /><span style={{ color: 'var(--text-muted)' }}>{fmtDay(dates[hv.i])}</span></span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(hv.c)}</span></div>
          {compare && <div className="row between" style={{ gap: 16, marginTop: 4 }}><span className="row gap-2"><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--chart-muted)' }} /><span style={{ color: 'var(--text-muted)' }}>{fmtDay(prevDates[hv.i])}</span></span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(hv.p)}</span></div>}
        </div>
      )}
    </div>
  );
}

function InfoDot({ text }) {
  const I = window.Icons;
  return <span title={text} aria-label={text} role="img" style={{ display: 'inline-flex', color: 'var(--text-muted)', cursor: 'help' }}><I.Info size={13} /></span>;
}

function CardFooter({ updated, more, onMore }) {
  return (
    <div className="row between" style={{ marginTop: 'auto', paddingTop: 16, fontSize: 12.5, color: 'var(--text-muted)' }}>
      <span>{updated}</span>
      {more && <button onClick={onMore} className="link-muted">{more}</button>}
    </div>
  );
}

function MetricCard({ title, info, series, money, compare = true, goodWhen = 'up', format, updated = 'Actualizado hace 4 s', onMore, onExport }) {
  const I = window.Icons;
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const total = format === 'avg' ? sum(series.cur) / series.cur.length : sum(series.cur);
  const prevT = format === 'avg' ? sum(series.prev) / series.prev.length : sum(series.prev);
  const d = prevT ? ((total - prevT) / prevT) * 100 : 0;
  const good = goodWhen === 'up' ? d >= 0 : d <= 0;
  const show = (v) => money && window.GovKit ? window.GovKit.usd(v) : (format === 'avg' ? Math.round(v).toLocaleString('es-ES') + ' ms' : v.toLocaleString('es-ES', { maximumFractionDigits: 0 }));
  return (
    <section className="card metric-card">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 className="row gap-2" style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>{title}{info && <InfoDot text={info} />}</h2>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <span title={money && window.GovKit ? window.GovKit.usd(total) : undefined} style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{money && total >= 10000 ? 'USD ' + (total / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + 'k' : show(total)}</span>
            {compare && <span style={{ fontSize: 13, fontWeight: 500, color: good ? 'var(--green)' : 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>{d >= 0 ? '+' : ''}{d.toLocaleString('es-ES', { maximumFractionDigits: 1 })}%</span>}
          </div>
          {compare && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{money && prevT >= 10000 ? 'USD ' + (prevT / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + 'k' : show(prevT)} periodo anterior</div>}
        </div>
        <button className="btn btn-icon" aria-label={'Exportar ' + title} title="Exportar" onClick={onExport}><I.Share size={13} /></button>
      </div>
      <div style={{ marginTop: 18 }}><LineChart series={series} money={money} compare={compare} label={title} format={format === 'avg' ? (v) => Math.round(v) + ' ms' : undefined} /></div>
      <CardFooter updated={updated} more="Ver detalles" onMore={onMore} />
    </section>
  );
}

function ListCard({ title, info, rows, updated, more, onMore, children }) {
  return (
    <section className="card metric-card">
      <h2 className="row gap-2" style={{ fontSize: 14, fontWeight: 500, margin: '0 0 8px' }}>{title}{info && <InfoDot text={info} />}</h2>
      {children}
      <div>
        {rows.map((r, i) => (
          <button key={i} onClick={r.onClick} disabled={!r.onClick} className="row between list-row" style={{ width: '100%', padding: '13px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5, textAlign: 'left', cursor: r.onClick ? 'pointer' : 'default' }}>
            <span className="row gap-3" style={{ minWidth: 0 }}>
              {r.color && <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: r.color, flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
              {r.sub && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{r.sub}</span>}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: r.tone || 'var(--text)' }}>{r.value}</span>
          </button>
        ))}
      </div>
      <CardFooter updated={updated} more={more} onMore={onMore} />
    </section>
  );
}

function Pill({ label, value, options, onChange, removable, onRemove }) {
  const I = window.Icons;
  const [open, setOpen] = useStateCh(false);
  const cur = options.find(o => o[0] === value);
  return (
    <div style={{ position: 'relative' }}>
      <button className="filter-pill" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {removable && <span role="button" tabIndex={0} aria-label={'Quitar ' + label} onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ display: 'inline-flex', color: 'var(--text-muted)' }}><I.X2 size={13} /></span>}
        {label && <><span>{label}</span><span className="filter-pill-sep" /></>}
        <span style={{ color: 'var(--accent-ink)', fontWeight: 500 }}>{cur ? cur[1] : '—'}</span>
        <I.ChevronDown size={12} style={{ color: 'var(--accent-ink)' }} />
      </button>
      {open && <>
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
        <div role="listbox" className="card" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 180, padding: 4, zIndex: 41, boxShadow: 'var(--shadow)' }}>
          {options.map(([k, l]) => (
            <button key={k} role="option" aria-selected={k === value} onClick={() => { onChange(k); setOpen(false); }} className="row between" style={{ width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 13, background: k === value ? 'var(--row-hover)' : 'transparent' }}>
              {l}{k === value && <I.Check size={12} style={{ color: 'var(--accent-ink)' }} />}
            </button>
          ))}
        </div>
      </>}
    </div>
  );
}

function FilterPills({ period, setPeriod, gran, setGran, compare, setCompare }) {
  return (
    <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
      <Pill label="Periodo" value={period} onChange={setPeriod} options={[['7d', 'Últimos 7 días'], ['30d', 'Últimos 30 días'], ['90d', 'Últimos 3 meses'], ['180d', 'Últimos 6 meses']]} />
      <Pill value={gran} onChange={setGran} options={[['day', 'Diario'], ['week', 'Semanal']]} />
      {compare
        ? <Pill label="Comparar" value="prev" removable onRemove={() => setCompare(false)} onChange={() => {}} options={[['prev', 'Periodo anterior']]} />
        : <button className="filter-pill" onClick={() => setCompare(true)}><span style={{ color: 'var(--text-muted)' }}>+ Comparar</span></button>}
    </div>
  );
}

function SetupGuide({ steps, onOpenTour, onGo }) {
  const I = window.Icons;
  const [hidden, setHidden] = useStateCh(() => localStorage.getItem('mango-setup-hidden') === '1');
  const done = steps.filter(s => s.done).length;
  const next = steps.find(s => !s.done);
  if (hidden || !next) return null;
  return (
    <aside className="card setup-guide" aria-label="Primeros pasos">
      <div className="row between">
        <span style={{ fontSize: 14, fontWeight: 500 }}>Primeros pasos</span>
        <span className="row gap-1">
          <button className="btn btn-ghost btn-icon" aria-label="Ver guía completa" title="Ver guía completa" onClick={onOpenTour}><I.Expand size={13} /></button>
          <button className="btn btn-ghost btn-icon" aria-label="Ocultar primeros pasos" onClick={() => { setHidden(true); localStorage.setItem('mango-setup-hidden', '1'); }}><I.Close size={13} /></button>
        </span>
      </div>
      <div role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={steps.length} aria-label={`${done} de ${steps.length} pasos`} style={{ height: 4, borderRadius: 2, background: 'var(--border)', margin: '10px 0 12px', overflow: 'hidden' }}>
        <div style={{ width: (done / steps.length) * 100 + '%', height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Siguiente: <button className="link-accent" onClick={() => onGo(next.view)}>{next.label}</button></div>
    </aside>
  );
}

Object.assign(window, { makeSeries, LineChart, MetricCard, ListCard, FilterPills, SetupGuide, InfoDot });
