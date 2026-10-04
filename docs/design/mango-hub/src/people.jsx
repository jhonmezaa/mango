// Ajustes › Personas: directorio, grupos por persona, invitar, deshabilitar, restablecer MFA y primer día de la instalación
(function () {
const S = window.MangoStore;
const SENS = ['mango-admin', 'finops-central'];
const SYS_ORDER = ['mango-admin', 'mango-agent-creator', 'finops-central', 'bu-lead'];
const PUBLIC = /@(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|proton|protonmail|aol)\./i;
const PAGE = 20;
const day = (d) => new Date(Date.now() - d * 864e5).toISOString();
const P = (n, status, mfa, groups, d) => ({ email: 'usuario' + n + '@empresa.com', status, mfa, groups, at: day(d) });
const SEED = [
  P(1, 'active', true, ['mango-admin', 'finops-central'], 210), P(2, 'active', true, ['mango-agent-creator', 'finops-central'], 190),
  P(3, 'active', true, ['mango-agent-creator', 'people'], 160), P(4, 'active', true, ['bu-lead', 'bu-finanzas'], 150),
  P(5, 'active', true, ['finops-central'], 120), P(6, 'active', true, ['mango-admin', 'bu-lead', 'bu-plataforma'], 200),
  P(7, 'active', true, [], 0.2), P(8, 'invited', false, ['bu-finanzas'], 1), P(9, 'disabled', true, ['devops'], 300),
];
const ROT = [['bu-lead', 'bu-retail'], ['people'], ['devops'], ['bu-lead', 'bu-plataforma'], ['security'], ['bu-finanzas'], ['people'], ['devops', 'mango-agent-creator']];
for (let n = 10; n <= 64; n++) SEED.push(P(n, n % 17 === 0 ? 'disabled' : n % 13 === 0 ? 'invited' : 'active', n % 13 !== 0, n % 11 === 0 ? [] : ROT[n % ROT.length], 3 + n * 2));
const FRESH = [P(1, 'active', true, ['mango-admin'], 0.1), P(7, 'active', true, [], 0.05)];
S.set({ people: SEED, simInstall: 'running' });

const domains = () => S.get().authCfg.domains || ['empresa.com'];
const list = () => S.get().people || [];
const find = (email) => list().find(p => p.email === email);
const isAdminP = (p) => p.groups.includes('mango-admin') && p.status !== 'disabled';
const adminCount = () => list().filter(isAdminP).length;
const noAccess = (p) => p.status === 'active' && !p.groups.length;
const upd = (email, f) => S.set({ people: list().map(p => p.email === email ? { ...p, ...f(p) } : p) });
const pendingFor = (email) => (S.get().changes || []).filter(c => (c.kind === 'member' || c.kind === 'mfa_reset') && c.target === email && window.chgStatus(c) === 'pending');
const initials = (email) => { const m = email.match(/^usuario(\d+)@/); return m ? 'U' + m[1] : email.slice(0, 2).toUpperCase(); };
const fmtDate = (iso) => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });

let saved = null;
const setInstall = (mode) => {
  const st = S.get();
  if (mode === 'fresh' && st.simInstall !== 'fresh') {
    saved = { people: st.people, groupDefs: st.groupDefs, areas: window.GovData.mapping.areas };
    window.GovData.mapping = { ...window.GovData.mapping, areas: {} };
    S.set({ simInstall: 'fresh', people: FRESH, groupDefs: st.groupDefs.filter(g => g.system) });
  } else if (mode === 'running' && st.simInstall === 'fresh' && saved) {
    window.GovData.mapping = { ...window.GovData.mapping, areas: saved.areas };
    S.set({ simInstall: 'running', people: saved.people, groupDefs: saved.groupDefs });
  }
};

