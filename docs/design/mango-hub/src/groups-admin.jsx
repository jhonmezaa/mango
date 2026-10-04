// Ajustes › Grupos: grupos de acceso (central, de área, general)
function GroupsAdmin({ goAreas, notify }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const defs = window.useMango(s => s.groupDefs);
  const changes = window.useMango(s => s.changes);
  window.useMango(s => s.role);
  const pendingOf = (id) => changes.find(c => c.kind === 'group' && c.target === id && c.status === 'pending');
  const pendingNew = changes.filter(c => c.kind === 'group' && c.key === 'create' && c.status === 'pending');
  const isAdmin = S.get().role === 'admin';
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const Q = q.trim().toLowerCase();
  const list = defs.filter(g => (type === 'all' || g.type === type) && (!Q || (g.id + ' ' + (g.desc || '') + ' ' + (g.area || '')).toLowerCase().includes(Q)));
  const cnt = (t) => defs.filter(g => g.type === t).length;
  const TONE = { central: 'badge-violet', area: 'badge-amber', general: 'badge' };
  return (
    <section>
      <div className="g-sec-h" style={{ marginBottom: 12 }}>
        <div>
          <div className="g-sec-t">Grupos de acceso</div>
          <div className="g-sec-meta">Deciden quién ve cada agente y qué datos puede usar. Solo los grupos centrales pueden usar tools de «Datos de cuentas». Crear, cambiar el tipo o eliminar un grupo lo propone un admin y lo aprueba otro distinto{S.get().avail ? '; la propuesta vence a las 72 h' : ''}. Los grupos del sistema no se eliminan.</div>
        </div>
        {isAdmin && <button className="btn btn-sm btn-primary" onClick={() => setEdit({ isNew: true, id: '', type: 'general', area: null, desc: '' })}><I.Plus size={12} /> Nuevo grupo</button>}
      </div>
      <div className="row gap-2" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="search-wrap" style={{ flex: '1 1 200px', maxWidth: 280 }}><I.Search size={13} /><input className="input" placeholder="Buscar grupo o área" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar grupos" /></div>
        <div className="tk-quick" role="group" aria-label="Tipo">
          {[['all', 'Todos', defs.length], ['central', 'Centrales', cnt('central')], ['area', 'De área', cnt('area')], ['general', 'Generales', cnt('general')]].map(([k, l, n]) => <button key={k} className={type === k ? 'is-on' : ''} aria-pressed={type === k} onClick={() => setType(k)}>{l}<span className="mk-count">{n}</span></button>)}
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="gr-tr mc-th"><span>grupo</span><span>tipo</span><span>área</span><span>miembros</span><span>agentes</span><span /></div>
        {list.map(g => {
          const used = L.agentsWithGroup(g.id).length;
          return (
            <div key={g.id} className="gr-tr">
              <span style={{ minWidth: 0 }}><span className="mono" style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-strong)' }}>{g.id}</span>{pendingOf(g.id) && <span className="badge badge-amber" style={{ marginLeft: 6 }}>{pendingOf(g.id).key === 'delete' ? 'Eliminación pendiente' : 'Cambio pendiente'}</span>}<span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.desc || '—'}</span></span>
              <span><span className={'badge ' + TONE[g.type]} title={L.GROUP_TYPES[g.type][1]}>{L.GROUP_TYPES[g.type][0]}</span></span>
              <span className="mono" style={{ fontSize: 12.5 }}>{g.area || <span className="mk-meta">—</span>}</span>
              <span className="mk-meta" title={S.get().avail ? 'Todavía no hay dato de miembros' : undefined}>{S.get().avail ? '—' : g.members}</span>
              <span className="mk-meta">{used || '—'}</span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>{isAdmin && <button className="btn btn-sm btn-ghost" aria-label={'Editar ' + g.id} disabled={!!pendingOf(g.id)} title={pendingOf(g.id) ? 'Tiene un cambio pendiente' : 'Editar'} onClick={() => setEdit({ ...g })}><I.Edit size={12} /></button>}</span>
            </div>
          );
        })}
        {pendingNew.map(c => <div key={c.id} className="gr-tr" style={{ opacity: .75 }}><span style={{ minWidth: 0 }}><span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{c.target}</span><span className="badge badge-amber" style={{ marginLeft: 6 }}>Creación pendiente</span><span className="mk-meta" style={{ display: 'block' }}>{c.to.desc || '—'}</span></span><span><span className={'badge ' + TONE[c.to.type]}>{L.GROUP_TYPES[c.to.type][0]}</span></span><span className="mono" style={{ fontSize: 12.5 }}>{c.to.area || '—'}</span><span className="mk-meta">—</span><span className="mk-meta">—</span><span /></div>)}
        {!list.length && !pendingNew.length && <div className="mk-meta" style={{ padding: 16 }}>Ningún grupo coincide.</div>}
      </div>
      <window.ChangeList kind="group" title="Cambios de grupos" />
      {!isAdmin && <div className="ap-reason" style={{ marginTop: 10 }}><I.Lock size={12} /> Solo los administradores pueden proponer cambios de grupos.</div>}
      {edit && <GroupModal g={edit} defs={defs} onClose={() => setEdit(null)} goAreas={() => { setEdit(null); goAreas(); }} notify={notify} />}
    </section>
  );
}

