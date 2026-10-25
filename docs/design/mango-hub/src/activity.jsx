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
// Duración: «N ms» bajo 1 s, «N,N s» bajo 1 min y «M min S s» hasta el techo del turno (600 s).
const fmtDur = (ms) => { if (ms == null) return ''; if (ms < 1000) return Math.round(ms) + ' ms'; if (ms < 59950) return (ms / 1000).toFixed(1).replace('.', ',') + ' s'; const s = Math.round(ms / 1000); return Math.floor(s / 60) + ' min' + (s % 60 ? ' ' + s % 60 + ' s' : ''); };

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

// Disponible hoy: solo turnos de chat y tareas, con FinOps. No se guardan los parámetros ni la respuesta de las tools (la fila con error no lleva texto debajo);
// no hay tickets ni publicaciones; de presupuesto, solo el turno que se bloquea al llegar al límite. Las tools van por nombre, como en el chat.
// Las tools de datos de cuentas tardan segundos (la primera medida en la instalación: get_cost_and_usage, 19.319 ms). El techo es el del turno: 600 s.
// Turnos de chat de ejemplo: [quién, turno, minutos atrás, conversación, llamadas [tool, ms] (ms null: falló), sigue en curso]
const ACT_AV_TURNS = [
  ['Usuario 8', 'TRN-5110', 0.8, 't1', [['get_cost_and_usage', 19319], ['get_dimension_values', 2870]], true],
  ['Usuario 1', 'TRN-5106', 6, 't1', [['get_cost_and_usage', 14820], ['get_dimension_values', 3140], ['get_cost_and_usage', 11260]]],
  ['Usuario 4', 'TRN-5102', 22, 't1', [['get_cost_and_usage', 16400], ['get_dimension_values', 2410], ['get_cost_and_usage', 21930]]],
  ['Usuario 5', 'TRN-5094', 120, 't1', [['get_dimension_values', 3380], ['get_cost_and_usage', null]]],
  ['Usuario 6', 'TRN-5090', 190, 't2', [['get_cost_and_usage', 12750], ['get_cost_and_usage', 18040], ['get_cost_forecast', 9620], ['get_dimension_values', 2190], ['get_cost_and_usage', 74300]]],
  ['Usuario 2', 'TRN-5071', 410, 't2', [['get_cost_forecast', 8310], ['get_cost_and_usage', 13570]]],
  ['Usuario 1', 'TRN-5040', 1500, 't2', [['get_cost_and_usage', 10980], ['get_cost_and_usage', 15210]]],
  ['Usuario 4', 'TRN-4988', 2900, 't1', [['get_cost_and_usage', 17650]]],
  ['Usuario 2', 'TRN-4950', 4300, 't1', [['get_dimension_values', 2650], ['get_cost_and_usage', 20480]]],
  ['Usuario 6', 'TRN-4901', 7000, 't2', [['get_cost_forecast', 11040]]],
];
const ACT_AV_TOOLS = ['get_cost_and_usage', 'get_cost_forecast', 'get_dimension_values'];
const actHash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
// Latencia de ejemplo por tool, estable para cada llamada: segundos.
const actMs = (tool, h) => tool === 'get_dimension_values' ? 1600 + h % 3400 : tool === 'get_cost_forecast' ? 6500 + h % 9000 : 8000 + h % 19000;
// Estado de la aprobación pedida. El producto conoce cuatro: pendiente, ejecutada, rechazada y vencida (aprobada sin ejecutar sigue pendiente).
const ACT_AP = { pending: ['pendiente', 'var(--amber)'], approved: ['pendiente', 'var(--amber)'], executing: ['pendiente', 'var(--amber)'], executed: ['ejecutada', 'var(--green)'], rejected: ['rechazada', 'var(--red)'], expired: ['vencida', 'var(--text-muted)'] };
// Tope por consulta: si el periodo tiene más, llegan los más recientes y el producto lo sabe.
const ACT_CAP = 1000;
// De otra persona, la fila abierta nombra exactamente lo que muestra la fila.
const ACT_OTHER = { tool: 'el agente, la tool, la hora y la latencia', error: 'el agente, la tool, la hora y el resultado', approval: 'el agente, la tool, la hora y el estado', budget: 'el agente y la hora' };

