// Shell: Sidebar + Topbar — minimal, light-first
const { useState } = React;
const I = window.Icons;

const NAV_PRIMARY = [
  { key: 'dashboard', icon: 'Dashboard', label: 'Inicio' },
  { key: 'chat', icon: 'Chat' },
  { key: 'inbox', icon: 'Inbox' },
  { key: 'marketplace', icon: 'Store' },
  { key: 'tickets', icon: 'Tickets' },
  { key: 'search', icon: 'Search' },
];
const NAV_GROUPS = [
  { id: 'gov', label: 'Gobernanza', icon: 'Shield', items: ['approvals', 'review', 'governance', 'budgets', 'audit', 'activity'] },
  { id: 'build', label: 'Construir', icon: 'Skill', items: ['playground', 'models', 'skills', 'mcp', 'knowledge', 'schedules'] },
  { id: 'ops', label: 'Operación', icon: 'Activity', items: ['observability', 'evals', 'costs', 'org'] },
];
const NAV_ICONS = { review: 'Eye', approvals: 'Check2', governance: 'Shield', budgets: 'Money', audit: 'Lock', activity: 'Activity', playground: 'Play', models: 'Bot', skills: 'Skill', mcp: 'Cloud', knowledge: 'BookOpen', schedules: 'Clock', observability: 'Activity', evals: 'Check', costs: 'Zap', org: 'Org' };

