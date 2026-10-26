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
const PIN_CAP = 4; // agentes fijados visibles en el riel; el resto va en «Más agentes fijados»
const NAV_ICONS = { review: 'Eye', approvals: 'Check2', governance: 'Shield', budgets: 'Money', audit: 'Lock', activity: 'Activity', playground: 'Play', models: 'Bot', skills: 'Skill', mcp: 'Cloud', knowledge: 'BookOpen', schedules: 'Clock', observability: 'Activity', evals: 'Check', costs: 'Zap', org: 'Org' };

function Sidebar({ view, setView, agents, user, collapsed, setCollapsed, pinnedIds, setPinnedIds, openChat, mobile, mobileOpen, setMobileOpen, onTour }) {
  const t = window.t;
  const S = window.MangoStore;
  const role = window.useMango(s => s.role);
  const lang = window.useMango(s => s.lang);
  const pendingApprovals = window.useMango(s => s.approvals.filter(a => a.status === 'pending').length + (s.kbReqs || []).filter(r => r.status === 'pending').length);
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
  const [fly, setFly] = useState(null); // { id, el, kb }
  // Títulos al pasar el cursor (o con foco) por el riel colapsado: una etiqueta flotante, fuera del scroll del riel.
  const asideRef = React.useRef(null);
  const [tip, setTip] = useState(null);
  React.useEffect(() => {
    const el = asideRef.current; if (!el || !isCollapsed) { setTip(null); return; }
    const on = (e) => { const n = e.target.closest?.('[data-tip]'); if (!n || !el.contains(n)) { setTip(null); return; } const r = n.getBoundingClientRect(); setTip({ text: n.getAttribute('data-tip'), top: r.top + r.height / 2 }); };
    const off = (e) => { if (!e.relatedTarget || !e.relatedTarget.closest?.('[data-tip]')) setTip(null); };
    el.addEventListener('mouseover', on); el.addEventListener('focusin', on); el.addEventListener('mouseleave', off); el.addEventListener('focusout', off);
    const nav = el.querySelector('.sb-nav'); const hide = () => setTip(null); nav?.addEventListener('scroll', hide);
    return () => { el.removeEventListener('mouseover', on); el.removeEventListener('focusin', on); el.removeEventListener('mouseleave', off); el.removeEventListener('focusout', off); nav?.removeEventListener('scroll', hide); };
  }, [isCollapsed]);
  const badgeOf = (k) => k === 'approvals' ? pendingApprovals || null : k === 'review' ? pendingReviews || null : k === 'inbox' ? inboxUnread || null : null;
  const logout = () => { setMenuOpen(false); S.log('account.logout', user.email, 'Cerró sesión'); window.dispatchEvent(new CustomEvent('mango:logout')); };

  return (
    <>
      {mobile && mobileOpen && <div className="sb-scrim" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
      <aside ref={asideRef} className={`sidebar ${isCollapsed ? 'sidebar-collapsed' : ''} ${mobile ? 'sidebar-mobile' : ''} ${mobile && mobileOpen ? 'open' : ''}`} aria-label="Navegación principal">
        <div className="sb-top">
          <button className="sb-workspace" onClick={() => mobile ? setMobileOpen(false) : setCollapsed(!collapsed)} aria-label={mobile ? 'Cerrar menú' : collapsed ? 'Expandir sidebar' : 'Colapsar sidebar'} aria-expanded={!isCollapsed} data-tip={isCollapsed ? 'Expandir' : undefined}>
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
              {(isCollapsed && pinned.length > PIN_CAP ? pinned.slice(0, PIN_CAP - 1) : pinned).map(a => {
                const Ic = I[a.icon];
                return (
                  <div key={a.id} className="sb-item sb-item-agent" style={{ padding: 0 }}>
                    <button className="sb-item-main" data-tip={isCollapsed ? a.name : undefined} aria-label={'Chat con ' + a.name} onClick={() => { openChat(a.id, null); mobile && setMobileOpen(false); }}>
                      <span className="sb-item-icon"><Ic size={16} /></span>
                      {!isCollapsed && <span className="sb-item-label">{a.name}</span>}
                    </button>
                    {!isCollapsed && <button className="sb-pin-btn" title="Quitar de fijados" aria-label={'Quitar ' + a.name + ' de fijados'} onClick={() => setPinnedIds(pinnedIds.filter(x => x !== a.id))}><I.Close size={11} /></button>}
                  </div>
                );
              })}
              {isCollapsed && pinned.length > PIN_CAP && <RailGroup id="pins" title={lang === 'en' ? 'Pinned agents' : 'Agentes fijados'} icon="MoreHorizontal" label={'Más agentes fijados (' + (pinned.length - PIN_CAP + 1) + ')'} fly={fly} setFly={setFly}
                items={pinned.slice(PIN_CAP - 1).map(a => ({ key: a.id, icon: a.icon, label: a.name, onClick: () => openChat(a.id, null) }))} />}
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
              const gLabel = lang === 'en' ? ({ gov: 'Governance', build: 'Build', ops: 'Operations' })[g.id] : g.label;
              if (isCollapsed) return <RailGroup key={g.id} id={g.id} title={gLabel} icon={g.icon} fly={fly} setFly={setFly} containsActive={containsActive}
                items={items.map(k => ({ key: k, icon: NAV_ICONS[k], label: label(k), badge: soon(k) ? null : badgeOf(k), soon: soon(k), active: view === k, href: window.MangoRouter.href(k), onClick: () => go(k) }))} />;
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
          <button className="sb-user" onClick={() => setMenuOpen(v => !v)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={'Cuenta de ' + S.actor() + ' · ' + roleLabel(role)} data-tip={isCollapsed && !menuOpen ? S.actor() : undefined}>
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
      {isCollapsed && tip && !fly && <div className="sb-tip" role="tooltip" style={{ top: tip.top }}>{tip.text}</div>}
    </>
  );
}

// Riel colapsado: un ícono por grupo; su menú flotante se abre al pasar el cursor o con clic/teclado.
function RailGroup({ id, title, icon, label, items, fly, setFly, containsActive }) {
  const Ic = window.Icons; const GIc = Ic[icon] || Ic.MoreHorizontal;
  const btn = React.useRef(null); const menu = React.useRef(null); const tmr = React.useRef(null);
  const open = fly?.id === id;
  const count = items.reduce((s, x) => s + (x.badge || 0), 0);
  const [pos, setPos] = useState({ top: 0 });
  const show = (kb, pin) => { clearTimeout(tmr.current); const r = btn.current.getBoundingClientRect(); setPos({ top: r.top }); setFly({ id, kb, pin: !!(kb || pin) }); };
  const hide = (focus) => { clearTimeout(tmr.current); setFly(f => f?.id === id ? null : f); if (focus) btn.current?.focus(); };
  const later = () => { clearTimeout(tmr.current); tmr.current = setTimeout(() => setFly(f => f?.id === id && !f.pin ? null : f), 220); };
  React.useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const h = menu.current.offsetHeight; const top = Math.max(8, Math.min(pos.top - 6, window.innerHeight - h - 8));
    menu.current.style.top = top + 'px';
    if (fly.kb) menu.current.querySelector('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open, pos.top]);
  React.useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) hide(false); };
    document.addEventListener('mousedown', away); return () => document.removeEventListener('mousedown', away);
  }, [open]);
  React.useEffect(() => () => clearTimeout(tmr.current), []);
  const onMenuKey = (e) => {
    const els = [...menu.current.querySelectorAll('[role="menuitem"]')]; const i = els.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); hide(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); els[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus(); }
    else if (e.key === 'Tab') hide(false);
  };
  const aria = (label || title) + (containsActive ? ', contiene la vista actual' : '') + (count ? ', ' + count + ' pendientes' : '');
  return (
    <div onMouseEnter={() => { clearTimeout(tmr.current); if (!open) tmr.current = setTimeout(() => show(false), 120); }} onMouseLeave={later}>
      <button ref={btn} type="button" className={'sb-item sb-rail-group' + (containsActive ? ' is-current' : '') + (open ? ' is-open' : '')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'sb-fly-' + id : undefined} aria-label={aria} data-tip={label && label !== title ? label : undefined}
        onClick={() => !open ? show(false, true) : !fly.pin ? setFly({ ...fly, pin: true }) : hide(false)}
        onKeyDown={e => { if (['Enter', ' ', 'ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); show(true); } else if (e.key === 'Escape' && open) hide(true); }}>
        <span className="sb-item-icon" aria-hidden="true"><GIc size={16} /></span>
        {count > 0 && <span className="sb-dot-badge" aria-hidden="true" />}
      </button>
      {open && (
        <div ref={menu} id={'sb-fly-' + id} role="menu" aria-label={title} className="sb-fly" style={{ top: pos.top }} onKeyDown={onMenuKey} onMouseEnter={() => clearTimeout(tmr.current)}>
          <div className="sb-fly-t" aria-hidden="true">{title}</div>
          {items.map(x => { const XI = x.icon ? Ic[x.icon] : null; const inner = <>{XI && <span className="sb-fly-ic" aria-hidden="true"><XI size={15} /></span>}<span className="sb-fly-l">{x.label}</span>{x.soon ? <window.SoonTag /> : x.badge ? <span className="sb-fly-n">{x.badge}</span> : x.active ? <Ic.Check size={12} aria-hidden="true" /> : null}</>;
            return x.soon
              ? <div key={x.key} role="menuitem" tabIndex={-1} aria-disabled="true" className="sb-fly-i is-soon" aria-label={x.label + ', próximamente'}>{inner}</div>
              : <a key={x.key} role="menuitem" tabIndex={-1} href={x.href || '#'} className={'sb-fly-i' + (x.active ? ' active' : '')} aria-current={x.active ? 'page' : undefined} aria-label={x.label + (x.badge ? ' (' + x.badge + ')' : '') + (x.active ? ', vista actual' : '')}
                  onClick={e => { e.preventDefault(); hide(false); x.onClick(); }}>{inner}</a>;
          })}
        </div>
      )}
    </div>
  );
}

function NavItem({ item, active, onClick, collapsed, sub, soon }) {
  const Ic = item.icon ? window.Icons[item.icon] : null;
  if (soon) return (
    <div className={`sb-item is-soon ${sub ? 'sb-item-sub' : ''}`} aria-disabled="true" title={collapsed ? undefined : item.label + ' · Próximamente'} data-tip={collapsed ? item.label + ' · Próximamente' : undefined} aria-label={item.label + ', próximamente'}>
      {Ic && <span className="sb-item-icon" aria-hidden="true"><Ic size={16} /></span>}
      {!collapsed && <span className="sb-item-label">{item.label}</span>}
      {!collapsed && <window.SoonTag />}
    </div>
  );
  return (
    <a href={window.MangoRouter.href(item.key)} className={`sb-item ${sub ? 'sb-item-sub' : ''} ${active ? 'active' : ''}`} onClick={(e) => { e.preventDefault(); onClick(); }}
      aria-current={active ? 'page' : undefined} aria-label={collapsed ? item.label + (item.badge ? ` (${item.badge})` : '') : undefined} data-tip={collapsed ? item.label + (item.badge ? ' · ' + item.badge : '') : undefined}>
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
