// Compartir agente con usuarios o grupos concretos. Todo cambio queda pendiente de aprobación por otro admin.
const SHARE_PEOPLE = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ name: 'Usuario ' + i, email: 'usuario' + i + '@empresa.com', area: ['Plataforma', 'DevOps', 'Datos', 'Finanzas', 'Finanzas', 'Seguridad', 'Personas', 'Retail'][i - 1] }));
const shareInitials = (n) => 'U' + (n.match(/\d+/) || [''])[0];
const personOf = (email) => SHARE_PEOPLE.find(p => p.email === email) || { name: email.split('@')[0], email, area: '' };

function sharesOf(agent) {
  if (agent.shares) return { everyone: null, ...agent.shares };
  return { everyone: agent.id === 'hr-01' ? 'use' : null, groups: (agent.groups || ['mango-admin']).map(g => ({ id: g, role: 'use' })), users: [] };
}
const norm = (sh) => ({ everyone: sh.everyone ? 'use' : null, groups: sh.groups.map(g => ({ id: g.id, role: 'use' })), users: sh.users.map(u => ({ email: u.email, role: 'use' })) });

function shareDiff(a, b) {
  const parts = [];
  if (!a.everyone && b.everyone) parts.push('Abre a toda la organización');
  if (a.everyone && !b.everyone) parts.push('Deja de estar abierto a toda la organización');
  const ag = a.groups.map(g => g.id), bg = b.groups.map(g => g.id), au = a.users.map(u => u.email), bu = b.users.map(u => u.email);
  bg.filter(x => !ag.includes(x)).forEach(x => parts.push('Agrega el grupo ' + x));
  ag.filter(x => !bg.includes(x)).forEach(x => parts.push('Quita el grupo ' + x));
  bu.filter(x => !au.includes(x)).forEach(x => parts.push('Agrega a ' + x));
  au.filter(x => !bu.includes(x)).forEach(x => parts.push('Quita a ' + x));
  return parts;
}