// Reglas: dar o quitar mango-admin y finops-central lo aprueba otro admin; el resto se aplica y queda en Auditoría.
// Excepción de arranque: con un solo administrador, nombrar al segundo se aplica sin segundo aprobador y se marca en Auditoría.
const bootstrap = (g) => g === 'mango-admin' && adminCount() === 1;
const People = {
  addGroup(email, g, reason) {
    if (SENS.includes(g) && !bootstrap(g)) { S.propose({ kind: 'member', key: 'add', target: email, to: g, title: 'Dar ' + g + ' a ' + email, summary: 'Agrega a ' + email + ' al grupo ' + g, reason }); return 'proposed'; }
    const boot = bootstrap(g);
    upd(email, p => ({ groups: [...p.groups, g] }));
    S.log('directory.group_add', email, 'Agregó a ' + email + ' al grupo ' + g + (boot ? ' · único administrador: sin segundo aprobador' : ''), { outcome: 'applied', ...(reason ? { after: { motivo: reason } } : {}) });
    return boot ? 'bootstrap' : 'applied';
  },
  removeGroup(email, g, reason) {
    if (SENS.includes(g)) { S.propose({ kind: 'member', key: 'remove', target: email, to: g, title: 'Quitar ' + g + ' a ' + email, summary: 'Quita a ' + email + ' del grupo ' + g, reason }); return 'proposed'; }
    upd(email, p => ({ groups: p.groups.filter(x => x !== g) }));
    S.log('directory.group_remove', email, 'Quitó a ' + email + ' del grupo ' + g, { outcome: 'applied' });
    return 'applied';
  },
  disable(email, reason) {
    const p = find(email);
    if (isAdminP(p)) { S.propose({ kind: 'member', key: 'disable', target: email, to: null, title: 'Deshabilitar el acceso de ' + email, summary: 'Es administrador: cierra sus sesiones y no puede volver a entrar', reason }); return 'proposed'; }
    upd(email, () => ({ status: 'disabled' }));
    S.log('directory.disable', email, 'Deshabilitó el acceso de ' + email + ' y cerró sus sesiones — "' + reason + '"', { outcome: 'applied' });
    return 'applied';
  },
  enable(email) { upd(email, () => ({ status: 'active' })); S.log('directory.enable', email, 'Rehabilitó el acceso de ' + email, { outcome: 'applied' }); },
  invite(email, groups) {
    const boot = groups.includes('mango-admin') && adminCount() === 1;
    S.set({ people: [{ email, status: 'invited', mfa: false, groups, at: new Date().toISOString() }, ...list()] });
    S.log('directory.invite', email, 'Invitó a ' + email + ' · contraseña temporal enviada por correo' + (groups.length ? ' · grupos: ' + groups.join(', ') : '') + (boot ? ' · único administrador: sin segundo aprobador' : ''), { outcome: 'applied' });
  },
};
S.onDecide.member = (c, d) => {
  if (d !== 'approved') return;
  if (c.key === 'add') { upd(c.target, p => ({ groups: [...new Set([...p.groups, c.to])] })); S.log('directory.group_add', c.target, 'Agregó a ' + c.target + ' al grupo ' + c.to + ' (' + c.id + ', pedido por ' + c.by + ')', { outcome: 'applied' }); }
  if (c.key === 'remove') { upd(c.target, p => ({ groups: p.groups.filter(x => x !== c.to) })); S.log('directory.group_remove', c.target, 'Quitó a ' + c.target + ' del grupo ' + c.to + ' (' + c.id + ', pedido por ' + c.by + ')', { outcome: 'applied' }); }
  if (c.key === 'disable') { upd(c.target, () => ({ status: 'disabled' })); S.log('directory.disable', c.target, 'Deshabilitó el acceso de ' + c.target + ' (' + c.id + ', pedido por ' + c.by + ')', { outcome: 'applied' }); }
};
S.onDecide.mfa_reset = (c, d) => { if (d === 'approved' && find(c.target)) upd(c.target, () => ({ mfa: false })); };

function PersonChip({ email, onRemove, size }) {
  const I = window.Icons;
  return (
    <span className={'person-chip' + (size === 'lg' ? ' is-lg' : '')}>
      <span className="person-av" aria-hidden="true">{initials(email)}</span>
      <span className="person-mail">{email}</span>
      {onRemove && <button type="button" aria-label={'Quitar ' + email} onClick={onRemove}><I.Close size={10} /></button>}
    </span>
  );
}

const STATUS = { active: ['Activa', 'badge'], invited: ['Invitada · contraseña temporal', 'badge-blue'], disabled: ['Deshabilitada', 'badge-red'] };
function StatusBadge({ p }) {
  if (noAccess(p)) return <span className="badge badge-amber" title="Se registró y aún no tiene ningún grupo">Sin acceso</span>;
  const s = STATUS[p.status]; return <span className={'badge ' + s[1]}>{s[0]}</span>;
}