function Sidebar({ view, setView, agents, user, collapsed, setCollapsed, pinnedIds, setPinnedIds, openChat, mobile, mobileOpen, setMobileOpen, onTour }) {
  const t = window.t;
  const S = window.MangoStore;
  const role = window.useMango(s => s.role);
  const lang = window.useMango(s => s.lang);
  const pendingApprovals = window.useMango(s => s.approvals.filter(a => a.status === 'pending').length);
  const pendingReviews = window.useMango(s => (s.agentRevs || []).filter(r => r.status === 'review').length);
  const inboxUnread = window.useMango(s => s.inboxUnread);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => { try { return JSON.parse(localStorage.getItem('mango-sb-groups') || '{"gov":true}'); } catch { return { gov: true }; } });
  const isCollapsed = mobile ? false : collapsed;
  const go = (k) => { setView(k); if (mobile) setMobileOpen(false); };
  const saveGroups = (n) => { setOpenGroups(n); localStorage.setItem('mango-sb-groups', JSON.stringify(n)); };
  const toggleGroup = (id, isOpen) => saveGroups({ ...openGroups, [id]: !isOpen });
  // Opening a view inside a group expands it once; the user can collapse it afterwards.
  React.useEffect(() => {
    const g = NAV_GROUPS.find(x => x.items.includes(view));
    if (g && openGroups[g.id] !== true) saveGroups({ ...openGroups, [g.id]: true });
  }, [view]);
  const label = (k) => k === 'dashboard' ? (lang === 'en' ? 'Home' : 'Inicio') : t('nav.' + k);
  const avail0 = window.useMango(s => s.avail);
  const pinned = (pinnedIds || []).map(id => agents.find(a => a.id === id)).filter(Boolean);
  const roleLabel = (r) => S.ROLES[r].label;
  const avail = window.useMango(s => s.avail);
  const soon = (k) => avail && S.isSoon(k);
  const logout = () => { setMenuOpen(false); S.log('account.logout', user.email, 'Cerró sesión'); window.dispatchEvent(new CustomEvent('mango:logout')); };

  return (
    <>
      {mobile && mobileOpen && <div className="sb-scrim" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar ${isCollapsed ? 'sidebar-collapsed' : ''} ${mobile ? 'sidebar-mobile' : ''} ${mobile && mobileOpen ? 'open' : ''}`} aria-label="Navegación principal">
        <div className="sb-top">
          <button className="sb-workspace" onClick={() => mobile ? setMobileOpen(false) : setCollapsed(!collapsed)} aria-label={mobile ? 'Cerrar menú' : collapsed ? 'Expandir sidebar' : 'Colapsar sidebar'} aria-expanded={!isCollapsed}>
            <span className="sb-ws-logo" aria-hidden="true">m</span>
            {!isCollapsed && <span className="sb-ws-text"><span className="sb-ws-name">Mango</span><span className="sb-ws-org">Empresa</span></span>}
            {!isCollapsed && <I.ChevronLeft size={14} style={{ color: 'var(--text-muted)' }} />}
          </button>
        </div>

        <nav className="sb-nav">
          <div className="sb-group">
            {NAV_PRIMARY.filter(i => S.canView(i.key)).map(item => <NavItem key={item.key} soon={soon(item.key)} item={{ ...item, label: label(item.key), badge: item.key === 'inbox' ? inboxUnread || null : null }} active={view === item.key} onClick={() => go(item.key)} collapsed={isCollapsed} />)}
          </div>

          {pinned.length > 0 && (
            <div className="sb-group" role="group" aria-label="Agentes fijados">
              {!isCollapsed ? <div className="sb-label">{lang === 'en' ? 'Pinned agents' : 'Agentes fijados'}</div> : <div className="sb-divider" />}
              {pinned.map(a => {
                const Ic = I[a.icon];
                return (
                  <div key={a.id} className="sb-item sb-item-agent" style={{ padding: 0 }}>
                    <button className="sb-item-main" title={isCollapsed ? a.name : undefined} aria-label={'Chat con ' + a.name} onClick={() => { openChat(a.id, null); mobile && setMobileOpen(false); }}>
                      <span className="sb-item-icon"><Ic size={16} /></span>
                      {!isCollapsed && <span className="sb-item-label">{a.name}</span>}
                    </button>
                    {!isCollapsed && <button className="sb-pin-btn" title="Quitar de fijados" aria-label={'Quitar ' + a.name + ' de fijados'} onClick={() => setPinnedIds(pinnedIds.filter(x => x !== a.id))}><I.Close size={11} /></button>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="sb-group">
            {!isCollapsed && <div className="sb-label">{lang === 'en' ? 'Platform' : 'Plataforma'}</div>}
            {isCollapsed && <div className="sb-divider" />}
            {NAV_GROUPS.map(g => {
              const items = g.items.filter(k => S.canView(k));
              if (!items.length) return null;
              const containsActive = items.includes(view);
              const open = openGroups[g.id] ?? containsActive;
              const GIc = I[g.icon];
              if (isCollapsed) return items.map(k => <NavItem key={k} soon={soon(k)} item={{ key: k, icon: NAV_ICONS[k], label: label(k), badge: k === 'approvals' ? pendingApprovals || null : k === 'review' ? pendingReviews || null : null }} active={view === k} onClick={() => go(k)} collapsed />);
              return (
                <div key={g.id}>
                  <button className={`sb-item sb-group-head ${containsActive && !open ? 'active' : ''}`} aria-expanded={open} onClick={() => toggleGroup(g.id, open)}>
                    <span className="sb-item-icon" aria-hidden="true"><GIc size={16} /></span>
                    <span className="sb-item-label">{lang === 'en' ? ({ gov: 'Governance', build: 'Build', ops: 'Operations' })[g.id] : g.label}</span>
                    {g.id === 'gov' && (pendingApprovals + pendingReviews) > 0 && !open && <span className="sb-item-badge">{pendingApprovals + pendingReviews}</span>}
                    <I.ChevronDown size={13} style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
                  </button>
                  {open && <div className="sb-sub">{items.map(k => <NavItem key={k} sub soon={soon(k)} item={{ key: k, label: label(k), badge: k === 'approvals' ? pendingApprovals || null : k === 'review' ? pendingReviews || null : null }} active={view === k} onClick={() => go(k)} />)}</div>}
                </div>
              );
            })}
          </div>
        </nav>

        <div className="sb-footer" style={{ position: 'relative' }}>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div role="menu" className="card" style={isCollapsed
                ? { position: 'fixed', left: 68, bottom: 12, width: 260, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', padding: 6, zIndex: 60, boxShadow: 'var(--shadow)' }
                : { position: 'absolute', bottom: 'calc(100% + 4px)', left: 8, right: 8, minWidth: 230, maxHeight: 'calc(100vh - 90px)', overflowY: 'auto', padding: 6, zIndex: 41, boxShadow: 'var(--shadow)' }}>
                <div style={{ padding: '6px 10px 8px' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{S.actor()}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{user.email}</div>
                  <div style={{ fontSize: 12, color: 'var(--text)', marginTop: 6, fontWeight: 500 }}>{roleLabel(role)}</div>
                  <div className="row gap-1" style={{ marginTop: 4, flexWrap: 'wrap' }} aria-label="Grupos">{S.ROLES[role].groups.map(g => <span key={g} className="badge mono" style={{ fontSize: 11 }}>{g}</span>)}</div>
                </div>
                <div className="sb-menu-sep" />
                <div style={{ padding: '6px 10px 8px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}><span className="row gap-2" style={{ color: 'var(--text)', fontWeight: 500, marginBottom: 2 }}><I.Lock size={12} /> Contraseña y MFA</span>Para cambiar tu contraseña usa «Olvidé mi contraseña» al iniciar sesión. Para restablecer tu MFA, pídeselo a un admin.</div>
                <div className="sb-menu-sep" />
                <div className="row between sb-menu-item" style={{ cursor: 'default' }} aria-disabled="true"><span className="row gap-2" style={{ opacity: .55 }}><I.Globe size={14} /> {t('sb.lang')} · Español</span><window.SoonTag /></div>
                <div className="sb-menu-sep" />
                <button role="menuitem" className="row gap-2 sb-menu-item" onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('mango:toggle-theme')); }}><I.Moon size={14} /> Cambiar tema</button>
                <div className="row between sb-menu-item" style={{ cursor: 'default' }} aria-disabled="true"><span className="row gap-2" style={{ opacity: .55 }}><I.BookOpen size={14} /> {t('sb.tour')}</span><window.SoonTag /></div>
                {S.canView('settings') && <button role="menuitem" className="row gap-2 sb-menu-item" onClick={() => { setMenuOpen(false); go('settings'); }}><I.Settings size={14} /> {t('nav.settings')}</button>}
                <div className="sb-menu-sep" />
                <button role="menuitem" className="row gap-2 sb-menu-item danger" onClick={logout}><I.ArrowRight size={14} /> Cerrar sesión</button>
              </div>
            </>
          )}
          <button className="sb-user" onClick={() => setMenuOpen(v => !v)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={'Cuenta de ' + S.actor() + ' · ' + roleLabel(role)}>
            <span className="sb-user-avatar" aria-hidden="true">{'U' + S.actor().replace(/\D/g, '')}</span>
            {!isCollapsed && <>
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <span className="sb-user-name" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{S.actor()}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{roleLabel(role)}</span>
              </span>
              <I.MoreHorizontal size={14} style={{ color: 'var(--text-muted)' }} />
            </>}
          </button>
        </div>
      </aside>
    </>
  );
}

function NavItem({ item, active, onClick, collapsed, sub, soon }) {
  const Ic = item.icon ? window.Icons[item.icon] : null;
  if (soon) return (
    <div className={`sb-item is-soon ${sub ? 'sb-item-sub' : ''}`} aria-disabled="true" title={item.label + ' · Próximamente'} aria-label={item.label + ', próximamente'}>
      {Ic && <span className="sb-item-icon" aria-hidden="true"><Ic size={16} /></span>}
      {!collapsed && <span className="sb-item-label">{item.label}</span>}
      {!collapsed && <window.SoonTag />}
    </div>
  );
  return (
    <a href={window.MangoRouter.href(item.key)} className={`sb-item ${sub ? 'sb-item-sub' : ''} ${active ? 'active' : ''}`} onClick={(e) => { e.preventDefault(); onClick(); }}
      aria-current={active ? 'page' : undefined} aria-label={collapsed ? item.label + (item.badge ? ` (${item.badge})` : '') : undefined} title={collapsed ? item.label : undefined}>
      {Ic && <span className="sb-item-icon" aria-hidden="true"><Ic size={16} /></span>}
      {!collapsed && <span className="sb-item-label">{item.label}</span>}
      {!collapsed && item.badge ? <span className="sb-item-badge">{item.badge}</span> : null}
      {collapsed && item.badge ? <span className="sb-dot-badge" aria-hidden="true" /> : null}
    </a>
  );
}

function Topbar({ title, actions, crumbs }) {
  const pending = window.useMango(s => s.approvals.filter(a => a.status === 'pending').length);
  const go = (v) => window.dispatchEvent(new CustomEvent('mango:go', { detail: v }));
  const avail = window.useMango(s => s.avail);
  window.useMango(s => s.role);
  return (
    <header className="topbar">
      {crumbs && <nav aria-label="Breadcrumb" className="sr-only">{crumbs.join(' / ')}</nav>}
      <div className="row gap-2" style={{ minWidth: 0, flex: 1 }}>
        <button className="btn btn-ghost btn-icon topbar-menu" aria-label="Abrir menú" onClick={() => window.dispatchEvent(new CustomEvent('mango:open-nav'))}><I.List size={16} /></button>
        <window.Soon on={avail}><button className="topbar-search" onClick={() => window.dispatchEvent(new CustomEvent('mango:cmdk'))} aria-label="Buscar (⌘K)">
          <I.Search size={15} />
          <span>Buscar</span>
          <span className="kbd" style={{ marginLeft: 'auto' }}>⌘K</span>
        </button></window.Soon>
      </div>
      <div className="topbar-actions">
        {actions}
        {actions && <span className="topbar-sep" aria-hidden="true" />}
        {!avail && <button className="topbar-icon" aria-label="Ayuda" title="Ayuda" onClick={() => window.dispatchEvent(new CustomEvent('mango:tour'))}><I.Info size={17} /></button>}
        {!avail && <button className="topbar-icon topbar-bell" aria-label={`Aprobaciones pendientes (${pending})`} title="Aprobaciones" onClick={() => go('approvals')}>
          <I.Inbox size={17} />{pending > 0 && <span className="topbar-dot" aria-hidden="true" />}
        </button>}
        {window.MangoStore.get().role === 'admin' && <button className="topbar-icon" aria-label="Ajustes" title="Ajustes" onClick={() => go('settings')}><I.Settings size={17} /></button>}
        <button className="topbar-create" aria-label="Nueva conversación" title="Nueva conversación" onClick={() => window.dispatchEvent(new CustomEvent('mango:pick-agent'))}><I.Plus size={16} /></button>
      </div>
    </header>
  );
}

Object.assign(window, { Sidebar, Topbar });