function ShareAgent({ agent, canShare, onClose }) {
  const I = window.Icons; const S = window.MangoStore;
  const toast = window.useToast?.();
  const groupsAll = window.MangoData?.groups || [];
  const changes = window.useMango(s => s.changes);
  window.useMango(s => s.actorOverride);
  const pending = changes.find(c => c.kind === 'share' && c.target === agent.id && c.status === 'pending');
  const base = norm(sharesOf(agent));
  const [sh, setSh] = useState(() => JSON.parse(JSON.stringify(base)));
  const [reason, setReason] = useState('');
  const isAdmin = S.get().role === 'admin';
  const acctTools = (agent.mcp || []).some(m => window.Lifecycle?.serverOf(m)?.level === 'accounts');
  const orgBlock = !isAdmin ? 'Solo un admin puede compartirlo con toda la organización.' : acctTools ? 'Usa tools de «Datos de cuentas»: no puede compartirse con toda la organización.' : null;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef(null);
  const diff = shareDiff(base, sh);
  const editable = canShare && !pending;
  useEffect(() => { const h = e => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);

  const Q = q.trim().toLowerCase();
  const hasG = (id) => sh.groups.some(g => g.id === id);
  const hasU = (e) => sh.users.some(u => u.email === e);
  const gOpts = groupsAll.filter(g => !hasG(g) && (!Q || g.includes(Q))).map(g => ({ kind: 'group', id: g }));
  const uOpts = SHARE_PEOPLE.filter(p => !hasU(p.email) && (!Q || (p.name + ' ' + p.email + ' ' + p.area).toLowerCase().includes(Q))).map(p => ({ kind: 'user', id: p.email, p }));
  const opts = [...gOpts, ...uOpts].slice(0, Q ? 8 : 5);
  const notInDir = Q.includes('@') && !opts.length;

  const add = (o) => {
    setErr('');
    if (o.kind === 'group') setSh(s => ({ ...s, groups: [...s.groups, { id: o.id, role: 'use' }] }));
    else setSh(s => ({ ...s, users: [...s.users, { email: o.id, role: 'use' }] }));
    setQ(''); setOpen(false); inputRef.current?.focus();
  };
  const remove = (kind, id) => setSh(s => kind === 'group' ? { ...s, groups: s.groups.filter(g => g.id !== id) } : { ...s, users: s.users.filter(u => u.email !== id) });
  const submit = () => {
    if (!sh.everyone && !sh.groups.length && !sh.users.length) { setErr('Elige al menos un grupo o usuario.'); return; }
    if (!reason.trim()) { setErr('Escribe el motivo del cambio.'); return; }
    S.propose({ kind: 'share', target: agent.id, key: 'shares', from: base, to: sh, summary: diff.join(' · '), reason: reason.trim() });
    toast?.({ tone: 'success', msg: 'Cambio enviado · lo debe aprobar otro admin' });
    onClose();
  };
  const total = sh.groups.length + sh.users.length;

  const Row = ({ kind, id, icon, title, sub }) => (
    <div className="sh-row">
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}><div className="sh-t">{title}</div><div className="sh-s">{sub}</div></div>
      <span className="sh-s">Puede usar</span>
      {editable && <button className="btn btn-ghost btn-icon" aria-label={'Quitar acceso a ' + title} title="Quitar acceso" onClick={() => remove(kind, id)}><I.Close size={13} /></button>}
    </div>
  );

  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ justifyContent: 'center', alignItems: 'center', zIndex: 130 }}>
      <div className="card sh-modal" role="dialog" aria-modal="true" aria-label={'Compartir ' + agent.name} onClick={e => e.stopPropagation()}>
        <div className="row between" style={{ padding: '18px 20px 0', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>Compartir “{agent.name}”</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>Solo quien tenga acceso lo ve y puede abrir un chat. Los cambios se aplican cuando otro admin los aprueba.</div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>

        {pending && <div style={{ padding: '14px 20px 0' }}><window.ChangeList kind="share" target={agent.id} /></div>}

        <div style={{ padding: '16px 20px 6px' }}>
          {editable ? (
            <div style={{ position: 'relative' }}>
              <div className="search-wrap">
                <I.Search size={13} />
                <input ref={inputRef} className="input" placeholder="Agregar grupos o usuarios del directorio" value={q}
                  onChange={e => { setQ(e.target.value); setOpen(true); setErr(''); }} onClick={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (opts[0]) add(opts[0]); } }} aria-label="Agregar grupos o usuarios" />
              </div>
              {open && (opts.length > 0 || notInDir) && (
                <div className="card sh-pop" role="listbox">
                  {opts.map(o => (
                    <button key={o.kind + o.id} role="option" className="sh-opt" onMouseDown={e => e.preventDefault()} onClick={() => add(o)}>
                      {o.kind === 'group' ? <span className="sh-av grp"><I.Org size={13} /></span> : <span className="sh-av">{shareInitials(o.p.name)}</span>}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="sh-t">{o.kind === 'group' ? o.id : o.p.name}</span>
                        <span className="sh-s">{o.kind === 'group' ? 'Grupo de Cognito' : o.p.email + ' · ' + o.p.area}</span>
                      </span>
                    </button>
                  ))}
                  {notInDir && <div className="sh-s" style={{ padding: '10px 12px' }}>Solo puedes compartir con usuarios del directorio de la empresa.</div>}
                </div>
              )}
            </div>
          ) : !canShare ? (
            <div className="sh-note"><I.Lock size={12} /> Solo quien creó el agente o un admin puede proponer con quién se comparte.</div>
          ) : (
            <div className="sh-note"><I.Lock size={12} /> Hay un cambio pendiente. Espera a que se resuelva para proponer otro.</div>
          )}
        </div>

        <div className="sh-general">
          <div className="sh-h">acceso general</div>
          <div className="sh-row" style={{ borderTop: 'none' }}>
            <span className={'sh-av ' + (sh.everyone ? 'all' : 'lock')}>{sh.everyone ? <I.Globe size={13} /> : <I.Lock size={13} />}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {editable ? (
                <select className="input sh-gen" value={sh.everyone ? 'org' : 'restricted'} aria-label="Acceso general" disabled={!!orgBlock && !sh.everyone}
                  onChange={e => setSh(x => ({ ...x, everyone: e.target.value === 'org' ? 'use' : null }))}>
                  <option value="restricted">Solo los grupos y usuarios de abajo</option>
                  <option value="org" disabled={!!orgBlock}>Toda la organización</option>
                </select>
              ) : <div className="sh-t">{sh.everyone ? 'Toda la organización' : 'Solo los grupos y usuarios de abajo'}</div>}
              <div className="sh-s" style={{ marginTop: 3 }}>{sh.everyone ? 'Cualquier persona de la organización lo ve y puede usarlo.' : 'Solo quienes están en la lista lo ven.'}</div>
            </div>
          </div>
          {orgBlock && <div className="sh-note" style={{ marginTop: 4 }}><I.Lock size={12} /> {orgBlock}</div>}
        </div>

        <div className="sh-list">
          <div className="sh-h">con acceso · {total + 1}</div>
          <div className="sh-row">
            <span className="sh-av own"><I.Shield size={13} /></span>
            <div style={{ flex: 1, minWidth: 0 }}><div className="sh-t">{agent.owner || 'Admins de Mango'}</div><div className="sh-s">Creador</div></div>
          </div>
          {sh.groups.map(g => <Row key={'g' + g.id} kind="group" id={g.id} title={g.id} sub="Grupo · todos sus miembros" icon={<span className="sh-av grp"><I.Org size={13} /></span>} />)}
          {sh.users.map(u => { const p = personOf(u.email); return <Row key={'u' + u.email} kind="user" id={u.email} title={p.name} sub={u.email} icon={<span className="sh-av">{shareInitials(p.name)}</span>} />; })}
        </div>

        {editable && diff.length > 0 && (
          <div style={{ padding: '4px 20px 0' }}>
            <div className="sh-h" style={{ marginBottom: 6 }}>cambios que se propondrán</div>
            <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>{diff.map(d => <li key={d}>{d}</li>)}</ul>
            <textarea className="input" rows={2} value={reason} onChange={e => { setReason(e.target.value); setErr(''); }} placeholder="Motivo (obligatorio) · lo verá el admin que revise" aria-label="Motivo del cambio" style={{ width: '100%' }} />
          </div>
        )}
        {err && <div style={{ fontSize: 12, color: 'var(--red)', padding: '6px 20px 0' }}>{err}</div>}

        <div className="sh-foot">
          <div style={{ flex: 1 }} />
          {editable ? <>
            <button className="btn btn-sm" onClick={onClose}>Cancelar</button>
            <button className="btn btn-sm btn-primary" disabled={!diff.length} onClick={submit}>Enviar a aprobación</button>
          </> : <button className="btn btn-sm" onClick={onClose}>Cerrar</button>}
        </div>
      </div>
    </div>
  );
}

function shareSummary(agent) {
  const s = sharesOf(agent);
  if (s.everyone) return 'Toda la organización';
  const parts = [];
  if (s.groups.length) parts.push(s.groups.length === 1 ? s.groups[0].id : s.groups.length + ' grupos');
  if (s.users.length) parts.push(s.users.length === 1 ? personOf(s.users[0].email).name : s.users.length + ' usuarios');
  return parts.join(' y ') || 'Nadie';
}

Object.assign(window, { ShareAgent, sharesOf, shareSummary });
