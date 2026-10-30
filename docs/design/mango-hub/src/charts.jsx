// Minimal analytics primitives: seeded series, LineChart w/ comparison tooltip, MetricCard, ListCard, FilterPills, SetupGuide
const { useState: useStateCh, useRef: useRefCh, useEffect: useEffectCh, useMemo: useMemoCh } = React;

const TODAY = new Date(2026, 8, 29);
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtDay = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const fmtDate = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

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
// Marcas del eje: las cuatro partes de niceMax si las etiquetas las pueden decir; si no, paso de 1, 2 o 5 y el tope sube a su marca siguiente.
// Invocaciones sin decimales; USD por debajo de 10 con céntimos (hasta 3 decimales).
const axisTicks = (vmax, money) => {
  const max = niceMax(vmax * 1.05), q = max / 4, dec = money && max < 10 ? 3 : 0;
  const fits = (v) => Math.abs(v * Math.pow(10, dec) - Math.round(v * Math.pow(10, dec))) < 1e-9;
  if (fits(q)) return [0, 1, 2, 3, 4].map(k => k * q);
  let step = 0; for (let e = -dec; !step; e++) for (const m of [1, 2, 5]) { const s = m * Math.pow(10, e); if (s >= q) { step = s; break; } }
  const top = Math.max(step, Math.ceil(vmax / step - 1e-9) * step), out = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
};
const fmtTick = (v, money, top) => money && top < 10 ? (v === 0 ? 'USD 0' : 'USD ' + v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 3 })) : fmtCompact(v, money);
const fmtCompact = (v, money) => (money ? 'USD ' : '') + (v >= 1e6 ? (v / 1e6).toFixed(1).replace('.0', '') + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace('.0', '') + 'K' : Math.round(v));

