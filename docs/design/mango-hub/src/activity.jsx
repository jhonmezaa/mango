// Actividad — qué están haciendo los agentes (operación), distinto del Audit log (gobierno)
const ACT_KINDS = {
  tool: ['Llamadas a tools', 'Terminal', 'var(--blue)'],
  ticket: ['Tickets', 'Tickets', 'var(--text-muted)'],
  approval: ['Aprobaciones', 'Lock', 'var(--amber)'],
  budget: ['Presupuesto', 'Money', 'var(--amber)'],
  error: ['Errores', 'X2', 'var(--red)'],
  publish: ['Publicaciones', 'Zap', 'var(--green)'],
};
const actAgo = (min) => new Date(Date.now() - min * 60000).toISOString();

function buildActivity(agents) {
  const D = window.MangoData; const S = window.MangoStore;
  const seeds = window.seedMessages || {};
  const byName = (n) => agents.find(a => a.name === n || a.name.startsWith(n));
  const ev = [];
  let n = 0;
  // Tool calls reales de las conversaciones
  (D.threads || []).forEach((t, ti) => {
    (seeds[t.id] || []).forEach((m, mi) => {
      if (m.type !== 'tool_call') return;
      ev.push({ id: 'ev' + n++, kind: m.status === 'ok' ? 'tool' : 'error', agentId: t.agentId, at: actAgo(8 + ti * 190 + mi * 3), text: m.status === 'ok' ? 'llamó a' : 'falló al llamar a', target: m.tool, ms: m.ms, ok: m.status === 'ok', link: ['chat', t.agentId, t.id], params: m.params });
    });
  });
  // Tickets
  (D.tickets || []).forEach((t, i) => {
    const mins = /d/.test(t.age) ? parseFloat(t.age) * 1440 : parseFloat(t.age) * 60 || 1;
    ev.push({ id: 'ev' + n++, kind: 'ticket', agentId: t.agent, at: actAgo(mins), text: t.status === 'done' ? 'cerró el ticket' : 'abrió el ticket', target: t.id, sub: t.title, link: ['tickets', t.id] });
  });
  // Aprobaciones pedidas por agentes
  (S.get().approvals || []).forEach(ap => ev.push({ id: 'ev' + n++, kind: 'approval', agentId: ap.agent, at: ap.at, text: ap.status === 'pending' ? 'pidió aprobación para' : ap.status === 'approved' ? 'ejecutó tras aprobación' : 'no ejecutó (rechazada)', target: ap.tool, sub: ap.action, ok: ap.status !== 'rejected', link: ['approvals'] }));
  // Presupuestos
  (S.get().budgets || []).filter(b => b.scope === 'agent' && b.spent / b.limit >= b.warn / 100).forEach((b, i) => ev.push({ id: 'ev' + n++, kind: 'budget', agentId: b.target, at: actAgo(60 + i * 140), text: b.spent >= b.limit ? 'llegó al 100% de su presupuesto' : `pasó el ${b.warn}% de su presupuesto`, target: Math.round(b.spent / b.limit * 100) + '%', link: ['budgets'] }));
  // Eventos operativos del feed original
  (D.activity || []).forEach((a, i) => { const ag = byName(a.who); if (!ag) return; ev.push({ id: 'ev' + n++, kind: a.tone === 'red' ? 'error' : a.tone === 'amber' ? 'budget' : 'tool', agentId: ag.id, at: actAgo(20 + i * 17), text: a.what, target: a.target, ok: a.tone !== 'red' }); });
  // Publicaciones recientes
  (S.get().agentRevs || []).filter(r => r.status === 'published' && r.publishedAt).forEach(r => ev.push({ id: 'ev' + n++, kind: 'publish', agentId: r.agentId, at: r.publishedAt, text: 'se publicó una nueva versión', target: r.id, link: ['review'] }));
  return ev.sort((a, b) => new Date(b.at) - new Date(a.at));
}

