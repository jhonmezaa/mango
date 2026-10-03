// Marketplace — catálogo de agentes con detalle lateral y vista de lista
const MK_STATUS = {
  online: { label: 'En línea', cls: 'badge-green', dot: 'green' },
  warmup: { label: 'Iniciando', cls: 'badge-amber', dot: 'amber' },
  degraded: { label: 'Degradado', cls: 'badge-red', dot: 'red' },
  offline: { label: 'Fuera de línea', cls: '', dot: 'gray' },
};
const MK_SORTS = [['relevance', 'Relevancia'], ['name', 'Nombre'], ['usage', 'Más usados'], ['spend', 'Mayor gasto']];
const mkMoney = (n) => window.GovKit ? window.GovKit.usd(n) : '$' + n.toLocaleString();
const mkPct = (a) => a.budgetMax ? Math.round(a.budget / a.budgetMax * 100) : 0;
const mkModel = (m) => { if (!window.MangoStore.get().avail) return m; const x = (window.MangoData.models || []).find(y => y.short === m); return !x ? m : mkNames() ? x.name : x.modelId; };
const mkNames = () => { const S = window.MangoStore; return !S.get().avail || !!S.ROLES?.[S.get().role]?.creator; };
const mkShowBudget = (a) => { const S = window.MangoStore; return !S.get().avail || (S.get().role === 'admin' && (a.budget > 0 || a.id === 'fin-01')); };
const mkTone = (p) => p >= 100 ? 'var(--red)' : p >= 80 ? 'var(--amber)' : 'var(--green)';