function LineChart({ series, money, compare = true, height = 200, label, format, since, noStart }) {
  const wrap = useRefCh(null);
  const [w, setW] = useStateCh(480);
  const [hover, setHover] = useStateCh(null);
  React.useLayoutEffect(() => { if (!wrap.current) return; setW(Math.max(200, wrap.current.getBoundingClientRect().width)); const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width))); ro.observe(wrap.current); return () => ro.disconnect(); }, []);
  const { cur, prev, dates, prevDates } = series;
  const axisW = 48, padT = 8, padB = 24, H = height, plotW = w - axisW, plotH = H - padT - padB;
  const vals = [...cur, ...(compare ? prev : [])].filter(v => v != null);
  const ticks = axisTicks(Math.max(0, ...vals), money), max = ticks[ticks.length - 1];
  const x = (i) => (i / (cur.length - 1)) * (plotW - 4) + 2;
  const y = (v) => padT + plotH - (v / max) * plotH;
  const path = (arr) => { let d = '', pen = false; arr.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; }); return d; };
  const fmt = format || ((v) => money && window.GovKit ? window.GovKit.usd(v) : Math.round(v).toLocaleString('es-ES'));
  const first = cur.findIndex(v => v != null);
  const curPts = cur.filter(v => v != null).length;
  const gapW = first > 0 ? x(first) : first < 0 ? plotW : 0;
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - 2) / (plotW - 4)) * (cur.length - 1));
    setHover(Math.max(0, Math.min(cur.length - 1, i)));
  };
  const hv = hover != null ? { i: hover, c: cur[hover], p: prev[hover] } : null;
  const delta = hv && hv.c != null && hv.p ? ((hv.c - hv.p) / hv.p) * 100 : null;
  const none = 'Sin datos';
  const pid = 'hatch-' + (label || 'c').replace(/\W/g, '');
  return (
    <div ref={wrap} style={{ position: 'relative', width: '100%' }}>
      <svg width={w} height={H} role="img" aria-label={(label || 'Gráfico de línea') + (noStart ? ' · todavía sin datos' : since && first !== 0 ? ' · cuenta desde el ' + fmtDate(since) : '')} style={{ display: 'block', overflow: 'visible' }}>
        <defs><pattern id={pid} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" strokeWidth="2" /></pattern></defs>
        {ticks.map((t, k) => (
          <g key={k}>
            <line x1={0} x2={plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={w} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTick(t, money, max)}</text>
          </g>
        ))}
        {gapW > 0 && <g aria-hidden="true">
          <rect x={0} y={padT} width={gapW} height={plotH} fill={`url(#${pid})`} opacity="0.8" />
          {first > 0 && <line x1={x(first)} x2={x(first)} y1={padT} y2={padT + plotH} stroke="var(--text-muted)" strokeDasharray="3 3" />}
          {gapW > 72 && <text x={gapW / 2} y={padT + plotH / 2 + 4} textAnchor="middle" fontSize="11.5" fill="var(--text-muted)">{none}</text>}
        </g>}
        {compare && <path d={path(prev)} fill="none" stroke="var(--chart-muted)" strokeWidth="1.5" strokeDasharray="2 4" strokeLinecap="round" />}
        <path d={path(cur)} fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinejoin="round" />
        {curPts === 1 && <circle cx={x(first)} cy={y(cur[first])} r="3.5" fill="var(--accent)" />}
        {hv && <>
          <line x1={x(hv.i)} x2={x(hv.i)} y1={padT} y2={padT + plotH} stroke="var(--text-muted)" strokeDasharray="2 3" />
          {compare && hv.p != null && <circle cx={x(hv.i)} cy={y(hv.p)} r="4" fill="var(--chart-muted)" stroke="var(--card)" strokeWidth="2" />}
          {hv.c != null && <circle cx={x(hv.i)} cy={y(hv.c)} r="4.5" fill="var(--accent)" stroke="var(--card)" strokeWidth="2" />}
        </>}
        <text x={2} y={H - 4} fontSize="11" fill="var(--text-muted)">{fmtDay(dates[0])}</text>
        <text x={plotW - 2} y={H - 4} fontSize="11" fill="var(--text-muted)" textAnchor="end">{fmtDay(dates[dates.length - 1])}</text>
        <rect x={0} y={0} width={plotW} height={padT + plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hv && (
        <div role="tooltip" style={{ position: 'absolute', top: Math.max(0, Math.min((hv.c != null ? y(hv.c) : padT + plotH / 2) - 20, H - 110)), left: x(hv.i) > plotW * 0.55 ? undefined : x(hv.i) + 14, right: x(hv.i) > plotW * 0.55 ? w - x(hv.i) + 14 : undefined, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow)', padding: '10px 12px', fontSize: 12.5, pointerEvents: 'none', minWidth: 190, maxWidth: 260, zIndex: 5 }}>
          <div className="row between" style={{ marginBottom: 6, gap: 16 }}>
            <span style={{ fontWeight: 500 }}>{label}</span>
            {compare && delta != null && <span style={{ color: delta >= 0 ? 'var(--green)' : 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}%</span>}
          </div>
          <div className="row between" style={{ gap: 16 }}><span className="row gap-2"><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--accent)' }} /><span style={{ color: 'var(--text-muted)' }}>{fmtDay(dates[hv.i])}</span></span><span style={{ fontVariantNumeric: 'tabular-nums', color: hv.c == null ? 'var(--text-muted)' : undefined }}>{hv.c == null ? none : fmt(hv.c)}</span></div>
          {compare && <div className="row between" style={{ gap: 16, marginTop: 4 }}><span className="row gap-2"><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--chart-muted)' }} /><span style={{ color: 'var(--text-muted)' }}>{fmtDay(prevDates[hv.i])}</span></span><span style={{ fontVariantNumeric: 'tabular-nums', color: hv.p == null ? 'var(--text-muted)' : undefined }}>{hv.p == null ? none : fmt(hv.p)}</span></div>}
          {noStart && <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12 }}>Mango todavía no tiene datos. Empieza a contar con el primer turno.</div>}
          {since && !noStart && (hv.c == null || (compare && hv.p == null)) && <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12 }}>Mango cuenta desde el {fmtDate(since)}. Antes no hay datos, no es que no hubiera gasto.</div>}
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
    <div className="row between" style={{ marginTop: 'auto', paddingTop: 16, fontSize: 12.5, color: 'var(--text-muted)', gap: 12 }}>
      <span>{updated}</span>
      {more && <button onClick={onMore} className="link-muted">{more}</button>}
    </div>
  );
}