function ActivityView({ agents, openChat }) {
  const I = window.Icons; const S = window.MangoStore;
  const toast = window.useToast?.();
  window.useMango(s => s.approvals); window.useMango(s => s.agentRevs);
  const [live, setLive] = useState(true);
  const [extra, setExtra] = useState([]);
  const [fresh, setFresh] = useState(null);
  const [kind, setKind] = useState('all');
  const [agent, setAgent] = useState('all');
  const [range, setRange] = useState('24h');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [limit, setLimit] = useState(50);
  const base0 = React.useMemo(() => buildActivity(agents), [agents, S.get().approvals, S.get().agentRevs]);
  const all = [...extra, ...base0];

  useEffect(() => {
    if (!live) return;
    const pool = agents.filter(a => a.status === 'online' && a.mcp.length);
    const t = setInterval(() => {
      const a = pool[Math.floor(Math.random() * pool.length)]; if (!a) return;
      const server = a.mcp[Math.floor(Math.random() * a.mcp.length)];
      const srv = window.Lifecycle?.serverOf(server);
      const tool = srv?.tools?.filter(x => !x.write)[0]?.name || 'query';
      const ok = Math.random() > 0.08;
      const e = { id: 'live' + Date.now(), kind: ok ? 'tool' : 'error', agentId: a.id, at: new Date().toISOString(), text: ok ? 'llamó a' : 'falló al llamar a', target: server + '.' + tool, ms: 150 + Math.round(Math.random() * 1200), ok, live: true };
      setExtra(x => [e, ...x].slice(0, 40)); setFresh(e.id);
    }, 5000);
    return () => clearInterval(t);
  }, [live, agents]);

  const RANGES = [['1h', '1 h', 36e5], ['24h', '24 h', 864e5], ['7d', '7 días', 7 * 864e5]];
  const since = Date.now() - RANGES.find(r => r[0] === range)[2];
  const inRange = all.filter(e => new Date(e.at).getTime() >= since);
  const Q = q.trim().toLowerCase();
  const agName = (id) => agents.find(a => a.id === id)?.name || id;
  const base = inRange.filter(e => (agent === 'all' || e.agentId === agent) && (!Q || [agName(e.agentId), e.text, e.target, e.sub].join(' ').toLowerCase().includes(Q)));
  const rows = base.filter(e => kind === 'all' || e.kind === kind);
  const anyFilter = kind !== 'all' || agent !== 'all' || Q;
  const clear = () => { setKind('all'); setAgent('all'); setQ(''); };

  const calls = inRange.filter(e => e.kind === 'tool' || e.kind === 'error');
  const errs = calls.filter(e => !e.ok).length;
  const withMs = calls.filter(e => e.ms);
  const avgMs = withMs.length ? Math.round(withMs.reduce((s, e) => s + e.ms, 0) / withMs.length) : null;
  const activeAgents = new Set(inRange.map(e => e.agentId)).size;
  const byAgent = Object.values(inRange.reduce((m, e) => { const k = e.agentId; m[k] = m[k] || { id: k, n: 0, err: 0 }; m[k].n++; if (e.kind === 'error') m[k].err++; return m; }, {})).sort((a, b) => b.n - a.n);
  const maxN = byAgent[0]?.n || 1;
  const silent = agents.filter(a => a.status !== 'offline' && !byAgent.some(b => b.id === a.id));

  const exportCsv = () => {
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const csv = ['fecha,agente,tipo,evento,objetivo,ms,resultado', ...rows.map(e => [e.at, agName(e.agentId), ACT_KINDS[e.kind][0], e.text, e.target, e.ms || '', e.ok === false ? 'error' : 'ok'].map(esc).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    const el = document.createElement('a'); el.href = url; el.download = 'mango-actividad.csv'; el.click(); URL.revokeObjectURL(url);
    toast?.({ tone: 'success', msg: rows.length + ' eventos exportados' });
  };
  const go = (e) => { if (!e.link) return; if (e.link[0] === 'chat') openChat?.(e.link[1], e.link[2]); else window.MangoNav?.(e.link[0], e.link[1]); };
  const shown = rows.slice(0, limit);
  const hourKey = (iso) => { const d = new Date(iso); d.setMinutes(0, 0, 0); return d.getTime(); };
  const groups = []; shown.forEach(e => { const k = hourKey(e.at); const g = groups[groups.length - 1]; if (g && g.k === k) g.items.push(e); else groups.push({ k, items: [e] }); });
  const hourLabel = (k) => { const d = new Date(k); const today = new Date(); today.setHours(0, 0, 0, 0); const day = d >= today ? '' : d >= today - 864e5 ? 'Ayer · ' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) + ' · '; const h = (x) => String(x).padStart(2, '0') + ':00'; return day + h(d.getHours()) + ' – ' + h((d.getHours() + 1) % 24); };

  return (
    <>
      <Topbar crumbs={['Gobernanza', 'Actividad']} actions={<>
        <button className={'btn btn-sm' + (live ? ' ac-live-on' : '')} onClick={() => setLive(v => !v)} aria-pressed={live}>{live ? <><span className="ac-pulse" /> En vivo</> : <><I.Play size={11} /> Reanudar</>}</button>
        <button className="btn btn-sm" onClick={exportCsv} disabled={!rows.length}><I.Download size={12} /> Exportar CSV</button>
      </>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Actividad</h1>
          <p className="page-subtitle">Qué están haciendo los agentes: llamadas a tools, tickets, aprobaciones y errores. Las decisiones y los cambios de ajustes están en el <a href="#" className="sr-link" style={{ fontSize: 'inherit', padding: 0 }} onClick={(ev) => { ev.preventDefault(); window.MangoNav?.('audit'); }}>Audit log</a>.</p>
        </div>
        <div className="bg-kpis">
          <div className="card bg-kpi"><span className="bg-kpi-l">Eventos · {RANGES.find(r => r[0] === range)[1]}</span><span className="bg-kpi-v">{inRange.length}</span><span className="bg-kpi-s">{calls.length} llamadas a tools</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Agentes con actividad</span><span className="bg-kpi-v">{activeAgents}</span><span className="bg-kpi-s">de {agents.filter(a => a.status !== 'offline').length} en línea</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Tools con error</span><span className="bg-kpi-v" style={errs ? { color: 'var(--red)' } : null}>{calls.length ? (errs / calls.length * 100).toFixed(1).replace('.', ',') + '%' : '—'}</span><span className="bg-kpi-s">{errs} de {calls.length}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Latencia media</span><span className="bg-kpi-v">{avgMs != null ? avgMs + ' ms' : '—'}</span><span className="bg-kpi-s">{avgMs != null ? 'De ' + withMs.length + ' llamadas medidas' : 'Sin mediciones'}</span></div>
        </div>
        <div className="bg-toolbar">
          <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar agente, tool o ticket" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar actividad" /></div>
          <div className="tk-quick" role="group" aria-label="Periodo">{RANGES.map(([k, l]) => <button key={k} className={range === k ? 'is-on' : ''} aria-pressed={range === k} onClick={() => setRange(k)}>{l}</button>)}</div>
          <select className="input mk-sel" value={agent} onChange={e => setAgent(e.target.value)} aria-label="Agente"><option value="all">Todos los agentes</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <div style={{ flex: 1 }} />
          {anyFilter && <button className="btn btn-sm btn-ghost" onClick={clear}>Limpiar</button>}
        </div>
        <div className="au-cats" style={{ padding: '0 28px 14px' }} role="group" aria-label="Tipo">
          <button className={kind === 'all' ? 'is-on' : ''} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>Todo<span>{base.length}</span></button>
          {Object.entries(ACT_KINDS).map(([k, [l]]) => { const c = base.filter(e => e.kind === k).length; return c || kind === k ? <button key={k} className={kind === k ? 'is-on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}<span>{c}</span></button> : null; })}
        </div>

        <div className="ac-grid">
          <div>
            {!rows.length ? (
              <div className="card"><div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600 }}>Sin actividad</div><div className="mk-meta">{anyFilter ? 'Nada coincide con los filtros.' : 'No hubo actividad en este periodo.'}</div>{anyFilter && <button className="btn btn-sm" onClick={clear}>Limpiar filtros</button>}</div></div>
            ) : groups.map(g => (
              <section key={g.k} style={{ marginBottom: 18 }}>
                <div className="au-day-h">{hourLabel(g.k)}<span>{g.items.length}</span></div>
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  {g.items.map(e => {
                    const a = agents.find(x => x.id === e.agentId); const Ic = a ? I[a.icon] || I.Bot : I.Bot; const [kl, kic, kc] = ACT_KINDS[e.kind]; const K = I[kic];
                    const open = openId === e.id;
                    return (
                      <div key={e.id} className={'ac-row' + (e.id === fresh ? ' is-fresh' : '') + (e.kind === 'error' ? ' is-err' : '')}>
                        <button className="ac-main" onClick={() => setOpenId(open ? null : e.id)} aria-expanded={open}>
                          <span className="mono au-time">{new Date(e.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                          <span className="tk-agent-ic" style={{ background: a?.iconBg, color: a?.iconColor, width: 24, height: 24, borderRadius: 6 }}><Ic size={12} /></span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span className="ac-t"><b>{a?.name || e.agentId}</b> {e.text} {e.target && <code className="ac-target">{e.target}</code>}</span>
                            {e.sub && <span className="ac-s">{e.sub}</span>}
                          </span>
                          {e.ms != null && <span className="mono ac-ms" style={{ color: e.ok === false ? 'var(--red)' : undefined }}>{e.ok === false ? 'error' : e.ms + ' ms'}</span>}
                          <span className="ac-kind" style={{ color: kc }} title={kl}><K size={12} /></span>
                        </button>
                        {open && (
                          <div className="ac-more">
                            {e.params && <pre className="mono">{JSON.stringify(e.params, null, 2)}</pre>}
                            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
                              <button className="btn btn-sm" onClick={() => { setAgent(e.agentId); setOpenId(null); }}>Solo {a?.name}</button>
                              {e.link && <button className="btn btn-sm" onClick={() => go(e)}>{e.link[0] === 'chat' ? 'Abrir conversación' : e.link[0] === 'tickets' ? 'Abrir ' + e.target : e.link[0] === 'approvals' ? 'Ver aprobación' : e.link[0] === 'budgets' ? 'Ver presupuesto' : 'Ver revisión'} <I.ArrowRight size={11} /></button>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
            {rows.length > limit && <button className="btn btn-sm" style={{ margin: '0 auto', display: 'flex' }} onClick={() => setLimit(l => l + 50)}>Mostrar más · quedan {rows.length - limit}</button>}
          </div>

          <aside className="ac-side">
            <div className="card" style={{ padding: 0 }}>
              <div className="ac-side-h">agentes más activos</div>
              {byAgent.slice(0, 7).map(b => { const a = agents.find(x => x.id === b.id); return (
                <button key={b.id} className={'ac-ag' + (agent === b.id ? ' is-on' : '')} onClick={() => setAgent(agent === b.id ? 'all' : b.id)}>
                  <span className="row between" style={{ gap: 8 }}><span className="ac-ag-n">{a?.name || b.id}</span><span className="mono mk-meta">{b.n}{b.err ? <span style={{ color: 'var(--red)' }}> · {b.err} err</span> : ''}</span></span>
                  <span className="mk-bar-track" style={{ display: 'block', marginTop: 5 }}><span style={{ width: b.n / maxN * 100 + '%', background: b.err ? 'var(--amber)' : 'var(--blue)' }} /></span>
                </button>
              ); })}
              {!byAgent.length && <div className="mk-meta" style={{ padding: 14 }}>Sin actividad.</div>}
            </div>
            {silent.length > 0 && (
              <div className="card" style={{ padding: 0, marginTop: 12 }}>
                <div className="ac-side-h">sin actividad en el periodo</div>
                {silent.slice(0, 6).map(a => <div key={a.id} className="ac-silent"><span>{a.name}</span><span className="mk-meta">{a.status === 'degraded' ? 'Degradado' : a.status === 'warmup' ? 'Iniciando' : 'En línea'}</span></div>)}
              </div>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { ActivityView });
