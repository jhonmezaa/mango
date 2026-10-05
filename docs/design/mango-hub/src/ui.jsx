// Shared UI: Toasts, Cmd+K palette, Skeletons, EmptyState
const { createContext, useContext } = React;

// ============ TOAST SYSTEM ============
const ToastCtx = createContext(null);
window.useToast = () => useContext(ToastCtx);

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = (t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(ts => [...ts, { id, ...t }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), t.duration || 4200);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack">
        {toasts.map(t => <Toast key={t.id} t={t} onClose={() => setToasts(ts => ts.filter(x => x.id !== t.id))} />)}
      </div>
    </ToastCtx.Provider>
  );
}

function Toast({ t, onClose }) {
  const I = window.Icons;
  const icon = t.tone === 'success' ? <I.Check size={13} /> : t.tone === 'error' ? <I.X2 size={13} /> : t.tone === 'warn' ? <I.Warn size={13} /> : <I.Info size={13} />;
  const color = t.tone === 'success' ? 'var(--green)' : t.tone === 'error' ? 'var(--red)' : t.tone === 'warn' ? 'var(--amber)' : 'var(--blue)';
  return (
    <div className="toast" style={{padding:'10px 12px', background:'var(--panel)', border:'1px solid var(--border-strong)', borderLeft:`3px solid ${color}`, borderRadius: 8, boxShadow:'0 8px 24px rgba(0,0,0,0.35)', display:'flex', gap: 10, alignItems:'flex-start', fontSize: 12.5, animation:'toastIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)'}}>
      <span style={{color, marginTop: 1}}>{icon}</span>
      <div style={{flex:1, minWidth: 0}}>
        {t.title && <div style={{fontWeight: 600, marginBottom: 2}}>{t.title}</div>}
        <div style={{color: t.title ? 'var(--text-muted)' : 'var(--text)', lineHeight: 1.5}}>{t.msg}</div>
        {t.action && <button className="btn btn-sm" style={{marginTop: 8}} onClick={() => { t.action.fn(); onClose(); }}>{t.action.label}</button>}
      </div>
      <button className="btn btn-ghost btn-icon" onClick={onClose} style={{padding: 2}}><I.Close size={11} /></button>
    </div>
  );
}

// ============ EMPTY STATE ============
function EmptyState({ icon, title, hint, action }) {
  const I = window.Icons;
  const Icon = I[icon] || I.Bot;
  return (
    <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding: 40}}>
      <div style={{textAlign:'center', maxWidth: 360}}>
        <div style={{width: 52, height: 52, margin:'0 auto 14px', borderRadius: 12, background:'var(--accent-soft)', color:'var(--accent-ink)', display:'flex', alignItems:'center', justifyContent:'center'}}>
          <Icon size={24} />
        </div>
        <div style={{fontSize: 18, marginBottom: 6, color:'var(--text-strong)'}}>{title}</div>
        {hint && <div style={{fontSize: 12.5, color:'var(--text-muted)', lineHeight: 1.55, marginBottom: 14}}>{hint}</div>}
        {action && <button className="btn btn-primary btn-sm" onClick={action.fn}>{action.label}</button>}
      </div>
    </div>
  );
}

// ============ SKELETON ============
function Skeleton({ w = '100%', h = 12, r = 4, style }) {
  return <div className="skeleton" style={{width: w, height: h, borderRadius: r, ...style}} />;
}