function Marketplace({ agents, setAgents, setView, openChat, pinnedIds, setPinnedIds, editAgent }) {
  const S = window.MangoStore;
  window.useMango(s => s.role);
  const avail = window.useMango(s => s.avail);
  const simMk = window.useMango(s => s.simMarket) || null;
  const canManage = S.can('agent.edit');
  const I = window.Icons;
  const toast = window.useToast?.();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('relevance');
  const [layout, setLayout] = useState(() => localStorage.getItem('mango-mk-layout') || 'cards');
  const [tab, setTab] = useState('active');
  const retiredMap = window.useMango(s => s.retired);
  const archived = { has: (id) => !!retiredMap[id] };
  const [moreOpen, setMoreOpen] = useState(false);
  const [extra, setExtra] = useState({ owner: 'all', onlyPinned: false, onlyOrg: false });
  const [detailId, setDetailId] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [shareId, setShareId] = useState(null);
  useEffect(() => { localStorage.setItem('mango-mk-layout', layout); }, [layout]);

  const pinned = pinnedIds || [];
  const isPinned = (id) => pinned.includes(id);
  const retire = (a, reason) => { S.set({ retired: { ...S.get().retired, [a.id]: { by: S.actor(), at: new Date().toISOString(), reason, cleanup: 'running' } } }); setTimeout(() => { const r = S.get().retired[a.id]; if (r && r.cleanup === 'running') S.set({ retired: { ...S.get().retired, [a.id]: { ...r, cleanup: 'done' } } }); }, 6000); setConfirmDel(null); S.log('agent.retire', a.id, `Retiró ${a.name}: ${reason}`); toast?.({ tone: 'success', msg: `"${a.name}" retirado · el historial se conserva` }); };
  const isAdmin = S.get().role === 'admin';
  const clone = (a) => {
    const L = window.Lifecycle;
    const snap = { ...L.snapOf(a), name: a.name + ' (copia)' };
    const r = L.saveDraft({ id: L.newRevId(), agentId: null, kind: 'new', base: null, snap, clonedFrom: a.name });
    if (!avail) toast?.({ tone: 'success', msg: 'Copia guardada como borrador · envíala a aprobación para publicarla' });
    setView('admin', r.id);
  };
  const canShareAgent = (a) => canManage || (a.owner && a.owner === S.actor());
  const togglePin = (id) => {
    if (!setPinnedIds) return;
    const on = isPinned(id);
    setPinnedIds(on ? pinned.filter(x => x !== id) : [...pinned, id]);
    toast?.({ tone: on ? 'info' : 'success', msg: on ? 'Quitado de fijados' : 'Fijado en la barra lateral' });
  };

  const role = S.get().role;
  const USER_GROUPS = S.ROLES[role].groups;
  const canUse = (a) => (role !== 'user' && role !== 'creator') || window.sharesOf(a).everyone || (window.sharesOf(a).groups || []).some(g => USER_GROUPS.includes(g.id));
  const live = agents.filter(a => canUse(a));
  const revs = window.useMango(s => s.agentRevs);
  const me = S.actor();
  const mine = S.can('agent.create') ? revs.filter(r => r.by === me && !r.hidden && ['draft', 'review', 'rejected', 'approved', 'failed'].includes(r.status)).sort((x, y) => new Date(y.updatedAt || y.submittedAt || y.createdAt) - new Date(x.updatedAt || x.submittedAt || x.createdAt)) : [];
  const othersReview = role === 'admin' ? revs.filter(r => r.status === 'review' && r.by !== me).length : 0;
  const pool = live.filter(a => tab === 'archived' ? archived.has(a.id) : !archived.has(a.id));
  const matchQ = (a) => !q || [a.name, a.desc, a.cat, a.caps.join(' ')].join(' ').toLowerCase().includes(q.toLowerCase());
  const base = pool.filter(a => matchQ(a) && (!extra.onlyPinned || isPinned(a.id)) && (!extra.onlyOrg || window.sharesOf(a).everyone) && (extra.owner === 'all' || a.owner === extra.owner));
  const catCounts = base.filter(a => status === 'all' || a.status === status).reduce((m, a) => (m[a.cat] = (m[a.cat] || 0) + 1, m), {});
  const stCounts = base.filter(a => cat === 'all' || a.cat === cat).reduce((m, a) => (m[a.status] = (m[a.status] || 0) + 1, m), {});
  const filtered = base.filter(a => (cat === 'all' || a.cat === cat) && (status === 'all' || a.status === status));
  const sorters = {
    relevance: avail ? (a, b) => a.name.localeCompare(b.name, 'es') : (a, b) => (isPinned(b.id) - isPinned(a.id)) || (b.tickets - a.tickets),
    name: (a, b) => a.name.localeCompare(b.name, 'es'),
    usage: (a, b) => b.tickets - a.tickets,
    spend: avail && !isAdmin ? (a, b) => a.name.localeCompare(b.name, 'es') : (a, b) => b.budget - a.budget,
  };
  const list = [...filtered].sort(sorters[sort]);
  const cats = [...new Set(live.map(a => a.cat))].sort();
  const owners = [...new Set(live.map(a => a.owner).filter(Boolean))];
  const extraCount = (extra.owner !== 'all' ? 1 : 0) + (extra.onlyPinned ? 1 : 0) + (extra.onlyOrg ? 1 : 0);
  const anyFilter = q || cat !== 'all' || status !== 'all' || extraCount > 0;
  const clearAll = () => { setQ(''); setCat('all'); setStatus('all'); setExtra({ owner: 'all', onlyPinned: false, onlyOrg: false }); };
  const grouped = layout === 'cards' && tab === 'active' && sort === 'relevance' && cat === 'all' && !q;
  const pinnedList = tab === 'active' && !anyFilter ? pool.filter(a => isPinned(a.id)) : [];
  const detail = detailId ? live.find(a => a.id === detailId) : null;
  const archivedCount = live.filter(a => archived.has(a.id)).length;

  const cardProps = (a) => ({
    agent: a, pinned: isPinned(a.id), archived: archived.has(a.id), retiredInfo: retiredMap[a.id], canManage: canManage && (!avail || isAdmin || a.owner === me), isAdmin, avail,
    onOpen: () => setDetailId(a.id), onChat: () => openChat(a.id, null), onTogglePin: () => togglePin(a.id),
    onEdit: () => editAgent(a.id), onShare: () => setShareId(a.id), onClone: () => clone(a), onRetire: () => setConfirmDel(a),
  });

  return (
    <>
      <Topbar crumbs={['Marketplace']}
        actions={S.can('agent.create') && <button className="btn btn-sm btn-primary" onClick={() => setView('admin')}><I.Plus size={12} /> Nuevo agente</button>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Agentes</h1>
          <p className="page-subtitle">{pool.length} {tab === 'archived' ? 'retirados · con historial conservado' : 'disponibles para ti'} · según tus grupos de acceso</p>
        </div>

        <div className="mk-bar">
          <div className="mk-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'is-on' : ''} onClick={() => setTab('active')}>Activos</button>
            <button role="tab" aria-selected={tab === 'archived'} className={tab === 'archived' ? 'is-on' : ''} onClick={() => setTab('archived')}>Retirados{archivedCount > 0 && <span className="mk-count">{archivedCount}</span>}</button>
          </div>
          <div className="mk-filters">
            <div className="search-wrap mk-search"><I.Search size={13} /><input className="input" placeholder="Buscar agentes o capacidades" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar agentes" /></div>
            <select className="input mk-sel" value={cat} onChange={e => setCat(e.target.value)} aria-label="Categoría">
              <option value="all">Todas las categorías</option>
              {cats.map(c => <option key={c} value={c}>{c} · {catCounts[c] || 0}</option>)}
            </select>
            <window.Soon on={avail}><select className="input mk-sel" value={status} onChange={e => setStatus(e.target.value)} aria-label="Estado">
              <option value="all">Cualquier estado</option>
              {Object.entries(MK_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label} · {stCounts[k] || 0}</option>)}
            </select></window.Soon>
            <window.Soon on={avail}><div style={{ position: 'relative' }}>
              <button className={'btn btn-sm' + (extraCount ? ' mk-active' : '')} onClick={() => setMoreOpen(v => !v)} aria-expanded={moreOpen}><I.Filter size={12} /> Más{extraCount > 0 && <span className="mk-count">{extraCount}</span>}</button>
              {moreOpen && (
                <>
                  <div onClick={() => setMoreOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div className="card mk-pop">
                    <div className="row between" style={{ marginBottom: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>Más filtros</span>
                      <button className="btn btn-sm btn-ghost" onClick={() => setExtra({ owner: 'all', onlyPinned: false, onlyOrg: false })}>Limpiar</button>
                    </div>
                    {owners.length > 0 && <>
                      <label htmlFor="mk-owner" style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Owner</label>
                      <select id="mk-owner" className="input" value={extra.owner} onChange={e => setExtra({ ...extra, owner: e.target.value })} style={{ width: '100%', marginBottom: 10 }}>
                        <option value="all">Todos</option>{owners.map(o => <option key={o}>{o}</option>)}
                      </select>
                    </>}
                    <label className="row gap-2" style={{ cursor: 'pointer', fontSize: 13 }}>
                      <input type="checkbox" checked={extra.onlyPinned} onChange={e => setExtra({ ...extra, onlyPinned: e.target.checked })} style={{ accentColor: 'var(--accent)' }} /> Solo fijados
                    </label>
                    <label className="row gap-2" style={{ cursor: 'pointer', fontSize: 13, marginTop: 8 }}>
                      <input type="checkbox" checked={extra.onlyOrg} onChange={e => setExtra({ ...extra, onlyOrg: e.target.checked })} style={{ accentColor: 'var(--accent)' }} /> Para toda la organización
                    </label>
                  </div>
                </>
              )}
            </div></window.Soon>
            <div className="mk-spacer" />
            <select className="input mk-sel" value={sort} onChange={e => setSort(e.target.value)} aria-label="Ordenar">
              {MK_SORTS.map(([k, l]) => <option key={k} value={k} disabled={avail && k === 'usage'}>Ordenar: {l}{avail && k === 'usage' ? ' · Próximamente' : ''}</option>)}
            </select>
            <div className="mk-seg" role="group" aria-label="Vista">
              <button className={layout === 'cards' ? 'is-on' : ''} aria-pressed={layout === 'cards'} onClick={() => setLayout('cards')} title="Tarjetas"><I.Dashboard size={13} /></button>
              <button className={layout === 'list' ? 'is-on' : ''} aria-pressed={layout === 'list'} onClick={() => setLayout('list')} title="Lista"><I.List size={13} /></button>
            </div>
          </div>
        </div>

        <div className="mk-body">
          {avail && simMk === 'loading' ? <div className="mk-empty" role="status"><span className="g-spin" /><div className="mk-meta">Cargando agentes…</div></div>
          : avail && simMk === 'error' ? <div className="mk-empty" role="alert"><div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>No se pudieron cargar los agentes</div><div className="mk-meta">No se pudo completar la acción. Inténtalo de nuevo.</div><button className="btn btn-sm" onClick={() => S.set({ simMarket: null })}><I.Refresh size={12} /> Reintentar</button></div>
          : <>
          {tab === 'active' && !anyFilter && (mine.length > 0 || othersReview > 0) && <MkInProgress mine={mine} othersReview={othersReview} setView={setView} />}
          {list.length === 0 ? (
            <div className="mk-empty">
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>{tab === 'archived' && !anyFilter ? 'No hay agentes retirados' : 'Ningún agente coincide'}</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{tab === 'archived' && !anyFilter ? 'Cuando un admin retire un agente, aparecerá aquí con su historial.' : 'Prueba con otra búsqueda o quita algún filtro.'}</div>
              {anyFilter && <button className="btn btn-sm" onClick={clearAll}>Limpiar filtros</button>}
            </div>
          ) : layout === 'list' ? (
            <AgentTable list={list} cardProps={cardProps} />
          ) : grouped ? (
            <>
              {pinnedList.length > 0 && <MkGroup title="Fijados" count={pinnedList.length}>{pinnedList.map(a => <AgentCard key={a.id} {...cardProps(a)} />)}</MkGroup>}
              {cats.map(c => { const g = list.filter(a => a.cat === c && !(pinnedList.length > 0 && isPinned(a.id))); return g.length ? <MkGroup key={c} title={c} count={g.length}>{g.map(a => <AgentCard key={a.id} {...cardProps(a)} />)}</MkGroup> : null; })}
            </>
          ) : (
            <div className="mk-grid">{list.map(a => <AgentCard key={a.id} {...cardProps(a)} />)}</div>
          )}
          </>}
        </div>
      </div>
      {detail && <AgentDetail agent={detail} {...cardProps(detail)} onClose={() => setDetailId(null)} />}
      {shareId && live.find(a => a.id === shareId) && <window.ShareAgent agent={live.find(a => a.id === shareId)} canShare={canShareAgent(live.find(a => a.id === shareId))} onClose={() => setShareId(null)} />}
      {confirmDel && <RetireAgent agent={confirmDel} onClose={() => setConfirmDel(null)} onRetire={(r) => retire(confirmDel, r)} />}
    </>
  );
}

function MkGroup({ title, count, children }) {
  return (
    <section className="mk-group">
      <div className="mk-group-h">{title.toLowerCase()} <span>{count}</span></div>
      <div className="mk-grid">{children}</div>
    </section>
  );
}

function MkStatus({ status }) {
  const st = MK_STATUS[status] || MK_STATUS.offline;
  return <span className={'badge ' + st.cls}><span className={`dot dot-${st.dot}${status === 'online' ? ' pulse' : ''}`} />{st.label}</span>;
}

function MkBudget({ agent, compact }) {
  const p = mkPct(agent);
  return (
    <div className="mk-budget" title={`${mkMoney(agent.budget)} de ${mkMoney(agent.budgetMax)} este mes`}>
      <div className="mk-bar-track"><span style={{ width: Math.min(p, 100) + '%', background: mkTone(p) }} /></div>
      <span className="mono">{compact ? p + '%' : `${mkMoney(agent.budget)} / ${mkMoney(agent.budgetMax)}`}</span>
    </div>
  );
}

function AgentMenu({ agent, archived, canManage, isAdmin, avail, onEdit, onShare, onClone, onRetire }) {
  const I = window.Icons;
  const [open, setOpen] = useState(false);
  if (!canManage || archived) return null;
  const go = (fn) => (e) => { e.stopPropagation(); setOpen(false); fn?.(); };
  return (
    <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
      <button className="icon-btn mk-icon" title="Más opciones" aria-label={'Más opciones de ' + agent.name} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}><I.MoreHorizontal size={13} /></button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
          <div className="card mk-menu" role="menu">
            <MenuItem icon={I.Edit} label="Editar" onClick={go(onEdit)} />
            {avail ? <div className="row between" style={{ padding: '7px 10px', fontSize: 13.5, color: 'var(--text-muted)', gap: 8 }} aria-disabled="true"><span className="row gap-2"><I.Share size={12} /> Compartir…</span><window.SoonTag /></div> : <MenuItem icon={I.Share} label="Compartir…" onClick={go(onShare)} />}
            <MenuItem icon={I.Copy} label="Duplicar" onClick={go(onClone)} />
            {isAdmin && <><div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />
            <MenuItem icon={I.Archive} label="Retirar…" danger onClick={go(onRetire)} /></>}
          </div>
        </>
      )}
    </div>
  );
}