function buildActivityAvail(cap) {
  const S = window.MangoStore; const ev = []; let n = 0;
  const T = (ms) => new Date(ms).toISOString(); const now = Date.now();
  // Las llamadas de un turno van una tras otra: cada una empieza al terminar la anterior, más unos segundos del modelo.
  ACT_AV_TURNS.forEach(([who, turn, min, thread, calls, pending]) => { let t = now - min * 6e4; calls.forEach(([tool, ms]) => { ev.push({ id: (pending ? 'avp' : 'av') + n++, kind: ms == null ? 'error' : 'tool', agentId: 'fin-01', who, turn, pending: !!pending, at: T(t), text: ms == null ? 'falló al llamar a' : 'llamó a', target: tool, ms, ok: ms != null, link: ['chat', 'fin-01', thread] }); t += (ms || 0) + 2500; }); });
  // Tareas: cada paso con tool de una ejecución completada, con la identidad de quien la creó. Los pasos reparten la duración de la ejecución (cuadra con Schedules).
  (S.get().schedules || []).filter(s => s.agent === 'fin-01').forEach(s => (s.runs || []).forEach(r => {
    if (r.status !== 'ok' || !r.result) return;
    const steps = (r.result.steps || []).filter(st => st.tool); if (!steps.length) return;
    const w = steps.map((st, i) => 2 + actHash(r.id + ':' + i * 7919) % 5); const W = w.reduce((a, b) => a + b, 0);
    const gap = r.ms ? r.ms * 0.2 / (steps.length + 1) : 2500; let t = new Date(r.at).getTime() + gap;
    steps.forEach((st, i) => { const ms = r.ms ? Math.round(r.ms * 0.8 * w[i] / W) : actMs(st.tool, actHash(r.id + i)); ev.push({ id: 'av' + n++, kind: 'tool', agentId: s.agent, who: s.owner, task: s.name, at: T(Math.min(t, now)), text: 'llamó a', target: st.tool, ms, ok: true, link: ['run', s.id, r.id] }); t += ms + gap; });
  }));
  // Aprobaciones que pidió el agente en un turno, con su estado. Sin la descripción de la tool: esta vista no tiene el catálogo.
  (S.get().approvals || []).filter(ap => ap.agent === 'fin-01').forEach(ap => {
    const [srv, ...rest] = (ap.tool || '').split('.'); const name = rest.join('.') || srv;
    const late = ['pending', 'approved'].includes(ap.status) && ap.expiresMin && now - new Date(ap.at).getTime() >= ap.expiresMin * 6e4;
    ev.push({ id: 'av' + n++, kind: 'approval', agentId: ap.agent, who: ap.requestedBy, at: ap.at, text: 'pidió aprobación para', target: name, apState: late ? 'expired' : ap.status, link: ['approvals'] });
  });
  ev.push({ id: 'av' + n++, kind: 'budget', agentId: 'fin-01', who: 'Usuario 3', turn: 'TRN-5085', at: T(now - 300.5 * 6e4), text: 'no respondió: se agotó el presupuesto', link: ['budgets'] });
  // Demo «Más de 1000 eventos en 7 días»: llamadas de otras personas cada ~4 min durante la semana.
  if (cap) for (let i = 0; i < 2600; i++) { const h = actHash('cap' + i); const tool = ACT_AV_TOOLS[h % 3]; const ok = h % 31 !== 0; ev.push({ id: 'cap' + i, kind: ok ? 'tool' : 'error', agentId: 'fin-01', who: 'Usuario ' + (2 + h % 8), at: T(now - 9e5 - i * 23e4), text: ok ? 'llamó a' : 'falló al llamar a', target: tool, ms: ok ? actMs(tool, h) : null, ok }); }
  return ev.sort((a, b) => new Date(b.at) - new Date(a.at));
}

