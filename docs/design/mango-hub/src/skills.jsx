// Skills — playbooks reutilizables sobre MCP habilitados
function skInit() {
  const S = window.MangoStore;
  if (S.get().skills) return;
  const BUNDLED = { 0: ['analizar_costos.py'], 2: ['rightsizing.py', 'plantilla_reporte.md'] };
  const list = (window.MangoData.skills || []).map((s, i) => { const v = (i % 3) + 1; return { ...s, ...(BUNDLED[i] ? { bundled: true, scripts: BUNDLED[i], owner: 'Mango' } : {}), version: v, agentV: Object.fromEntries((s.usedBy || []).map((a, j) => [a, j === 0 ? v : Math.max(1, v - 1)])), updatedBy: s.owner, updatedAt: new Date(Date.now() - (i + 2) * 864e5 * 3).toISOString() }; });
  list.push({ id: 'invoice-reconciliation', name: 'Invoice Reconciliation', cat: 'FinOps', icon: 'Document', desc: 'Cruza facturas de AWS con órdenes de compra y marca diferencias.', tools: ['aws-billing', 'sap-s4-hana'], instructions: '1. Lista las facturas de {{período}} en AWS Billing.\n2. Busca la PO de cada factura en SAP.\n3. Marca diferencias mayores a {{tolerancia}}.', inputs: ['período', 'tolerancia'], outputs: ['conciliación', 'diferencias'], usedBy: [], agentV: {}, runs30d: 0, owner: 'Mango', bundled: true, scripts: ['conciliar.py'], version: 1, updatedBy: 'Mango', updatedAt: new Date(Date.now() - 2 * 864e5).toISOString() });
  S.set({ skills: list });
}
const SK_LEVEL_RANK = { public: 0, internal: 1, accounts: 2, write: 3 };
const skPending = (id) => (window.MangoStore.get().changes || []).find(c => c.kind === 'skill' && c.target === id && c.status === 'pending');
window.MangoStore.onDecide.skill = (c, d) => {
  if (d !== 'approved') return; const S = window.MangoStore; const all = S.get().skills || [];
  if (c.key === 'create') S.set({ skills: [...all, { ...c.to, version: 1, usedBy: [], agentV: {}, runs30d: 0, updatedBy: c.by, updatedAt: new Date().toISOString() }] });
  else S.set({ skills: all.map(x => x.id === c.target ? { ...x, ...c.to, version: x.version + 1, updatedBy: c.by, updatedAt: new Date().toISOString() } : x) });
};
function skMeta(s) {
  const L = window.Lifecycle;
  const servers = (s.tools || []).map(id => ({ id, s: L.serverOf(id) }));
  const off = servers.filter(x => !x.s || x.s.status !== 'enabled');
  const level = servers.reduce((lv, x) => x.s && SK_LEVEL_RANK[x.s.level] > SK_LEVEL_RANK[lv] ? x.s.level : lv, 'public');
  const writes = servers.some(x => x.s?.tools.some(t => t.write));
  const acct = servers.some(x => x.s?.level === 'accounts');
  return { servers, off, level, writes, acct, ok: off.length === 0 };
}
const skVars = (txt) => [...new Set([...(txt || '').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(m => m[1]))];

function SkillsCatalog({ agents }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const skills = window.useMango(s => s.skills) || [];
  window.useMango(s => s.mcpCatalog); window.useMango(s => s.role); window.useMango(s => s.changes);
  const canEdit = S.can('agent.create');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [avail, setAvail] = useState('all');
  const [level, setLevel] = useState('all');
  const [sel, setSel] = useState(null);
  const [edit, setEdit] = useState(null);
  const cats = [...new Set(skills.map(s => s.cat))].sort();
  const Q = q.trim().toLowerCase();
  const pendingNew = (window.MangoStore.get().changes || []).filter(c => c.kind === 'skill' && c.key === 'create' && c.status === 'pending');
  const withMeta = skills.map(s => ({ s, m: skMeta(s) }));
  const base = withMeta.filter(({ s, m }) => (cat === 'all' || s.cat === cat) && (level === 'all' || m.level === level) && (!Q || (s.name + ' ' + s.desc + ' ' + s.tools.join(' ')).toLowerCase().includes(Q)));
  const list = base.filter(({ m }) => avail === 'all' || (avail === 'ok' ? m.ok : !m.ok));
  const anyFilter = Q || cat !== 'all' || avail !== 'all' || level !== 'all';
  const selected = sel && skills.find(s => s.id === sel);

  return (
    <>
      <Topbar crumbs={['Construir', 'Skills']} actions={canEdit && <button className="btn btn-sm btn-primary" onClick={() => setEdit({ isNew: true, id: '', name: '', cat: cats[0] || 'FinOps', icon: 'Skill', desc: '', instructions: '', tools: [], outputs: [] })}><I.Plus size={12} /> Nueva skill</button>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Skills</h1>
          <p className="page-subtitle">Playbooks reutilizables sobre uno o más MCP. Las que se crean aquí son solo instrucciones; las que incluyen scripts vienen instaladas con Mango y no se editan. Cada versión nueva la aprueba otro admin: hasta entonces, los agentes siguen con la anterior.</p>
        </div>
        <div className="ap-bar">
          <div className="ap-filters" style={{ borderTop: 'none' }}>
            <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar skill o MCP" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar skills" /></div>
            <div className="tk-quick" role="group" aria-label="Disponibilidad">
              {[['all', 'Todas', base.length], ['ok', 'Disponibles', base.filter(x => x.m.ok).length], ['off', 'Con MCP no habilitado', base.filter(x => !x.m.ok).length]].map(([k, l, n]) => <button key={k} className={avail === k ? 'is-on' : ''} aria-pressed={avail === k} onClick={() => setAvail(k)}>{l}<span className="mk-count">{n}</span></button>)}
            </div>
            <select className="input mk-sel" value={cat} onChange={e => setCat(e.target.value)} aria-label="Categoría"><option value="all">Todas las categorías</option>{cats.map(c => <option key={c}>{c}</option>)}</select>
            <select className="input mk-sel" value={level} onChange={e => setLevel(e.target.value)} aria-label="Nivel de datos"><option value="all">Cualquier nivel de datos</option>{Object.entries(L.DATA_LEVEL).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
            {anyFilter && <button className="btn btn-sm btn-ghost" onClick={() => { setQ(''); setCat('all'); setAvail('all'); setLevel('all'); }}>Limpiar</button>}
          </div>
        </div>
        <div className="mc-body">
          {!list.length ? <div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600 }}>Ninguna skill coincide</div><div className="mk-meta">Prueba quitando algún filtro.</div></div> : (
            <div className="card mc-table">
              <div className="sk-tr mc-th"><span>skill</span><span>mcp requeridos</span><span>nivel de datos</span><span>agentes</span><span>ejecuciones · 30 d</span><span>versión</span></div>
              {list.map(({ s, m }) => { const Ic = I[s.icon] || I.Skill; const outdated = Object.values(s.agentV || {}).filter(v => v < s.version).length; return (
                <button key={s.id} className={'sk-tr' + (m.ok ? '' : ' is-warn')} onClick={() => setSel(s.id)}>
                  <span className="row gap-3" style={{ minWidth: 0 }}>
                    <span className="mc-ic"><Ic size={14} /></span>
                    <span style={{ minWidth: 0 }}><span className="mk-name" style={{ display: 'block' }}>{s.name}{s.bundled && <span className="badge" style={{ marginLeft: 6 }}>Incluida con Mango</span>}{skPending(s.id) && <span className="badge badge-amber" style={{ marginLeft: 6 }}>v{s.version + 1} en aprobación</span>}</span><span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.cat} · {s.desc}</span></span>
                  </span>
                  <span className="row gap-1" style={{ flexWrap: 'wrap', minWidth: 0 }}>{m.servers.map(x => <span key={x.id} className={'sk-mcp' + (x.s?.status === 'enabled' ? '' : ' off')} title={x.s ? window.Lifecycle.MCP_STATUS[x.s.status][0] : 'No existe en el catálogo'}><span className={'dot dot-' + (x.s?.status === 'enabled' ? 'green' : 'red')} />{x.s?.name || x.id}</span>)}</span>
                  <span className="row gap-1" style={{ flexWrap: 'wrap' }}><McpLevel level={m.level} />{m.writes && m.level !== 'write' && <span className="badge badge-amber" title="Incluye tools de escritura: confirmación o aprobación en cada uso">+ escritura</span>}</span>
                  <span className="mk-meta">{(s.usedBy || []).length || '—'}</span>
                  <span className="mk-meta mono">{s.runs30d ? s.runs30d.toLocaleString('es-ES') : 'Sin datos'}</span>
                  <span className="mk-meta"><span className="mono">v{s.version}</span>{outdated ? <span style={{ color: 'var(--amber)' }}> · {outdated} en anterior</span> : ''}</span>
                </button>
              ); })}
              {pendingNew.map(c => <div key={c.id} className="sk-tr" style={{ opacity: .7, cursor: 'default' }}><span className="row gap-3" style={{ minWidth: 0 }}><span className="mc-ic"><I.Skill size={14} /></span><span style={{ minWidth: 0 }}><span className="mk-name" style={{ display: 'block' }}>{c.to.name}<span className="badge badge-amber" style={{ marginLeft: 6 }}>v1 pendiente de aprobación</span></span><span className="mk-meta" style={{ display: 'block' }}>Propuesta de {c.by} · {c.summary}</span></span></span><span /><span /><span className="mk-meta">—</span><span className="mk-meta">—</span><span className="mk-meta mono">v1</span></div>)}
            </div>
          )}
          {pendingNew.length > 0 && <window.ChangeList kind="skill" keys={['create']} title="Skills nuevas en aprobación" />}
        </div>
      </div>
      {selected && <SkillDetail s={selected} agents={agents} canEdit={canEdit} onClose={() => setSel(null)} onEdit={() => { setEdit({ ...selected }); }} />}
      {edit && <SkillEditor s={edit} agents={agents} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); setSel(id); }} />}
    </>
  );
}