function PeopleAdmin({ goTab, notify }) {
  const I = window.Icons;
  const people = window.useMango(s => s.people);
  window.useMango(s => s.changes); window.useMango(s => s.actorOverride);
  const fresh = window.useMango(s => s.simInstall) === 'fresh';
  const sim = window.useMango(s => s.simPeopleList);
  const [q, setQ] = useState(''); const [filter, setFilter] = useState('all'); const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState(null); const [invite, setInvite] = useState(null);
  useEffect(() => setShown(PAGE), [q, filter]);
  const Q = q.trim().toLowerCase();
  const pend = people.filter(noAccess).length;
  const FILTERS = [['all', 'Todas'], ['pending', 'Sin acceso', pend], ['invited', 'Invitadas'], ['disabled', 'Deshabilitadas']];
  const rows = people.filter(p => (!Q || p.email.startsWith(Q)) && (filter === 'all' || (filter === 'pending' ? noAccess(p) : p.status === filter)))
    .sort((a, b) => (noAccess(b) - noAccess(a)) || (new Date(b.at) - new Date(a.at)));
  const page = rows.slice(0, shown);
  return (
    <section>
      {fresh && <FirstDay goTab={goTab} onInviteAdmin={() => setInvite({ preset: ['mango-admin'] })} onPending={() => setFilter('pending')} />}
      <div className="g-sec-h" style={{ marginBottom: 12 }}>
        <div>
          <div className="g-sec-t">Personas</div>
          <div className="g-sec-meta">Las cuentas del directorio de Mango. Los grupos deciden qué agentes y qué datos ve cada persona. Dar o quitar <span className="mono">mango-admin</span> o <span className="mono">finops-central</span> lo aprueba otro administrador; el resto se aplica al momento y queda en Auditoría. No se borran personas: se deshabilita su acceso y su historial se conserva.</div>
        </div>
        <button className="btn btn-sm btn-primary" onClick={() => setInvite({ preset: [] })}><I.Plus size={12} /> Invitar persona</button>
      </div>
      {pend > 0 && filter !== 'pending' && !sim && <div className="pp-pending" role="status">
        <I.Info size={14} /><div style={{ flex: 1, minWidth: 0 }}><b>{pend === 1 ? '1 persona se registró' : pend + ' personas se registraron'} y aún no {pend === 1 ? 'tiene' : 'tienen'} acceso a nada.</b> Al entrar ven «Todavía no tienes acceso» hasta que les asignes un grupo.</div>
        <button className="btn btn-sm" onClick={() => setFilter('pending')}>Ver pendientes</button>
      </div>}
      <div className="row gap-2" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 320 }}><I.Search size={13} /><input className="input" type="search" placeholder="Buscar por correo (empieza por…)" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar por correo" /></div>
        <div className="tk-quick" role="group" aria-label="Estado">
          {FILTERS.map(([k, l, n]) => <button key={k} className={filter === k ? 'is-on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}{n ? <span className="mk-count">{n}</span> : null}</button>)}
        </div>
      </div>
      {sim === 'error' ? <div className="g-err" role="alert" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>No se pudo cargar el directorio.<button className="btn btn-sm" onClick={() => S.set({ simPeopleList: null })}>Reintentar</button></div>
        : <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="pp-tr mc-th"><span>persona</span><span>estado</span><span>mfa</span><span>grupos</span><span>alta</span><span /></div>
          {sim === 'loading' ? <div role="status" aria-label="Cargando personas">{[0, 1, 2, 3].map(i => <div key={i} className="pp-tr"><span className="skeleton" style={{ height: 14, width: '70%' }} /><span className="skeleton" style={{ height: 14 }} /><span className="skeleton" style={{ height: 14 }} /><span className="skeleton" style={{ height: 14 }} /><span className="skeleton" style={{ height: 14 }} /><span /></div>)}</div>
            : page.map(p => { const pc = pendingFor(p.email).length; return (
              <button key={p.email} type="button" className="pp-tr pp-row" onClick={() => setOpen(p.email)} aria-label={'Gestionar ' + p.email}>
                <span style={{ minWidth: 0 }}><PersonChip email={p.email} />{p.email === S.actorEmail() && <span className="mk-meta" style={{ marginLeft: 6 }}>tú</span>}{pc > 0 && <span className="badge badge-amber" style={{ marginLeft: 6 }}>{pc === 1 ? 'Cambio pendiente' : pc + ' cambios pendientes'}</span>}</span>
                <span><StatusBadge p={p} /></span>
                <span className="mk-meta">{p.mfa ? 'Registrado' : 'Sin registrar'}</span>
                <span className="pp-groups">{p.groups.length ? <>{p.groups.slice(0, 2).map(g => <span key={g} className="pp-g mono">{g}</span>)}{p.groups.length > 2 && <span className="mk-meta">+{p.groups.length - 2}</span>}</> : <span className="mk-meta">Sin grupos</span>}</span>
                <span className="mk-meta">{fmtDate(p.at)}</span>
                <span style={{ display: 'flex', justifyContent: 'flex-end', color: 'var(--text-muted)' }}><I.ChevronRight size={14} /></span>
              </button>
            ); })}
          {!sim && !rows.length && <div className="mk-meta" style={{ padding: 16 }}>{Q ? 'Ningún correo empieza por «' + Q + '».' : filter === 'pending' ? 'Nadie está esperando acceso.' : 'No hay personas en este estado.'}</div>}
        </div>}
      {!sim && rows.length > shown && <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}><button className="btn btn-sm" onClick={() => setShown(shown + PAGE)}>Mostrar más</button></div>}
      <window.ChangeList kind="member" title="Cambios de personas" />
      <window.MfaResetList />
      {open && <PersonPanel email={open} onClose={() => setOpen(null)} notify={notify} />}
      {invite && <InviteModal preset={invite.preset} onClose={() => setInvite(null)} notify={notify} />}
    </section>
  );
}