function PinBtn({ agent, pinned, onTogglePin }) {
  const I = window.Icons;
  return (
    <button className={'icon-btn mk-icon' + (pinned ? ' is-pinned' : '')} title={pinned ? 'Quitar de fijados' : 'Fijar en la barra lateral'} aria-label={(pinned ? 'Quitar de fijados ' : 'Fijar ') + agent.name} aria-pressed={pinned}
      onClick={(e) => { e.stopPropagation(); onTogglePin?.(); }}><I.Star size={12} filled={pinned} /></button>
  );
}

function AgentCard(p) {
  const { agent, archived, onOpen, onChat } = p;
  const I = window.Icons;
  const Icon = I[agent.icon] || I.Bot;
  return (
    <div className={'card mk-card' + (archived ? ' is-archived' : '')} role="button" tabIndex={0} aria-label={'Ver detalle de ' + agent.name}
      onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
      <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span className="mk-avatar" style={{ background: agent.iconBg, color: agent.iconColor }}><Icon size={17} /></span>
          <div style={{ minWidth: 0 }}>
            <div className="mk-name">{agent.name}</div>
            <div className="mk-meta">{agent.cat} · <span className={p.avail && mkNames() ? undefined : 'mono'}>{mkModel(agent.model)}</span></div>
          </div>
        </div>
        <div className="row gap-1" style={{ flexShrink: 0 }}>
          {!p.avail && window.sharesOf(agent).everyone && <span className="mk-shared org" title="Disponible para toda la organización"><I.Globe size={11} />Todos</span>}
          {!p.avail && !window.sharesOf(agent).everyone && window.sharesOf(agent).users.length > 0 && <span className="mk-shared" title={'Compartido con ' + window.shareSummary(agent)}><I.User size={11} />{window.sharesOf(agent).users.length}</span>}
          <PinBtn {...p} />
          <AgentMenu {...p} />
        </div>
      </div>
      <p className="mk-desc">{agent.desc}</p>
      {(!p.avail || agent.id === 'fin-01') && <div className="row gap-1" style={{ flexWrap: 'wrap' }}>
        {agent.caps.slice(0, 3).map(c => <span key={c} className="badge" style={{ fontSize: 11 }}>{c}</span>)}
        {agent.caps.length > 3 && <span className="badge" style={{ fontSize: 11 }}>+{agent.caps.length - 3}</span>}
      </div>}
      <div className="mk-foot">
        {!p.avail && <MkStatus status={agent.status} />}
        {mkShowBudget(agent) ? <MkBudget agent={agent} compact /> : p.avail ? <span style={{ flex: 1 }} /> : null}
        {archived
          ? <span className="row gap-1">{p.avail && p.isAdmin && (window.MangoStore.get().simCleanup || p.retiredInfo?.cleanup) === 'running' && <span className="badge badge-blue">Limpiando</span>}{p.avail && p.isAdmin && (window.MangoStore.get().simCleanup || p.retiredInfo?.cleanup) === 'failed' && <span className="badge badge-red">Limpieza falló</span>}<span className="badge">Retirado</span></span>
          : <button className="btn btn-sm" onClick={e => { e.stopPropagation(); onChat(); }}>Abrir chat <I.ArrowRight size={11} /></button>}
      </div>
    </div>
  );
}