// Valores null = días antes de que Mango empezara a contar (since). No se suman ni se dibujan.
function MetricCard({ title, info, series, money, compare = true, goodWhen = 'up', format, updated = 'Actualizado hace unos segundos', more = 'Ver detalles', onMore, onExport, since, noStart }) {
  const I = window.Icons;
  const nn = (a) => a.filter(v => v != null);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const cur = nn(series.cur), prev = nn(series.prev);
  const agg = (a) => format === 'avg' ? (a.length ? sum(a) / a.length : 0) : sum(a);
  const total = agg(cur), prevT = agg(prev);
  const prevFull = prev.length === series.prev.length;
  const partial = cur.length < series.cur.length || (compare && !prevFull);
  const canPct = compare && prevFull && prevT > 0 && cur.length > 0;
  const d = canPct ? ((total - prevT) / prevT) * 100 : 0;
  const good = goodWhen === 'up' ? d >= 0 : d <= 0;
  const show = (v) => money && window.GovKit ? window.GovKit.usd(v) : (format === 'avg' ? Math.round(v).toLocaleString('es-ES') + ' ms' : v.toLocaleString('es-ES', { maximumFractionDigits: 0 }));
  const big = (v) => money && v >= 10000 ? 'USD ' + (v / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + 'k' : show(v);
  return (
    <section className="card metric-card">
      <div className="row between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="row gap-2" style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>{title}{info && <InfoDot text={info} />}</h2>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <span title={money && window.GovKit && cur.length ? window.GovKit.usd(total) : undefined} style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{cur.length ? big(total) : '—'}</span>
            {canPct && <span style={{ fontSize: 13, fontWeight: 500, color: good ? 'var(--green)' : 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>{d >= 0 ? '+' : ''}{d.toLocaleString('es-ES', { maximumFractionDigits: 1 })}%</span>}
          </div>
          {compare && prevFull && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{big(prevT)} periodo anterior</div>}
          {partial && since && !noStart && <div className="dash-since" title={compare && !prevFull ? 'No hay datos de todo el periodo anterior, así que no se compara.' : undefined}>Cuenta desde el {fmtDate(since)}</div>}
        </div>
        <button className="btn btn-icon" aria-label={'Exportar ' + title} title="Exportar" onClick={onExport}><I.Share size={13} /></button>
      </div>
      <div style={{ marginTop: 18 }}><LineChart series={series} money={money} compare={compare} label={title} since={since} noStart={noStart} format={format === 'avg' ? (v) => Math.round(v) + ' ms' : undefined} /></div>
      <CardFooter updated={updated} more={more} onMore={onMore} />
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
          <button key={i} onClick={r.onClick} disabled={!r.onClick} className="row between list-row" style={{ width: '100%', padding: '13px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5, textAlign: 'left', cursor: r.onClick ? 'pointer' : 'default', gap: 12 }}>
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

// «Quitar» es un botón propio al lado del de la píldora (no un control dentro de otro).
function Pill({ label, value, options, onChange, removable, onRemove }) {
  const I = window.Icons;
  const [open, setOpen] = useStateCh(false);
  const cur = options.find(o => o[0] === value);
  const main = <>
    {label && <><span>{label}</span><span className="filter-pill-sep" /></>}
    <span style={{ color: 'var(--accent-ink)', fontWeight: 500 }}>{cur ? cur[1] : '—'}</span>
    <I.ChevronDown size={12} style={{ color: 'var(--accent-ink)' }} />
  </>;
  return (
    <div style={{ position: 'relative' }}>
      {removable
        ? <div className="filter-pill filter-pill-split"><button className="fp-x" aria-label={'Quitar ' + label} title={'Quitar ' + label} onClick={onRemove}><I.X2 size={13} /></button><button className="fp-main" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(v => !v)}>{main}</button></div>
        : <button className="filter-pill" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(v => !v)}>{main}</button>}
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

Object.assign(window, { CHART_TODAY: TODAY, fmtDate, makeSeries, LineChart, MetricCard, ListCard, FilterPills, SetupGuide, InfoDot });