function FirstDay({ goTab, onInviteAdmin, onPending }) {
  const I = window.Icons;
  window.useMango(s => s.people); const defs = window.useMango(s => s.groupDefs);
  const admins = adminCount();
  const areas = Object.keys(window.GovData?.mapping?.areas || {}).length;
  const own = defs.filter(g => !g.system).length;
  const withAccess = list().filter(p => p.groups.length && !isAdminP(p)).length;
  const pend = list().filter(noAccess).length;
  const two = admins >= 2;
  const steps = [
    { done: two, t: 'Nombra un segundo administrador', d: 'Las acciones con doble aprobación (áreas, grupos, packs de MCP, dar o quitar administradores, restablecer MFA) necesitan que otro admin apruebe. Mientras seas el único, nombrarlo se aplica sin segundo aprobador y queda marcado en Auditoría.', st: two ? admins + ' administradores' : 'Solo tú', act: !two && <button className="btn btn-sm btn-primary" onClick={onInviteAdmin}>Invitar administrador</button>, alt: !two && 'Si ya se registró, ábrela en la lista y agrégala a mango-admin.' },
    { done: areas > 0, t: 'Define las áreas y sus OUs', d: 'Cada área agrupa OUs de tu organización de AWS. Los líderes de área solo ven el gasto de las suyas.', st: areas ? areas + (areas === 1 ? ' área' : ' áreas') : 'Sin áreas', act: <button className="btn btn-sm" onClick={() => goTab('areas')}>Ir a Áreas y OUs</button>, needs: !two },
    { done: own > 0, t: 'Crea grupos de acceso', d: 'Hoy solo existen los cuatro de sistema: mango-admin, mango-agent-creator, finops-central y bu-lead. Los grupos de área (bu-<área>) necesitan su área.', st: own ? own + (own === 1 ? ' grupo propio' : ' grupos propios') : 'Solo los de sistema', act: <button className="btn btn-sm" onClick={() => goTab('groups')}>Ir a Grupos</button>, needs: !two },
    { done: withAccess > 0, t: 'Da acceso a las personas', d: 'Quien se registra entra sin grupo y ve «Todavía no tienes acceso». Asígnale un grupo o invítala con uno.', st: withAccess ? withAccess + (withAccess === 1 ? ' persona con acceso' : ' personas con acceso') : pend ? pend + ' esperando acceso' : 'Nadie más tiene acceso', act: pend > 0 && <button className="btn btn-sm" onClick={onPending}>Ver pendientes</button> },
  ];
  const left = steps.filter(s => !s.done).length;
  return (
    <div className="card pp-first">
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div><div className="g-sec-t">Primeros pasos de esta instalación</div><div className="g-sec-meta">{left ? (left === 1 ? 'Falta 1 paso' : 'Faltan ' + left + ' pasos') + ' para que tu equipo empiece a usar Mango.' : 'Listo: tu equipo ya puede usar Mango.'}</div></div>
      </div>
      <ol className="pp-steps">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? 'is-done' : ''}>
            <span className="pp-step-n" aria-hidden="true">{s.done ? <I.Check size={12} /> : i + 1}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><span className="pp-step-t">{s.t}</span><span className={'badge ' + (s.done ? 'badge-green' : '')}>{s.done ? 'Hecho · ' : ''}{s.st}</span>{s.needs && !s.done && <span className="badge badge-amber">Necesita un segundo administrador</span>}</div>
              {!s.done && <div className="mk-meta" style={{ marginTop: 3, lineHeight: 1.5 }}>{s.d}</div>}
              {!s.done && s.alt && <div className="mk-meta" style={{ marginTop: 3 }}>{s.alt}</div>}
            </div>
            {!s.done && s.act && <div style={{ flexShrink: 0 }}>{s.act}</div>}
          </li>
        ))}
      </ol>
      <div className="pp-first-foot">Ya viene con la instalación: el agente FinOps publicado; presupuestos por defecto de USD 5 por usuario y USD 30 por agente al mes (<button className="sr-link" onClick={() => window.MangoNav?.('budgets')}>Presupuestos</button>); MFA obligatorio y registro solo con {domains().join(', ')}.</div>
    </div>
  );
}