function SkInstructions({ text }) {
  const parts = (text || '').split(/(\{\{\s*[^}]+?\s*\}\})/g);
  return <pre className="sk-ins">{parts.map((p, i) => /^\{\{/.test(p) ? <mark key={i}>{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>)}</pre>;
}

function SkillDetail({ s, agents, canEdit, onClose, onEdit }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const m = skMeta(s);
  const users = (s.usedBy || []).map(id => agents.find(a => a.id === id)).filter(Boolean);
  const areaUsers = m.acct ? users.filter(a => (a.groups || window.sharesOf?.(a).groups.map(g => g.id) || []).some(g => L.isRestricted(g))) : [];
  const vars = skVars(s.instructions);
  const Ic = I[s.icon] || I.Skill;
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const duplicate = () => {
    const all = S.get().skills; const taken = new Set([...all.map(x => x.id), ...(S.get().changes || []).filter(c => c.kind === 'skill').map(c => c.target)]); let n = 1; while (taken.has(s.id + '-copia-' + n)) n++; const id = s.id + '-copia-' + n;
    const { usedBy, agentV, runs30d, version, updatedBy, updatedAt, scripts, bundled, ...base } = s;
    S.propose({ kind: 'skill', key: 'create', target: id, from: null, to: { ...base, id, name: s.name + ' (copia)', bundled: false, owner: S.actor() }, title: 'Nueva skill ' + s.name + ' (copia)', summary: 'v1 · copia de ' + s.name + ' · solo instrucciones', reason: 'Duplicada desde ' + s.name + ' v' + s.version });
    toast?.({ tone: 'success', msg: 'Copia enviada a aprobación · v1 pendiente de otro admin' }); onClose();
  };
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" style={{ width: 540 }} role="dialog" aria-modal="true" aria-label={s.name}>
        <div className="mk-drawer-h">
          <span className="mc-ic lg"><Ic size={20} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{s.name}</div>
            <div className="row gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}><span className={'badge ' + (m.ok ? 'badge-green' : 'badge-red')}>{m.ok ? 'Disponible' : 'MCP no habilitado'}</span><McpLevel level={m.level} /><span className="mk-meta">{s.cat} · v{s.version}</span></div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="mk-drawer-b">
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{s.desc}</p>
          {!m.ok && <div className="mc-alert red"><I.X2 size={14} /><div>Requiere {m.off.map(x => (x.s?.name || x.id) + ' (' + (x.s ? L.MCP_STATUS[x.s.status][0].toLowerCase() : 'no existe') + ')').join(', ')}. Los agentes nuevos no podrán usarla hasta que se habilite. <button className="sr-link" onClick={() => { onClose(); window.MangoNav?.('mcp'); }}>Ver catálogo</button></div></div>}
          {m.writes && <div className="mc-alert amber"><I.Lock size={14} /><div>Incluye tools de escritura: cada uso pide confirmación o aprobación, según su política.</div></div>}
          {areaUsers.length > 0 && <div className="mc-alert amber"><I.Warn size={14} /><div>Usa «Datos de cuentas» y {areaUsers.map(a => a.name).join(', ')} {areaUsers.length === 1 ? 'es visible' : 'son visibles'} para roles de área. Su próximo envío a aprobación no pasará.</div></div>}
          {s.bundled && <div className="mc-alert"><I.Lock size={14} /><div>Incluida con Mango: trae scripts y solo se actualiza con Mango. No se edita ni se duplica desde la app.</div></div>}
          {skPending(s.id) && <window.ChangeList kind="skill" target={s.id} title="Versión en aprobación" />}
          <MkSec title="Instrucciones"><SkInstructions text={s.instructions} /></MkSec>
          {s.bundled && <MkSec title={'Scripts · ' + s.scripts.length}><div className="row gap-1" style={{ flexWrap: 'wrap' }}>{s.scripts.map(x => <code key={x} className="mc-tool-chip">{x}</code>)}</div></MkSec>}
          <MkSec title={`Variables · ${vars.length}`}>{vars.length ? <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{vars.map(v => <code key={v} className="mc-tool-chip">{v}</code>)}</div> : <div className="mk-meta">Sin variables.</div>}</MkSec>
          {(s.outputs || []).length > 0 && <MkSec title="Entrega"><div className="row gap-1" style={{ flexWrap: 'wrap' }}>{s.outputs.map(o => <span key={o} className="badge">{o}</span>)}</div></MkSec>}
          <MkSec title={`MCP requeridos · ${m.servers.length}`}>
            {m.servers.map(x => (
              <div key={x.id} className="mk-line row between" style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}><div style={{ fontWeight: 500 }}>{x.s?.name || x.id}</div><div className="mk-meta">{x.s ? x.s.tools.length + ' tools · ' + (x.s.tools.some(t => t.write) ? 'incluye escritura' : 'solo lectura') : 'No está en el catálogo'}</div></div>
                <span className="row gap-1">{x.s && <McpLevel level={x.s.level} />}<span className={'badge ' + (x.s ? L.MCP_STATUS[x.s.status][1] : 'badge-red')}>{x.s ? L.MCP_STATUS[x.s.status][0] : 'No existe'}</span></span>
              </div>
            ))}
          </MkSec>
          <MkSec title={`Agentes que la usan · ${users.length}`}>
            {users.length ? users.map(a => { const v = s.agentV?.[a.id] || s.version; return <div key={a.id} className="mk-line row between"><span>{a.name}</span><span className="mk-meta"><span className="mono">v{v}</span>{v < s.version ? <span style={{ color: 'var(--amber)' }}> · recibe v{s.version} con su siguiente aprobación</span> : ' · al día'}</span></div>; }) : <div className="mk-meta">Ningún agente la usa todavía.</div>}
          </MkSec>
          <MkSec title="Uso y dueño">
            <div className="mk-kv"><span>Ejecuciones · 30 días</span><span className="mono">{s.runs30d ? s.runs30d.toLocaleString('es-ES') : 'Sin datos'}</span></div>
            <div className="mk-kv"><span>Dueño</span><span>{s.owner || '—'}</span></div>
            <div className="mk-kv"><span>Última versión</span><span>v{s.version} · {s.updatedBy} · {window.fmtAgo(s.updatedAt)}</span></div>
          </MkSec>
        </div>
        {canEdit && !s.bundled && <div className="mc-foot row gap-2"><button className="btn btn-sm btn-primary" disabled={!!skPending(s.id)} title={skPending(s.id) ? 'Ya hay una versión en aprobación' : undefined} onClick={onEdit}><I.Edit size={12} /> Nueva versión</button><button className="btn btn-sm" onClick={duplicate}><I.Copy size={12} /> Duplicar como instrucciones</button></div>}
      </aside>
    </div>
  );
}

