// Costos — gasto en Bedrock por agente, modelo, equipo y origen
function CostsView({ agents }) {
  const I = window.Icons; const S = window.MangoStore;
  const toast = window.useToast?.();
  window.useMango(s => s.budgets); window.useMango(s => s.schedules); window.useMango(s => s.evals);
  const money = (n) => window.GovKit ? window.GovKit.usd(n) : '$' + n.toFixed(2);
  const kmoney = (n) => n >= 1000 ? 'USD ' + (n / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + 'k' : money(n);
  const [group, setGroup] = useState('agent');
  const [sel, setSel] = useState(null);
  const now = new Date(); const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); const day = now.getDate();
  const scheds = S.get().schedules || []; const evals = S.get().evals || [];
  const models = window.MangoData.models || [];
  const rows = agents.map((a, i) => {
    const spent = a.budget || 0;
    const prev = Math.round(spent * (0.75 + ((i * 37) % 50) / 100));
    const sch = scheds.filter(s => s.agent === a.id && s.status === 'active').length;
    const src = { chat: 0, schedules: Math.min(0.45, sch * 0.12), evals: evals.some(e => e.agent === a.id) ? 0.04 : 0, playground: 0.02 };
    src.chat = 1 - src.schedules - src.evals - src.playground;
    const m = models.find(x => x.short === a.model) || { inputPrice: 3, outputPrice: 15 };
    const perQ = (3000 * m.inputPrice + 800 * m.outputPrice) / 1e6;
    return { a, spent, prev, src, queries: Math.round(spent / perQ), perQ, proj: day >= 5 ? spent / day * days : null };
  });
  const total = rows.reduce((s, r) => s + r.spent, 0), prevTotal = rows.reduce((s, r) => s + r.prev, 0);
  const projTotal = day >= 5 ? total / day * days : null;
  const assigned = (S.get().budgets || []).filter(b => b.scope === 'team').reduce((s, b) => s + b.limit, 0);
  const groups = {
    agent: rows.map(r => ({ key: r.a.id, label: r.a.name, sub: r.a.cat + ' · ' + r.a.model, v: r.spent, p: r.prev })),
    model: Object.values(rows.reduce((m, r) => { const k = r.a.model; m[k] = m[k] || { key: k, label: k, sub: (models.find(x => x.short === k)?.provider || '') + ' · vía Bedrock', v: 0, p: 0, n: 0 }; m[k].v += r.spent; m[k].p += r.prev; m[k].n++; return m; }, {})).map(x => ({ ...x, sub: x.sub + ' · ' + x.n + (x.n === 1 ? ' agente' : ' agentes') })),
    team: Object.values(rows.reduce((m, r) => { const k = r.a.cat; m[k] = m[k] || { key: k, label: k, sub: '', v: 0, p: 0, n: 0 }; m[k].v += r.spent; m[k].p += r.prev; m[k].n++; return m; }, {})).map(x => ({ ...x, sub: x.n + (x.n === 1 ? ' agente' : ' agentes') })),
    source: [['chat', 'Conversaciones', 'Lo que piden los usuarios'], ['schedules', 'Schedules', 'Tareas programadas'], ['evals', 'Evals', 'Juez y ejecución de suites'], ['playground', 'Playground', 'Pruebas antes de publicar']].map(([k, l, d]) => ({ key: k, label: l, sub: d, v: rows.reduce((s, r) => s + r.spent * r.src[k], 0), p: rows.reduce((s, r) => s + r.prev * r.src[k], 0) })),
  };
  const list = [...groups[group]].sort((x, y) => y.v - x.v);
  const max = Math.max(1, ...list.map(x => x.v));
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const daily = Array.from({ length: days }, (_, i) => { if (i >= day) return null; const d = new Date(now.getFullYear(), now.getMonth(), i + 1).getDay(); return (d === 0 || d === 6 ? 0.4 : 1) * (0.8 + rnd() * 0.4); });
  const dsum = daily.reduce((s, x) => s + (x || 0), 0) || 1;
  const dvals = daily.map(x => x == null ? null : x / dsum * total);
  const dmax = Math.max(...dvals.filter(Boolean), 1);
  const movers = rows.map(r => ({ r, d: r.spent - r.prev })).filter(x => x.r.prev > 0).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 4);
  const cheaper = rows.filter(r => /Opus/.test(r.a.model) && r.spent > 500).map(r => { const alt = models.find(m => m.short === 'Sonnet 4.6'); const m = models.find(x => x.short === r.a.model); return alt && m ? { r, alt: alt.short, save: r.spent * (1 - (alt.inputPrice + alt.outputPrice) / (m.inputPrice + m.outputPrice)) } : null; }).filter(Boolean);
  const exportCsv = () => {
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const csv = ['agente,equipo,modelo,gasto_mes,mes_anterior,conversaciones,schedules,evals,playground,consultas_estimadas', ...rows.map(r => [r.a.name, r.a.cat, r.a.model, r.spent.toFixed(2), r.prev.toFixed(2), (r.spent * r.src.chat).toFixed(2), (r.spent * r.src.schedules).toFixed(2), (r.spent * r.src.evals).toFixed(2), (r.spent * r.src.playground).toFixed(2), r.queries].map(esc).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    const el = document.createElement('a'); el.href = url; el.download = 'mango-costos-' + now.toISOString().slice(0, 7) + '.csv'; el.click(); URL.revokeObjectURL(url);
    toast?.({ tone: 'success', msg: 'Costos exportados' });
  };
  const selRow = sel && rows.find(r => r.a.id === sel);
  const delta = (v, p) => { const d = p ? (v - p) / p * 100 : 0; return <span className="mono" style={{ fontSize: 11.5, color: d > 10 ? 'var(--red)' : d < -5 ? 'var(--green)' : 'var(--text-muted)' }}>{d >= 0 ? '+' : ''}{Math.round(d)}%</span>; };

  return (
    <>
      <Topbar crumbs={['Operación', 'Costos']} actions={<><button className="btn btn-sm" onClick={() => window.MangoNav?.('budgets')}>Presupuestos</button><button className="btn btn-sm" onClick={exportCsv}><I.Download size={12} /> Exportar CSV</button></>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Costos</h1>
          <p className="page-subtitle">Gasto en Amazon Bedrock de {now.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' })}, día {day} de {days}. Se calcula con los precios confirmados en Brains.</p>
        </div>
        <div className="bg-kpis">
          <div className="card bg-kpi"><span className="bg-kpi-l">Gasto del mes</span><span className="bg-kpi-v">{kmoney(total)}</span><span className="bg-kpi-s">{delta(total, prevTotal)} vs mes anterior ({kmoney(prevTotal)})</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Proyección a fin de mes</span><span className="bg-kpi-v">{projTotal ? kmoney(projTotal) : '—'}</span><span className="bg-kpi-s">{projTotal ? (assigned && projTotal > assigned ? 'Supera lo asignado a equipos' : 'Ritmo actual') : 'Menos de 5 días de datos'}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Costo medio por consulta</span><span className="bg-kpi-v">{money(total / Math.max(1, rows.reduce((s, r) => s + r.queries, 0)))}</span><span className="bg-kpi-s">{rows.reduce((s, r) => s + r.queries, 0).toLocaleString('es-ES', { useGrouping: 'always' })} consultas estimadas</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Mayor gasto</span><span className="bg-kpi-v" style={{ fontSize: 17 }}>{[...rows].sort((x, y) => y.spent - x.spent)[0]?.a.name}</span><span className="bg-kpi-s">{Math.round([...rows].sort((x, y) => y.spent - x.spent)[0]?.spent / total * 100)}% del total</span></div>
        </div>
        <div className="ob-grid co-grid" style={{ paddingTop: 16 }}>
          <div style={{ minWidth: 0 }}>
            <CostChart dvals={dvals} days={days} day={day} total={total} prevTotal={prevTotal} projTotal={projTotal} assigned={assigned} money={money} kmoney={kmoney} />
            <div className="row between" style={{ margin: '20px 0 8px', gap: 12, flexWrap: 'wrap' }}>
              <div className="mk-sec-t" style={{ margin: 0 }}>desglose</div>
              <div className="tk-quick">{[['agent', 'Por agente'], ['model', 'Por modelo'], ['team', 'Por equipo'], ['source', 'Por origen']].map(([k, l]) => <button key={k} className={group === k ? 'is-on' : ''} onClick={() => setGroup(k)}>{l}</button>)}</div>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="co-tr mc-th"><span>{({ agent: 'agente', model: 'modelo', team: 'equipo', source: 'origen' })[group]}</span><span>gasto del mes</span><span style={{ textAlign: 'right' }}>vs anterior</span><span style={{ textAlign: 'right' }}>% del total</span></div>
              {list.map(x => (
                <button key={x.key} className="co-tr" onClick={() => group === 'agent' && setSel(x.key)} style={group !== 'agent' ? { cursor: 'default' } : null}>
                  <span style={{ minWidth: 0 }}><span className="mk-name" style={{ display: 'block' }}>{x.label}</span><span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.sub}</span></span>
                  <span><span className="mk-bar-track" style={{ display: 'block', marginBottom: 4 }}><span style={{ width: x.v / max * 100 + '%', background: 'var(--accent)' }} /></span><span className="mono" style={{ fontSize: 12 }}>{money(x.v)}</span></span>
                  <span style={{ textAlign: 'right' }}>{delta(x.v, x.p)}</span>
                  <span className="mono mk-meta" style={{ textAlign: 'right' }}>{(x.v / total * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })}%</span>
                </button>
              ))}
            </div>
          </div>
          <aside className="ac-side">
            <div className="card" style={{ padding: 0 }}>
              <div className="ac-side-h">cambios frente al mes anterior</div>
              {movers.map(({ r, d }) => <button key={r.a.id} className="ac-ag" onClick={() => setSel(r.a.id)}><span className="row between" style={{ gap: 8 }}><span className="ac-ag-n">{r.a.name}</span><span className="mono" style={{ fontSize: 12, color: d > 0 ? 'var(--red)' : 'var(--green)' }}>{d > 0 ? '+' : '−'}{money(Math.abs(d))}</span></span></button>)}
            </div>
            {cheaper.length > 0 && <div className="card" style={{ padding: 0, marginTop: 12 }}>
              <div className="ac-side-h">oportunidades de ahorro</div>
              {cheaper.map(({ r, alt, save }) => <div key={r.a.id} style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 12.5, lineHeight: 1.5 }}><b style={{ fontWeight: 600 }}>{r.a.name}</b> usa {r.a.model}. Con {alt} gastaría ≈ <b className="mono">{money(save)}</b> menos al mes. <span className="mk-meta">Pruébalo en Playground antes de cambiarlo.</span></div>)}
            </div>}
            <div className="mk-meta" style={{ marginTop: 12, lineHeight: 1.5 }}>El origen del gasto y las consultas son estimaciones con datos de ejemplo. En producción vienen de las trazas de cada llamada.</div>
          </aside>
        </div>
      </div>
      {selRow && <CostAgent r={selRow} onClose={() => setSel(null)} money={money} />}
    </>
  );
}