function ActivityView({ agents, openChat }) {
  const I = window.Icons; const S = window.MangoStore; const K = window.GovKit; const Sk = K.Skel;
  const toast = window.useToast?.();
  window.useMango(s => s.approvals); window.useMango(s => s.agentRevs); window.useMango(s => s.schedules); window.useMango(s => s.actorOverride);
  const avail = window.useMango(s => s.avail);
  const sim = window.useMango(s => s.simAct) || null;
  const role = window.useMango(s => s.role);
  const retired = window.useMango(s => s.retired) || {};
  const isAdmin = role === 'admin'; const me = S.actor();
  const blocked = sim === 'loading' || sim === 'error' || sim === 'denied';
  const cap = !!avail && sim === 'cap';
  const [live, setLive] = useState(true);
  const [extra, setExtra] = useState([]);
  const [fresh, setFresh] = useState([]);
  const [ended, setEnded] = useState(false);
  const endedRef = React.useRef(false);
  const [kind, setKind] = useState('all');
  const [agent, setAgent] = useState('all');
  const [range, setRange] = useState('24h');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [limit, setLimit] = useState(50);
  const base0 = React.useMemo(() => avail ? buildActivityAvail(cap) : buildActivity(agents), [agents, avail, cap, S.get().approvals, S.get().agentRevs, S.get().schedules]);
  const baseRef = React.useRef(base0); baseRef.current = base0;
  // Disponible hoy: cada persona ve lo suyo, al momento. Un admin ve también lo de los demás (solo metadatos), cuando termina cada turno.
  const shows = (e) => !avail || e.who === me || (isAdmin && (!e.pending || ended));
  const all = [...extra, ...base0].filter(shows).map(e => avail ? { ...e, mine: e.who === me } : e).sort((x, y) => new Date(y.at) - new Date(x.at));

  useEffect(() => { setExtra([]); setFresh([]); }, [avail]);
  useEffect(() => { if (cap) setRange('7d'); }, [cap]);
  useEffect(() => {
    if (!live || blocked) return;
    if (!avail) {
      const pool = agents.filter(a => a.status === 'online' && a.mcp.length);
      const t = setInterval(() => {
        const a = pool[Math.floor(Math.random() * pool.length)]; if (!a) return;
        const server = a.mcp[Math.floor(Math.random() * a.mcp.length)];
        const srv = window.Lifecycle?.serverOf(server);
        const tool = srv?.tools?.filter(x => !x.write)[0]?.name || 'query';
        const ok = Math.random() > 0.08;
        const e = { id: 'live' + Date.now(), kind: ok ? 'tool' : 'error', agentId: a.id, at: new Date().toISOString(), text: ok ? 'llamó a' : 'falló al llamar a', target: server + '.' + tool, ms: 150 + Math.round(Math.random() * 1200), ok, live: true };
        setExtra(x => [e, ...x].slice(0, 40)); setFresh([e.id]);
      }, 5000);
      return () => clearInterval(t);
    }
    // Consulta cada 15 s y se pausa con la pestaña oculta. Lo de otras personas llega al terminar su turno, con la hora de cada llamada.
    const poll = () => {
      if (!isAdmin || S.get().simAct === 'poll') return;
      if (!endedRef.current) { endedRef.current = true; setEnded(true); setFresh(baseRef.current.filter(e => e.pending).map(e => e.id)); return; }
      if (Math.random() < 0.5) return;
      const k = 1 + Math.floor(Math.random() * 3); const id = 'live' + Date.now();
      const specs = Array.from({ length: k }, () => { const ok = Math.random() > 0.08; const tool = ACT_AV_TOOLS[Math.floor(Math.random() * ACT_AV_TOOLS.length)]; return { ok, tool, ms: ok ? actMs(tool, Math.floor(Math.random() * 1e6)) : null }; });
      let t = Date.now() - 15e3 - specs.reduce((s, x) => s + (x.ms || 4000) + 2500, 0);
      const evs = specs.map((x, i) => { const e = { id: id + '-' + i, kind: x.ok ? 'tool' : 'error', agentId: 'fin-01', who: 'Usuario 9', at: new Date(t).toISOString(), text: x.ok ? 'llamó a' : 'falló al llamar a', target: x.tool, ms: x.ms, ok: x.ok, live: true }; t += (x.ms || 4000) + 2500; return e; });
      setExtra(x => [...evs, ...x].slice(0, 40)); setFresh(evs.map(e => e.id));
    };
    let t = null;
    const start = () => { if (!t && !document.hidden) t = setInterval(poll, 15000); };
    const stop = () => { clearInterval(t); t = null; };
    const onVis = () => { if (document.hidden) stop(); else { poll(); start(); } };
    start(); document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [live, agents, avail, isAdmin, blocked]);

  const RANGES = [['1h', '1 h', 36e5], ['24h', '24 h', 864e5], ['7d', '7 días', 7 * 864e5]];
  const rangeL = RANGES.find(r => r[0] === range)[1];
  const since = Date.now() - RANGES.find(r => r[0] === range)[2];
  const inPeriod = all.filter(e => new Date(e.at).getTime() >= since);
  // Tope del servidor: con más de 1000 eventos en el periodo llegan los 1000 más recientes. Todo lo de abajo se calcula sobre esos.
  const capped = !!avail && inPeriod.length > ACT_CAP;
  const inRange = capped ? inPeriod.slice(0, ACT_CAP) : inPeriod;
  const Q = q.trim().toLowerCase();
  const agName = (id) => agents.find(a => a.id === id)?.name || id;
  // De otra persona no se muestra (ni se busca) el detalle: la tarea solo va en lo propio.
  const subOf = (e) => !avail ? e.sub : e.mine && e.task ? 'Tarea · ' + e.task : null;
  // A la derecha: la latencia, «error» o, en una aprobación, su estado.
  const slotOf = (e) => avail && e.kind === 'approval' ? ACT_AP[e.apState] || null : e.ok === false && (avail || e.ms != null) ? ['error', 'var(--red)'] : e.ms != null ? [fmtDur(e.ms), null] : null;
  const base = inRange.filter(e => (agent === 'all' || e.agentId === agent) && (!Q || [agName(e.agentId), e.text, e.target, subOf(e)].join(' ').toLowerCase().includes(Q)));
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
  // Disponible hoy un agente está publicado o retirado: no hay «en línea», «degradado» ni «iniciando».
  const published = agents.filter(a => !retired[a.id]);
  const silent = avail ? (isAdmin ? published.filter(a => !byAgent.some(b => b.id === a.id)) : []) : agents.filter(a => a.status !== 'offline' && !byAgent.some(b => b.id === a.id));
  const agentOpts = avail ? agents.filter(a => all.some(e => e.agentId === a.id)) : agents;

  const exportCsv = () => {
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const res = (e) => avail && e.kind === 'approval' ? (ACT_AP[e.apState] || [''])[0] : avail && e.kind === 'budget' ? 'bloqueado' : e.ok === false ? 'error' : 'ok';
    const csv = ['fecha,agente,tipo,evento,objetivo,ms,resultado', ...rows.map(e => [e.at, agName(e.agentId), ACT_KINDS[e.kind][0], e.text, e.target, e.ms || '', res(e)].map(esc).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    const el = document.createElement('a'); el.href = url; el.download = 'mango-actividad.csv'; el.click(); URL.revokeObjectURL(url);
    toast?.({ tone: 'success', msg: rows.length + ' eventos exportados' });
  };
  const go = (e) => { if (!e.link) return; if (e.link[0] === 'chat') openChat?.(e.link[1], e.link[2]); else if (e.link[0] === 'run') { S.set({ scOpen: { id: e.link[1], run: e.link[2] } }); window.MangoNav?.('schedules'); } else window.MangoNav?.(e.link[0], e.link[1]); };
  // Disponible hoy: la conversación y la tarea solo se abren desde lo propio; Presupuestos, solo para quien lo ve.
  const linkOf = (e) => !e.link ? null : !avail ? e.link : ['chat', 'run'].includes(e.link[0]) ? (e.mine ? e.link : null) : e.link[0] === 'budgets' ? (S.canView('budgets') ? e.link : null) : e.link;
  const LINK_L = { chat: 'Abrir conversación', run: 'Ver ejecución', approvals: 'Ver aprobación', budgets: avail ? 'Ver presupuestos' : 'Ver presupuesto' };
  const linkLabel = (e) => e.link[0] === 'tickets' ? 'Abrir ' + e.target : LINK_L[e.link[0]] || 'Ver revisión';
  const shown = rows.slice(0, limit);
  const hourKey = (iso) => { const d = new Date(iso); d.setMinutes(0, 0, 0); return d.getTime(); };
  const groups = []; shown.forEach(e => { const k = hourKey(e.at); const g = groups[groups.length - 1]; if (g && g.k === k) g.items.push(e); else groups.push({ k, items: [e] }); });
  const hourLabel = (k) => { const d = new Date(k); const today = new Date(); today.setHours(0, 0, 0, 0); const day = d >= today ? '' : d >= today - 864e5 ? 'Ayer · ' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) + ' · '; const h = (x) => String(x).padStart(2, '0') + ':00'; return day + h(d.getHours()) + ' – ' + h((d.getHours() + 1) % 24); };
  const auditLink = <a href="#" className="sr-link" style={{ fontSize: 'inherit', padding: 0 }} onClick={(ev) => { ev.preventDefault(); window.MangoNav?.('audit'); }}>Audit log</a>;
  const crumbs = ['Gobernanza', 'Actividad'];

  if (sim === 'denied') return <><Topbar crumbs={crumbs} /><div className="content"><K.Denied view="activity" /></div></>;

  const KPI_L = ['Eventos · ' + rangeL, 'Agentes con actividad', 'Tools con error', 'Latencia media'];
  const toolbar = (
    <div className="bg-toolbar">
      <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder={avail ? 'Buscar agente o tool' : 'Buscar agente, tool o ticket'} value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar actividad" /></div>
      <div className="tk-quick" role="group" aria-label="Periodo">{RANGES.map(([k, l]) => <button key={k} className={range === k ? 'is-on' : ''} aria-pressed={range === k} onClick={() => setRange(k)}>{l}</button>)}</div>
      <select className="input mk-sel" value={agent} onChange={e => setAgent(e.target.value)} aria-label="Agente"><option value="all">Todos los agentes</option>{(blocked ? [] : agentOpts).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      <div style={{ flex: 1 }} />
      {sim === 'poll' && live && <span className="ac-poll" role="status"><I.Warn size={12} /> No se pudo buscar actividad nueva. Se vuelve a intentar en 15 s.</span>}
      {anyFilter && <button className="btn btn-sm btn-ghost" onClick={clear}>Limpiar</button>}
    </div>
  );

  return (
    <>
      <Topbar crumbs={crumbs} actions={<>
        <button className={'btn btn-sm' + (live && !blocked ? ' ac-live-on' : '')} onClick={() => setLive(v => !v)} aria-pressed={live} disabled={blocked} title={avail ? 'Busca actividad nueva cada 15 s. Se pausa mientras la pestaña está oculta.' : undefined}>{live ? <><span className="ac-pulse" /> En vivo</> : <><I.Play size={11} /> Reanudar</>}</button>
        <button className="btn btn-sm" onClick={exportCsv} disabled={blocked || !rows.length}><I.Download size={12} /> Exportar CSV</button>
      </>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Actividad</h1>
          <p className="page-subtitle">{!avail ? <>Qué están haciendo los agentes: llamadas a tools, tickets, aprobaciones y errores. Las decisiones y los cambios de ajustes están en el {auditLink}.</>
            : isAdmin ? <>Llamadas a tools, aprobaciones pedidas, errores y turnos bloqueados por presupuesto en los chats y las tareas de todos. Lo tuyo aparece al momento; lo de otras personas, al terminar cada turno y sin su conversación. Las decisiones y los cambios de ajustes están en el {auditLink}.</>
            : 'Llamadas a tools, aprobaciones pedidas, errores y turnos bloqueados por presupuesto en tus conversaciones y tus tareas.'}</p>
        </div>
        {sim === 'loading' ? <div className="bg-kpis" aria-hidden="true">{KPI_L.map(l => <div key={l} className="card bg-kpi"><span className="bg-kpi-l">{l}</span><Sk w={64} h={22} /><Sk w="62%" h={10} /></div>)}</div>
          : sim !== 'error' && <div className="bg-kpis">
            <div className="card bg-kpi"><span className="bg-kpi-l">Eventos · {rangeL}</span><span className="bg-kpi-v">{capped ? 'Más de ' + ACT_CAP : inRange.length}</span><span className="bg-kpi-s">{capped ? 'Se muestran los ' + ACT_CAP + ' más recientes' : calls.length + ' llamadas a tools'}</span></div>
            <div className="card bg-kpi"><span className="bg-kpi-l">Agentes con actividad</span><span className="bg-kpi-v">{activeAgents}</span><span className="bg-kpi-s">{!avail ? 'de ' + agents.filter(a => a.status !== 'offline').length + ' en línea' : isAdmin ? 'de ' + published.length + ' publicados' : 'En tus conversaciones y tareas'}</span></div>
            <div className="card bg-kpi"><span className="bg-kpi-l">Tools con error</span><span className="bg-kpi-v" style={errs ? { color: 'var(--red)' } : null}>{calls.length ? (errs / calls.length * 100).toFixed(1).replace('.', ',') + '%' : '—'}</span><span className="bg-kpi-s">{errs} de {calls.length}</span></div>
            <div className="card bg-kpi"><span className="bg-kpi-l">Latencia media</span><span className="bg-kpi-v">{avgMs != null ? fmtDur(avgMs) : '—'}</span><span className="bg-kpi-s">{avgMs != null ? 'De ' + withMs.length + ' llamadas medidas' : 'Sin mediciones'}</span></div>
          </div>}
        {toolbar}
        {!blocked && <div className="au-cats" style={{ padding: '0 28px 14px' }} role="group" aria-label="Tipo">
          <button className={kind === 'all' ? 'is-on' : ''} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>Todo<span>{base.length}</span></button>
          {Object.entries(ACT_KINDS).map(([k, [l]]) => { const c = base.filter(e => e.kind === k).length; return c || kind === k ? <button key={k} className={kind === k ? 'is-on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}<span>{c}</span></button> : null; })}
        </div>}

        {sim === 'loading' ? (
          <div className="ac-grid" role="status" aria-label="Cargando la actividad">
            <div><div className="au-day-h"><Sk w={92} h={10} /></div><div className="card" style={{ padding: 0, overflow: 'hidden' }}>{[62, 48, 70, 55, 66, 44].map((w, i) => <div key={i} className="ac-row"><div className="ac-main" style={{ pointerEvents: 'none' }}><Sk w={34} h={10} /><Sk w={24} h={24} r={6} /><span style={{ flex: 1, minWidth: 0 }}><Sk w={w + '%'} /></span><Sk w={40} h={10} /></div></div>)}</div></div>
            <aside className="ac-side"><div className="card" style={{ padding: 0 }}><div className="ac-side-h">agentes más activos</div>{[70, 52, 60].map((w, i) => <div key={i} className="ac-ag" style={{ display: 'grid', gap: 8 }}><Sk w={w + '%'} /><Sk h={4} r={2} /></div>)}</div></aside>
          </div>
        ) : sim === 'error' ? (
          <div className="ac-grid" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}><div role="alert"><K.ErrorState title="No se pudo cargar la actividad" body="Vuelve a intentarlo en unos segundos." onRetry={() => S.set({ simAct: null })} /></div></div>
        ) : (
        <div className="ac-grid">
          <div>
            {!rows.length ? (
              <div className="card"><div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600 }}>Sin actividad</div><div className="mk-meta">{anyFilter ? 'Nada coincide con los filtros.' : 'No hubo actividad en este periodo.'}</div>{anyFilter && <button className="btn btn-sm" onClick={clear}>Limpiar filtros</button>}</div></div>
            ) : groups.map(g => (
              <section key={g.k} style={{ marginBottom: 18 }}>
                <div className="au-day-h">{hourLabel(g.k)}<span>{g.items.length}</span></div>
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  {g.items.map(e => {
                    const a = agents.find(x => x.id === e.agentId); const Ic = a ? I[a.icon] || I.Bot : I.Bot; const [kl, kic, kc] = ACT_KINDS[e.kind]; const Kd = I[kic];
                    const open = openId === e.id; const sub = subOf(e); const lk = linkOf(e); const slot = slotOf(e);
                    return (
                      <div key={e.id} className={'ac-row' + (fresh.includes(e.id) ? ' is-fresh' : '') + (e.kind === 'error' ? ' is-err' : '')}>
                        <button className="ac-main" onClick={() => setOpenId(open ? null : e.id)} aria-expanded={open}>
                          <span className="mono au-time">{new Date(e.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                          <span className="tk-agent-ic" style={{ background: a?.iconBg, color: a?.iconColor, width: 24, height: 24, borderRadius: 6 }}><Ic size={12} /></span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span className="ac-t"><b>{a?.name || e.agentId}</b> {e.text} {e.target && <code className="ac-target">{e.target}</code>}</span>
                            {sub && <span className="ac-s">{sub}</span>}
                          </span>
                          {slot && <span className="mono ac-ms" style={{ color: slot[1] || undefined }}>{slot[0]}</span>}
                          <span className="ac-kind" style={{ color: kc }} title={kl}><Kd size={12} /></span>
                        </button>
                        {open && (
                          <div className="ac-more">
                            {!avail && e.params && <pre className="mono">{JSON.stringify(e.params, null, 2)}</pre>}
                            {avail && !e.mine && <div className="mk-meta">De otra persona: solo ves {ACT_OTHER[e.kind] || 'el agente y la hora'}.</div>}
                            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
                              <button className="btn btn-sm" onClick={() => { setAgent(e.agentId); setOpenId(null); }}>Solo {a?.name}</button>
                              {lk && <button className="btn btn-sm" onClick={() => go(e)}>{linkLabel(e)} <I.ArrowRight size={11} /></button>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
            {rows.length > limit ? <button className="btn btn-sm" style={{ margin: '0 auto', display: 'flex' }} onClick={() => setLimit(l => l + 50)}>Mostrar más · quedan {rows.length - limit}</button>
              : rows.length > 0 && (capped || (avail && range === '7d')) && <div className="mk-meta" style={{ textAlign: 'center', display: 'grid', gap: 4 }}>
                {capped && <span>Este periodo tiene más de {ACT_CAP} eventos. Se muestran los {ACT_CAP} más recientes.</span>}
                {avail && range === '7d' && <span>Aquí se ven hasta 7 días. La actividad se guarda 30 días.</span>}
              </div>}
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
                {silent.slice(0, 6).map(a => <div key={a.id} className="ac-silent"><span>{a.name}</span>{!avail && <span className="mk-meta">{a.status === 'degraded' ? 'Degradado' : a.status === 'warmup' ? 'Iniciando' : 'En línea'}</span>}</div>)}
              </div>
            )}
          </aside>
        </div>
        )}
      </div>
    </>
  );
}

Object.assign(window, { ActivityView, fmtDur });
