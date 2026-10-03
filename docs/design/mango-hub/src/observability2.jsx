// Observability — trazas de ejecución de agentes (modelo + tools + aprobaciones)
function obsTraces(agents) {
  const L = window.Lifecycle; const D = window.MangoData; const seeds = window.seedMessages || {};
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const models = D.models || [];
  const price = (m) => models.find(x => x.short === m) || { inputPrice: 3, outputPrice: 15 };
  const out = [];
  const mk = (a, at, calls, q, threadId) => {
    const mdl = a.model; const p = price(mdl);
    const tin = 1200 + Math.round(rnd() * 5000), tout = 200 + Math.round(rnd() * 900);
    const plan = 400 + Math.round(rnd() * (/Haiku/.test(mdl) ? 500 : 1400));
    const spans = [{ kind: 'model', name: 'Planificar · ' + mdl, ms: plan, tin: Math.round(tin * 0.6), tout: 60 }];
    calls.forEach(c => spans.push({ kind: 'tool', name: c.tool, ms: c.ms, status: c.status, write: c.write }));
    spans.push({ kind: 'model', name: 'Responder · ' + mdl, ms: 600 + Math.round(rnd() * 1800), tin: Math.round(tin * 0.4), tout });
    let t = 0; spans.forEach(s => { s.start = t; t += s.ms + (s.kind === 'tool' ? 20 : 0); });
    const err = spans.some(s => s.status === 'error');
    const appr = spans.some(s => s.status === 'approval');
    const cost = (tin * p.inputPrice + tout * p.outputPrice) / 1e6;
    out.push({ id: 'tr-' + (out.length + 1).toString(36).padStart(4, '0') + Math.floor(rnd() * 1e6).toString(36), agentId: a.id, at, q, threadId, user: 'usuario' + (1 + Math.floor(rnd() * 8)) + '@empresa.com', spans, ms: t, tin, tout, cost, status: err ? 'error' : appr ? 'approval' : 'ok', model: mdl });
  };
  (D.threads || []).forEach((th, i) => {
    const a = agents.find(x => x.id === th.agentId); if (!a) return;
    const ms = seeds[th.id] || []; const q = ms.find(m => m.type === 'user_message')?.text || th.title;
    const calls = ms.filter(m => m.type === 'tool_call').map(m => ({ tool: m.tool, ms: m.ms, status: m.status === 'ok' ? 'ok' : 'error' }));
    mk(a, Date.now() - (20 + i * 170) * 60000, calls, q, th.id);
  });
  const Q = ['Resumen del día', '¿Qué cambió desde ayer?', 'Revisa alertas activas', 'Top 5 por costo', 'Estado del último deploy', 'Busca la política vigente', 'Lista pendientes de la semana'];
  agents.filter(a => a.status !== 'offline').forEach(a => {
    const n = 4 + Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) {
      const tools = (a.mcp || []).flatMap(id => { const s = L?.serverOf(id); return s ? s.tools.map(t => ({ id: id + '.' + t.name, write: t.write, en: s.status === 'enabled' })) : []; });
      const pick = tools.filter(t => !t.write).sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * 3));
      if (rnd() < 0.12) { const w = tools.find(t => t.write); if (w) pick.push(w); }
      const calls = pick.map(t => ({ tool: t.id, write: t.write, ms: t.write ? 0 : 150 + Math.round(rnd() * (a.status === 'degraded' ? 4200 : 1400)), status: !t.en ? 'error' : t.write ? 'approval' : rnd() < (a.status === 'degraded' ? 0.15 : 0.03) ? 'error' : 'ok' }));
      mk(a, Date.now() - Math.floor(rnd() * 24 * 60) * 60000, calls, Q[Math.floor(rnd() * Q.length)], null);
    }
  });
  return out.sort((x, y) => y.at - x.at);
}
const obsPct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const obsMs = (ms) => ms >= 1000 ? (ms / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' s' : Math.round(ms) + ' ms';

function ObservabilityView({ agents, openChat }) {
  const I = window.Icons;
  const convAccess = window.useMango(s => s.authCfg.convAccess);
  const qText = (t) => convAccess ? t.q : 'Conversación de ' + t.user;
  const all = React.useMemo(() => obsTraces(agents), [agents]);
  const [range, setRange] = useState('24h'); const [ag, setAg] = useState('all'); const [st, setSt] = useState('all'); const [q, setQ] = useState('');
  const [sel, setSel] = useState(null); const [limit, setLimit] = useState(40);
  const since = Date.now() - ({ '1h': 36e5, '6h': 6 * 36e5, '24h': 864e5 })[range];
  const inR = all.filter(t => t.at >= since && (ag === 'all' || t.agentId === ag));
  const p95All = obsPct(inR.map(t => t.ms), 95);
  const Q = q.trim().toLowerCase();
  const rows = inR.filter(t => (st === 'all' || (st === 'slow' ? t.ms >= p95All : t.status === st)) && (!Q || ((convAccess ? t.q : '') + ' ' + t.user + ' ' + t.id + ' ' + t.spans.map(s => s.name).join(' ')).toLowerCase().includes(Q)));
  const errRate = inR.length ? inR.filter(t => t.status === 'error').length / inR.length * 100 : 0;
  const cost = inR.reduce((s, t) => s + t.cost, 0);
  const byAgent = agents.map(a => { const ts = inR.filter(t => t.agentId === a.id); return { a, n: ts.length, p50: obsPct(ts.map(t => t.ms), 50), p95: obsPct(ts.map(t => t.ms), 95), err: ts.filter(t => t.status === 'error').length, cost: ts.reduce((s, t) => s + t.cost, 0) }; }).filter(x => x.n).sort((x, y) => y.p95 - x.p95);
  const toolStats = Object.values(inR.flatMap(t => t.spans.filter(s => s.kind === 'tool' && s.status !== 'approval')).reduce((m, s) => { const k = s.name; m[k] = m[k] || { name: k, n: 0, err: 0, ms: [] }; m[k].n++; if (s.status === 'error') m[k].err++; m[k].ms.push(s.ms); return m; }, {})).map(x => ({ ...x, p95: obsPct(x.ms, 95) })).sort((a, b) => b.err - a.err || b.p95 - a.p95).slice(0, 8);
  const selected = sel && all.find(t => t.id === sel);
  const agName = (id) => agents.find(a => a.id === id)?.name || id;
  const money = (n) => window.GovKit ? window.GovKit.usd(n) : n.toFixed(2);
  const hours = Array.from({ length: 24 }, (_, i) => { const end = Date.now() - (23 - i) * 36e5, start = end - 36e5; const ts = all.filter(t => t.at >= start && t.at < end && (ag === 'all' || t.agentId === ag)); return { n: ts.length, e: ts.filter(t => t.status === 'error').length }; });
  const maxH = Math.max(1, ...hours.map(h => h.n));
  const STATUS = { ok: ['OK', 'var(--green)'], error: ['Error', 'var(--red)'], approval: ['Espera aprobación', 'var(--amber)'] };

  return (
    <>
      <Topbar crumbs={['Operación', 'Observability']} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Observability</h1>
          <p className="page-subtitle">Cada respuesta de un agente como una traza: llamadas al modelo, tools y aprobaciones, con su duración, tokens y costo. Lo que hicieron los agentes está en Actividad, y las decisiones de las personas en el Audit log.</p>
        </div>
        <div className="bg-kpis">
          <div className="card bg-kpi"><span className="bg-kpi-l">Trazas</span><span className="bg-kpi-v">{inR.length}</span><span className="bg-kpi-s">{new Set(inR.map(t => t.agentId)).size} agentes</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Latencia p50 / p95</span><span className="bg-kpi-v" style={{ fontSize: 19 }}>{obsMs(obsPct(inR.map(t => t.ms), 50))} / {obsMs(p95All)}</span><span className="bg-kpi-s">Tiempo total por respuesta</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Con error</span><span className="bg-kpi-v" style={errRate > 5 ? { color: 'var(--red)' } : null}>{errRate.toFixed(1).replace('.', ',')}%</span><span className="bg-kpi-s">{inR.filter(t => t.status === 'error').length} trazas con una tool fallida</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Costo del modelo</span><span className="bg-kpi-v">{money(cost)}</span><span className="bg-kpi-s">{(inR.reduce((s, t) => s + t.tin + t.tout, 0) / 1e3).toLocaleString('es-ES', { maximumFractionDigits: 0 })} k tokens</span></div>
        </div>
        <div className="bg-toolbar">
          <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar pregunta, tool o ID de traza" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar trazas" /></div>
          <div className="tk-quick">{[['1h', '1 h'], ['6h', '6 h'], ['24h', '24 h']].map(([k, l]) => <button key={k} className={range === k ? 'is-on' : ''} onClick={() => setRange(k)}>{l}</button>)}</div>
          <div className="tk-quick">{[['all', 'Todas'], ['error', 'Con error'], ['slow', 'Lentas (≥ p95)'], ['approval', 'Con aprobación']].map(([k, l]) => <button key={k} className={st === k ? 'is-on' : ''} onClick={() => setSt(k)}>{l}</button>)}</div>
          <select className="input mk-sel" value={ag} onChange={e => setAg(e.target.value)} aria-label="Agente"><option value="all">Todos los agentes</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </div>
        <div className="ob-grid">
          <div style={{ minWidth: 0 }}>
            <div className="card ob-hist" aria-label="Trazas por hora, últimas 24 h">
              <div className="row between" style={{ marginBottom: 8 }}><span className="mk-sec-t" style={{ margin: 0 }}>trazas por hora · 24 h</span><span className="mk-meta"><i className="ob-lg" style={{ background: 'var(--blue)' }} /> ok <i className="ob-lg" style={{ background: 'var(--red)' }} /> error</span></div>
              <div className="ob-bars">{hours.map((h, i) => <div key={i} title={`${h.n} trazas · ${h.e} con error`}><span style={{ height: (h.n - h.e) / maxH * 100 + '%', background: 'var(--blue)' }} /><span style={{ height: h.e / maxH * 100 + '%', background: 'var(--red)' }} /></div>)}</div>
              <div className="row between mk-meta" style={{ fontSize: 11, marginTop: 4 }}><span>hace 24 h</span><span>ahora</span></div>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 16 }}>
              <div className="ob-tr mc-th"><span>traza</span><span>agente</span><span>duración</span><span>tools</span><span>costo</span><span>estado</span></div>
              {rows.slice(0, limit).map(t => { const tools = t.spans.filter(s => s.kind === 'tool'); return (
                <button key={t.id} className={'ob-tr' + (sel === t.id ? ' is-on' : '')} onClick={() => setSel(t.id)}>
                  <span style={{ minWidth: 0 }}><span className="ac-t" style={{ color: 'var(--text-strong)' }}>{qText(t)}</span><span className="mk-meta mono" style={{ fontSize: 11 }}>{t.id} · {new Date(t.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })}</span></span>
                  <span className="mk-meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agName(t.agentId)}</span>
                  <span><span className="ob-mini"><span style={{ width: Math.min(100, t.ms / Math.max(p95All, 1) * 80) + '%', background: t.ms >= p95All ? 'var(--amber)' : 'var(--blue)' }} /></span><span className="mono" style={{ fontSize: 11.5 }}>{obsMs(t.ms)}</span></span>
                  <span className="mk-meta">{tools.length}{tools.some(s => s.status === 'error') ? <span style={{ color: 'var(--red)' }}> · falla</span> : ''}</span>
                  <span className="mono mk-meta" style={{ fontSize: 11.5 }}>{money(t.cost)}</span>
                  <span className="row gap-2" style={{ fontSize: 12.5 }}><span className="tk-dot" style={{ background: STATUS[t.status][1] }} />{STATUS[t.status][0]}</span>
                </button>
              ); })}
              {!rows.length && <div className="mk-meta" style={{ padding: 16 }}>Ninguna traza coincide.</div>}
            </div>
            {rows.length > limit && <button className="btn btn-sm" style={{ margin: '12px auto 0', display: 'flex' }} onClick={() => setLimit(l => l + 40)}>Mostrar más · quedan {rows.length - limit}</button>}
          </div>
          <aside className="ac-side">
            <div className="card" style={{ padding: 0 }}>
              <div className="ac-side-h">latencia por agente · p95</div>
              {byAgent.slice(0, 8).map(x => <button key={x.a.id} className={'ac-ag' + (ag === x.a.id ? ' is-on' : '')} onClick={() => setAg(ag === x.a.id ? 'all' : x.a.id)}>
                <span className="row between" style={{ gap: 8 }}><span className="ac-ag-n">{x.a.name}</span><span className="mono mk-meta">{obsMs(x.p95)}{x.err ? <span style={{ color: 'var(--red)' }}> · {x.err} err</span> : ''}</span></span>
                <span className="mk-bar-track" style={{ display: 'block', marginTop: 5 }}><span style={{ width: x.p95 / Math.max(...byAgent.map(y => y.p95), 1) * 100 + '%', background: x.err ? 'var(--amber)' : 'var(--blue)' }} /></span>
              </button>)}
            </div>
            <div className="card" style={{ padding: 0, marginTop: 12 }}>
              <div className="ac-side-h">tools más lentas o con fallas</div>
              {toolStats.map(x => <div key={x.name} className="ac-silent" style={{ alignItems: 'flex-start' }}><span className="mono" style={{ fontSize: 11.5, minWidth: 0, overflowWrap: 'anywhere' }}>{x.name}</span><span className="mk-meta mono" style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>{obsMs(x.p95)}<br />{x.err ? <span style={{ color: 'var(--red)' }}>{x.err}/{x.n} err</span> : x.n + ' llamadas'}</span></div>)}
            </div>
          </aside>
        </div>
      </div>
      {selected && <TraceDetail t={selected} agent={agents.find(a => a.id === selected.agentId)} onClose={() => setSel(null)} openChat={openChat} />}
    </>
  );
}