function PersonPanel({ email, onClose, notify }) {
  const I = window.Icons; const K = window.GovKit; const L = window.Lifecycle;
  window.useMango(s => s.people); window.useMango(s => s.changes); window.useMango(s => s.actorOverride);
  const defs = window.useMango(s => s.groupDefs);
  const p = find(email);
  const me = S.actorEmail(); const self = email === me;
  const pend = pendingFor(email);
  const [add, setAdd] = useState(''); const [reason, setReason] = useState(''); const [tried, setTried] = useState(false);
  const [rm, setRm] = useState(null); const [rmWhy, setRmWhy] = useState('');
  const [mfaOpen, setMfaOpen] = useState(false); const [mfaWhy, setMfaWhy] = useState(''); const [verified, setVerified] = useState(false); const [mfaTried, setMfaTried] = useState(false);
  const [dis, setDis] = useState(false); const [disWhy, setDisWhy] = useState('');
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  if (!p) return null;
  const disabled = p.status === 'disabled';
  const pendingG = (g, key) => pend.find(c => c.kind === 'member' && c.key === key && c.to === g);
  const order = (g) => { const i = SYS_ORDER.indexOf(g.id); return i < 0 ? 99 : i; };
  const avail = defs.filter(g => !p.groups.includes(g.id) && !pendingG(g.id, 'add')).sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
  const sens = SENS.includes(add); const boot = bootstrap(add);
  const lastAdmins = (g) => g === 'mango-admin' && adminCount() <= 2;
  const run = (fn) => { setErr(null); setBusy(true); setTimeout(() => { setBusy(false); if (S.get().simPeopleAct === 'error') { setErr('No se pudo completar la acción. Inténtalo de nuevo.'); return; } fn(); }, 500); };
  const doAdd = () => { setTried(true); if (!add || (sens && !boot && !reason.trim())) return; run(() => { const r = People.addGroup(email, add, reason.trim()); notify?.(r === 'proposed' ? 'Propuesta enviada · la debe aprobar otro admin' : 'Grupo agregado'); setAdd(''); setReason(''); setTried(false); }); };
  const doRm = (g) => { if (SENS.includes(g) && !rmWhy.trim()) return; run(() => { const r = People.removeGroup(email, g, rmWhy.trim()); notify?.(r === 'proposed' ? 'Propuesta enviada · la debe aprobar otro admin' : 'Grupo quitado'); setRm(null); setRmWhy(''); }); };
  const mfaPending = pend.find(c => c.kind === 'mfa_reset');
  const mfaErr = !mfaWhy.trim() ? 'Escribe el motivo' : !verified ? 'Confirma que verificaste la identidad por otro canal' : null;
  const doMfa = () => { setMfaTried(true); if (mfaErr) return; run(() => { S.propose({ kind: 'mfa_reset', key: 'mfa_reset', target: email, from: null, to: null, title: 'Restablecer MFA de ' + email, summary: 'Borra su MFA y cierra todas sus sesiones · identidad verificada por otro canal', reason: mfaWhy.trim(), verified: true }); notify?.('Solicitud enviada · la debe aprobar otro admin'); setMfaOpen(false); setMfaWhy(''); setVerified(false); setMfaTried(false); }); };
  const disPending = pend.find(c => c.kind === 'member' && c.key === 'disable');
  const doDis = () => { if (!disWhy.trim()) return; run(() => { const r = People.disable(email, disWhy.trim()); notify?.(r === 'proposed' ? 'Propuesta enviada · la debe aprobar otro admin' : 'Acceso deshabilitado'); setDis(false); setDisWhy(''); }); };
  const TONE = { central: 'badge-violet', area: 'badge-amber', general: 'badge' };
  const gType = (id) => { const d = L.groupDef(id); return d ? <span className={'badge ' + TONE[d.type]}>{d.system ? 'Sistema · ' : ''}{L.GROUP_TYPES[d.type][0]}</span> : null; };
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ zIndex: 130 }}>
      <aside className="pp-drawer" role="dialog" aria-modal="true" aria-label={'Persona ' + email} onClick={e => e.stopPropagation()}>
        <div className="pp-drawer-h">
          <button className="btn btn-sm btn-ghost pp-back" onClick={onClose}><I.ChevronLeft size={12} /> Volver</button>
          <div style={{ minWidth: 0, flex: 1 }}><PersonChip email={email} size="lg" /><div className="row gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}><StatusBadge p={p} /><span className="mk-meta">MFA {p.mfa ? 'registrado' : 'sin registrar'}</span><span className="mk-meta">Alta {fmtDate(p.at)}</span>{self && <span className="badge">Tu cuenta</span>}</div></div>
          <button className="btn btn-ghost btn-icon pp-x" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="pp-drawer-b">
          {err && <div className="g-err" role="alert">{err}</div>}
          {p.status === 'invited' && <K.Reason>Recibió una contraseña temporal por correo. Al entrar crea la suya y configura MFA.</K.Reason>}
          <section>
            <div className="pp-sec-t">Grupos</div>
            {disabled ? <K.Reason>Acceso deshabilitado: rehabilítalo para cambiar sus grupos.</K.Reason> : <>
              {!p.groups.length && <div className="mk-meta" style={{ marginBottom: 8 }}>Sin grupos: entra y ve «Todavía no tienes acceso».</div>}
              <div className="pp-glist">
                {p.groups.map(g => { const pr = pendingG(g, 'remove'); const blockSelf = self && SENS.includes(g); const blockLast = lastAdmins(g); return (
                  <div key={g} className="pp-gi">
                    <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{g}</span>{gType(g)}{pr && <span className="badge badge-amber">Quitar · pendiente de aprobación</span>}
                      <div style={{ flex: 1 }} />
                      {!pr && rm !== g && <button className="btn btn-sm btn-ghost" disabled={busy || blockSelf || blockLast} title={blockSelf ? 'No puedes quitarte este grupo: pídeselo a otro administrador' : blockLast ? 'Nombra otro administrador antes de quitar este' : undefined} onClick={() => SENS.includes(g) ? (setRm(g), setRmWhy('')) : doRm(g)}>Quitar</button>}
                    </div>
                    {(blockLast && !blockSelf) && <div className="mk-meta" style={{ marginTop: 4 }}>Quedaría un solo administrador y nadie podría aprobar las acciones con doble aprobación.</div>}
                    {rm === g && <div className="g-field" style={{ marginTop: 8 }}>
                      <textarea className="input" rows={2} value={rmWhy} onChange={e => setRmWhy(e.target.value)} placeholder="Motivo (obligatorio) · lo verá el admin que lo apruebe" aria-label="Motivo para quitar el grupo" autoFocus />
                      <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 6 }}><button className="btn btn-sm" onClick={() => setRm(null)}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={!rmWhy.trim() || busy} onClick={() => doRm(g)}>Enviar a aprobación</button></div>
                    </div>}
                  </div>
                ); })}
                {pend.filter(c => c.kind === 'member' && c.key === 'add').map(c => <div key={c.id} className="pp-gi" style={{ opacity: .8 }}><div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}><span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{c.to}</span>{gType(c.to)}<span className="badge badge-amber">Agregar · pendiente de aprobación</span></div></div>)}
              </div>
              <div className="pp-add">
                <label htmlFor="pp-add" className="pp-lbl">Agregar a un grupo</label>
                <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
                  <select id="pp-add" className="input" style={{ flex: '1 1 200px', minWidth: 0 }} value={add} onChange={e => { setAdd(e.target.value); setTried(false); }}>
                    <option value="">Elige un grupo</option>
                    <optgroup label="De sistema">{avail.filter(g => g.system).map(g => <option key={g.id} value={g.id}>{g.id}{SENS.includes(g.id) ? ' · con aprobación' : ''}</option>)}</optgroup>
                    {avail.some(g => !g.system) && <optgroup label="De acceso">{avail.filter(g => !g.system).map(g => <option key={g.id} value={g.id}>{g.id}{g.area ? ' · área ' + g.area : ''}</option>)}</optgroup>}
                  </select>
                  <button className="btn btn-sm btn-primary" disabled={!add || busy} onClick={doAdd}>{sens && !boot ? 'Enviar a aprobación' : 'Agregar'}</button>
                </div>
                {add && <div className="mk-meta" style={{ marginTop: 6 }}>{L.groupDef(add)?.desc}{add === 'finops-central' ? ' · ve los costos de toda la organización.' : add === 'mango-admin' ? ' · administra Mango y aprueba cambios de otros.' : ''}</div>}
                {sens && !boot && <div className="g-field" style={{ marginTop: 8 }}>
                  <textarea className="input" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo (obligatorio) · lo verá el admin que lo apruebe" aria-label="Motivo" style={tried && !reason.trim() ? { borderColor: 'var(--red)' } : null} />
                  {tried && !reason.trim() ? <div className="g-err" role="alert">Escribe el motivo</div> : <div className="g-hint">No se aplica hasta que otro administrador lo apruebe. Si nadie lo decide en 72 h, vence.</div>}
                </div>}
                {boot && <K.Reason tone="warn">Eres el único administrador: este cambio se aplica sin segundo aprobador y queda marcado en Auditoría. Desde entonces, dar o quitar administradores lo aprueba el otro.</K.Reason>}
              </div>
            </>}
          </section>
          <section>
            <div className="pp-sec-t">Restablecer MFA</div>
            {self ? <K.Reason>Es tu cuenta: otro administrador debe restablecer tu MFA.</K.Reason>
              : !p.mfa ? <div className="mk-meta">Todavía no registró MFA: lo configura en su próximo ingreso.</div>
              : mfaPending ? <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}><span className="badge badge-amber">Pendiente de aprobación</span><span className="mk-meta mono">{mfaPending.id}</span><span className="mk-meta">Se decide en la lista de restablecimientos.</span></div>
              : !mfaOpen ? <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}><span className="mk-meta" style={{ flex: 1, minWidth: 200 }}>Borra su MFA y cierra todas sus sesiones; lo configura de nuevo al entrar. Lo aprueba otro administrador.</span><button className="btn btn-sm" disabled={disabled} onClick={() => setMfaOpen(true)}>Restablecer MFA…</button></div>
              : <div style={{ display: 'grid', gap: 8 }}>
                <textarea className="input" rows={2} value={mfaWhy} onChange={e => setMfaWhy(e.target.value)} placeholder="Motivo (obligatorio)" aria-label="Motivo del restablecimiento" autoFocus />
                <label className="row gap-2" style={{ fontSize: 13, cursor: 'pointer', alignItems: 'flex-start' }}><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} style={{ accentColor: 'var(--accent-ink)', marginTop: 2 }} /><span>Verifiqué su identidad por otro canal <span style={{ color: 'var(--text-muted)' }}>· llamada, videollamada o en persona; no por el mismo correo</span></span></label>
                {mfaTried && mfaErr && <div className="g-err" role="alert">{mfaErr}</div>}
                <div className="row gap-2" style={{ justifyContent: 'flex-end' }}><button className="btn btn-sm" onClick={() => setMfaOpen(false)}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={busy} onClick={doMfa}>Proponer restablecimiento</button></div>
              </div>}
          </section>
          <section>
            <div className="pp-sec-t">Acceso</div>
            {disabled ? <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}><span className="mk-meta" style={{ flex: 1, minWidth: 200 }}>No puede entrar. Conserva sus grupos y su historial en Auditoría.</span><button className="btn btn-sm" disabled={busy} onClick={() => run(() => { People.enable(email); notify?.('Acceso rehabilitado'); })}>Rehabilitar acceso</button></div>
              : self ? <K.Reason>No puedes deshabilitar tu propia cuenta.</K.Reason>
              : disPending ? <div className="row gap-2" style={{ alignItems: 'center' }}><span className="badge badge-amber">Deshabilitación pendiente de aprobación</span><span className="mk-meta mono">{disPending.id}</span></div>
              : !dis ? <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}><span className="mk-meta" style={{ flex: 1, minWidth: 200 }}>Cierra sus sesiones y no puede volver a entrar. No se borra: su historial queda en Auditoría.{isAdminP(p) ? ' Es administrador: lo aprueba otro.' : ''}</span><button className="btn btn-sm mk-danger" disabled={isAdminP(p) && adminCount() <= 2} title={isAdminP(p) && adminCount() <= 2 ? 'Nombra otro administrador antes' : undefined} onClick={() => setDis(true)}>Deshabilitar acceso…</button></div>
              : <div style={{ display: 'grid', gap: 8 }}>
                <textarea className="input" rows={2} value={disWhy} onChange={e => setDisWhy(e.target.value)} placeholder="Motivo (obligatorio) · queda en Auditoría" aria-label="Motivo para deshabilitar" autoFocus />
                <div className="row gap-2" style={{ justifyContent: 'flex-end' }}><button className="btn btn-sm" onClick={() => setDis(false)}>Cancelar</button><button className="btn btn-sm mk-danger" disabled={!disWhy.trim() || busy} onClick={doDis}>{isAdminP(p) ? 'Enviar a aprobación' : 'Deshabilitar acceso'}</button></div>
              </div>}
          </section>
          <div className="pp-limits"><I.Lock size={12} /> Desde Mango no se cambia el correo ni la contraseña de otra persona, ni se ven sus conversaciones.</div>
        </div>
      </aside>
    </div>
  );
}