function AgentTable({ list, cardProps }) {
  const I = window.Icons; const avail = window.MangoStore.get().avail;
  return (
    <div className="card mk-table">
      <div className="mk-tr mk-th"><span>agente</span><span>estado</span><span>modelo</span><span>gasto del mes</span><span style={{ textAlign: 'right' }}>tickets</span><span /></div>
      {list.map(a => {
        const p = cardProps(a); const Icon = I[a.icon] || I.Bot;
        return (
          <div key={a.id} className={'mk-tr' + (p.archived ? ' is-archived' : '')} role="button" tabIndex={0} onClick={p.onOpen} onKeyDown={e => { if (e.key === 'Enter') p.onOpen(); }}>
            <div className="row gap-3" style={{ minWidth: 0 }}>
              <span className="mk-avatar sm" style={{ background: a.iconBg, color: a.iconColor }}><Icon size={14} /></span>
              <div style={{ minWidth: 0 }}><div className="mk-name">{a.name}</div><div className="mk-meta">{a.cat}{a.role ? ' · ' + a.role : ''}</div></div>
            </div>
            <span>{avail ? <span className="mk-meta">—</span> : <MkStatus status={a.status} />}</span>
            <span className={avail && mkNames() ? undefined : 'mono'} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{mkModel(a.model)}</span>
            <div style={{ minWidth: 0 }}>{mkShowBudget(a) ? <><MkBudget agent={a} compact /><div className="mk-meta mono" style={{ fontSize: 11, marginTop: 3 }}>{mkMoney(a.budget)}</div></> : <span className="mk-meta">—</span>}</div>
            <span className="mono" style={{ fontSize: 12.5, textAlign: 'right' }}>{avail ? '—' : a.tickets}</span>
            <div className="row gap-1" style={{ justifyContent: 'flex-end' }}><PinBtn {...p} /><AgentMenu {...p} /></div>
          </div>
        );
      })}
    </div>
  );
}