function TraceDetail({ t, agent, onClose, openChat }) {
  const I = window.Icons; const toast = window.useToast?.();
  const convAccess = window.useMango(s => s.authCfg.convAccess);
  useEffect(() => { if (convAccess) window.MangoStore.log('conversation.read', t.id, 'Leyó la pregunta de ' + t.user + ' en Observabilidad'); }, [t.id]);
  const [open, setOpen] = useState(null);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const COL = { model: 'var(--violet)', ok: 'var(--blue)', error: 'var(--red)', approval: 'var(--amber)' };
  const money = (n) => window.GovKit ? window.GovKit.usd(n) : n.toFixed(4);
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" style={{ width: 620 }} role="dialog" aria-modal="true" aria-label={'Traza ' + t.id}>
        <div className="mk-drawer-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>{convAccess ? t.q : 'Traza ' + t.id}</div>
            <div className="mk-meta" style={{ marginTop: 3 }}>{agent?.name} · {t.user} · <span className="mono">{t.model}</span> · {new Date(t.at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}</div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Copiar ID" title="Copiar ID" onClick={() => { navigator.clipboard?.writeText(t.id); toast?.({ tone: 'success', msg: 'ID copiado' }); }}><I.Copy size={13} /></button>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="mk-drawer-b">
          {convAccess ? <div className="mc-alert amber"><I.Eye size={14} /><div>El acceso de admins a conversaciones está activado. Esta lectura quedó registrada en Auditoría.</div></div>
            : <div className="mc-alert"><I.Lock size={14} /><div>Solo metadatos: el texto de la pregunta no se muestra porque la instalación no activó el acceso de admins a conversaciones.</div></div>}
          <div className="ob-sum"><div><span>Duración</span><b className="mono">{obsMs(t.ms)}</b></div><div><span>Tokens</span><b className="mono">{t.tin.toLocaleString('es-ES', { useGrouping: 'always' })} / {t.tout}</b></div><div><span>Costo</span><b className="mono">{money(t.cost)}</b></div><div><span>Spans</span><b className="mono">{t.spans.length}</b></div></div>
          {t.status === 'error' && <div className="mc-alert red"><I.X2 size={14} /><div>Una tool falló; el agente respondió con la información que tenía.</div></div>}
          {t.status === 'approval' && <div className="mc-alert amber"><I.Lock size={14} /><div>Una tool de escritura quedó esperando aprobación y no se ejecutó.</div></div>}
          <MkSec title="Cascada">
            <div className="ob-wf">
              {t.spans.map((s, i) => { const c = s.kind === 'model' ? COL.model : COL[s.status]; const isOpen = open === i; return (
                <React.Fragment key={i}>
                  <button className="ob-span" onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen}>
                    <span className="ob-span-n"><span className="tk-dot" style={{ background: c }} /><span className={s.kind === 'tool' ? 'mono' : ''} style={{ fontSize: s.kind === 'tool' ? 11.5 : 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span></span>
                    <span className="ob-span-bar"><span style={{ left: s.start / t.ms * 100 + '%', width: Math.max(0.8, s.ms / t.ms * 100) + '%', background: c }} /></span>
                    <span className="mono mk-meta" style={{ fontSize: 11, textAlign: 'right' }}>{s.status === 'approval' ? 'pendiente' : obsMs(s.ms)}</span>
                  </button>
                  {isOpen && <div className="ob-span-d">{s.kind === 'model' ? <>Tokens de entrada <b className="mono">{s.tin}</b> · salida <b className="mono">{s.tout}</b></> : s.status === 'error' ? 'Error: tiempo de espera agotado o MCP no disponible.' : s.status === 'approval' ? 'Tool de escritura: se creó una solicitud en Aprobaciones.' : 'Respuesta correcta.'} · empieza en {obsMs(s.start)}</div>}
                </React.Fragment>
              ); })}
            </div>
            <div className="mk-meta" style={{ marginTop: 6 }}><i className="ob-lg" style={{ background: COL.model }} /> modelo <i className="ob-lg" style={{ background: COL.ok }} /> tool <i className="ob-lg" style={{ background: COL.error }} /> error <i className="ob-lg" style={{ background: COL.approval }} /> aprobación</div>
          </MkSec>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
            {t.threadId && convAccess && <button className="btn btn-sm" onClick={() => { window.MangoStore.log('conversation.read', t.threadId, 'Abrió la conversación de ' + t.user + ' desde Observabilidad'); onClose(); openChat?.(t.agentId, t.threadId); }}><I.Chat size={12} /> Abrir conversación</button>}
            {t.status === 'approval' && <button className="btn btn-sm" onClick={() => { onClose(); window.MangoNav?.('approvals'); }}>Ver aprobaciones <I.ArrowRight size={11} /></button>}
            <button className="btn btn-sm" onClick={() => { onClose(); window.MangoNav?.('activity'); }}>Ver en Actividad <I.ArrowRight size={11} /></button>
          </div>
        </div>
      </aside>
    </div>
  );
}

Object.assign(window, { ObservabilityView });