// ============ CMD+K PALETTE ============
function CmdK({ open, onClose, agents, tickets, threads, setView, openChat }) {
  const I = window.Icons;
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  const trapRef = window.useFocusTrap ? window.useFocusTrap(open, null) : null;

  useEffect(() => { if (open) { setQ(""); setIdx(0); setTimeout(() => inputRef.current?.focus(), 50); } }, [open]);

  const items = useMemo(() => {
    const Q = q.toLowerCase();
    const nav = [
      { kind: "nav", label: "Dashboard", icon: "Dashboard", do: () => setView('dashboard') },
      { kind: "nav", label: "Marketplace de agentes", icon: "Store", do: () => setView('marketplace') },
      { kind: "nav", label: "Tickets", icon: "Tickets", do: () => setView('tickets') },
      { kind: "nav", label: "Governance", icon: "Shield", do: () => setView('governance') },
      { kind: "nav", label: "Observability · Traces", icon: "Activity", do: () => setView('observability') },
      { kind: "nav", label: "Skills & MCP", icon: "Skill", do: () => setView('skills') },
      { kind: "nav", label: "Dashboard de costos", icon: "Money", do: () => setView('costs') },
      { kind: "nav", label: "Actividad", icon: "Activity", do: () => setView('activity') },
      ...(window.MangoStore.can('agent.create') ? [{ kind: "action", label: "Crear nuevo agente", icon: "Plus", shortcut: "N", do: () => setView('admin') }] : []),
      { kind: "action", label: "Nueva conversación", icon: "Chat", shortcut: "C", do: () => window.dispatchEvent(new CustomEvent('mango:pick-agent')) },
      { kind: "action", label: "Cambiar tema", icon: "Sun", do: () => window.dispatchEvent(new CustomEvent('mango:toggle-theme')) },
    ];
    const ags = agents.map(a => ({ kind: "agent", label: a.name, sub: a.cat + " · " + a.desc.slice(0, 60), icon: a.icon, iconBg: a.iconBg, iconColor: a.iconColor, do: () => openChat(a.id) }));
    const thr = (threads || []).map(t => {
      const a = agents.find(x => x.id === t.agentId);
      return { kind: "thread", label: t.title, sub: (a ? a.name : t.agentId) + " · " + t.last, icon: "Chat", do: () => openChat(t.agentId, t.id) };
    });
    const tks = tickets.slice(0, 20).map(t => ({ kind: "ticket", label: t.id + " — " + t.title, sub: t.status, icon: "Tickets", do: () => setView('tickets') }));
    nav.push(
      { kind: "nav", label: "Aprobaciones pendientes", icon: "Check2", do: () => setView('approvals') },
      { kind: "nav", label: "Audit log", icon: "Lock", do: () => setView('audit') },
      { kind: "nav", label: "Presupuestos y alertas", icon: "Money", do: () => setView('budgets') },
      { kind: "nav", label: "Playground", icon: "Play", do: () => setView('playground') },
      { kind: "nav", label: "Buscar en conversaciones", icon: "Search", do: () => setView('search') },
    );
    const S = window.MangoStore;
    const allowed = nav.filter(n => { const m = n.do.toString().match(/setView\((['"])(\w+)\1\)/); return !m || !S || S.canView(m[2]); });
    const all = [...allowed, ...ags, ...thr, ...tks];
    if (!Q) return all.slice(0, 18);
    const base = all.filter(x => x.label.toLowerCase().includes(Q) || (x.sub || '').toLowerCase().includes(Q)).slice(0, 14);
    const msgs = Q.length >= 3 && window.searchMessages ? window.searchMessages(Q, threads, agents).slice(0, 5).map(r => ({ kind: "message", label: r.pre.slice(-30) + r.hit + r.post.slice(0, 50), sub: r.thread.title + " · " + (r.agent ? r.agent.name : ''), icon: "Chat", do: () => openChat(r.thread.agentId, r.thread.id) })) : [];
    return [...base, ...msgs];
  }, [q, agents, tickets, threads]);

  useEffect(() => { setIdx(0); }, [q]);

  const exec = (item) => { item.do(); onClose(); };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) exec(items[idx]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  if (!open) return null;

  const groups = {};
  items.forEach((it, i) => { (groups[it.kind] ||= []).push({ ...it, i }); });
  const labels = { nav: "Ir a", action: "Acciones", agent: "Agentes", thread: "Conversaciones", ticket: "Tickets", message: "En mensajes" };

  return (
    <div onClick={onClose} style={{position:'fixed', inset: 0, background:'rgba(0,0,0,0.5)', backdropFilter:'blur(6px)', zIndex: 1500, display:'flex', alignItems:'flex-start', justifyContent:'center', paddingTop: '12vh', animation:'fadeIn 0.15s'}}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Paleta de comandos" onClick={e => e.stopPropagation()} style={{width: 620, maxWidth:'92vw', background:'var(--panel)', border:'1px solid var(--border-strong)', borderRadius: 12, boxShadow:'0 24px 60px rgba(0,0,0,0.5)', overflow:'hidden', display:'flex', flexDirection:'column', maxHeight:'70vh'}}>
        <div style={{padding:'14px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap: 10}}>
          <I.Search size={15} style={{color:'var(--text-dim)'}} />
          <input ref={inputRef} aria-label="Buscar" role="combobox" aria-expanded="true" aria-controls="cmdk-list" value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Buscar agentes, tickets, acciones..."
            style={{flex:1, background:'transparent', border:'none', outline:'none', fontSize: 15, color:'var(--text)', fontFamily:'var(--font-sans)'}} />
          <span className="mono" style={{fontSize: 10.5, color:'var(--text-dim)', border:'1px solid var(--border)', padding:'2px 6px', borderRadius: 4}}>ESC</span>
        </div>
        <div style={{flex:1, overflowY:'auto', padding: 6}}>
          {items.length === 0 && (
            <div style={{padding: 32, textAlign:'center', color:'var(--text-muted)', fontSize: 13}}>Sin resultados para "{q}"</div>
          )}
          {Object.entries(groups).map(([k, list]) => (
            <div key={k} style={{marginBottom: 4}}>
              <div style={{padding:'8px 12px 4px', fontSize: 10.5, color:'var(--text-muted)', fontWeight: 500}}>{labels[k]}</div>
              {list.map(it => {
                const Icon = I[it.icon] || I.Bot;
                const active = it.i === idx;
                return (
                  <button key={it.i} onClick={() => exec(it)} onMouseEnter={() => setIdx(it.i)}
                    style={{
                      width:'100%', display:'flex', alignItems:'center', gap: 10, padding:'8px 12px', textAlign:'left',
                      background: active ? 'var(--row-hover)' : 'transparent', borderRadius: 6}}>
                    <span style={{width: 26, height: 26, borderRadius: 6, background: it.iconBg || 'var(--input-bg)', color: it.iconColor || 'var(--text-muted)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0}}>
                      <Icon size={13} />
                    </span>
                    <div style={{flex: 1, minWidth: 0}}>
                      <div style={{fontSize: 13, fontWeight: 500, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.label}</div>
                      {it.sub && <div style={{fontSize: 11, color:'var(--text-dim)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.sub}</div>}
                    </div>
                    {it.shortcut && <span className="mono" style={{fontSize: 10, color:'var(--text-dim)', border:'1px solid var(--border)', padding:'1px 5px', borderRadius: 3}}>{it.shortcut}</span>}
                    {active && <I.ArrowRight size={11} style={{color:'var(--accent-ink)'}} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div style={{padding:'8px 14px', borderTop:'1px solid var(--border)', display:'flex', gap: 16, fontSize: 10.5, color:'var(--text-dim)'}}>
          <span className="row gap-1"><span className="mono" style={{border:'1px solid var(--border)', padding:'0 4px', borderRadius: 3}}>↑↓</span> navegar</span>
          <span className="row gap-1"><span className="mono" style={{border:'1px solid var(--border)', padding:'0 4px', borderRadius: 3}}>↵</span> abrir</span>
          <span className="row gap-1" style={{marginLeft:'auto'}}><span className="mono" style={{border:'1px solid var(--border)', padding:'0 4px', borderRadius: 3}}>⌘K</span> Mango</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ToastProvider, EmptyState, Skeleton, CmdK, AgentPicker, Stepper });

function Stepper({ value, onChange, min = 0, max = Infinity, step = 1, prefix, suffix, precision = 0, width }) {
  const dec = () => onChange(Math.max(min, +(value - step).toFixed(precision)));
  const inc = () => onChange(Math.min(max, +(value + step).toFixed(precision)));
  const onInput = (e) => {
    const v = e.target.value;
    if (v === '' || v === '-') return onChange(v);
    const n = +v;
    if (!isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
  };
  return (
    <div className="stepper" style={width ? {maxWidth: width} : undefined}>
      {prefix && <span className="stepper-prefix">{prefix}</span>}
      <button type="button" className="stepper-btn" onClick={dec} aria-label="decrease">−</button>
      <input type="text" inputMode="decimal" value={value} onChange={onInput} />
      <button type="button" className="stepper-btn" onClick={inc} aria-label="increase">+</button>
      {suffix && <span className="stepper-suffix">{suffix}</span>}
    </div>
  );
}

// ============ AGENT PICKER MODAL ============
function AgentPicker({ open, onClose, agents, threads, openChat }) {
  const I = window.Icons;
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const inputRef = useRef(null);

  useEffect(() => { if (open) { setQ(""); setCat("all"); setTimeout(() => inputRef.current?.focus(), 60); } }, [open]);

  const cats = useMemo(() => {
    const c = {};
    agents.forEach(a => { c[a.cat] = (c[a.cat] || 0) + 1; });
    return Object.entries(c);
  }, [agents]);

  const recent = useMemo(() => {
    const seen = new Set();
    const ids = [];
    (threads || []).forEach(t => { if (!seen.has(t.agentId)) { seen.add(t.agentId); ids.push(t.agentId); } });
    return ids.slice(0, 4).map(id => agents.find(a => a.id === id)).filter(Boolean);
  }, [threads, agents]);

  const filtered = useMemo(() => {
    const Q = q.trim().toLowerCase();
    return agents.filter(a => (cat === 'all' || a.cat === cat) && (!Q || a.name.toLowerCase().includes(Q) || a.desc.toLowerCase().includes(Q) || a.caps.some(c => c.toLowerCase().includes(Q))));
  }, [q, cat, agents]);

  const pick = (a) => { openChat(a.id); onClose(); };

  if (!open) return null;

  return (
    <div onClick={onClose} style={{position:'fixed', inset: 0, background:'rgba(0,0,0,0.55)', backdropFilter:'blur(6px)', zIndex: 1500, display:'flex', alignItems:'flex-start', justifyContent:'center', paddingTop:'8vh', animation:'fadeIn 0.15s'}}>
      <div onClick={e => e.stopPropagation()} style={{width: 760, maxWidth:'94vw', maxHeight:'84vh', background:'var(--panel)', border:'1px solid var(--border-strong)', borderRadius: 14, boxShadow:'0 24px 60px rgba(0,0,0,0.5)', overflow:'hidden', display:'flex', flexDirection:'column'}}>
        <div style={{padding:'16px 20px 14px', borderBottom:'1px solid var(--border)'}}>
          <div className="row between" style={{marginBottom: 10}}>
            <div>
              <div style={{fontSize: 20, fontWeight: 500, letterSpacing:'-0.01em'}}>Nueva conversación</div>
              <div style={{fontSize: 12, color:'var(--text-muted)', marginTop: 2}}>Elige el agente con el que quieres conversar</div>
            </div>
            <button className="btn btn-ghost btn-icon" onClick={onClose}><I.Close size={12} /></button>
          </div>
          <div style={{position:'relative'}}>
            <I.Search size={13} style={{position:'absolute', left: 10, top: '50%', transform:'translateY(-50%)', color:'var(--text-dim)'}} />
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nombre, capability o categoría..." className="input"
              style={{width:'100%', padding:'9px 10px 9px 30px', fontSize: 13}} />
          </div>
          <div className="row gap-1" style={{marginTop: 10, flexWrap:'wrap'}}>
            <button className={`pill ${cat === 'all' ? 'pill-active' : ''}`} onClick={() => setCat('all')}>Todos <span className="pill-count">{agents.length}</span></button>
            {cats.map(([c, n]) => (
              <button key={c} className={`pill ${cat === c ? 'pill-active' : ''}`} onClick={() => setCat(c)}>{c} <span className="pill-count">{n}</span></button>
            ))}
          </div>
        </div>
        <div style={{flex: 1, overflowY:'auto', padding:'12px 16px 18px'}}>
          {cat === 'all' && !q && recent.length > 0 && (
            <div style={{marginBottom: 14}}>
              <div style={{fontSize: 10.5, color:'var(--text-muted)', fontWeight: 500, padding:'4px 4px 8px'}}>Recientes</div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(210px, 1fr))', gap: 8}}>
                {recent.map(a => <AgentPickerCard key={a.id} agent={a} onClick={() => pick(a)} mini />)}
              </div>
            </div>
          )}
          <div style={{fontSize: 10.5, color:'var(--text-muted)', fontWeight: 500, padding:'4px 4px 8px'}}>
            {q ? `Resultados (${filtered.length})` : cat === 'all' ? 'Todos los agentes' : cat}
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))', gap: 10}}>
            {filtered.map(a => <AgentPickerCard key={a.id} agent={a} onClick={() => pick(a)} />)}
          </div>
          {filtered.length === 0 && (
            <div style={{padding:'40px 20px', textAlign:'center', color:'var(--text-muted)', fontSize: 13}}>
              Sin agentes que coincidan con "{q}"
            </div>
          )}
        </div>
        <div style={{padding:'10px 20px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', fontSize: 11.5, color:'var(--text-dim)'}}>
          <span>¿No encuentras el agente correcto?</span>
          {window.MangoStore.can('agent.create') ? <button className="btn btn-sm" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('mango:new-agent')); }}><I.Plus size={11} /> Crear nuevo agente</button> : <button className="btn btn-sm" onClick={() => { onClose(); window.MangoNav?.('marketplace'); }}>Ver Marketplace</button>}
        </div>
      </div>
    </div>
  );
}

function AgentPickerCard({ agent, onClick, mini }) {
  const I = window.Icons;
  const Ag = I[agent.icon] || I.Bot;
  const pct = Math.round((agent.budget / agent.budgetMax) * 100);
  const statusColor = agent.status === 'online' ? 'var(--green)' : agent.status === 'warmup' ? 'var(--amber)' : agent.status === 'degraded' ? 'var(--amber)' : 'var(--text-dim)';
  return (
    <button onClick={onClick} className="picker-card">
      <div style={{display:'flex', gap: 10, alignItems:'flex-start'}}>
        <span style={{width: 36, height: 36, borderRadius: 9, background: agent.iconBg, color: agent.iconColor, display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0}}>
          <Ag size={17} />
        </span>
        <div style={{flex: 1, minWidth: 0, textAlign:'left'}}>
          <div className="row between" style={{marginBottom: 2}}>
            <span style={{fontSize: 13, fontWeight: 600, color:'var(--text-strong)'}}>{agent.name}</span>
            {!window.MangoStore.get().avail && <span style={{width: 6, height: 6, borderRadius:'50%', background: statusColor, flexShrink: 0}} />}
          </div>
          <div style={{fontSize: 10.5, color:'var(--text-muted)', fontWeight: 500, marginBottom: mini ? 0 : 6}}>{agent.cat} · {agent.model}</div>
          {!mini && <div style={{fontSize: 12, color:'var(--text-muted)', lineHeight: 1.45, display:'-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient:'vertical', overflow:'hidden'}}>{agent.desc}</div>}
        </div>
      </div>
    </button>
  );
}