function GroupModal({ g, defs, onClose, goAreas, notify }) {
  const I = window.Icons; const L = window.Lifecycle;
  const areas = Object.keys(window.GovData?.mapping?.areas || {});
  const [f, setF] = useState({ ...g, area: g.area || (g.type === 'area' ? areas[0] : null) });
  const [tried, setTried] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [reason, setReason] = useState('');
  const S = window.MangoStore;
  const typeChanged = !g.isNew && f.type !== g.type;
  const areaChanged = !g.isNew && (f.area || null) !== (g.area || null);
  const needsApproval = g.isNew || typeChanged || areaChanged;
  const used = g.isNew ? [] : L.agentsWithGroup(g.id);
  const acctAgents = used.filter(a => a.mcp.some(m => L.serverOf(m)?.level === 'accounts'));
  const avail = S.get().avail;
  const RESERVED = ['mango-admin', 'mango-agent-creator', 'finops-central', 'bu-lead'];
  const idErr = !g.isNew ? null : !f.id ? 'Escribe un nombre' : !/^[a-z0-9-]{2,32}$/.test(f.id) ? 'Minúsculas, números y guiones (2 a 32)' : avail && (RESERVED.includes(f.id) || f.id.startsWith('mango-')) ? 'Ese nombre está reservado para grupos del sistema.' : defs.some(x => x.id === f.id) ? 'Ya existe un grupo con ese nombre' : avail && defs.length >= 100 ? 'Se alcanzó el máximo de 100 grupos registrados. Propón eliminar alguno antes de crear otro.' : null;
  const ownGroup = avail && !g.isNew && S.ROLES[S.get().role].groups.includes(g.id) && (typeChanged || areaChanged);
  const typeErr = avail && f.id.startsWith('bu-') && f.id !== 'bu-lead' && f.type !== 'area' ? 'Los grupos que empiezan por «bu-» son de área: el tipo lo fija el nombre.' : avail && !f.id.startsWith('bu-') && f.type === 'area' && g.isNew ? 'Los grupos de área se nombran «bu-<área>»: el tipo lo fija el nombre.' : ownGroup ? 'No puedes cambiar un grupo al que perteneces. Pídeselo a otro administrador.' : f.type !== 'central' && g.type === 'central' && acctAgents.length ? `No puede dejar de ser central: ${acctAgents.map(a => a.name).join(', ')} ${acctAgents.length === 1 ? 'lo usa' : 'lo usan'} con tools de «Datos de cuentas».` : null;
  const areaErr = f.type === 'area' && !f.area ? 'Elige el área' : null;
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const reasonErr = (needsApproval || confirmDel) && !reason.trim() ? 'Escribe el motivo' : null;
  const T = (k) => L.GROUP_TYPES[k][0].toLowerCase();
  const save = () => {
    setTried(true); if (idErr || typeErr || areaErr) return;
    const { isNew, ...rest } = f; const data = { ...rest, area: f.type === 'area' ? f.area : null };
    if (!needsApproval) { L.saveGroup(data, false); notify?.('Descripción actualizada'); onClose(); return; }
    if (reasonErr) return;
    S.propose({ kind: 'group', key: g.isNew ? 'create' : 'update', target: data.id, from: g.isNew ? null : { type: g.type, area: g.area }, to: data, title: (g.isNew ? 'Crear grupo ' : 'Cambiar grupo ') + data.id, summary: g.isNew ? 'Nuevo grupo ' + T(data.type) + (data.area ? ' · área ' + data.area : '') : 'Tipo ' + T(g.type) + (g.area ? ' (' + g.area + ')' : '') + ' → ' + T(data.type) + (data.area ? ' (' + data.area + ')' : ''), reason: reason.trim() });
    notify?.('Propuesta enviada · la debe aprobar otro admin'); onClose();
  };
  const del = () => { setTried(true); if (!reason.trim()) return; S.propose({ kind: 'group', key: 'delete', target: g.id, from: { type: g.type, area: g.area }, to: null, title: 'Eliminar grupo ' + g.id, summary: used.length ? 'Lo usan ' + used.length + ' agentes; perderán este acceso' : 'Ningún agente lo usa', reason: reason.trim() }); notify?.('Propuesta enviada · la debe aprobar otro admin'); onClose(); };
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div className="card" role="dialog" aria-modal="true" aria-label={g.isNew ? 'Nuevo grupo' : 'Editar grupo'} onClick={e => e.stopPropagation()} style={{ width: 520, maxWidth: '94vw', padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
        <div className="row between" style={{ padding: '18px 20px 4px', alignItems: 'flex-start' }}>
          <div><div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>{g.isNew ? 'Nuevo grupo' : 'Editar ' + g.id}</div><div className="mk-meta" style={{ marginTop: 2 }}>Se sincroniza con Cognito. Las personas se agregan en Ajustes › Personas.</div></div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div style={{ padding: '14px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label htmlFor="gr-id" style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 6 }}>Nombre</label>
            <input id="gr-id" className="input mono" value={f.id} disabled={!g.isNew} onChange={e => setF({ ...f, id: e.target.value })} placeholder="p. ej. finanzas-lideres" autoFocus={g.isNew} style={tried && idErr ? { borderColor: 'var(--red)' } : null} />
            {tried && idErr ? <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 5 }}>{idErr}</div> : !g.isNew && <div className="mk-meta" style={{ marginTop: 5 }}>El nombre no se puede cambiar porque lo usan agentes y Cognito.</div>}
          </div>
          <div>
            <label htmlFor="gr-desc" style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 6 }}>Descripción</label>
            <input id="gr-desc" className="input" value={f.desc} onChange={e => setF({ ...f, desc: e.target.value })} placeholder="Quién está en este grupo" />
          </div>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>Tipo</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {Object.entries(L.GROUP_TYPES).map(([k, [l, d]]) => (
                <label key={k} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', border: '1px solid ' + (f.type === k ? 'var(--accent-border)' : 'var(--border)'), background: f.type === k ? 'var(--accent-soft)' : 'transparent', borderRadius: 10, cursor: 'pointer' }}>
                  <input type="radio" name="gr-type" checked={f.type === k} onChange={() => setF({ ...f, type: k, area: k === 'area' ? (f.area || areas[0]) : null })} style={{ accentColor: 'var(--accent-ink)', marginTop: 3 }} />
                  <span><span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{l}</span><span className="mk-meta">{d}</span></span>
                </label>
              ))}
            </div>
            {tried && typeErr && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{typeErr}</div>}
          </div>
          {f.type === 'area' && (
            <div>
              <label htmlFor="gr-area" style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 6 }}>Área</label>
              <select id="gr-area" className="input" value={f.area || ''} onChange={e => setF({ ...f, area: e.target.value })} style={{ width: 'auto', minWidth: 200 }}>
                {areas.map(a => <option key={a} value={a}>{a} · {(window.GovData.mapping.areas[a] || []).length} OUs</option>)}
              </select>
              <div className="mk-meta" style={{ marginTop: 6 }}>Sus miembros solo verán el gasto de las OUs de esta área. ¿Falta el área? <button type="button" className="sr-link" onClick={goAreas}>Propónla en Áreas y OUs</button>: otro administrador debe aprobarla.</div>
            </div>
          )}
          {(needsApproval || confirmDel) && <div>
            <label htmlFor="gr-why" style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 6 }}>Motivo</label>
            <textarea id="gr-why" className="input" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Lo verá el admin que lo revise" style={tried && !reason.trim() ? { borderColor: 'var(--red)' } : null} />
            <div className="mk-meta" style={{ marginTop: 5 }}>{confirmDel ? 'La eliminación' : g.isNew ? 'El grupo' : 'El cambio de tipo o área'} no se aplica hasta que otro admin lo apruebe.{avail && ' Si nadie lo decide en 72 h, vence.'}</div>
          </div>}
          {!g.isNew && used.length > 0 && <div className="mc-alert"><I.Info size={14} /><div>{used.length === 1 ? 'Un agente usa' : used.length + ' agentes usan'} este grupo: {used.slice(0, 4).map(a => a.name).join(', ')}{used.length > 4 ? '…' : ''}.</div></div>}
        </div>
        <div className="row gap-2" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', alignItems: 'center' }}>
          {!g.isNew && (confirmDel
            ? <><span className="mk-meta">{used.length ? 'Lo usan agentes; perderán este acceso.' : '¿Proponer eliminarlo?'}</span><button className="btn btn-sm mk-danger" onClick={del}>Proponer eliminación</button><button className="btn btn-sm btn-ghost" onClick={() => setConfirmDel(false)}>No</button></>
            : <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} disabled={!!g.system} title={g.system ? 'Grupo del sistema' : undefined} onClick={() => setConfirmDel(true)}><I.Trash size={12} /> Eliminar</button>)}
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={onClose}>Cancelar</button>
          {!confirmDel && <button className="btn btn-sm btn-primary" onClick={save}>{needsApproval ? 'Enviar a aprobación' : 'Guardar'}</button>}
        </div>
      </div>
    </div>
  );
}

window.MangoStore.onDecide.group = (c, d) => { if (d !== 'approved') return; const L = window.Lifecycle; if (c.key === 'delete') L.deleteGroup(c.target); else L.saveGroup(c.to, c.key === 'create'); };
Object.assign(window, { GroupsAdmin });
