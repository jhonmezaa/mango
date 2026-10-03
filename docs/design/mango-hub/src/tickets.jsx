// Tickets — tablero + lista + detalle lateral
const TK_STATUS = [
  { k: 'open', l: 'Abierto', dot: 'var(--text-dim)' },
  { k: 'in_progress', l: 'En curso', dot: 'var(--blue)' },
  { k: 'needs_approval', l: 'Por aprobar', dot: 'var(--amber)' },
  { k: 'done', l: 'Resuelto', dot: 'var(--green)' },
];
const TK_PRIO = [
  { k: 'high', l: 'Alta', dot: 'var(--red)', w: 3 },
  { k: 'medium', l: 'Media', dot: 'var(--amber)', w: 2 },
  { k: 'low', l: 'Baja', dot: 'var(--text-dim)', w: 1 },
];
const TK_PEOPLE = [
  { k: 'U1', name: 'Usuario 1' },
  { k: 'U2', name: 'Usuario 2' },
  { k: 'U3', name: 'Usuario 3' },
  { k: 'U4', name: 'Usuario 4' },
];
const tkStatus = (k) => TK_STATUS.find(s => s.k === k) || TK_STATUS[0];
const tkPrio = (k) => TK_PRIO.find(p => p.k === k) || TK_PRIO[1];
const tkPerson = (k) => TK_PEOPLE.find(p => p.k === k);
const tkMe = () => { const n = window.MangoStore?.actor?.() || ''; return (TK_PEOPLE.find(p => p.name === n) || TK_PEOPLE[0]).k; };
const tkAgeMin = (a) => { if (!a || a === 'ahora') return 0; const n = parseFloat(a); return /d/.test(a) ? n * 1440 : /h/.test(a) ? n * 60 : n; };
const tkAgeLabel = (a) => !a || a === 'ahora' ? 'ahora' : 'hace ' + a.replace('d', ' d').replace('h', ' h');