function InviteModal({ preset, onClose, notify }) {
  const K = window.GovKit; const I = window.Icons;
  const defs = window.useMango(s => s.groupDefs);
  const [email, setEmail] = useState(''); const [groups, setGroups] = useState(preset || []); const [tried, setTried] = useState(false);
  const [fail, setFail] = useState(false); const [busy, setBusy] = useState(false);
  const e = email.trim().toLowerCase(); const doms = domains();
  const boot = adminCount() === 1;
  const err = !e ? 'Escribe el correo' : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? 'Escribe un correo válido' : PUBLIC.test(e) ? 'Los correos públicos no se aceptan. Usa el correo de la empresa.' : !doms.includes(e.split('@')[1]) ? 'Solo se puede invitar a correos de ' + doms.join(' o ') + '.' : find(e) ? 'Ese correo ya está en el directorio. Ábrelo en la lista para cambiar sus grupos.' : null;
  const pickable = defs.filter(g => !SENS.includes(g.id) || (g.id === 'mango-admin' && boot));
  const toggle = (g) => setGroups(groups.includes(g) ? groups.filter(x => x !== g) : [...groups, g]);
  const submit = () => { setTried(true); setFail(false); if (err) return; setBusy(true); setTimeout(() => { setBusy(false); if (S.get().simPeopleAct === 'error') { setFail(true); return; } People.invite(e, groups); notify?.('Invitación enviada · recibirá una contraseña temporal por correo'); onClose(); }, 500); };
  return (
    <K.Modal title={preset?.includes('mango-admin') ? 'Invitar al segundo administrador' : 'Invitar persona'} sub="Recibe una contraseña temporal por correo; al entrar crea la suya y configura MFA. Queda en Auditoría." onClose={onClose} autoFocus={false}
      footer={<><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={busy} onClick={submit}>{busy ? 'Enviando…' : 'Enviar invitación'}</button></>}>
      <div className="g-field">
        <label htmlFor="pp-inv">Correo</label>
        <input id="pp-inv" className={'input' + (tried && err ? ' has-error' : '')} type="email" autoComplete="off" autoFocus value={email} onChange={ev => { setEmail(ev.target.value); setFail(false); }} placeholder={'nombre@' + doms[0]} />
        {tried && err ? <div className="g-err" role="alert">{err}</div> : <div className="g-hint">Dominios permitidos: {doms.join(', ')}.</div>}
      </div>
      <div className="g-field">
        <label>Grupos <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· opcional</span></label>
        <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{pickable.map(g => { const on = groups.includes(g.id); return <button key={g.id} type="button" className={'tweak-chip ab-chip' + (on ? ' is-on' : '')} aria-pressed={on} title={g.desc} onClick={() => toggle(g.id)}>{on && <I.Check size={10} />}<span className="mono">{g.id}</span></button>; })}</div>
        <div className="g-hint">{groups.length ? '' : 'Sin grupos entra y ve «Todavía no tienes acceso». '}{boot && groups.includes('mango-admin') ? 'Eres el único administrador: mango-admin se aplica sin segundo aprobador y queda marcado en Auditoría.' : 'mango-admin y finops-central se piden después, sobre la persona, con aprobación de otro administrador.'}</div>
      </div>
      {fail && <div className="g-err" role="alert">No se pudo enviar la invitación. Inténtalo de nuevo.</div>}
    </K.Modal>
  );
}

Object.assign(window, { PeopleAdmin, PersonChip, MangoPeople: { setInstall, adminCount } });
})();