function SkillEditor({ s, agents, onClose, onSaved }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const catalog = window.useMango(st => st.mcpCatalog);
  const [f, setF] = useState({ ...s, outputs: [...(s.outputs || [])], tools: [...(s.tools || [])] });
  const [out, setOut] = useState('');
  const [tried, setTried] = useState(false);
  const [reason, setReason] = useState('');
  const vars = skVars(f.instructions);
  const secret = L.findSecret(f.instructions);
  const m = skMeta(f);
  const users = (s.usedBy || []).length;
  const idOf = (n) => n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const errs = [!f.name.trim() && 'Escribe un nombre', !f.instructions.trim() && 'Escribe las instrucciones', secret && 'Hay un posible secreto en las instrucciones', !f.tools.length && 'Elige al menos un MCP', m.off.length && 'Hay MCP que no están habilitados', s.isNew && S.get().skills.some(x => x.id === idOf(f.name)) && 'Ya existe una skill con ese nombre', !reason.trim() && 'Escribe el motivo'].filter(Boolean);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const save = () => {
    setTried(true); if (errs.length) return;
    const { isNew, ...rest } = f;
    const id = s.isNew ? idOf(f.name) : s.id;
    const data = { ...rest, id, inputs: vars, bundled: false, owner: s.isNew ? S.actor() : s.owner };
    S.propose({ kind: 'skill', key: s.isNew ? 'create' : 'version', target: id, from: s.isNew ? null : s.version, to: data, title: s.isNew ? 'Nueva skill ' + f.name : f.name + ' · v' + s.version + ' → v' + (s.version + 1), summary: s.isNew ? 'Crea la skill (solo instrucciones)' : (users ? users + ' agentes siguen en v' + s.version + ' hasta aprobarse' : 'Nueva versión'), reason: reason.trim() });
    toast?.({ tone: 'success', msg: 'Enviada a aprobación · la debe aprobar otro admin' }); s.isNew ? onClose() : onSaved(s.id);
  };
  const Lb = ({ children, htmlFor, hint }) => <div className="row between" style={{ marginBottom: 6 }}><label htmlFor={htmlFor} style={{ fontSize: 12.5, fontWeight: 500 }}>{children}</label>{hint && <span className="mk-meta">{hint}</span>}</div>;
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div className="card" role="dialog" aria-modal="true" aria-label={s.isNew ? 'Nueva skill' : 'Editar skill'} onClick={e => e.stopPropagation()} style={{ width: 720, maxWidth: '95vw', padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}>
        <div className="row between" style={{ padding: '18px 20px 4px', alignItems: 'flex-start' }}>
          <div><div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>{s.isNew ? 'Nueva skill' : `Nueva versión de ${s.name} · v${s.version} → v${s.version + 1}`}</div><div className="mk-meta" style={{ marginTop: 2 }}>Solo instrucciones: las skills con scripts vienen instaladas con Mango. Se aplica cuando otro admin la apruebe{!s.isNew && users > 0 ? `; hasta entonces ${users === 1 ? 'el agente sigue' : 'los ' + users + ' agentes siguen'} con v${s.version}` : ''}.</div></div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div style={{ padding: '14px 20px', overflowY: 'auto', display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)', gap: 20 }} className="sk-edit">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div><Lb htmlFor="sk-name">Nombre</Lb><input id="sk-name" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} maxLength={48} autoFocus /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div><Lb htmlFor="sk-cat">Categoría</Lb><select id="sk-cat" className="input" value={f.cat} onChange={e => setF({ ...f, cat: e.target.value })}>{['FinOps', 'DevOps', 'ERP', 'Productivity', 'Security', 'Data'].map(c => <option key={c}>{c}</option>)}</select></div>
              <div><Lb htmlFor="sk-desc">Descripción corta</Lb><input id="sk-desc" className="input" value={f.desc} onChange={e => setF({ ...f, desc: e.target.value })} maxLength={140} /></div>
            </div>
            <div><Lb htmlFor="sk-ins" hint="Usa {{variable}} para datos que da el usuario">Instrucciones</Lb>
              <textarea id="sk-ins" className="input mono" rows={10} value={f.instructions} onChange={e => setF({ ...f, instructions: e.target.value })} style={{ fontSize: 12.5, lineHeight: 1.6, borderColor: secret ? 'var(--red)' : undefined }} placeholder={'1. Consulta {{servicio}} en el período {{período}}.\n2. …'} />
              {secret && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 5 }}>Posible secreto ({secret}) en las instrucciones. No pegues credenciales.</div>}
              <div className="row gap-1" style={{ flexWrap: 'wrap', marginTop: 8 }}><span className="mk-meta">Variables detectadas:</span>{vars.length ? vars.map(v => <code key={v} className="mc-tool-chip">{v}</code>) : <span className="mk-meta">ninguna</span>}</div>
            </div>
            <div><Lb>Entrega</Lb>
              <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{f.outputs.map(o => <span key={o} className="badge" style={{ gap: 6 }}>{o}<button type="button" aria-label={'Quitar ' + o} onClick={() => setF({ ...f, outputs: f.outputs.filter(x => x !== o) })} style={{ display: 'flex' }}><I.Close size={9} /></button></span>)}
                <input className="input" value={out} onChange={e => setOut(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && out.trim()) { e.preventDefault(); setF({ ...f, outputs: [...new Set([...f.outputs, out.trim()])] }); setOut(''); } }} placeholder="p. ej. tabla_resumen + Enter" style={{ flex: '1 1 160px', maxWidth: 220, fontSize: 12.5 }} /></div>
            </div>
          </div>
          <div>
            <Lb hint={f.tools.length + ' elegidos'}>MCP requeridos</Lb>
            <div className="ab-list" style={{ maxHeight: 360 }}>
              {catalog.slice().sort((a, b) => (a.status === 'enabled' ? 0 : 1) - (b.status === 'enabled' ? 0 : 1) || a.name.localeCompare(b.name)).map(x => { const on = f.tools.includes(x.id); const en = x.status === 'enabled'; return (
                <button key={x.id} type="button" className={'ab-item' + (on ? ' is-on' : '')} disabled={!en && !on} onClick={() => setF({ ...f, tools: on ? f.tools.filter(t => t !== x.id) : [...f.tools, x.id] })} aria-pressed={on} style={!en && !on ? { opacity: .5 } : null}>
                  <span className="ab-check">{on && <I.Check size={10} />}</span>
                  <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{x.name}</span><span className="ab-sub">{en ? x.tools.length + ' tools' + (x.tools.some(t => t.write) ? ' · escritura' : '') : L.MCP_STATUS[x.status][0]}</span></span>
                  <McpLevel level={x.level} />
                </button>
              ); })}
            </div>
            <div className="mk-meta" style={{ marginTop: 8, lineHeight: 1.5 }}>Nivel de datos resultante: <McpLevel level={m.level} />{m.writes ? ' · con escritura (confirmación o aprobación en cada uso)' : ''}</div>
          </div>
        </div>
        {tried && errs.length > 0 && <div style={{ padding: '0 20px 10px', fontSize: 12.5, color: 'var(--red)' }}>{errs.join(' · ')}</div>}
        <div className="row gap-2" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}>
          <input className="input" style={{ flex: 1, maxWidth: 360, borderColor: tried && !reason.trim() ? 'var(--red)' : undefined }} value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo (obligatorio)" aria-label="Motivo" />
          <button className="btn btn-sm" onClick={onClose}>Cancelar</button>
          <button className="btn btn-sm btn-primary" onClick={save}>Enviar a aprobación</button>
        </div>
      </div>
    </div>
  );
}

skInit();
Object.assign(window, { SkillsCatalog });