function Tickets({ tickets: initialTickets, agents, initialOpenId, onOpenChange }) {
  const I = window.Icons; const S = window.MangoStore;
  const toast = window.useToast?.();
  const me = tkMe();
  const [tickets, setTickets] = useState(() => initialTickets.map(t => ({ ...t, assignee: t.assignee || null, history: [] })));
  const [view, setView] = useState(() => localStorage.getItem('mango-tk-view') || 'kanban');
  useEffect(() => { localStorage.setItem('mango-tk-view', view); }, [view]);
  const [openId, setOpenIdRaw] = useState(initialOpenId || null);
  const setOpenId = (id) => { setOpenIdRaw(id); onOpenChange && onOpenChange(id); };
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState('all');
  const [filters, setFilters] = useState({ status: new Set(), prio: new Set(), agent: 'all', assignee: 'all' });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState({ key: 'age', dir: 1 });
  const [creating, setCreating] = useState(null);

  const QUICK = [
    ['all', 'Todos', () => true],
    ['mine', 'Asignados a mí', t => t.assignee === me],
    ['unassigned', 'Sin asignar', t => !t.assignee],
    ['high', 'Prioridad alta', t => t.prio === 'high' && t.status !== 'done'],
  ];
  const Q = q.trim().toLowerCase();
  const base = tickets.filter(t => {
    if (Q && !(t.title + ' ' + t.id).toLowerCase().includes(Q)) return false;
    if (filters.status.size && !filters.status.has(t.status)) return false;
    if (filters.prio.size && !filters.prio.has(t.prio)) return false;
    if (filters.agent !== 'all' && t.agent !== filters.agent) return false;
    if (filters.assignee !== 'all' && (t.assignee || 'none') !== filters.assignee) return false;
    return true;
  });
  const quickFn = QUICK.find(x => x[0] === quick)[2];
  const filtered = base.filter(quickFn);
  const filterCount = filters.status.size + filters.prio.size + (filters.agent !== 'all') + (filters.assignee !== 'all');
  const anyFilter = Q || filterCount || quick !== 'all';
  const clearAll = () => { setQ(''); setQuick('all'); setFilters({ status: new Set(), prio: new Set(), agent: 'all', assignee: 'all' }); };

  const update = (id, patch, what) => {
    const who = S?.actor?.() || 'Tú';
    setTickets(ts => ts.map(t => t.id === id ? { ...t, ...patch, history: [...(t.history || []), { t: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }), actor: who, action: what }] } : t));
    S?.log('ticket.update', id, what);
  };
  const move = (id, status) => {
    const t = tickets.find(x => x.id === id);
    if (!t || t.status === status) return;
    update(id, { status }, `cambió el estado a ${tkStatus(status).l.toLowerCase()}`);
    toast?.({ tone: 'success', msg: `${id} → ${tkStatus(status).l}` });
  };
  const create = (data) => {
    const id = 'MNG-' + (413 + tickets.filter(t => /^MNG-4[1-9]\d$|^MNG-[5-9]/.test(t.id) && parseInt(t.id.slice(4)) > 412).length);
    const nt = { id, title: data.title, desc: data.desc, status: data.status || 'open', prio: data.prio, agent: data.agent, assignee: data.assignee || null, age: 'ahora', history: [{ t: 'ahora', actor: S?.actor?.() || 'Tú', action: 'creó el ticket' }] };
    setTickets(ts => [nt, ...ts]);
    setCreating(null);
    S?.log('ticket.create', id, data.title);
    toast?.({ tone: 'success', msg: `Ticket ${id} creado` });
  };
  const open = openId ? tickets.find(t => t.id === openId) : null;

  return (
    <>
      <Topbar crumbs={['Tickets']}
        actions={<>
          <div className="mk-seg" role="group" aria-label="Vista">
            <button className={view === 'kanban' ? 'is-on' : ''} aria-pressed={view === 'kanban'} onClick={() => setView('kanban')} title="Tablero"><I.Kanban size={13} /></button>
            <button className={view === 'list' ? 'is-on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')} title="Lista"><I.List size={13} /></button>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => setCreating({})}><I.Plus size={12} /> Nuevo ticket</button>
        </>} />
      <div className="content tk-content">
        <div className="tk-bar">
          <div className="search-wrap tk-search"><I.Search size={13} /><input className="input" placeholder="Buscar por título o ID" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar tickets" /></div>
          <div className="tk-quick" role="group" aria-label="Vistas rápidas">
            {QUICK.map(([k, l, fn]) => (
              <button key={k} className={quick === k ? 'is-on' : ''} aria-pressed={quick === k} onClick={() => setQuick(k)}>{l}<span className="mk-count">{base.filter(fn).length}</span></button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <button className={'btn btn-sm' + (filterCount ? ' mk-active' : '')} onClick={() => setFiltersOpen(v => !v)} aria-expanded={filtersOpen}><I.Filter size={12} /> Filtros{filterCount > 0 && <span className="mk-count">{filterCount}</span>}</button>
            {filtersOpen && <FiltersPopover filters={filters} setFilters={setFilters} agents={agents} onClose={() => setFiltersOpen(false)} />}
          </div>
          <div style={{ flex: 1 }} />
          <span className="tk-meta">{filtered.length} {filtered.length === 1 ? 'ticket' : 'tickets'}</span>
          {anyFilter && <button className="btn btn-sm btn-ghost" onClick={clearAll}>Limpiar</button>}
        </div>

        {view === 'kanban'
          ? <Kanban tickets={filtered} agents={agents} onOpen={setOpenId} onMove={move} onCreate={(status) => setCreating({ status })} me={me} />
          : <TicketList tickets={filtered} agents={agents} onOpen={setOpenId} sort={sort} setSort={setSort} me={me} anyFilter={anyFilter} onClear={clearAll} />}
      </div>

      {open && <TicketSlideOver ticket={open} agents={agents} me={me} onClose={() => setOpenId(null)} onUpdate={update} onMove={move} />}
      {creating && <NewTicketModal agents={agents} initialStatus={creating.status} onClose={() => setCreating(null)} onCreate={create} />}
    </>
  );
}

function TkAvatar({ k, size = 20 }) {
  const p = tkPerson(k);
  if (!k) return <span className="tk-av empty" style={{ width: size, height: size }} title="Sin asignar" aria-label="Sin asignar" />;
  return <span className="tk-av" style={{ width: size, height: size, fontSize: size < 22 ? 9.5 : 11 }} title={p?.name || k}>{k}</span>;
}
function TkPrio({ prio, label = true }) {
  const p = tkPrio(prio);
  return <span className="tk-prio" title={'Prioridad ' + p.l.toLowerCase()}><span className="tk-bars" data-w={p.w}><i /><i /><i /></span>{label && p.l}</span>;
}
function TkAgent({ agent, small }) {
  if (!agent) return null;
  const Ag = window.Icons[agent.icon] || window.Icons.Bot;
  return <span className="row gap-2" style={{ minWidth: 0 }}><span className="tk-agent-ic" style={{ background: agent.iconBg, color: agent.iconColor }}><Ag size={10} /></span><span className="tk-agent-n" style={small ? { fontSize: 12 } : null}>{agent.name}</span></span>;
}

function Kanban({ tickets, agents, onOpen, onMove, onCreate, me }) {
  const I = window.Icons;
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  return (
    <div className="tk-board">
      {TK_STATUS.map(c => {
        const items = tickets.filter(t => t.status === c.k).sort((a, b) => tkPrio(b.prio).w - tkPrio(a.prio).w || tkAgeMin(a.age) - tkAgeMin(b.age));
        return (
          <div key={c.k} className={'tk-col' + (over === c.k ? ' is-over' : '')}
            onDragOver={e => { e.preventDefault(); setOver(c.k); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }}
            onDrop={() => { if (dragging) onMove(dragging, c.k); setDragging(null); setOver(null); }}>
            <div className="tk-col-h">
              <span className="tk-dot" style={{ background: c.dot }} />
              <span className="tk-col-t">{c.l}</span>
              <span className="tk-col-n">{items.length}</span>
              <button className="btn btn-ghost btn-icon" style={{ marginLeft: 'auto' }} aria-label={'Nuevo ticket en ' + c.l} title="Nuevo ticket aquí" onClick={() => onCreate(c.k)}><I.Plus size={12} /></button>
            </div>
            <div className="tk-col-b">
              {items.map(t => {
                const a = agents.find(x => x.id === t.agent);
                return (
                  <div key={t.id} className={'card tk-card' + (dragging === t.id ? ' is-drag' : '')} draggable role="button" tabIndex={0}
                    aria-label={`${t.id}: ${t.title}`}
                    onDragStart={() => setDragging(t.id)} onDragEnd={() => { setDragging(null); setOver(null); }}
                    onClick={() => onOpen(t.id)} onKeyDown={e => { if (e.key === 'Enter') onOpen(t.id); }}>
                    <div className="row between" style={{ marginBottom: 6 }}>
                      <span className="tk-id">{t.id}</span>
                      <TkPrio prio={t.prio} label={false} />
                    </div>
                    <div className="tk-title">{t.title}</div>
                    {t.status === 'needs_approval' && <div className="tk-flag"><I.Warn size={11} /> Espera aprobación</div>}
                    <div className="row between" style={{ marginTop: 10, gap: 8 }}>
                      <TkAgent agent={a} small />
                      <div className="row gap-2" style={{ flexShrink: 0 }}>
                        <span className="tk-meta">{t.age}</span>
                        <TkAvatar k={t.assignee} size={20} />
                      </div>
                    </div>
                  </div>
                );
              })}
              {items.length === 0 && <div className="tk-empty-col">{dragging ? 'Suelta aquí' : 'Sin tickets'}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TicketList({ tickets, agents, onOpen, sort, setSort, anyFilter, onClear }) {
  const I = window.Icons;
  const val = {
    id: t => parseInt(t.id.slice(4)), title: t => t.title.toLowerCase(), agent: t => agents.find(a => a.id === t.agent)?.name || '',
    status: t => TK_STATUS.findIndex(s => s.k === t.status), prio: t => -tkPrio(t.prio).w, age: t => tkAgeMin(t.age), assignee: t => t.assignee || 'zz',
  };
  const list = [...tickets].sort((a, b) => { const x = val[sort.key](a), y = val[sort.key](b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
  const H = ({ k, children, right }) => (
    <button className={'tk-th' + (sort.key === k ? ' is-on' : '')} style={right ? { justifyContent: 'flex-end' } : null}
      onClick={() => setSort(s => ({ key: k, dir: s.key === k ? -s.dir : 1 }))} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      {children}{sort.key === k && <I.ChevronDown size={10} style={{ transform: sort.dir === 1 ? 'none' : 'rotate(180deg)' }} />}
    </button>
  );
  if (!list.length) return <TkEmpty anyFilter={anyFilter} onClear={onClear} />;
  return (
    <div className="tk-listwrap">
      <div className="card tk-list">
        <div className="tk-tr tk-head"><H k="id">id</H><H k="title">título</H><H k="agent">agente</H><H k="status">estado</H><H k="prio">prioridad</H><H k="age">antigüedad</H><H k="assignee">asignado</H></div>
        {list.map(t => {
          const a = agents.find(x => x.id === t.agent); const st = tkStatus(t.status);
          return (
            <button key={t.id} className="tk-tr" onClick={() => onOpen(t.id)}>
              <span className="tk-id">{t.id}</span>
              <span className="tk-cell-title">{t.title}</span>
              <TkAgent agent={a} small />
              <span className="row gap-2 tk-st"><span className="tk-dot" style={{ background: st.dot }} />{st.l}</span>
              <TkPrio prio={t.prio} />
              <span className="tk-meta">{t.age}</span>
              <span className="row gap-2" style={{ minWidth: 0 }}><TkAvatar k={t.assignee} />{t.assignee ? <span className="tk-meta tk-trunc">{tkPerson(t.assignee)?.name.split(' ')[0]}</span> : <span className="tk-meta">—</span>}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TkEmpty({ anyFilter, onClear }) {
  return (
    <div className="mk-empty">
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>{anyFilter ? 'Ningún ticket coincide' : 'No hay tickets'}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{anyFilter ? 'Prueba con otra búsqueda o quita algún filtro.' : 'Los agentes crean tickets al trabajar; también puedes crear uno.'}</div>
      {anyFilter && <button className="btn btn-sm" onClick={onClear}>Limpiar filtros</button>}
    </div>
  );
}

function TicketSlideOver({ ticket, agents, me, onClose, onUpdate, onMove }) {
  const I = window.Icons;
  const toast = window.useToast?.();
  const a = agents.find(ag => ag.id === ticket.agent);
  const [tab, setTab] = useState('comments');
  useEffect(() => { const h = e => { if (e.key === 'Escape' && !e.target.closest?.('textarea,input')) onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const trace = ticket.trace || [
    { t: '10:34:12', tool: 'internal.lookup', status: 'ok', ms: 120 },
    { t: '10:34:14', tool: `${a?.mcp[0]}.query`, status: 'ok', ms: 640 },
  ];
  const activity = [
    { t: tkAgeLabel(ticket.age), actor: a?.name, action: 'creó el ticket', tone: 'blue' },
    ...(ticket.assignee ? [{ t: '', actor: tkPerson(ticket.assignee)?.name, action: 'quedó como responsable', tone: 'gray' }] : []),
    ...(ticket.status === 'needs_approval' ? [{ t: '', actor: 'Sistema', action: 'pidió aprobación humana antes de ejecutar', tone: 'amber' }] : []),
    ...(ticket.history || []).map(h => ({ ...h, tone: 'accent' })),
  ];
  const copy = () => { navigator.clipboard?.writeText(location.origin + location.pathname + '#/tickets/' + ticket.id); toast?.({ tone: 'success', msg: 'Enlace copiado' }); };
  const set = (k, v, label) => onUpdate(ticket.id, { [k]: v }, label);

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="slide-over tk-slide" role="dialog" aria-modal="true" aria-label={ticket.id + ' ' + ticket.title}>
        <div className="tk-slide-h">
          <span className="tk-id" style={{ fontSize: 12.5 }}>{ticket.id}</span>
          <div className="row gap-1" style={{ marginLeft: 'auto' }}>
            <button className="btn btn-ghost btn-icon" title="Copiar enlace" aria-label="Copiar enlace" onClick={copy}><I.Copy size={13} /></button>
            <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={13} /></button>
          </div>
        </div>
        <div className="tk-slide-b">
          <h2 className="tk-h2">{ticket.title}</h2>

          <div className="tk-props">
            <span>Estado</span>
            <select className="input tk-sel" value={ticket.status} onChange={e => onMove(ticket.id, e.target.value)} aria-label="Estado">
              {TK_STATUS.map(s => <option key={s.k} value={s.k}>{s.l}</option>)}
            </select>
            <span>Prioridad</span>
            <select className="input tk-sel" value={ticket.prio} onChange={e => set('prio', e.target.value, `cambió la prioridad a ${tkPrio(e.target.value).l.toLowerCase()}`)} aria-label="Prioridad">
              {TK_PRIO.map(p => <option key={p.k} value={p.k}>{p.l}</option>)}
            </select>
            <span>Asignado</span>
            <div className="row gap-2">
              <select className="input tk-sel" value={ticket.assignee || ''} onChange={e => set('assignee', e.target.value || null, e.target.value ? `asignó a ${tkPerson(e.target.value)?.name}` : 'quitó al responsable')} aria-label="Asignado">
                <option value="">Sin asignar</option>
                {TK_PEOPLE.map(p => <option key={p.k} value={p.k}>{p.name}{p.k === me ? ' (tú)' : ''}</option>)}
              </select>
              {ticket.assignee !== me && <button className="btn btn-sm btn-ghost" onClick={() => set('assignee', me, 'se asignó el ticket')}>Asignarme</button>}
            </div>
            <span>Agente</span>
            <TkAgent agent={a} />
            <span>Creado</span>
            <span>{tkAgeLabel(ticket.age)}</span>
          </div>

          {ticket.status === 'needs_approval' && (
            <div className="tk-approval">
              <I.Warn size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Espera aprobación</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '2px 0 8px' }}>El agente no ejecutará la acción hasta que alguien la apruebe.</div>
                <button className="btn btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('mango:go', { detail: 'approvals' }))}>Revisar en Aprobaciones <I.ArrowRight size={11} /></button>
              </div>
            </div>
          )}

          {ticket.desc && <div className="tk-desc">{ticket.desc}</div>}

          <div className="tk-tabs" role="tablist">
            {[['comments', 'Comentarios'], ['activity', 'Actividad'], ['trace', `Herramientas · ${trace.length}`]].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {tab === 'comments' && <window.CommentThread ticketId={ticket.id} />}
          {tab === 'activity' && (
            <div className="tk-activity">
              {activity.map((e, i) => (
                <div key={i} className="tk-act">
                  <span className="tk-dot" style={{ background: e.tone === 'amber' ? 'var(--amber)' : e.tone === 'blue' ? 'var(--blue)' : e.tone === 'accent' ? 'var(--accent)' : 'var(--text-dim)', marginTop: 6 }} />
                  <span style={{ flex: 1 }}><b style={{ fontWeight: 500, color: 'var(--text)' }}>{e.actor}</b> {e.action}</span>
                  {e.t && <span className="tk-meta">{e.t}</span>}
                </div>
              ))}
            </div>
          )}
          {tab === 'trace' && (
            <div style={{ position: 'relative', paddingLeft: 24 }}>
              <div style={{ position: 'absolute', left: 7, top: 6, bottom: 6, width: 1, background: 'var(--border)' }} />
              {trace.map((s, i) => <TraceStep key={i} step={s} />)}
            </div>
          )}
        </div>
        <div className="tk-slide-f">
          {ticket.status !== 'done'
            ? <button className="btn btn-sm btn-primary" onClick={() => onMove(ticket.id, 'done')}><I.Check size={12} /> Marcar como resuelto</button>
            : <button className="btn btn-sm" onClick={() => onMove(ticket.id, 'open')}><I.Refresh size={12} /> Reabrir</button>}
        </div>
      </div>
    </>
  );
}

function TraceStep({ step }) {
  const [expanded, setExpanded] = useState(false);
  const I = window.Icons;
  const ok = step.status === 'ok';
  return (
    <div style={{ position: 'relative', paddingBottom: 12 }}>
      <div style={{ position: 'absolute', left: -24, top: 3, width: 14, height: 14, borderRadius: '50%', background: ok ? 'var(--green-soft)' : 'var(--red-soft)', border: `1.5px solid ${ok ? 'var(--green)' : 'var(--red)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {ok ? <I.Check size={8} style={{ color: 'var(--green)' }} /> : <I.Close size={8} style={{ color: 'var(--red)' }} />}
      </div>
      <button onClick={() => setExpanded(!expanded)} disabled={!step.params} style={{ width: '100%', textAlign: 'left', padding: '2px 0', display: 'flex', alignItems: 'center', gap: 8 }} aria-expanded={expanded}>
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-dim)', width: 56 }}>{step.t}</span>
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--text)', flex: 1 }}>{step.tool}</span>
        <span className="mono" style={{ fontSize: 11.5, color: ok ? 'var(--text-dim)' : 'var(--red)' }}>{ok ? step.ms + ' ms' : 'error'}</span>
      </button>
      {expanded && step.params && <pre className="mono" style={{ margin: '4px 0 0', fontSize: 11.5, background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text-muted)', overflow: 'auto' }}>{JSON.stringify(step.params, null, 2)}</pre>}
    </div>
  );
}

Object.assign(window, { Tickets });

function FiltersPopover({ filters, setFilters, agents, onClose }) {
  const toggle = (group, val) => { const s = new Set(filters[group]); s.has(val) ? s.delete(val) : s.add(val); setFilters({ ...filters, [group]: s }); };
  const Chip = ({ on, dot, children, onClick }) => (
    <button className={'tk-chip' + (on ? ' is-on' : '')} aria-pressed={on} onClick={onClick}><span className="tk-dot" style={{ background: dot }} />{children}</button>
  );
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div className="card mk-pop" style={{ width: 300 }}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Filtros</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setFilters({ status: new Set(), prio: new Set(), agent: 'all', assignee: 'all' })}>Limpiar</button>
        </div>
        <div className="tk-fl">Estado</div>
        <div className="row gap-1" style={{ flexWrap: 'wrap', marginBottom: 12 }}>{TK_STATUS.map(s => <Chip key={s.k} on={filters.status.has(s.k)} dot={s.dot} onClick={() => toggle('status', s.k)}>{s.l}</Chip>)}</div>
        <div className="tk-fl">Prioridad</div>
        <div className="row gap-1" style={{ flexWrap: 'wrap', marginBottom: 12 }}>{TK_PRIO.map(p => <Chip key={p.k} on={filters.prio.has(p.k)} dot={p.dot} onClick={() => toggle('prio', p.k)}>{p.l}</Chip>)}</div>
        <label className="tk-fl" htmlFor="tk-f-agent">Agente</label>
        <select id="tk-f-agent" className="input" style={{ width: '100%', marginBottom: 12 }} value={filters.agent} onChange={e => setFilters({ ...filters, agent: e.target.value })}>
          <option value="all">Todos</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="tk-fl" htmlFor="tk-f-as">Asignado a</label>
        <select id="tk-f-as" className="input" style={{ width: '100%' }} value={filters.assignee} onChange={e => setFilters({ ...filters, assignee: e.target.value })}>
          <option value="all">Cualquiera</option><option value="none">Sin asignar</option>{TK_PEOPLE.map(p => <option key={p.k} value={p.k}>{p.name}</option>)}
        </select>
      </div>
    </>
  );
}

function NewTicketModal({ agents, onClose, onCreate, initialStatus }) {
  const I = window.Icons;
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [agent, setAgent] = useState(agents[0]?.id || '');
  const [prio, setPrio] = useState('medium');
  const [status, setStatus] = useState(initialStatus || 'open');
  const [assignee, setAssignee] = useState('');
  const [tried, setTried] = useState(false);
  const me = tkMe();
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const submit = (e) => { e?.preventDefault(); setTried(true); if (!title.trim()) return; onCreate({ title: title.trim(), desc: desc.trim(), agent, prio, status, assignee }); };
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <form className="card" role="dialog" aria-modal="true" aria-label="Nuevo ticket" onClick={e => e.stopPropagation()} onSubmit={submit} style={{ width: 540, maxWidth: '92vw', padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
        <div className="row between" style={{ padding: '18px 20px 4px', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>Nuevo ticket</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>El agente elegido lo toma y registra su trabajo aquí.</div>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div style={{ padding: '14px 20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <TicketField label="Título" error={tried && !title.trim() && 'Escribe un título'}>
            <input autoFocus className="input" placeholder="p. ej. Investigar el aumento de costo en prod-web" value={title} onChange={e => setTitle(e.target.value)} style={tried && !title.trim() ? { borderColor: 'var(--red)' } : null} />
          </TicketField>
          <TicketField label="Descripción" hint="Opcional">
            <textarea className="input" rows={3} placeholder="Contexto, enlaces o pasos para reproducir" value={desc} onChange={e => setDesc(e.target.value)} style={{ resize: 'vertical', fontFamily: 'var(--font-sans)' }} />
          </TicketField>
          <TicketField label="Agente">
            <select className="input" value={agent} onChange={e => setAgent(e.target.value)}>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name} · {a.cat}</option>)}
            </select>
          </TicketField>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
            <TicketField label="Prioridad">
              <select className="input" value={prio} onChange={e => setPrio(e.target.value)}>{TK_PRIO.map(p => <option key={p.k} value={p.k}>{p.l}</option>)}</select>
            </TicketField>
            <TicketField label="Estado">
              <select className="input" value={status} onChange={e => setStatus(e.target.value)}>{TK_STATUS.map(s => <option key={s.k} value={s.k}>{s.l}</option>)}</select>
            </TicketField>
            <TicketField label="Asignar a">
              <select className="input" value={assignee} onChange={e => setAssignee(e.target.value)}>
                <option value="">Sin asignar</option>{TK_PEOPLE.map(p => <option key={p.k} value={p.k}>{p.name}{p.k === me ? ' (tú)' : ''}</option>)}
              </select>
            </TicketField>
          </div>
        </div>
        <div className="row gap-2" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-sm btn-primary">Crear ticket</button>
        </div>
      </form>
    </div>
  );
}

function TicketField({ label, hint, error, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)' }}>{label}</label>
        {hint && <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{hint}</span>}
      </div>
      {children}
      {error && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 5 }}>{error}</div>}
    </div>
  );
}

Object.assign(window, { NewTicketModal, FiltersPopover, TK_STATUS, TK_PRIO, TkAgent });