function AgentDetail(p) {
  const { agent, pinned, canManage, archived, retiredInfo, onClose, onChat, onTogglePin, onEdit, onShare, avail } = p;
  const L = window.Lifecycle;
  const I = window.Icons; const S = window.MangoStore;
  const Icon = I[agent.icon] || I.Bot;
  const mcp = window.MangoData?.mcpServers || [];
  const skills = (window.MangoData?.skills || []).filter(s => s.usedBy?.includes(agent.id));
  const versions = (S.get().versions?.[agent.id] || []).slice(0, 3);
  const managerName = agent.manager === 'platform' ? 'Platform Admin' : (window.MangoData?.agents || []).find(a => a.id === agent.manager)?.name || agent.manager;
  const pct = mkPct(agent);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" role="dialog" aria-modal="true" aria-label={agent.name}>
        <div className="mk-drawer-h">
          <span className="mk-avatar lg" style={{ background: agent.iconBg, color: agent.iconColor }}><Icon size={22} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{agent.name}</div>
            <div className="row gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}>{!avail && <MkStatus status={agent.status} />}<span className="mk-meta">{agent.cat}</span>{archived && <span className="badge">Retirado</span>}</div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="mk-drawer-b">
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, textWrap: 'pretty' }}>{agent.desc}</p>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
            {archived ? <div style={{ width: '100%', display: 'grid', gap: 8 }}><div className="sh-note"><I.Archive size={12} /> {avail ? 'Retirado' : 'Retirado por ' + retiredInfo?.by} · {retiredInfo?.reason} · conversaciones, versiones y auditoría se conservan.</div>{avail && p.isAdmin && (() => { const cl = window.MangoStore.get().simCleanup || retiredInfo?.cleanup; return cl === 'running' ? <div className="mc-alert" role="status"><span className="g-spin" /><div>Borrando su infraestructura en segundo plano. Tarda unos minutos.</div></div> : cl === 'failed' ? <div className="mc-alert red" role="alert"><I.X2 size={14} /><div><b>La limpieza de recursos falló.</b> Quedó infraestructura sin borrar; quien opera la instalación debe revisarla. El historial no se ve afectado.</div></div> : null; })()}</div> : <button className="btn btn-sm btn-primary" onClick={onChat}><I.Chat size={12} /> Abrir chat</button>}
            {!archived && <><button className="btn btn-sm" onClick={onTogglePin}><I.Star size={12} filled={pinned} /> {pinned ? 'Fijado' : 'Fijar'}</button>
            {avail ? <window.Soon on><button className="btn btn-sm"><I.Share size={12} /> Compartir</button></window.Soon> : <button className="btn btn-sm" onClick={onShare}><I.Share size={12} /> Compartir</button>}
            {canManage && <button className="btn btn-sm" onClick={onEdit}><I.Edit size={12} /> Editar</button>}</>}
          </div>

          {mkShowBudget(agent) && <MkSec title="Presupuesto del mes">
            <div className="row between" style={{ fontSize: 13, marginBottom: 8 }}><span className="mono">{mkMoney(agent.budget)} de {mkMoney(agent.budgetMax)}</span><span style={{ color: mkTone(pct), fontWeight: 500 }}>{pct}%</span></div>
            <div className="mk-bar-track lg"><span style={{ width: Math.min(pct, 100) + '%', background: mkTone(pct) }} /></div>
          </MkSec>}

          <MkSec title="Modelo">
            <div className="row gap-1" style={{ flexWrap: 'wrap' }}>
              {(agent.availableModels || [agent.model]).map(m => <span key={m} className={'badge' + (m === agent.model ? ' badge-accent' : '')} style={{ fontSize: 11.5 }}>{mkModel(m)}{m === agent.model ? ' · principal' : ''}</span>)}
            </div>
          </MkSec>

          {!avail && <MkSec title={`Skills · ${skills.length || agent.caps.length}`}>
            {skills.length ? skills.map(s => (
              <div key={s.id} className="mk-line"><span style={{ fontWeight: 500 }}>{s.name}</span><span className="mk-meta" style={{ display: 'block' }}>{s.desc}</span></div>
            )) : <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{agent.caps.map(c => <span key={c} className="badge" style={{ fontSize: 11 }}>{c}</span>)}</div>}
          </MkSec>}

          <MkSec title={`Herramientas · ${agent.mcp.length}`}>
            {avail ? agent.mcp.map(id => { const s = L?.serverOf(id); const off = !s || !['enabled'].includes(s.status); return (
              <div key={id} className="mk-line">
                <div className="row between" style={{ gap: 8 }}><span className="mono" style={{ fontWeight: 500, fontSize: 12.5 }}>{id}</span>{off && <span className="badge badge-amber">No disponibles</span>}</div>
                {s && <div className="row gap-1" style={{ flexWrap: 'wrap', marginTop: 4 }}>{s.tools.map(t => <code key={t.name} className="mc-tool-chip">{t.name}</code>)}</div>}
              </div>
            ); }) : agent.mcp.map(id => { const m = mcp.find(x => x.id === id); return (
              <div key={id} className="mk-line row between">
                <div style={{ minWidth: 0 }}><div style={{ fontWeight: 500 }}>{m?.name || id}</div><div className="mk-meta">{m ? `${m.toolsCount} tools · ${m.desc}` : id}</div></div>
                {m && <span className={`dot dot-${m.health === 'ok' ? 'green' : m.health === 'warn' ? 'amber' : 'red'}`} title={m.health} />}
              </div>
            ); })}
          </MkSec>

          <MkSec title="Organización">
            <div className="mk-kv"><span>Reporta a</span><span>{managerName}</span></div>
            {agent.role && <div className="mk-kv"><span>Rol</span><span>{agent.role}</span></div>}
            {!avail && agent.owner && <div className="mk-kv"><span>Owner</span><span>{agent.owner}</span></div>}
            {!avail && <div className="mk-kv"><span>Tickets</span><span className="mono">{agent.tickets}</span></div>}
            {!avail && <div className="mk-kv"><span>Compartido con</span><button className="mk-link" onClick={onShare}>{window.shareSummary(agent)}</button></div>}
          </MkSec>
          {avail && <div className="mk-meta" style={{ lineHeight: 1.5 }}>Cambiar con quién se comparte es una versión nueva del agente: se edita en el Builder y pasa por revisión.</div>}

          {!avail && versions.length > 0 && (
            <MkSec title="Versiones recientes">
              {versions.map(v => <div key={v.v} className="mk-line row between"><span><span className="mono">v{v.v}</span> · {v.note || 'Sin nota'}</span><span className="mk-meta">{v.by || ''}</span></div>)}
            </MkSec>
          )}
        </div>
      </aside>
    </div>
  );
}