function CostChart({ dvals, days, day, total, prevTotal, projTotal, assigned, money, kmoney }) {
  const [hov, setHov] = useState(null);
  const W = 720, H = 200, pl = 8, pr = 8, pt = 14, pb = 22;
  const cum = []; let acc = 0; dvals.forEach((v, i) => { if (v != null) { acc += v; cum[i] = acc; } });
  const prev = Array.from({ length: days }, (_, i) => prevTotal * Math.pow((i + 1) / days, 1.04));
  const top = Math.max(total, projTotal || 0, prevTotal, assigned || 0) * 1.08;
  const x = (i) => pl + i / (days - 1) * (W - pl - pr);
  const y = (v) => pt + (1 - v / top) * (H - pt - pb);
  const line = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const act = cum.map((v, i) => [x(i), y(v)]).filter(Boolean);
  const last = day - 1;
  const proj = projTotal ? [[x(last), y(cum[last])], [x(days - 1), y(projTotal)]] : null;
  const area = act.length ? line(act) + ' L' + x(last).toFixed(1) + ' ' + y(0) + ' L' + x(0) + ' ' + y(0) + ' Z' : '';
  const over = assigned && projTotal && projTotal > assigned;
  const hi = hov != null ? hov : last;
  const hv = hi <= last ? cum[hi] : (projTotal ? cum[last] + (projTotal - cum[last]) * (hi - last) / (days - 1 - last) : null);
  const onMove = (e) => { const r = e.currentTarget.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * W; setHov(Math.max(0, Math.min(days - 1, Math.round((px - pl) / (W - pl - pr) * (days - 1))))); };
  return (
    <div className="card co-chart">
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <div className="mk-sec-t" style={{ margin: 0 }}>gasto acumulado del mes</div>
          <div style={{ marginTop: 4 }}><b className="mono" style={{ fontSize: 18, color: 'var(--text-strong)' }}>{hv != null ? money(hv) : '—'}</b> <span className="mk-meta">{hi <= last ? 'al día ' + (hi + 1) : 'proyectado al día ' + (hi + 1)} · mes anterior {money(prev[hi])}</span></div>
        </div>
        <div className="co-legend"><span><i style={{ background: 'var(--accent)' }} />Este mes</span>{projTotal && <span><i className="dash" />Proyección</span>}<span><i style={{ background: 'var(--border-strong)' }} />Mes anterior</span>{assigned > 0 && <span><i className="lim" />Asignado a equipos</span>}</div>
      </div>
      <div style={{ position: 'relative' }}>
      {[0.25, 0.5, 0.75].map(f => <span key={f} className="co-ylab" style={{ top: (y(top * f) / H * 100) + '%' }}>{kmoney(top * f)}</span>)}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHov(null)} role="img" aria-label={`Gasto acumulado: ${money(total)} al día ${day}; proyección ${projTotal ? money(projTotal) : 'sin datos'}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs><linearGradient id="co-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".18" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map(f => <line key={f} x1={pl} x2={W - pr} y1={y(top * f)} y2={y(top * f)} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        <line x1={pl} x2={W - pr} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {assigned > 0 && <line x1={pl} x2={W - pr} y1={y(assigned)} y2={y(assigned)} stroke={over ? 'var(--red)' : 'var(--text-dim)'} strokeWidth="1" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />}
        <path d={line(prev.map((v, i) => [x(i), y(v)]))} fill="none" stroke="var(--border-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {area && <path d={area} fill="url(#co-g)" />}
        {act.length > 0 && <path d={line(act)} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        {proj && <path d={line(proj)} fill="none" stroke={over ? 'var(--red)' : 'var(--accent)'} strokeWidth="2" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />}
        <line x1={x(hi)} x2={x(hi)} y1={pt} y2={y(0)} stroke="var(--text-dim)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity=".5" />
        {hv != null && <circle cx={x(hi)} cy={y(hv)} r="4" fill="var(--card)" stroke={hi <= last ? 'var(--accent)' : over ? 'var(--red)' : 'var(--accent)'} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </svg>
      </div>
      <div className="co-xlab mk-meta"><span style={{ left: 0 }}>Día 1</span>{day > 3 && day < days - 2 && <span style={{ left: x(last) / W * 100 + '%', transform: 'translateX(-50%)' }}>Hoy</span>}<span style={{ right: 0 }}>{day >= days - 2 ? 'Hoy · día ' + day + ' de ' + days : 'Día ' + days}</span></div>
      {projTotal && <div className="mk-meta" style={{ marginTop: 8, fontSize: 12.5 }}>Cierre proyectado <b className="mono" style={{ color: over ? 'var(--red)' : 'var(--text)' }}>{kmoney(projTotal)}</b>{assigned > 0 && (over ? <> · supera lo asignado a equipos ({kmoney(assigned)}) en <b className="mono" style={{ color: 'var(--red)' }}>{kmoney(projTotal - assigned)}</b></> : <> · {Math.round(projTotal / assigned * 100)}% de lo asignado a equipos ({kmoney(assigned)})</>)}</div>}
    </div>
  );
}

function CostAgent({ r, onClose, money }) {
  const I = window.Icons; const S = window.MangoStore;
  const b = (S.get().budgets || []).find(x => x.scope === 'agent' && x.target === r.a.id);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const SRC = [['chat', 'Conversaciones'], ['schedules', 'Schedules'], ['evals', 'Evals'], ['playground', 'Playground']];
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" style={{ width: 460 }} role="dialog" aria-modal="true" aria-label={'Costos de ' + r.a.name}>
        <div className="mk-drawer-h"><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{r.a.name}</div><div className="mk-meta" style={{ marginTop: 3 }}>{r.a.cat} · <span className="mono">{r.a.model}</span></div></div><button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button></div>
        <div className="mk-drawer-b">
          <div className="ob-sum" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}><div><span>Este mes</span><b className="mono">{money(r.spent)}</b></div><div><span>Anterior</span><b className="mono">{money(r.prev)}</b></div><div><span>Proyección</span><b className="mono">{r.proj ? money(r.proj) : '—'}</b></div></div>
          {b && <MkSec title="Presupuesto"><div className="mk-kv"><span>Límite</span><span className="mono">{money(b.limit)}</span></div><div className="mk-kv"><span>Usado</span><span className="mono">{Math.round(b.spent / b.limit * 100)}%</span></div>{r.proj && r.proj > b.limit && <div className="mc-alert amber" style={{ fontSize: 12.5 }}><I.Warn size={13} /><div>Al ritmo actual superará su límite antes de fin de mes.</div></div>}</MkSec>}
          <MkSec title="Por origen">{SRC.map(([k, l]) => <div key={k} className="mk-kv"><span>{l}</span><span className="mono">{money(r.spent * r.src[k])} · {Math.round(r.src[k] * 100)}%</span></div>)}</MkSec>
          <MkSec title="Eficiencia"><div className="mk-kv"><span>Costo por consulta típica</span><span className="mono">{money(r.perQ)}</span></div><div className="mk-kv"><span>Consultas estimadas</span><span className="mono">{r.queries.toLocaleString('es-ES', { useGrouping: 'always' })}</span></div></MkSec>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}><button className="btn btn-sm" onClick={() => { onClose(); window.MangoNav?.('budgets'); }}>Ajustar presupuesto</button><button className="btn btn-sm" onClick={() => { onClose(); window.MangoNav?.('observability'); }}>Ver trazas</button></div>
        </div>
      </aside>
    </div>
  );
}

Object.assign(window, { CostsView });
