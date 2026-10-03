// Org chart (v2), Governance (v2), Inbox, Activity, Skills, Costs, Settings
function OrgChart({ agents: allAgents }) {
  const I = window.Icons; const S = window.MangoStore;
  const avail = window.useMango(s => s.avail);
  const role = window.useMango(s => s.role);
  const narrow = window.useMedia('(max-width: 760px)');
  const myGroups = S.ROLES[role].groups;
  const fullTree = !avail || role !== 'user';
  const agents = fullTree ? allAgents : allAgents.filter(a => (window.sharesOf(a).groups || []).some(g => myGroups.includes(g.id)) || a.id === 'fin-01');
  const [selected, setSelected] = useState(null);
  const [delegating, setDelegating] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [q, setQ] = useState('');
  const wrapRef = React.useRef(null);
  const treeRef = React.useRef(null);

  const tree = React.useMemo(() => {
    const rootNode = { id: 'platform', name: 'Platform Admin', role: avail ? 'Raíz · no es un agente' : 'Supervisor raíz', icon: 'Shield', kids: [] };
    const map = { platform: rootNode };
    agents.forEach(a => { map[a.id] = { id: a.id, name: a.name, role: a.role || a.cat, icon: a.icon, status: a.status, cat: a.cat, kids: [] }; });
    const hidden = { id: '__hidden', name: 'Supervisor no visible', role: 'No tienes acceso a su supervisor o está retirado', icon: 'Lock', ghost: true, kids: [] };
    agents.forEach(a => { const m = a.manager || 'platform'; const parent = map[m] || (avail ? hidden : rootNode); parent.kids.push(map[a.id]); });
    if (hidden.kids.length) rootNode.kids.push(hidden);
    return rootNode;
  }, [agents, avail]);
  const delegations = [
    { from: 'ops-02', to: 'ops-01', task: 'Verificar métricas p95 de checkout-api', status: 'running', time: 'hace 2 min', cost: 0.18 },
    { from: 'fin-01', to: 'fin-02', task: 'Analizar coverage de Savings Plans m3.large', status: 'done', time: 'hace 14 min', cost: 0.42, result: '3 SP sugeridos · ahorro $840/mes' },
    { from: 'dev-01', to: 'ops-02', task: 'Triage de incidente P2 en pipeline staging', status: 'done', time: 'hace 1 h', cost: 1.2, result: 'Rollback ejecutado · resuelto' },
    { from: 'sec-01', to: 'sec-02', task: 'Revisar 12 cuentas IAM sin rotación > 90 d', status: 'running', time: 'hace 25 min', cost: 0.67 },
    { from: 'platform', to: 'fin-01', task: 'Reporte mensual de costos por equipo', status: 'queued', time: 'programado 09:00', cost: null },
    { from: 'fin-01', to: 'data-01', task: 'Query de cost allocation por tag:team', status: 'done', time: 'hace 3 h', cost: 0.09, result: '42 filas' },
  ];
  const flatten = (n, depth = 0, parent = null) => [{ ...n, depth, parent }, ...(n.kids || []).flatMap(k => flatten(k, depth + 1, n.id))];
  const all = flatten(tree);
  const selNode = selected ? all.find(n => n.id === selected) : null;
  const selAgent = selNode && selNode.id !== 'platform' && !selNode.ghost ? agents.find(a => a.id === selNode.id) : null;
  const match = (n) => q && (n.name + ' ' + n.role).toLowerCase().includes(q.toLowerCase());
  // A2A: sin backend ni acción de permiso todavía → todo lo de delegación va como «Próximamente»
  const busy = () => false;

  // Pan & zoom viewport: view = { x, y, k }
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const drag = React.useRef(null);
  const userMoved = React.useRef(false);
  const lastW = React.useRef(0);
  const fitView = React.useCallback(() => {
    const w = wrapRef.current, t = treeRef.current; if (!w || !t) return;
    userMoved.current = false; lastW.current = w.clientWidth;
    const cw = w.clientWidth, ch = w.clientHeight, tw = Math.max(t.offsetWidth, t.scrollWidth), th = Math.max(t.offsetHeight, t.scrollHeight);
    const k = Math.max(0.5, Math.floor(Math.min(1, (cw - 64) / tw, (ch - 64) / th) * 10) / 10);
    setView({ k, x: tw * k > cw - 32 ? 32 : (cw - tw * k) / 2, y: Math.max(32, (ch - th * k) / 2) });
  }, []);
  React.useLayoutEffect(() => { fitView(); }, [collapsed, agents]);
  React.useEffect(() => {
    const w = wrapRef.current; if (!w) return;
    lastW.current = w.clientWidth;
    const ro = new ResizeObserver(() => {
      const nw = w.clientWidth, dw = nw - lastW.current; lastW.current = nw;
      if (!dw) return;
      if (!userMoved.current) fitView();
      else setView(v => ({ ...v, x: v.x + dw / 2 }));
    });
    ro.observe(w); return () => ro.disconnect();
  }, []);
  // keep the selected node visible when the side panel opens
  React.useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => {
      const el = treeRef.current?.querySelector('.oc-node.on'); const w = wrapRef.current; if (!el || !w) return;
      const er = el.getBoundingClientRect(), wr = w.getBoundingClientRect(), pad = 24;
      let dx = 0, dy = 0;
      if (er.left < wr.left + pad) dx = wr.left + pad - er.left; else if (er.right > wr.right - pad) dx = wr.right - pad - er.right;
      if (er.top < wr.top + pad) dy = wr.top + pad - er.top; else if (er.bottom > wr.bottom - pad) dy = wr.bottom - pad - er.bottom;
      if (dx || dy) setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }, 80);
    return () => clearTimeout(t);
  }, [selected]);
  const zoomAt = (factor, cx, cy, step) => { userMoved.current = true; setView(v => {
    const pct = Math.round(v.k * 100 / 10) * 10;
    const raw = step != null ? pct + step : Math.round(v.k * factor * 100 / 10) * 10;
    const k = Math.max(0.3, Math.min(2, (raw === pct && step == null ? pct + (factor > 1 ? 10 : -10) : raw) / 100));
    if (k === v.k) return v;
    const w = wrapRef.current; if (cx == null) { cx = w.clientWidth / 2; cy = w.clientHeight / 2; }
    return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
  }); };
  React.useEffect(() => {
    const w = wrapRef.current; if (!w) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r = w.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else if (e.deltaMode !== 0 || (Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 40)) zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
      else { userMoved.current = true; setView(v => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) })); }
    };
    w.addEventListener('wheel', onWheel, { passive: false });
    return () => w.removeEventListener('wheel', onWheel);
  }, []);
  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag.current = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y }; userMoved.current = true;
    setDragging(true); e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => { const d = drag.current; if (!d) return; setView(v => ({ ...v, x: d.x + e.clientX - d.sx, y: d.y + e.clientY - d.sy })); };
  const onPointerUp = () => { drag.current = null; setDragging(false); };
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? 160 : 60;
    const m = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (m) { e.preventDefault(); userMoved.current = true; setView(v => ({ ...v, x: v.x + m[0], y: v.y + m[1] })); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1, null, null, 10); }
    else if (e.key === '-') { e.preventDefault(); zoomAt(1, null, null, -10); }
    else if (e.key === '0') { e.preventDefault(); fitView(); }
  };
  React.useEffect(() => {
    if (!q) return;
    const t = setTimeout(() => {
      const hit = treeRef.current?.querySelector('.oc-node.hit'); const w = wrapRef.current; if (!hit || !w) return;
      const hr = hit.getBoundingClientRect(), wr = w.getBoundingClientRect();
      userMoved.current = true;
      setView(v => ({ ...v, x: v.x + (wr.left + wr.width / 2) - (hr.left + hr.width / 2), y: v.y + (wr.top + wr.height / 2) - (hr.top + hr.height / 2) }));
    }, 60);
    return () => clearTimeout(t);
  }, [q]);

  const toggle = (id) => { const n = new Set(collapsed); n.has(id) ? n.delete(id) : n.add(id); setCollapsed(n); };
  const Node = ({ n, root }) => {
    const Ic = I[n.icon] || I.Bot;
    const kids = n.kids || [];
    const isCol = collapsed.has(n.id);
    const count = (x) => (x.kids || []).reduce((s, k) => s + 1 + count(k), 0);
    return (
      <li>
        <div className={'oc-node' + (selected === n.id ? ' on' : '') + (root ? ' root' : '') + (match(n) ? ' hit' : '')} style={n.ghost ? { borderStyle: 'dashed', opacity: .85 } : undefined}>
          <button className="oc-node-main" onClick={() => setSelected(selected === n.id ? null : n.id)} aria-pressed={selected === n.id} aria-label={n.name + ', ' + n.role}>
            <span className="oc-ic"><Ic size={15} />{!root && !avail && !n.ghost && <span className="oc-pip" style={{ background: n.status === 'online' ? 'var(--green)' : n.status === 'warmup' ? 'var(--amber)' : n.status === 'degraded' ? 'var(--red)' : 'var(--chart-muted)' }} />}</span>
            <span style={{ minWidth: 0, textAlign: 'left' }}>
              <span className="oc-name">{n.name}</span>
              <span className="oc-role">{n.role}</span>
            </span>
            {busy(n.id) && <span className="mango-spinner" title="Delegación en curso" style={{ marginLeft: 'auto', flexShrink: 0 }} />}
          </button>
          {kids.length > 0 && (
            <button className="oc-toggle" onClick={() => toggle(n.id)} aria-expanded={!isCol} aria-label={(isCol ? 'Mostrar ' : 'Ocultar ') + count(n) + (count(n) === 1 ? ' subordinado de ' : ' subordinados de ') + n.name}>
              {isCol ? '+' + count(n) : <I.ChevronDown size={11} />}
            </button>
          )}
        </div>
        {kids.length > 0 && !isCol && <ul>{kids.map(k => <Node key={k.id} n={k} />)}</ul>}
      </li>
    );
  };
  const running = delegations.filter(d => d.status === 'running').length;
  const cost = delegations.reduce((s, d) => s + (d.cost || 0), 0);
  const STATUS = { running: ['En curso', 'badge-amber'], done: ['Completada', 'badge-green'], queued: ['En cola', 'badge'] };

  return (
    <>
      <Topbar crumbs={['Org chart']} actions={(!avail || S.can('agent.create')) && <button className="btn btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('mango:new-agent'))}><I.Plus size={12} /> Nuevo agente</button>} />
      <div className="content">
        <div className="page-wrap oc-page">
          <h1 className="page-title">Org Chart</h1>
          <p className="page-subtitle" style={{ marginBottom: 20 }}>Quién supervisa a quién, según el «Reporta a» y el rol de cada agente. Se definen en el Agent Builder y cambian solo con una versión aprobada.{!fullTree && ' Ves solo los agentes que puedes usar.'}</p>
          <div className="oc-stats">
            <div><span>Agentes</span><b>{agents.length}</b></div>
            <div><span>Supervisores</span><b>{all.filter(n => n.kids.length && n.id !== 'platform' && !n.ghost).length}</b></div>
            {avail ? <div><span>Con alertas</span><b><window.SoonTag /></b></div> : <div><span>Con alertas</span><b style={{ color: agents.filter(x => x.status === 'degraded' || x.status === 'offline' || (x.budgetMax && x.budget / x.budgetMax >= 0.8)).length ? 'var(--amber)' : undefined }}>{agents.filter(x => x.status === 'degraded' || x.status === 'offline' || (x.budgetMax && x.budget / x.budgetMax >= 0.8)).length}</b></div>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: selNode && !narrow ? 'minmax(0,1fr) 340px' : 'minmax(0,1fr)', gap: 16, alignItems: 'start' }} className="keep-grid">
            <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="row between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', gap: 12, flexWrap: 'wrap' }}>
                <div className="search-wrap" style={{ flex: 1, maxWidth: 280, minWidth: 160 }}>
                  <I.Search size={13} />
                  <input className="input" aria-label="Buscar agente en el organigrama" placeholder="Buscar agente..." value={q} onChange={e => setQ(e.target.value)} />
                </div>
                <div className="row gap-1" style={{ flexWrap: 'wrap' }}>
                  <button className="btn btn-sm btn-ghost" onClick={() => setCollapsed(new Set(all.filter(n => n.depth === 1 && n.kids.length).map(n => n.id)))}>Colapsar</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setCollapsed(new Set())}>Expandir</button>
                  <span className="topbar-sep" />
                  <button className="btn btn-sm btn-icon" aria-label="Alejar" title="Alejar (−)" onClick={() => zoomAt(1, null, null, -10)}>−</button>
                  <button className="btn btn-sm" style={{ minWidth: 64, justifyContent: 'center', fontVariantNumeric: 'tabular-nums' }} onClick={fitView} title="Ajustar a la vista (0)">{Math.round(view.k * 100) + '%'}</button>
                  <button className="btn btn-sm btn-icon" aria-label="Acercar" title="Acercar (+)" onClick={() => zoomAt(1, null, null, 10)}>+</button>
                  <button className="btn btn-sm btn-ghost" onClick={fitView} title="Centrar y ajustar (0)"><I.Expand size={12} /> Ajustar</button>
                </div>
              </div>
              <div ref={wrapRef} className={'oc-canvas' + (dragging ? ' grabbing' : '')} tabIndex={0} role="application" aria-label="Organigrama. Arrastra o usa las flechas para moverte; + y − para zoom; 0 para ajustar."
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onKey} onDoubleClick={(e) => { if (e.target.closest('button')) return; const r = wrapRef.current.getBoundingClientRect(); zoomAt(1.4, e.clientX - r.left, e.clientY - r.top); }}
                style={{ backgroundPosition: view.x + 'px ' + view.y + 'px', backgroundSize: 20 * view.k + 'px ' + 20 * view.k + 'px' }}>
                <div className="oc-hint" aria-hidden="true">Arrastra para moverte · rueda o pellizco para zoom · flechas para desplazar</div>
                <div ref={treeRef} className="oc-tree" style={{ transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')' }}>
                  <ul><Node n={tree} root /></ul>
                </div>
              </div>
              <div className="row gap-3" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                <window.Soon on={avail} className="row gap-3"><span className="row gap-3" style={{ flexWrap: 'wrap' }}>{[['var(--green)', 'En línea'], ['var(--amber)', 'Iniciando'], ['var(--red)', 'Degradado'], ['var(--chart-muted)', 'Fuera de línea']].map(([c, l]) => <span key={l} className="row gap-1"><span className="dot" style={{ background: c }} />{l}</span>)}
                <span className="row gap-1"><span className="mango-spinner" /> Delegación en curso</span></span></window.Soon>
              </div>
            </section>
            {selNode && <OrgSidePanel node={selNode} agent={selAgent} agents={agents} delegations={delegations.map(d => ({ ...d, cost: d.cost == null ? '—' : (window.GovKit ? window.GovKit.usd(d.cost) : '$' + d.cost) }))} onClose={() => setSelected(null)} onDelegate={() => setDelegating(selNode)} allNodes={all} />}
          </div>

          <h2 className="row gap-2" style={{ fontSize: 15, fontWeight: 600, margin: '32px 0 12px' }}>Delegaciones recientes <window.SoonTag /></h2>
          {avail ? <div className="card" style={{ padding: '18px 20px', display: 'flex', gap: 12, alignItems: 'center' }}><I.GitBranch size={16} style={{ color: 'var(--text-muted)' }} /><div style={{ flex: 1 }}><div style={{ fontSize: 13.5, fontWeight: 500 }}>Delegación A2A</div><div className="mk-meta">Cuando un agente pueda delegar tareas a sus subordinados, aparecerán aquí.</div></div><window.SoonTag /></div> : <window.Soon on block label="Delegación A2A · próximamente"><div className="card" style={{ padding: 0 }}>
            {delegations.map((d, i) => {
              const f = all.find(n => n.id === d.from), t = all.find(n => n.id === d.to);
              if (!f || !t) return null;
              return (
                <button key={i} className="oc-deleg" onClick={() => setSelected(d.to)} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ minWidth: 0 }}>
                    <span className="row gap-2" style={{ fontSize: 13.5, fontWeight: 500 }}>{f.name}<I.ArrowRight size={12} style={{ color: 'var(--text-muted)' }} />{t.name}</span>
                    <span style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{d.task}{d.result && <span style={{ color: 'var(--green)' }}> · {d.result}</span>}</span>
                  </span>
                  <span className={'badge ' + STATUS[d.status][1]}>{STATUS[d.status][0]}</span>
                  <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', width: 56, textAlign: 'right' }}>{d.cost == null ? '—' : (window.GovKit ? window.GovKit.usd(d.cost) : d.cost.toFixed(2))}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--text-muted)', width: 110, textAlign: 'right', whiteSpace: 'nowrap' }}>{d.time}</span>
                </button>
              );
            })}
          </div></window.Soon>}
        </div>
        {delegating && <DelegateModal from={delegating} allNodes={all} onClose={() => setDelegating(null)} />}
      </div>
    </>
  );
}