function MkSec({ title, children }) {
  return <section className="mk-sec"><div className="mk-sec-t">{title.toLowerCase()}</div>{children}</section>;
}

function RetireAgent({ agent, onClose, onRetire }) {
  const I = window.Icons;
  const [reason, setReason] = useState('');
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-label={'Retirar ' + agent.name} onClick={e => e.stopPropagation()} style={{ width: 480, maxWidth: '92vw', padding: 20 }}>
        <div className="row gap-3" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--row-hover)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><I.Archive size={15} /></span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Retirar “{agent.name}”</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Solo un admin puede retirar agentes.</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 14, padding: 12, background: 'var(--row-hover)', borderRadius: 8 }}>
          Deja de aparecer en el marketplace y no se pueden abrir conversaciones nuevas. Se conserva el historial: conversaciones, versiones y auditoría.{window.MangoStore.get().avail && ' Su infraestructura se borra en segundo plano, unos minutos después.'}
        </div>
        <label htmlFor="ret-reason" style={{ fontSize: 12.5, display: 'block', marginBottom: 6 }}>Motivo</label>
        <textarea id="ret-reason" className="input" rows={3} style={{ width: '100%' }} value={reason} onChange={e => setReason(e.target.value)} autoFocus placeholder="Queda registrado en Auditoría" />
        <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-sm" onClick={onClose}>Cancelar</button>
          <button className="btn btn-sm btn-primary" disabled={!reason.trim()} onClick={() => onRetire(reason.trim())}><I.Archive size={11} /> Retirar</button>
        </div>
      </div>
    </div>
  );
}

window.Marketplace = Marketplace;

function MenuItem({ icon: Icon, label, onClick, danger }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick?.(e); }} role="menuitem"
      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 10px', background: 'transparent', border: 'none', borderRadius: 4, color: danger ? 'var(--red)' : 'var(--text)', fontSize: 13.5, cursor: 'pointer', textAlign: 'left' }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--row-hover)'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
      {Icon && <Icon size={12} style={{ flexShrink: 0, opacity: 0.8 }} />}
      <span>{label}</span>
    </button>
  );
}
window.MenuItem = MenuItem;

function MkInProgress({ mine, othersReview, setView }) {
  const I = window.Icons; const L = window.Lifecycle;
  const cta = { draft: 'Seguir editando', rejected: 'Corregir', failed: 'Ver detalle', review: 'Ver', approved: 'Ver' };
  const when = (r) => r.status === 'review' ? 'Enviado ' + window.fmtAgo(r.submittedAt) : r.status === 'rejected' ? 'Rechazado ' + window.fmtAgo(r.decidedAt) : r.status === 'failed' ? 'Falló ' + window.fmtAgo(r.decidedAt) : 'Editado ' + window.fmtAgo(r.updatedAt || r.createdAt);
  return (
    <section className="mk-group" style={{ marginBottom: 28 }}>
      <div className="row between" style={{ marginBottom: 10, gap: 12 }}>
        <div className="mk-group-h" style={{ margin: 0 }}>tus agentes en curso <span>{mine.length}</span></div>
        {othersReview > 0 && <button className="sr-link" onClick={() => setView('review')}>{othersReview} {othersReview === 1 ? 'cambio espera' : 'cambios esperan'} tu revisión →</button>}
      </div>
      {mine.length > 0 && <div className="card" style={{ padding: 0 }}>
        {mine.map((r, i) => { const Ic = I[r.snap.icon] || I.Bot; const st = L.REV_STATUS[r.status]; return (
          <button key={r.id} className="mk-ip" style={{ borderTop: i ? '1px solid var(--border)' : 'none' }} onClick={() => setView('admin', r.id)}>
            <span className="mk-avatar sm" style={{ background: 'var(--row-hover)', color: 'var(--text-muted)' }}><Ic size={14} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="mk-name" style={{ display: 'block' }}>{r.snap.name}{r.kind === 'change' && <span className="mk-meta" style={{ fontWeight: 400 }}> · cambio a publicado</span>}</span>
              <span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{when(r)}{r.status === 'rejected' && r.reason ? ' · “' + r.reason + '”' : ''}{r.status === 'failed' ? ' · en «' + (window.MangoStore.get().avail ? (r.failedCode || 'publication_expired') : r.failedStep) + '»' : ''}</span>
            </span>
            <span className={'badge ' + st[1]}>{st[0]}</span>
            <span className="mk-ip-cta">{cta[r.status]} <I.ArrowRight size={11} /></span>
          </button>
        ); })}
      </div>}
    </section>
  );
}