function OrgSidePanel({ node, agent, agents, delegations, onClose, onDelegate, allNodes }) {
  const I = window.Icons;
  const Ag = I[node.icon] || I.Bot;
  const asSender = delegations.filter(d => d.from === node.id);
  const asReceiver = delegations.filter(d => d.to === node.id);
  const kids = (node.kids || []).map(k => allNodes.find(n => n.id === k.id)).filter(Boolean);

  return (
    <div className="card" style={{padding: 0, position: 'sticky', top: 20}}>
      <div className="row between" style={{padding:'14px 16px', borderBottom:'1px solid var(--border)'}}>
        <div className="row gap-3">
          <span style={{width: 36, height: 36, borderRadius: 10, background:'var(--row-hover)', color:'var(--text)', display:'flex', alignItems:'center', justifyContent:'center'}}>
            <Ag size={17} />
          </span>
          <div>
            <div style={{fontSize: 14, fontWeight: 600}}>{node.name}</div>
            <div style={{fontSize: 12, color:'var(--text-muted)'}}>{node.role}</div>
          </div>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose}><I.Close size={13} /></button>
      </div>

      <div style={{padding: 14}}>
        {kids.length > 0 && (
          <window.Soon on block style={{marginBottom: 14}}><button className="btn btn-primary btn-sm" style={{width:'100%', justifyContent:'center'}} onClick={onDelegate}>
            <I.GitBranch size={12} /> Delegar tarea a subordinado
          </button></window.Soon>
        )}

        {node.ghost && <div className="mc-alert" style={{ marginBottom: 14, fontSize: 12.5 }}><I.Lock size={13} /><div>Estos agentes reportan a un supervisor que no puedes ver o que fue retirado. La línea no muestra la relación real de reporte.</div></div>}
        {node.id === 'platform' && window.MangoStore.get().avail && <div className="mk-meta" style={{ marginBottom: 14 }}>Platform Admin es la raíz del organigrama, no un agente.</div>}
        <div className="row gap-2" style={{marginBottom: 14}}>
          <MiniStat label="Enviadas" value={window.MangoStore.get().avail ? '—' : asSender.length} />
          <MiniStat label="Recibidas" value={window.MangoStore.get().avail ? '—' : asReceiver.length} />
          <MiniStat label="Subordinados" value={kids.length} />
        </div>

        {kids.length > 0 && (
          <div style={{marginBottom: 14}}>
            <div style={{fontSize: 11.5, color:'var(--text-muted)', fontWeight: 500, marginBottom: 6}}>Subordinados directos</div>
            {kids.map(k => {
              const Kic = I[k.icon] || I.Bot;
              const ag = agents.find(a => a.id === k.id);
              return (
                <div key={k.id} className="row gap-2" style={{padding:'8px 10px', borderRadius: 8, background:'var(--row-hover)', marginBottom: 4}}>
                  <span style={{width: 24, height: 24, borderRadius: 6, background:'var(--card)', color:'var(--text-muted)', display:'flex', alignItems:'center', justifyContent:'center'}}><Kic size={12} /></span>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: 13.5, fontWeight: 500}}>{k.name}</div>
                    <div style={{fontSize: 11.5, color:'var(--text-muted)'}}>{k.role}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {asSender.length > 0 && (
          <div style={{marginBottom: 14}}>
            <div style={{fontSize: 11.5, color:'var(--text-muted)', fontWeight: 500, marginBottom: 6}}>Últimas delegaciones enviadas</div>
            {asSender.slice(0, 3).map((d, i) => {
              const to = allNodes.find(n => n.id === d.to);
              return (
                <div key={i} style={{padding:'8px 10px', borderRadius: 8, background:'var(--row-hover)', marginBottom: 4}}>
                  <div className="row between" style={{marginBottom: 3}}>
                    <span style={{fontSize: 12.5, fontWeight: 500}}>→ {to?.name}</span>
                    <span style={{fontSize: 11, color: d.status === 'running' ? 'var(--amber)' : 'var(--green)'}}>{d.status === 'running' ? 'En curso' : 'Completada'}</span>
                  </div>
                  <div style={{fontSize: 12, color:'var(--text-muted)', lineHeight: 1.4}}>{d.task}</div>
                </div>
              );
            })}
          </div>
        )}

        {agent && <OrgAgentFacts agent={agent} kids={kids} agents={agents} />}
      </div>
    </div>
  );
}

function OrgAgentFacts({ agent, kids, agents }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const money = (n) => window.GovKit ? window.GovKit.usd(n) : '$' + n;
  const pct = agent.budgetMax ? Math.round(agent.budget / agent.budgetMax * 100) : 0;
  const ST = { online: ['En línea', 'badge-green'], warmup: ['Iniciando', 'badge-amber'], degraded: ['Degradado', 'badge-red'], offline: ['Fuera de línea', 'badge'] };
  const servers = (agent.mcp || []).map(id => L?.serverOf(id)).filter(Boolean);
  const acct = servers.some(s => s.level === 'accounts');
  const writes = servers.some(s => s.status === 'enabled' && s.tools.some(t => t.write));
  const off = servers.filter(s => s.status !== 'enabled');
  const evals = (S.get().evals || []).filter(e => e.agent === agent.id);
  const evFail = evals.filter(e => e.required && e.status === 'fail');
  const rev = (S.get().agentRevs || []).find(r => r.agentId === agent.id && ['review', 'draft'].includes(r.status));
  const kidsWrite = kids.filter(k => { const a = agents.find(x => x.id === k.id); return (a?.mcp || []).some(id => L?.serverOf(id)?.tools.some(t => t.write)); });
  const Row = ({ k, children }) => <div className="mk-kv" style={{ fontSize: 12.5 }}><span>{k}</span><span>{children}</span></div>;
  if (S.get().avail) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {agent.desc && <div style={{ fontSize: 13, lineHeight: 1.5 }}>{agent.desc}</div>}
      <div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>Agente</div>
        <Row k="Categoría">{agent.cat}</Row>
        {[['Estado'], ['Modelo'], ['Compartido con'], ['Presupuesto del mes'], ['Datos y permisos']].map(([k]) => <Row key={k} k={k}><span className="row gap-2" style={{ alignItems: 'center' }}><span className="mk-meta">—</span><window.SoonTag /></span></Row>)}
      </div>
      <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-sm" onClick={() => window.MangoNav?.('marketplace')}>Ver en Marketplace</button>
        {S.can('agent.edit') && <button className="btn btn-sm" onClick={() => window.MangoNav?.('admin', agent.id)}><I.Edit size={12} /> Editar</button>}
        <window.Soon on><button className="btn btn-sm btn-ghost">Costos</button></window.Soon>
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>Estado</div>
        <Row k="Estado"><span className={'badge ' + (ST[agent.status] || ST.offline)[1]}>{(ST[agent.status] || ST.offline)[0]}</span></Row>
        <Row k="Modelo"><span className="mono" style={{ fontSize: 12 }}>{agent.model}</span></Row>
        <Row k="Compartido con">{window.shareSummary ? window.shareSummary(agent) : '—'}</Row>
        {rev && <Row k="Cambio pendiente"><button className="sr-link" onClick={() => window.MangoNav?.(rev.status === 'review' ? 'review' : 'admin', rev.status === 'review' ? undefined : rev.id)}>{rev.status === 'review' ? 'En revisión' : 'Borrador'}</button></Row>}
      </div>
      <div>
        <div className="row between" style={{ fontSize: 12.5, marginBottom: 6 }}><span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 500 }}>Presupuesto del mes</span><span className="mono" style={{ color: pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--text)' }}>{pct}%</span></div>
        <div className="mk-bar-track"><span style={{ width: Math.min(100, pct) + '%', background: pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)' }} /></div>
        <div className="mk-meta mono" style={{ marginTop: 4, fontSize: 11.5 }}>{money(agent.budget)} de {money(agent.budgetMax)}</div>
      </div>
      <div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>Datos y permisos</div>
        <Row k="Tools">{servers.length} MCP{writes ? ' · con escritura' : ''}</Row>
        <Row k="Nivel de datos">{acct ? <span className="badge badge-violet">Datos de cuentas</span> : <span className="badge">Datos públicos</span>}</Row>
        {off.length > 0 && <div className="mc-alert amber" style={{ fontSize: 12, marginTop: 6 }}><I.Warn size={12} /><div>{off.map(s => s.name).join(', ')} no {off.length === 1 ? 'está' : 'están'} habilitado{off.length === 1 ? '' : 's'}: sus tools no están disponibles.</div></div>}
      </div>
      <div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>Evals</div>
        {evals.length ? <>{evals.map(e => <Row key={e.id} k={e.name}><span className="mono" style={{ fontSize: 12, color: e.status === 'pass' ? 'var(--green)' : e.status === 'fail' ? 'var(--red)' : 'var(--text-muted)' }}>{e.status === 'pending' ? 'Sin ejecutar' : Math.round(e.lastScore * 100) + '%'}</span></Row>)}{evFail.length > 0 && <div className="mk-meta" style={{ color: 'var(--red)', marginTop: 4 }}>Hay evals obligatorias que no pasan: sus cambios no se pueden aprobar.</div>}</> : <div className="mk-meta">Sin evals.</div>}
      </div>
      {kids.length > 0 && <div className="mk-meta" style={{ lineHeight: 1.5, fontSize: 12 }}>Al delegar, cada subordinado trabaja con sus propios permisos y presupuesto.{kidsWrite.length > 0 ? ' Si la tarea escribe (' + kidsWrite.map(k => k.name).join(', ') + '), queda una aprobación pendiente.' : ''}</div>}
      <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-sm" onClick={() => window.MangoNav?.('marketplace')}>Ver en Marketplace</button>
        {S.can('agent.edit') && <button className="btn btn-sm" onClick={() => window.MangoNav?.('admin', agent.id)}><I.Edit size={12} /> Editar</button>}
        <button className="btn btn-sm btn-ghost" onClick={() => window.MangoNav?.('costs')}>Costos</button>
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{flex: 1, padding:'8px 10px', background:'var(--row-hover)', borderRadius: 8, textAlign:'center'}}>
      <div style={{fontSize: 18, fontWeight: 600, color:'var(--text-strong)'}}>{value}</div>
      <div style={{fontSize: 11, color:'var(--text-muted)'}}>{label}</div>
    </div>
  );
}

function DelegateModal({ from, allNodes, onClose }) {
  const I = window.Icons;
  const toast = window.useToast?.();
  const [toId, setToId] = useState(from.kids?.[0]?.id || null);
  const [task, setTask] = useState("");
  const [priority, setPriority] = useState("normal");
  const [maxCost, setMaxCost] = useState(5);
  const kids = (from.kids || []).map(k => allNodes.find(n => n.id === k.id)).filter(Boolean);
  const to = toId ? allNodes.find(n => n.id === toId) : null;
  const ToIc = to ? (I[to.icon] || I.Bot) : null;
  const FromIc = I[from.icon] || I.Bot;

  const send = () => {
    onClose();
    toast?.({ tone:'success', msg: `Tarea delegada a ${to.name}` });
  };

  return (
    <div className="drawer-backdrop" onClick={onClose} style={{justifyContent:'center', alignItems:'center'}}>
      <div className="card" onClick={e => e.stopPropagation()} style={{width: 560, maxWidth:'92vw', display:'flex', flexDirection:'column', maxHeight:'85vh'}}>
        <div className="row between" style={{padding:'14px 18px', borderBottom:'1px solid var(--border)'}}>
          <div className="row gap-2"><I.GitBranch size={14} /> <span style={{fontWeight: 600}}>Delegar vía A2A</span></div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><I.Close size={13} /></button>
        </div>
        <div style={{padding: 20, overflowY:'auto'}}>
          <div className="row gap-2" style={{padding:'10px 12px', background:'var(--row-hover)', borderRadius: 8, marginBottom: 16, alignItems:'center'}}>
            <span style={{width: 28, height: 28, borderRadius: 8, background:'var(--card)', color:'var(--text-muted)', display:'flex', alignItems:'center', justifyContent:'center'}}><FromIc size={13} /></span>
            <span style={{fontSize: 13.5, fontWeight: 500}}>{from.name}</span>
            <I.ArrowRight size={12} style={{color:'var(--text-dim)', margin:'0 4px'}} />
            <span style={{fontSize: 13.5, color:'var(--text-muted)'}}>supervisa la ejecución</span>
          </div>

          <div style={{marginBottom: 14}}>
            <div style={{fontSize: 12, color:'var(--text-muted)', marginBottom: 8, fontWeight: 500}}>Destinatario</div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 6}}>
              {kids.map(k => {
                const Kic = I[k.icon] || I.Bot;
                const active = toId === k.id;
                return (
                  <button key={k.id} onClick={() => setToId(k.id)} className="card card-hover" style={{
                    padding: 10, display:'flex', gap: 10, alignItems:'center', cursor:'pointer', textAlign:'left',
                    background: active ? 'var(--accent-soft)' : 'var(--card)',
                    borderColor: active ? 'var(--accent-border)' : 'var(--border)'}}>
                    <span style={{width: 26, height: 26, borderRadius: 8, background:'var(--row-hover)', color: active ? 'var(--accent)' : 'var(--text-muted)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0}}><Kic size={12} /></span>
                    <div style={{minWidth: 0}}>
                      <div style={{fontSize: 13.5, fontWeight: 500}}>{k.name}</div>
                      <div style={{fontSize: 11.5, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{k.role}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{marginBottom: 14}}>
            <div style={{fontSize: 12, color:'var(--text-muted)', marginBottom: 6, fontWeight: 500}}>Tarea</div>
            <textarea className="input" rows={3} value={task} onChange={e => setTask(e.target.value)} placeholder={`ej: Analizar coverage de Savings Plans para instancias m3.large...`} />
          </div>

          <div className="row gap-3" style={{marginBottom: 14}}>
            <div style={{flex: 1}}>
              <div style={{fontSize: 12, color:'var(--text-muted)', marginBottom: 6, fontWeight: 500}}>Prioridad</div>
              <div className="row gap-1">
                {[['low','Baja'],['normal','Normal'],['high','Alta']].map(([k,l]) => (
                  <button key={k} type="button" className="tweak-chip" style={{
                    padding:'5px 10px',
                    background: priority === k ? 'var(--accent-soft)' : 'var(--card)',
                    color: priority === k ? 'var(--accent)' : 'var(--text-muted)',
                    borderColor: priority === k ? 'var(--accent-border)' : 'var(--border)'}} onClick={() => setPriority(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div style={{flex: 1}}>
              <div style={{fontSize: 12, color:'var(--text-muted)', marginBottom: 6, fontWeight: 500}}>Max cost (USD)</div>
              <div className="row gap-2">
                <input type="range" min="0.5" max="20" step="0.5" value={maxCost} onChange={e => setMaxCost(+e.target.value)} style={{flex: 1}} />
                <span className="mono" style={{fontSize: 13, width: 50, textAlign:'right'}}>{window.GovKit ? window.GovKit.usd(maxCost) : maxCost.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="card" style={{padding:'10px 12px', background:'var(--panel)', borderStyle:'dashed'}}>
            <div className="row gap-2" style={{fontSize: 13}}>
              <I.Info size={14} style={{color:'var(--blue)', flexShrink: 0, marginTop: 1}} />
              <div style={{color:'var(--text-muted)', lineHeight: 1.5}}>
                La tarea se enviará por el protocolo A2A. {to?.name || 'El subordinado'} retornará el resultado al supervisor cuando termine o haga escalation.
              </div>
            </div>
          </div>
        </div>
        <div className="row between" style={{padding:'12px 18px', borderTop:'1px solid var(--border)'}}>
          <button className="btn btn-sm" onClick={onClose}>Cancelar</button>
          <button className="btn btn-sm btn-primary" onClick={send} disabled={!task || !toId}><I.Zap size={11} /> Delegar ahora</button>
        </div>
      </div>
    </div>
  );
}

function Governance({ tickets, agents }) {
  const I = window.Icons; const S = window.MangoStore;
  const approvals = window.useMango(s => s.approvals);
  const audit = window.useMango(s => s.audit);
  const budgets = window.useMango(s => s.budgets);
  window.useMango(s => s.role);
  const go = (v) => window.MangoNav ? window.MangoNav(v) : window.dispatchEvent(new CustomEvent('mango:go', { detail: v }));
  const money = (n) => window.GovKit ? window.GovKit.usd(n) : '$' + n.toLocaleString();
  const left = (ap) => ap.expiresMin ? ap.expiresMin - Math.round((Date.now() - new Date(ap.at).getTime()) / 60000) : null;
  const live = approvals.filter(ap => ap.status === 'pending' && !(left(ap) != null && left(ap) <= 0));
  const mine = live.filter(ap => S.can('approval.decide') && !(ap.approvalsGiven || []).includes(S.actor()));
  const soon = live.filter(ap => { const l = left(ap); return l != null && l < 60; });
  const highRisk = live.filter(ap => ap.risk === 'high');
  const week = Date.now() - 7 * 864e5;
  const decided = approvals.filter(ap => ap.status !== 'pending' && new Date(ap.decidedAt).getTime() >= week);
  const approved = decided.filter(ap => ap.status === 'approved').length;
  const overBudget = budgets.filter(bg => bg.spent / bg.limit * 100 >= bg.warn).sort((x, y) => y.spent / y.limit - x.spent / x.limit);
  const teamB = budgets.filter(bg => bg.scope === 'team');
  const teamSpent = teamB.reduce((s, bg) => s + bg.spent, 0), teamLimit = teamB.reduce((s, bg) => s + bg.limit, 0);
  const unhealthy = agents.filter(ag => ag.status === 'degraded' || ag.status === 'offline');
  const props = (window.GovData?.proposals || []).filter(p => Date.now() - new Date(p.createdAt).getTime() < 7 * 864e5).length;
  const dayAgo = Date.now() - 864e5;
  const auditToday = audit.filter(e => new Date(e.at).getTime() >= dayAgo).length;
  const GOV_ACTIONS = /^(approval|budget|mapping|agent\.(share|archive|delete|restore)|role|settings)/;
  const govLog = audit.filter(e => GOV_ACTIONS.test(e.action)).slice(0, 7);
  const bName = (bg) => bg.scope === 'agent' ? (agents.find(ag => ag.id === bg.target)?.name || bg.target) : 'Equipo ' + bg.target;
  const policies = Object.values(approvals.reduce((m, ap) => {
    const k = ap.policy || 'Sin política';
    m[k] = m[k] || { name: k, pending: 0, total: 0, sigs: 1, high: 0 };
    m[k].total++; if (ap.status === 'pending') m[k].pending++; if (ap.risk === 'high') m[k].high++;
    m[k].sigs = Math.max(m[k].sigs, ap.approvalsNeeded || 1);
    return m;
  }, {})).sort((x, y) => y.pending - x.pending || y.total - x.total);

  const attention = [
    mine.length && { tone: 'amber', icon: 'Lock', title: `${mine.length} ${mine.length === 1 ? 'aprobación espera' : 'aprobaciones esperan'} tu firma`, sub: soon.length ? `${soon.length} vence${soon.length === 1 ? '' : 'n'} en menos de 1 h` : highRisk.length ? `${highRisk.length} de riesgo alto` : 'Revísalas antes de que venzan', cta: 'Revisar', view: 'approvals' },
    overBudget.length && { tone: overBudget.some(bg => bg.spent >= bg.limit) ? 'red' : 'amber', icon: 'Money', title: `${overBudget.length} ${overBudget.length === 1 ? 'presupuesto pasó' : 'presupuestos pasaron'} su umbral de alerta`, sub: overBudget.slice(0, 2).map(bg => bName(bg) + ' ' + Math.round(bg.spent / bg.limit * 100) + '%').join(' · '), cta: 'Ver presupuestos', view: 'budgets' },
    props && { tone: 'blue', icon: 'Org', title: `${props} ${props === 1 ? 'cambio de áreas pendiente' : 'cambios de áreas pendientes'}`, sub: 'Deciden qué gasto ve cada líder de área', cta: 'Revisar', view: 'settings' },
    unhealthy.length && { tone: 'red', icon: 'Warn', title: `${unhealthy.length} ${unhealthy.length === 1 ? 'agente no está' : 'agentes no están'} en línea`, sub: unhealthy.slice(0, 3).map(ag => ag.name).join(', '), cta: 'Ver agentes', view: 'marketplace' },
  ].filter(Boolean);

  const TONE = { amber: 'var(--amber)', red: 'var(--red)', blue: 'var(--blue)', green: 'var(--green)' };
  const ACT = { 'approval.approve': 'aprobó', 'approval.reject': 'rechazó', 'approval.request': 'pidió aprobación', 'budget.update': 'editó un presupuesto', 'budget.create': 'creó un presupuesto', 'budget.alert': 'alerta de presupuesto', 'budget.pause': 'pausa por presupuesto', 'budget.user': 'cambió un límite de usuario', 'budget.default': 'cambió el límite por defecto', 'mapping.propose': 'propuso un cambio de áreas', 'mapping.approve': 'aprobó un cambio de áreas', 'mapping.reject': 'rechazó un cambio de áreas', 'mapping.withdraw': 'retiró un cambio de áreas', 'agent.share': 'cambió el acceso a un agente', 'agent.archive': 'archivó un agente', 'agent.delete': 'eliminó un agente', 'agent.restore': 'restauró un agente', 'role.assign': 'asignó un rol', 'settings.update': 'cambió la configuración' };
  const ago = (iso) => window.fmtAgo ? window.fmtAgo(iso) : '';

  const Kpi = ({ label, value, sub, view }) => (
    <button className="card gv-kpi" onClick={() => go(view)}>
      <span className="gv-kpi-l">{label}</span>
      <span className="gv-kpi-v">{value}</span>
      <span className="gv-kpi-s">{sub}</span>
    </button>
  );

  return (
    <>
      <Topbar crumbs={['Gobernanza']} actions={<button className="btn btn-sm" onClick={() => go('audit')}><I.Lock size={12} /> Audit log</button>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Gobernanza</h1>
          <p className="page-subtitle">Qué necesita atención y cómo están funcionando los controles: aprobaciones, presupuestos y acceso.</p>
        </div>
        <div className="gv-body">
          <section>
            <div className="mk-sec-t">necesita atención</div>
            <div className="card gv-attn">
              {attention.length === 0 && (
                <div className="gv-ok"><span className="g-dot-lg green" style={{ width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--green-soft)', color: 'var(--green)' }}><I.Check size={14} /></span><div><div style={{ fontWeight: 600, fontSize: 13.5 }}>Todo en orden</div><div className="mk-meta">No hay aprobaciones, alertas ni cambios pendientes.</div></div></div>
              )}
              {attention.map((it, i) => { const Ic = I[it.icon]; return (
                <button key={i} className="gv-attn-row" onClick={() => go(it.view)}>
                  <span className="gv-ic" style={{ color: TONE[it.tone], background: `color-mix(in oklab, ${TONE[it.tone]} 12%, transparent)` }}><Ic size={14} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}><span className="gv-t">{it.title}</span><span className="gv-s">{it.sub}</span></span>
                  <span className="gv-cta">{it.cta} <I.ArrowRight size={11} /></span>
                </button>
              ); })}
            </div>
          </section>

          <section className="gv-kpis">
            <Kpi label="Aprobaciones pendientes" value={live.length} sub={highRisk.length ? highRisk.length + ' de riesgo alto' : 'Ninguna de riesgo alto'} view="approvals" />
            <Kpi label="Decisiones · 7 días" value={decided.length} sub={decided.length ? `${approved} ${approved === 1 ? 'aprobada' : 'aprobadas'} · ${decided.length - approved} ${decided.length - approved === 1 ? 'rechazada' : 'rechazadas'}` : 'Sin decisiones esta semana'} view="approvals" />
            <Kpi label="Gasto de equipos" value={teamLimit ? Math.round(teamSpent / teamLimit * 100) + '%' : '—'} sub={`${money(teamSpent)} de ${money(teamLimit)}`} view="budgets" />
            <Kpi label="Eventos auditados · 24 h" value={auditToday} sub="Registro encadenado y verificable" view="audit" />
          </section>

          <div className="gv-grid">
            <section>
              <div className="gv-sec-h"><div className="mk-sec-t" style={{ margin: 0 }}>políticas que piden aprobación</div></div>
              <div className="card" style={{ padding: 0 }}>
                {policies.map((p, i) => (
                  <div key={p.name} className="gv-pol" style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="gv-t" style={{ whiteSpace: 'normal' }}>{p.name}</div>
                      <div className="gv-s">{p.sigs > 1 ? p.sigs + ' firmas de personas distintas' : '1 firma'} · {p.total} {p.total === 1 ? 'solicitud' : 'solicitudes'}{p.high ? ' · ' + p.high + ' de riesgo alto' : ''}</div>
                    </div>
                    {p.pending > 0 ? <span className="badge badge-amber">{p.pending} pendiente{p.pending === 1 ? '' : 's'}</span> : <span className="badge">Al día</span>}
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="gv-sec-h">
                <div className="mk-sec-t" style={{ margin: 0 }}>actividad reciente</div>
                <button className="sr-link" onClick={() => go('audit')}>Ver todo</button>
              </div>
              <div className="card" style={{ padding: 0 }}>
                {govLog.length === 0 && <div className="mk-meta" style={{ padding: '14px 16px' }}>Sin actividad de gobernanza reciente.</div>}
                {govLog.map(e => (
                  <div key={e.id} className="tk-act gv-act">
                    <span className="tk-dot" style={{ marginTop: 6, background: /reject|alert|pause|delete/.test(e.action) ? 'var(--red)' : /approve|restore/.test(e.action) ? 'var(--green)' : /request|propose/.test(e.action) ? 'var(--amber)' : 'var(--text-dim)' }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ fontWeight: 500, color: 'var(--text)' }}>{e.actor}</b> {ACT[e.action] || e.action}
                      {e.detail && <span className="gv-s" style={{ whiteSpace: 'normal' }}>{e.detail}</span>}
                    </span>
                    <span className="tk-meta">{ago(e.at)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}

function Inbox({ tickets, agents, setView, openChat }) {
  const I = window.Icons;
  const S = window.MangoStore;
  const approvals = window.useMango(st => st.approvals);
  const toast = window.useToast?.();
  const tk = (id) => tickets.find(t => t.id === id);
  const base = React.useMemo(() => [
    ...approvals.filter(ap => ap.status === 'pending').slice(0, 3).map((ap, i) => ({ id: 'ap-' + ap.id, type: 'approval', approvalId: ap.id, agent: ap.agent, title: 'Te piden aprobar: ' + ap.action, body: ap.impact + '. Política: ' + ap.policy + '.', time: window.fmtAgo(ap.at) })),
    { id: 'm-410', type: 'mention', agent: 'dev-01', title: 'Usuario 9 te mencionó en MNG-410', body: '“@Usuario 1 ¿puedes confirmar si el rollback de prod-web se puede hacer hoy antes de las 18:00?”', time: 'hace 4 h', ticketId: 'MNG-410' },
    { id: 'b-res', type: 'budget', agent: 'fin-01', title: 'FinOps alcanzó 80% de su presupuesto', body: 'Lleva USD 2.400,00 de USD 3.000,00 este mes. Al 100% solo se enviará una alerta; no se pausará.', time: 'hace 5 h' },
    { id: 't-412', type: 'ticket', agent: 'fin-01', title: 'MNG-412 pasó a En progreso', body: (tk('MNG-412') || {}).title || 'Identificar top 5 drivers de costo de octubre', time: 'hace 6 h', ticketId: 'MNG-412', threadId: 't1' },
    { id: 't-404', type: 'ticket', agent: 'dev-01', title: 'MNG-404 se cerró', body: (tk('MNG-404') || {}).title || 'Ticket resuelto por el agente', time: 'hace 1 d', ticketId: 'MNG-404' },
    { id: 's-sap', type: 'system', agent: 'sap-01', title: 'Heartbeat restaurado en SAP Procure', body: 'El agente volvió a responder tras 12 minutos sin heartbeat. No se perdieron solicitudes.', time: 'hace 1 d' },
  ], [approvals]);
  const [state, setState] = React.useState(() => { try { return JSON.parse(localStorage.getItem('mango-inbox') || '{}'); } catch { return {}; } });
  const [tab, setTab] = React.useState('all');
  const [sel, setSel] = React.useState(null);
  const [replying, setReplying] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  React.useEffect(() => { setReplying(false); setDraft(''); }, [sel]);
  const save = (n) => { setState(n); localStorage.setItem('mango-inbox', JSON.stringify(n)); };
  const items = base.map(it => ({ ...it, read: !!state[it.id]?.read, archived: !!state[it.id]?.archived }));
  const unread = items.filter(i => !i.read && !i.archived).length;
  React.useEffect(() => { S.set({ inboxUnread: unread }); }, [unread]);
  const list = items.filter(i => tab === 'archived' ? i.archived : !i.archived && (tab === 'all' || (tab === 'unread' && !i.read) || (tab === 'mentions' && i.type === 'mention') || (tab === 'approvals' && i.type === 'approval')));
  const open = (it) => { setSel(it.id); if (!it.read) save({ ...state, [it.id]: { ...state[it.id], read: true } }); };
  const archive = (it) => { save({ ...state, [it.id]: { read: true, archived: !it.archived } }); toast?.({ tone: 'info', msg: it.archived ? 'Movido a la bandeja' : 'Archivado' }); if (sel === it.id) setSel(null); };
  const markAll = () => { const n = { ...state }; items.forEach(i => { n[i.id] = { ...n[i.id], read: true }; }); save(n); };
  const current = items.find(i => i.id === sel);
  const ICON = { approval: ['Lock', 'var(--amber)'], mention: ['Chat', 'var(--accent-ink)'], budget: ['Money', 'var(--amber)'], ticket: ['Tickets', 'var(--text-muted)'], system: ['Activity', 'var(--text-muted)'] };
  const TYPE = { approval: 'Aprobación', mention: 'Mención', budget: 'Presupuesto', ticket: 'Ticket', system: 'Sistema' };

  return (
    <>
      <Topbar crumbs={["Bandeja"]} actions={<button className="btn btn-sm" onClick={markAll} disabled={!unread}>Marcar todo como leído</button>} />
      <div className="inbox">
        <div className="inbox-list">
          <div style={{ padding: '4px 24px 0' }}>
            <h1 className="page-title">Bandeja</h1>
            <p className="page-subtitle" style={{ marginBottom: 12 }}>{unread ? unread + ' sin leer' : 'Todo al día'}</p>
          </div>
          <div className="tabs" role="tablist" style={{ padding: '0 24px' }}>
            {[['all', 'Todo'], ['unread', 'Sin leer'], ['approvals', 'Aprobaciones'], ['mentions', 'Menciones'], ['archived', 'Archivado']].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={'tab ' + (tab === k ? 'active' : '')} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          <div role="listbox" aria-label="Notificaciones">
            {list.length === 0 && <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5 }}>Nada por aquí.</div>}
            {list.map(it => {
              const [ic, col] = ICON[it.type]; const Ic = I[ic];
              const ag = agents.find(x => x.id === it.agent);
              return (
                <button key={it.id} role="option" aria-selected={sel === it.id} className={'inbox-row ' + (sel === it.id ? 'on' : '')} onClick={() => open(it)}>
                  <span className="inbox-dot" style={{ background: it.read ? 'transparent' : 'var(--accent)' }} aria-label={it.read ? undefined : 'No leído'} />
                  <span style={{ color: col, display: 'flex', paddingTop: 2 }}><Ic size={15} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: it.read ? 400 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                    <span style={{ display: 'block', fontSize: 13.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ag ? ag.name + ' · ' : ''}{it.body}</span>
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{it.time}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="inbox-detail">
          {!current ? (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5 }}>
              <I.Inbox size={22} style={{ marginBottom: 8 }} /><div>Selecciona una notificación para verla</div>
            </div>
          ) : (() => {
            const ag = agents.find(x => x.id === current.agent);
            const ap = current.approvalId && approvals.find(x => x.id === current.approvalId);
            return (
              <div style={{ maxWidth: 620, width: '100%' }}>
                <div className="row between" style={{ marginBottom: 14 }}>
                  <span className="badge">{TYPE[current.type]}</span>
                  <span className="row gap-1">
                    <button className="btn btn-sm btn-ghost" onClick={() => save({ ...state, [current.id]: { ...state[current.id], read: !current.read } })}>{current.read ? 'Marcar como no leído' : 'Marcar como leído'}</button>
                    <button className="btn btn-sm" onClick={() => archive(current)}><I.Archive size={12} /> {current.archived ? 'Desarchivar' : 'Archivar'}</button>
                  </span>
                </div>
                <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 6px' }}>{current.title}</h2>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>{ag ? ag.name : 'Sistema'} · {current.time}</div>
                {current.type !== 'mention' && <p style={{ fontSize: 14.5, lineHeight: 1.6, margin: '0 0 22px' }}>{current.body}</p>}
                {ap && <div className="card" style={{ padding: 16, marginBottom: 16 }}><window.ApprovalDecision ap={ap} /></div>}
                {current.type === 'mention' && (
                  <div style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 13.5, color: 'var(--text-muted)', marginBottom: 10 }}>Conversación en {current.ticketId}</div>
                    <window.CommentThread ticketId={current.ticketId} composer={replying} autoFocus placeholder="Responder a Usuario 9…" onSent={() => setReplying(false)} />
                  </div>
                )}
                <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
                  {current.type === 'approval' && <button className="btn btn-sm" onClick={() => setView('approvals')}>Ver en Aprobaciones <I.ArrowRight size={11} /></button>}
                  {current.ticketId && <button className="btn btn-sm" onClick={() => setView('tickets', current.ticketId)}>Abrir {current.ticketId} <I.ArrowRight size={11} /></button>}
                  {(current.threadId || ap?.threadId) && <button className="btn btn-sm" onClick={() => openChat(current.agent, current.threadId || ap.threadId)}>Ver conversación <I.ArrowRight size={11} /></button>}
                  {current.type === 'budget' && <button className="btn btn-sm" onClick={() => setView('budgets')}>Ajustar presupuesto <I.ArrowRight size={11} /></button>}
                  {current.type === 'mention' && !replying && <button className="btn btn-sm btn-primary" onClick={() => setReplying(true)}><I.Chat size={12} /> Responder</button>}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </>
  );
}

function Activity({ activity, agents }) {
  const I = window.Icons;
  const [filter, setFilter] = useState('all');

  // Enrich activity with agent refs
  const enriched = activity.map(e => {
    const agent = agents.find(a => a.name === e.who);
    return { ...e, agent };
  });

  const filtered = filter === 'all' ? enriched : enriched.filter(e => e.tone === filter);

  // Stats
  const todayCount = activity.slice(0, 5).length;
  const yesterdayCount = activity.slice(5).length;
  const trend = todayCount - yesterdayCount;
  const activeAgents = new Set(activity.map(e => e.who).filter(w => agents.find(a => a.name === w))).size;
  const criticalCount = activity.filter(e => e.tone === 'red').length;

  // Top active agents
  const byAgent = {};
  enriched.forEach(e => {
    if (!e.agent) return;
    byAgent[e.agent.id] = byAgent[e.agent.id] || { agent: e.agent, count: 0, latest: e.t };
    byAgent[e.agent.id].count++;
  });
  const topAgents = Object.values(byAgent).sort((a,b) => b.count - a.count).slice(0, 5);

  // By tone breakdown
  const tones = ['blue', 'green', 'amber', 'red', 'violet'];
  const toneLabels = { blue: 'Tool calls', green: 'Completados', amber: 'Warnings', red: 'Críticos', violet: 'Cambios config' };
  const toneIcons = { blue: 'Activity', green: 'Check', amber: 'Warn', red: 'Zap', violet: 'Settings' };
  const toneCounts = tones.map(t => ({ tone: t, count: activity.filter(e => e.tone === t).length }));

  const groups = [
    { label: "Hoy", items: filtered.filter((_, i) => enriched.indexOf(filtered[i]) < 5) },
    { label: "Ayer", items: filtered.filter((_, i) => enriched.indexOf(filtered[i]) >= 5) },
  ].map(g => ({ ...g, items: g.items }));
  // Simpler grouping: just split by index threshold
  const todayItems = filtered.filter(e => enriched.indexOf(e) < 5);
  const yesterdayItems = filtered.filter(e => enriched.indexOf(e) >= 5);

  return (
    <>
      <Topbar crumbs={["Actividad"]} actions={<>
        <button className="btn btn-sm"><I.Refresh size={12} /></button>
        <button className="btn btn-sm"><I.Filter size={12} /></button>
        <button className="btn btn-sm"><I.Download size={12} /> Export</button>
      </>} />
      <div className="content" style={{overflow:'auto'}}>
        <div className="page-head">
          <h1 className="page-title">Actividad</h1>
          <p className="page-subtitle">Todas las acciones ejecutadas por agentes y usuarios en las últimas 24 horas.</p>
        </div>

        {/* Stat row */}
        <div style={{padding:'20px 32px 18px', display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap: 10}}>
          <StatCard label="Eventos hoy" value={todayCount} trend={trend} sub="vs ayer" />
          <StatCard label="Agentes activos" value={activeAgents} accent="blue" sub={`de ${agents.length} totales`} />
          <StatCard label="Eventos críticos" value={criticalCount} accent="red" sub="últimas 24h" />
          <StatCard label="Tasa de éxito" value="94.2%" accent="green" sub="tool calls exitosas" />
        </div>

        {/* Filter row spans full width */}
        <div style={{padding:'0 28px 14px', display:'grid', gridTemplateColumns:'1fr 280px', gap: 20, alignItems:'center'}}>
          <div className="row gap-1" style={{flexWrap:'wrap'}}>
            <button className={`pill ${filter==='all'?'pill-active':''}`} onClick={() => setFilter('all')}>Todos <span className="pill-count">{activity.length}</span></button>
            {tones.filter(t => toneCounts.find(tc => tc.tone === t).count > 0).map(t => (
              <button key={t} className={`pill ${filter===t?'pill-active':''}`} onClick={() => setFilter(t)} style={filter===t?{background:`color-mix(in oklab, var(--${t}) 14%, transparent)`, color:`var(--${t})`, borderColor:`color-mix(in oklab, var(--${t}) 35%, transparent)`}:{}}>
                <span style={{width: 6, height: 6, borderRadius:'50%', background:`var(--${t})`}} />
                {toneLabels[t]}
                <span className="pill-count">{toneCounts.find(tc => tc.tone === t).count}</span>
              </button>
            ))}
          </div>
          <span style={{fontSize: 11.5, color:'var(--text-muted)', textAlign:'right'}}>Resumen · 24h</span>
        </div>

        {/* Main grid */}
        <div style={{padding:'0 28px 28px', display:'grid', gridTemplateColumns:'1fr 280px', gap: 20, alignItems:'flex-start'}}>
          <div>
            {/* Timeline */}
            <div className="card" style={{padding: 0, overflow:'hidden'}}>
              {todayItems.length > 0 && <TimelineGroup label="Hoy" items={todayItems} agents={agents} />}
              {yesterdayItems.length > 0 && <TimelineGroup label="Ayer" items={yesterdayItems} agents={agents} />}
              {filtered.length === 0 && (
                <div style={{padding:'60px 20px', textAlign:'center', color:'var(--text-muted)', fontSize: 13}}>
                  <I.Filter size={20} style={{color:'var(--text-dim)', marginBottom: 10}} />
                  <div>No hay eventos de este tipo</div>
                </div>
              )}
            </div>
          </div>

          {/* Right column */}
          <div style={{display:'flex', flexDirection:'column', gap: 14}}>
            <div className="card">
              <div style={{padding:'12px 14px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                <span style={{fontSize: 13.5, fontWeight: 600}}>Agentes más activos</span>
                <span className="mono" style={{fontSize: 11, color:'var(--text-dim)'}}>24h</span>
              </div>
              <div style={{padding: 4}}>
                {topAgents.map((ta, i) => {
                  const Ag = I[ta.agent.icon] || I.Bot;
                  return (
                    <div key={ta.agent.id} style={{display:'flex', alignItems:'center', gap: 10, padding:'8px 10px', borderRadius: 8}}>
                      <span className="mono" style={{fontSize: 11, color:'var(--text-dim)', width: 12}}>{i+1}</span>
                      <span style={{width: 24, height: 24, borderRadius: 8, background: ta.agent.iconBg, color: ta.agent.iconColor, display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0}}><Ag size={11} /></span>
                      <div style={{flex: 1, minWidth: 0}}>
                        <div style={{fontSize: 13, fontWeight: 500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{ta.agent.name}</div>
                        <div style={{fontSize: 11.5, color:'var(--text-dim)'}}>{ta.count} evento{ta.count===1?'':'s'}</div>
                      </div>
                      <div style={{width: 40, height: 4, background:'var(--border)', borderRadius: 2, overflow:'hidden'}}>
                        <div style={{width: `${(ta.count / topAgents[0].count) * 100}%`, height:'100%', background: ta.agent.iconColor}} />
                      </div>
                    </div>
                  );
                })}
                {topAgents.length === 0 && <div style={{padding: 20, textAlign:'center', color:'var(--text-dim)', fontSize: 13}}>Sin actividad</div>}
              </div>
            </div>

            <div className="card">
              <div style={{padding:'12px 14px', borderBottom:'1px solid var(--border)', fontSize: 13.5, fontWeight: 600}}>Por tipo de evento</div>
              <div style={{padding: 10}}>
                {toneCounts.filter(tc => tc.count > 0).map(tc => {
                  const Icon = I[toneIcons[tc.tone]] || I.Activity;
                  const pct = Math.round((tc.count / activity.length) * 100);
                  return (
                    <div key={tc.tone} style={{marginBottom: 10}}>
                      <div className="row between" style={{marginBottom: 4}}>
                        <div className="row gap-2">
                          <span style={{width: 20, height: 20, borderRadius: 5, background:`color-mix(in oklab, var(--${tc.tone}) 18%, transparent)`, color: `var(--${tc.tone})`, display:'flex', alignItems:'center', justifyContent:'center'}}><Icon size={10} /></span>
                          <span style={{fontSize: 12.5}}>{toneLabels[tc.tone]}</span>
                        </div>
                        <span className="mono" style={{fontSize: 12, color:'var(--text-muted)'}}>{tc.count}</span>
                      </div>
                      <div style={{height: 3, background:'var(--border)', borderRadius: 2, overflow:'hidden'}}>
                        <div style={{width: pct+'%', height:'100%', background: `var(--${tc.tone})`, borderRadius: 2}} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card" style={{padding:'12px 14px'}}>
              <div className="row between" style={{marginBottom: 8}}>
                <span style={{fontSize: 13.5, fontWeight: 600}}>Heatmap horario</span>
                <span className="mono" style={{fontSize: 11, color:'var(--text-dim)'}}>hoy</span>
              </div>
              <HeatmapStrip />
              <div className="row between" style={{fontSize: 11, color:'var(--text-dim)', marginTop: 4, fontFamily:'var(--font-mono)'}}>
                <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function StatCard({ label, value, trend, accent, sub }) {
  const I = window.Icons;
  const trendUp = trend > 0;
  const color = accent ? `var(--${accent})` : 'var(--text)';
  return (
    <div className="card" style={{padding:'12px 14px'}}>
      <div style={{fontSize: 11.5, color:'var(--text-muted)', fontWeight: 500, marginBottom: 6}}>{label}</div>
      <div className="row gap-2" style={{alignItems:'baseline'}}>
        <div style={{fontSize: 26, fontWeight: 500, letterSpacing:'-0.015em', color}}>{value}</div>
        {trend !== undefined && (
          <span style={{fontSize: 11.5, color: trendUp ? 'var(--green)' : trend < 0 ? 'var(--red)' : 'var(--text-dim)', fontFamily:'var(--font-mono)'}}>
            {trendUp ? '+' : ''}{trend}
          </span>
        )}
      </div>
      <div style={{fontSize: 11.5, color:'var(--text-dim)', marginTop: 2}}>{sub}</div>
    </div>
  );
}

function TimelineGroup({ label, items, agents }) {
  const I = window.Icons;
  return (
    <div style={{borderBottom: '1px solid var(--border)'}}>
      <div style={{fontSize: 11.5, color:'var(--text-muted)', padding:'10px 14px 8px', background:'var(--panel)', borderBottom:'1px solid var(--border)'}}>{label} · {items.length}</div>
      <div>
        {items.map((e, i) => {
          const agent = e.agent;
          const Ag = agent ? I[agent.icon] : I.Bot;
          const isCurrent = agent;
          return (
            <div key={i} style={{
              display:'grid', gridTemplateColumns:'48px 28px 1fr auto', gap: 12, alignItems:'center',
              padding:'12px 14px', borderBottom: i < items.length-1 ? '1px solid var(--border)' : 'none', transition:'background 0.1s'
            }} onMouseEnter={e => e.currentTarget.style.background='var(--row-hover)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}>
              <span className="mono" style={{fontSize: 12, color:'var(--text-dim)'}}>{e.t}</span>
              <span style={{width: 26, height: 26, borderRadius: 8, background: agent ? agent.iconBg : 'var(--row-hover)', color: agent ? agent.iconColor : 'var(--text-muted)', display:'flex', alignItems:'center', justifyContent:'center'}}>
                <Ag size={13} />
              </span>
              <div style={{fontSize: 13, lineHeight: 1.5}}>
                <span style={{fontWeight: 600, color:'var(--text-strong)'}}>{e.who}</span>
                <span style={{color:'var(--text-muted)'}}> {e.what} </span>
                {e.target && <span className="mono" style={{fontSize: 12.5, background:'var(--input-bg)', border:'1px solid var(--border)', padding:'1px 6px', borderRadius: 4, color:'var(--text)'}}>{e.target}</span>}
              </div>
              <span style={{display:'inline-flex', alignItems:'center', gap: 4, fontSize: 11.5, color:`var(--${e.tone})`, background:`color-mix(in oklab, var(--${e.tone}) 14%, transparent)`, padding:'3px 8px', borderRadius: 999, fontWeight: 500}}>
                <span style={{width: 5, height: 5, borderRadius:'50%', background:`var(--${e.tone})`}} />
                {e.tone === 'blue' ? 'info' : e.tone === 'green' ? 'done' : e.tone === 'amber' ? 'warn' : e.tone === 'red' ? 'crit' : 'cfg'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HeatmapStrip() {
  // 24 cells representing hours
  const data = [1,0,0,0,0,1,2,3,5,8,12,14,18,22,24,20,17,14,10,8,6,4,3,2];
  const max = Math.max(...data);
  return (
    <div style={{display:'grid', gridTemplateColumns:'repeat(24, 1fr)', gap: 2}}>
      {data.map((v, i) => {
        const intensity = v / max;
        return (
          <div key={i} title={`${String(i).padStart(2,'0')}:00 · ${v} eventos`} style={{
            aspectRatio: '1 / 1.6',
            background: intensity > 0 ? `color-mix(in oklab, var(--accent) ${Math.round(intensity * 85)}%, transparent)` : 'var(--border)',
            borderRadius: 2
          }} />
        );
      })}
    </div>
  );
}

function Placeholder({ crumbs, title, desc, v2 }) {
  const I = window.Icons;
  return (
    <>
      <Topbar crumbs={crumbs} actions={v2 && <span className="badge badge-accent">v2 preview</span>} />
      <div className="content" style={{padding: 60, display:'flex', flexDirection:'column', alignItems:'center', textAlign:'center'}}>
        <div style={{width: 56, height: 56, borderRadius: 12, background:'var(--row-hover)', display:'flex', alignItems:'center', justifyContent:'center', marginBottom: 20, color:'var(--text-muted)'}}>
          <I.Skill size={26} />
        </div>
        <h2 style={{fontSize: 20, fontWeight: 600, margin:'0 0 6px'}}>{title}</h2>
        <p className="muted" style={{fontSize: 13, maxWidth: 420, margin: 0}}>{desc}</p>
      </div>
    </>
  );
}

Object.assign(window, { OrgChart, Governance, Inbox, Activity, Placeholder });
