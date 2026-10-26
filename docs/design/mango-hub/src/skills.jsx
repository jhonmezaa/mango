// Skills — playbooks reutilizables sobre MCP habilitados
function skInit() {
  const S = window.MangoStore;
  if (S.get().skills) return;
  const BUNDLED = { 0: ['analizar_costos.py'], 2: ['rightsizing.py', 'plantilla_reporte.md'] };
  const list = (window.MangoData.skills || []).map((s, i) => { const v = (i % 3) + 1; return { ...s, ...(BUNDLED[i] ? { bundled: true, scripts: BUNDLED[i], owner: 'Mango' } : {}), version: v, agentV: Object.fromEntries((s.usedBy || []).map((a, j) => [a, j === 0 ? v : Math.max(1, v - 1)])), updatedBy: s.owner, updatedAt: new Date(Date.now() - (i + 2) * 864e5 * 3).toISOString() }; });
  list.push({ id: 'invoice-reconciliation', name: 'Invoice Reconciliation', cat: 'FinOps', icon: 'Document', desc: 'Cruza facturas de AWS con órdenes de compra y marca diferencias.', tools: ['aws-billing', 'sap-s4-hana'], instructions: '1. Lista las facturas de {{período}} en AWS Billing.\n2. Busca la PO de cada factura en SAP.\n3. Marca diferencias mayores a {{tolerancia}}.', inputs: ['período', 'tolerancia'], outputs: ['conciliación', 'diferencias'], usedBy: [], agentV: {}, runs30d: 0, owner: 'Mango', bundled: true, scripts: ['conciliar.py'], version: 1, updatedBy: 'Mango', updatedAt: new Date(Date.now() - 2 * 864e5).toISOString() });
  const P = ['usuario3@empresa.com', 'usuario2@empresa.com', 'usuario6@empresa.com'];
  list.forEach((s, i) => { s.history = Array.from({ length: s.version }, (_, k) => { const by = P[(i + k) % 3]; return { v: k + 1, by, approvedBy: by === 'usuario1@empresa.com' ? 'usuario6@empresa.com' : 'usuario1@empresa.com', at: new Date(Date.now() - ((s.version - k) * 9 + i) * 864e5).toISOString() }; }); s.ownerUser = s.history[0].by; });
  S.set({ skills: list });
}
const SK_LEVEL_RANK = { public: 0, internal: 1, accounts: 2, write: 3 };
const skPending = (id) => (window.MangoStore.get().changes || []).find(c => c.kind === 'skill' && c.target === id && c.status === 'pending');
window.MangoStore.onDecide.skill = (c, d) => {
  if (d !== 'approved') return; const S = window.MangoStore; const all = S.get().skills || [];
  const at = new Date().toISOString(); const ap = S.actorEmail(); const by = S.emailOf(c.by) || c.by;
  if (c.key === 'create') S.set({ skills: [...all, { ...c.to, version: 1, usedBy: [], agentV: {}, runs30d: 0, updatedBy: c.by, updatedAt: at, ownerUser: by, history: [{ v: 1, by, approvedBy: ap, at }] }] });
  else S.set({ skills: all.map(x => x.id === c.target ? { ...x, ...c.to, version: x.version + 1, updatedBy: c.by, updatedAt: at, history: [...(x.history || []), { v: x.version + 1, by, approvedBy: ap, at }] } : x) });
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
  const allSkills = window.useMango(s => s.skills) || [];
  const availMode = window.useMango(s => s.avail);
  const sim = window.useMango(s => s.simSk) || null;
  const skills = availMode ? allSkills.filter(s => !s.bundled) : allSkills;
  window.useMango(s => s.mcpCatalog); window.useMango(s => s.role); window.useMango(s => s.changes);
  const K = window.GovKit;
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
          <p className="page-subtitle">{availMode ? 'Playbooks reutilizables sobre uno o más MCP, escritos como instrucciones. Cada versión la aprueba un administrador distinto de quien la propone: hasta entonces, los agentes siguen con la anterior.' : 'Playbooks reutilizables sobre uno o más MCP. Las que se crean aquí son solo instrucciones; las que incluyen scripts vienen instaladas con Mango y no se editan. Cada versión nueva la aprueba otro admin: hasta entonces, los agentes siguen con la anterior.'}</p>
        </div>
        {sim === 'denied' ? <K.Denied view="skills" /> : sim === 'error' ? <K.ErrorState title="No se pudieron cargar las skills" body="Inténtalo de nuevo en unos segundos." onRetry={() => window.MangoStore.set({ simSk: null })} /> : sim === 'loading' ? (
          <div className="card mc-table" aria-busy="true" aria-label="Cargando skills">{[0, 1, 2, 3, 4].map(i => <div key={i} className="sk-tr" style={{ cursor: 'default' }}><span className="row gap-3"><K.Skel w={28} h={28} r={7} /><span style={{ display: 'grid', gap: 6, flex: 1 }}><K.Skel w="50%" /><K.Skel w="80%" h={10} /></span></span><K.Skel w="70%" /><K.Skel w={70} /><K.Skel w={20} /><K.Skel w={40} /><K.Skel w={30} /></div>)}</div>
        ) : <>
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
              <div className="sk-tr mc-th"><span>skill</span><span>mcp requeridos</span><span>nivel de datos</span><span>agentes</span><span title="Veces que un agente cargó la skill en los últimos 30 días">ejecuciones · 30 d</span><span>versión</span></div>
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
        </>}
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
  const availMode = S.get().avail; const hist = (s.history || []).slice().reverse(); const last = hist[0];
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const duplicate = () => {
    const all = S.get().skills; const taken = new Set([...all.map(x => x.id), ...(S.get().changes || []).filter(c => c.kind === 'skill').map(c => c.target)]); let n = 1; while (taken.has(s.id + '-copia-' + n)) n++; const id = s.id + '-copia-' + n;
    const { usedBy, agentV, runs30d, version, updatedBy, updatedAt, scripts, bundled, ...base } = s;
    S.propose({ kind: 'skill', key: 'create', target: id, from: null, to: { ...base, id, name: s.name + ' (copia)', bundled: false, owner: S.actor() }, title: 'Nueva skill ' + s.name + ' (copia)', summary: 'v1 · copia de ' + s.name + ' · solo instrucciones', reason: 'Duplicada desde ' + s.name + ' v' + s.version });
    toast?.({ tone: 'success', msg: 'Copia enviada a aprobación · v1 pendiente de un administrador distinto de ti' }); onClose();
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
            <div className="mk-kv"><span title="Veces que un agente cargó la skill, contadas por día">Ejecuciones · 30 días</span><span className="mono">{s.runs30d ? s.runs30d.toLocaleString('es-ES') : 'Sin datos'}</span></div>
            <div className="mk-kv"><span>Dueño</span><span>{availMode ? (s.ownerUser || '—') + ' · propuso la v1' : s.owner || '—'}</span></div>
            <div className="mk-kv"><span>Última versión</span><span>{availMode && last ? 'v' + last.v + ' · aprobó ' + last.approvedBy + ' · ' + window.fmtAgo(last.at) : 'v' + s.version + ' · ' + s.updatedBy + ' · ' + window.fmtAgo(s.updatedAt)}</span></div>
          </MkSec>
          {availMode && hist.length > 0 && <MkSec title={'Versiones · ' + hist.length}>
            {hist.map(h => <div key={h.v} className="mk-line" style={{ display: 'grid', gridTemplateColumns: '40px minmax(0,1fr) auto', gap: 10, alignItems: 'baseline' }}><span className="mono" style={{ fontWeight: 600 }}>v{h.v}</span><span className="mk-meta" style={{ overflowWrap: 'anywhere' }}>Propuso {h.by} · aprobó {h.approvedBy}</span><span className="mk-meta">{window.fmtAgo(h.at)}</span></div>)}
          </MkSec>}
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
  const [srvErr, setSrvErr] = useState(null);
  const availMode = S.get().avail;
  const vars = skVars(f.instructions);
  const secret = L.findSecret(f.instructions);
  const m = skMeta(f);
  const users = (s.usedBy || []).length;
  const idOf = (n) => n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const errs = [!f.name.trim() && 'Escribe un nombre', !f.instructions.trim() && 'Escribe las instrucciones', secret && 'Hay un posible secreto en las instrucciones', !f.tools.length && 'Elige al menos un MCP', f.tools.length > 10 && 'Hasta 10 MCP', f.outputs.length > 10 && 'Hasta 10 entregas', f.instructions.length > 20000 && 'Las instrucciones pasan de 20.000 caracteres', m.off.length && 'Hay MCP que no están habilitados', s.isNew && S.get().skills.some(x => x.id === idOf(f.name)) && 'Ya existe una skill con ese nombre', !reason.trim() && 'Escribe el motivo'].filter(Boolean);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const save = () => {
    setTried(true); setSrvErr(null); if (errs.length) return;
    const lim = availMode && S.get().simSk;
    if (lim === 'limit-skills' && s.isNew) { setSrvErr('La instalación llegó al máximo de 200 skills. No se pueden crear más.'); return; }
    if (lim === 'limit-open') { setSrvErr('Ya hay 20 propuestas de skills abiertas, el máximo. Espera a que se decida alguna o retira una tuya.'); return; }
    const { isNew, ...rest } = f;
    const id = s.isNew ? idOf(f.name) : s.id;
    const data = { ...rest, id, inputs: vars, bundled: false, owner: s.isNew ? S.actor() : s.owner };
    S.propose({ kind: 'skill', key: s.isNew ? 'create' : 'version', target: id, from: s.isNew ? null : s.version, to: data, title: s.isNew ? 'Nueva skill ' + f.name : f.name + ' · v' + s.version + ' → v' + (s.version + 1), summary: s.isNew ? 'Crea la skill (solo instrucciones)' : (users ? users + ' agentes siguen en v' + s.version + ' hasta aprobarse' : 'Nueva versión'), reason: reason.trim() });
    toast?.({ tone: 'success', msg: 'Enviada a aprobación · la aprueba un administrador distinto de ti' }); s.isNew ? onClose() : onSaved(s.id);
  };
  const Lb = ({ children, htmlFor, hint }) => <div className="row between" style={{ marginBottom: 6 }}><label htmlFor={htmlFor} style={{ fontSize: 12.5, fontWeight: 500 }}>{children}</label>{hint && <span className="mk-meta">{hint}</span>}</div>;
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div className="card" role="dialog" aria-modal="true" aria-label={s.isNew ? 'Nueva skill' : 'Editar skill'} onClick={e => e.stopPropagation()} style={{ width: 720, maxWidth: '95vw', padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}>
        <div className="row between" style={{ padding: '18px 20px 4px', alignItems: 'flex-start' }}>
          <div><div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>{s.isNew ? 'Nueva skill' : `Nueva versión de ${s.name} · v${s.version} → v${s.version + 1}`}</div><div className="mk-meta" style={{ marginTop: 2 }}>{availMode ? 'Solo instrucciones.' : 'Solo instrucciones: las skills con scripts vienen instaladas con Mango.'} Se aplica cuando la apruebe un administrador distinto de ti{!s.isNew && users > 0 ? `; hasta entonces ${users === 1 ? 'el agente sigue' : 'los ' + users + ' agentes siguen'} con v${s.version}` : ''}.</div></div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div style={{ padding: '14px 20px', overflowY: 'auto', display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)', gap: 20 }} className="sk-edit">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div><Lb htmlFor="sk-name">Nombre</Lb><input id="sk-name" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} maxLength={48} autoFocus /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div><Lb htmlFor="sk-cat">Categoría</Lb><select id="sk-cat" className="input" value={f.cat} onChange={e => setF({ ...f, cat: e.target.value })}>{['FinOps', 'DevOps', 'ERP', 'Productivity', 'Security', 'Data'].map(c => <option key={c}>{c}</option>)}</select></div>
              <div><Lb htmlFor="sk-desc">Descripción corta</Lb><input id="sk-desc" className="input" value={f.desc} onChange={e => setF({ ...f, desc: e.target.value })} maxLength={140} /></div>
            </div>
            <div><Lb htmlFor="sk-ins" hint={f.instructions.length > 18000 ? f.instructions.length.toLocaleString('es-ES') + ' / 20.000' : 'Usa {{variable}} para datos que da el usuario'}>Instrucciones</Lb>
              <textarea id="sk-ins" maxLength={20000} className="input mono" rows={10} value={f.instructions} onChange={e => setF({ ...f, instructions: e.target.value })} style={{ fontSize: 12.5, lineHeight: 1.6, borderColor: secret ? 'var(--red)' : undefined }} placeholder={'1. Consulta {{servicio}} en el período {{período}}.\n2. …'} />
              {secret && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 5 }}>Posible secreto ({secret}) en las instrucciones. No pegues credenciales.</div>}
              <div className="row gap-1" style={{ flexWrap: 'wrap', marginTop: 8 }}><span className="mk-meta">Variables detectadas:</span>{vars.length ? vars.map(v => <code key={v} className="mc-tool-chip">{v}</code>) : <span className="mk-meta">ninguna</span>}</div>
            </div>
            <div><Lb>Entrega</Lb>
              <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{f.outputs.map(o => <span key={o} className="badge" style={{ gap: 6 }}>{o}<button type="button" aria-label={'Quitar ' + o} onClick={() => setF({ ...f, outputs: f.outputs.filter(x => x !== o) })} style={{ display: 'flex' }}><I.Close size={9} /></button></span>)}
                {f.outputs.length < 10 && <input className="input" value={out} onChange={e => setOut(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && out.trim()) { e.preventDefault(); setF({ ...f, outputs: [...new Set([...f.outputs, out.trim()])] }); setOut(''); } }} placeholder="p. ej. tabla_resumen + Enter" style={{ flex: '1 1 160px', maxWidth: 220, fontSize: 12.5 }} />}</div>
            </div>
          </div>
          <div>
            <Lb hint={f.tools.length + ' de 10'}>MCP requeridos</Lb>
            <div className="ab-list" style={{ maxHeight: 360 }}>
              {catalog.slice().sort((a, b) => (a.status === 'enabled' ? 0 : 1) - (b.status === 'enabled' ? 0 : 1) || a.name.localeCompare(b.name)).map(x => { const on = f.tools.includes(x.id); const en = x.status === 'enabled'; return (
                <button key={x.id} type="button" className={'ab-item' + (on ? ' is-on' : '')} disabled={(!en || f.tools.length >= 10) && !on} onClick={() => setF({ ...f, tools: on ? f.tools.filter(t => t !== x.id) : [...f.tools, x.id] })} aria-pressed={on} style={!en && !on ? { opacity: .5 } : null}>
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
        {srvErr && <div role="alert" style={{ padding: '0 20px 10px', fontSize: 12.5, color: 'var(--red)' }}>{srvErr}</div>}
        <div className="row gap-2" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}>
          <input className="input" style={{ flex: 1, maxWidth: 360, borderColor: tried && !reason.trim() ? 'var(--red)' : undefined }} value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo (obligatorio)" aria-label="Motivo" />
          <button className="btn btn-sm" onClick={onClose}>Cancelar</button>
          <button className="btn btn-sm btn-primary" onClick={save}>Enviar a aprobación</button>
        </div>
      </div>
    </div>
  );
}

// Skills de una versión de agente: 'id@vN', fijadas en una versión aprobada. Hasta 10.
const skParse = (x) => { const [id, v] = String(x).split('@'); const all = window.MangoStore.get().skills || []; return { id, v: +v || 1, s: all.find(k => k.id === id && !(window.MangoStore.get().avail && k.bundled)) }; };
function skIssues(r, snap) {
  const out = [];
  if (!r.s || r.v > r.s.version) { out.push({ code: 'skill-unapproved', msg: 'La skill ' + (r.s?.name || r.id) + ' v' + r.v + ' ya no está aprobada. Pásala a la última versión o quítala.' }); return out; }
  const m = skMeta(r.s);
  m.off.forEach(x => out.push({ code: 'skill-mcp-off', msg: 'La skill ' + r.s.name + ' requiere ' + (x.s?.name || x.id) + ', que no está habilitado. Quítala o pide que lo habiliten.' }));
  m.servers.filter(x => x.s && x.s.status === 'enabled' && !(snap.tools || []).some(t => t.startsWith(x.id + '.'))).forEach(x => out.push({ code: 'skill-mcp-missing', msg: 'La skill ' + r.s.name + ' requiere ' + x.s.name + ' y el agente no tiene ninguna de sus tools. Agrega una o quita la skill.' }));
  return out;
}
window.skAgentErrors = (snap) => {
  const sel = snap.skills || []; const errs = [];
  if (sel.length > 10) errs.push({ sec: 'skills', code: 'skills-max', msg: 'Un agente puede usar hasta 10 skills. Quita alguna.' });
  sel.forEach(x => skIssues(skParse(x), snap).forEach(e => errs.push({ sec: 'skills', ...e, code: e.code + ':' + x })));
  return errs;
};

function SkAgentSection({ snap, set, setView }) {
  const I = window.Icons;
  const all = window.useMango(s => s.skills) || [];
  const availMode = window.useMango(s => s.avail);
  window.useMango(s => s.mcpCatalog);
  const list = availMode ? all.filter(s => !s.bundled) : all;
  const sel = snap.skills || [];
  const rows = sel.map(x => ({ key: x, ...skParse(x) }));
  const chosen = new Set(rows.map(r => r.id));
  const opts = list.filter(s => !chosen.has(s.id)).sort((a, b) => a.name.localeCompare(b.name));
  const full = sel.length >= 10;
  const setOne = (key, next) => set({ skills: next ? sel.map(x => x === key ? next : x) : sel.filter(x => x !== key) });
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.length > 0 ? <div className="card" style={{ padding: '2px 14px' }}>
        {rows.map(r => { const iss = skIssues(r, snap); const latest = r.s?.version; const Ic = (r.s && I[r.s.icon]) || I.Skill; return (
          <div key={r.key} className="mk-line" style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr) auto', gap: 10, alignItems: 'start' }}>
            <span className="mc-ic" style={{ marginTop: 2 }}><Ic size={13} /></span>
            <span style={{ minWidth: 0 }}>
              <span className="row gap-2" style={{ flexWrap: 'wrap' }}><b style={{ fontWeight: 500 }}>{r.s?.name || r.id}</b><span className="mono mk-meta">{r.id}@v{r.v}</span>{latest > r.v && <span className="badge badge-amber">v{latest} disponible</span>}</span>
              {r.s && <span className="mk-meta" style={{ display: 'block' }}>{skMeta(r.s).servers.map(x => x.s?.name || x.id).join(' · ')}</span>}
              {iss.map(e => <span key={e.code + e.msg} style={{ display: 'block', fontSize: 12, color: e.code === 'skill-mcp-missing' ? 'var(--amber)' : 'var(--red)', marginTop: 3 }}>{e.msg}</span>)}
            </span>
            <span className="row gap-1">
              {latest > r.v && <button type="button" className="btn btn-sm" onClick={() => setOne(r.key, r.id + '@' + latest)}>Pasar a v{latest}</button>}
              <button type="button" className="btn btn-ghost btn-icon" aria-label={'Quitar ' + (r.s?.name || r.id)} onClick={() => setOne(r.key, null)}><I.Close size={12} /></button>
            </span>
          </div>
        ); })}
      </div> : <div className="mk-meta">Sin skills. El agente responde solo con su prompt, sus tools y sus knowledge bases.</div>}
      <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
        <select className="input" style={{ flex: '1 1 240px', maxWidth: 360 }} value="" disabled={full || !opts.length} aria-label="Agregar skill" onChange={e => e.target.value && set({ skills: [...sel, e.target.value] })}>
          <option value="">{full ? 'Ya tiene 10 skills, el máximo' : opts.length ? 'Agregar skill…' : 'No quedan skills aprobadas'}</option>
          {opts.map(s => { const m = skMeta(s); return <option key={s.id} value={s.id + '@' + s.version} disabled={!m.ok}>{s.name} · v{s.version}{m.ok ? '' : ' · MCP no habilitado'}</option>; })}
        </select>
        <span className="mk-meta">{sel.length} de 10</span>
        <button type="button" className="sr-link" onClick={() => setView?.('skills')}>Ver catálogo de skills</button>
      </div>
      <div className="mk-meta" style={{ lineHeight: 1.5 }}>Se agregan en su última versión aprobada. Si la skill recibe una versión nueva, el agente sigue con la suya hasta que pases a la nueva y se apruebe esta versión del agente.</div>
    </div>
  );
}

function RvSkills({ r, d, isNew }) {
  window.useMango(s => s.skills);
  const all = r.snap.skills || [];
  if (isNew && !all.length) return null;
  const add = isNew ? all : (d.skills?.add || []); const rem = isNew ? [] : (d.skills?.rem || []);
  const remIds = new Map(rem.map(x => [x.split('@')[0], x]));
  const changed = add.filter(x => remIds.has(x.split('@')[0]));
  const onlyAdd = add.filter(x => !changed.includes(x)); const onlyRem = rem.filter(x => !changed.some(c => c.split('@')[0] === x.split('@')[0]));
  const row = (x, kind, from) => { const p = skParse(x); const iss = kind === 'rem' ? [] : skIssues(p, r.snap); return (
    <div key={kind + x} className={'rv-tool ' + (kind === 'chg' ? 'add' : kind)}><span className="rv-sign">{kind === 'add' ? '+' : kind === 'rem' ? '−' : '~'}</span>
      <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block' }}>{p.s?.name || p.id}</span><span className="mono mk-meta" style={{ fontSize: 11.5 }}>{kind === 'chg' ? p.id + ' · v' + skParse(from).v + ' → v' + p.v : x}</span>{iss.map(e => <span key={e.msg} style={{ display: 'block', fontSize: 12, color: 'var(--red)' }}>{e.msg}</span>)}</span>
    </div>); };
  return (
    <div>
      <div className="mk-sec-t">skills {isNew ? '· ' + all.length : `· ${onlyAdd.length} agregadas, ${onlyRem.length} quitadas, ${changed.length} cambian de versión`}</div>
      <div className="rv-tools">{onlyAdd.map(x => row(x, 'add'))}{changed.map(x => row(x, 'chg', remIds.get(x.split('@')[0])))}{onlyRem.map(x => row(x, 'rem'))}{!isNew && !add.length && !rem.length && <div className="mk-meta" style={{ padding: '6px 0' }}>Sin cambios en skills ({all.length}).</div>}</div>
    </div>
  );
}

// Tarjeta de aprobación de una skill: el texto completo y, en una versión nueva, la comparación con la anterior.
function SkChangeBody({ c }) {
  const all = window.useMango(s => s.skills) || [];
  const [cmp, setCmp] = useState(false);
  if (c.status !== 'pending' || !c.to) return null;
  const cur = c.key === 'create' ? null : all.find(s => s.id === c.target);
  const fields = cur ? [['Nombre', cur.name, c.to.name], ['Categoría', cur.cat, c.to.cat], ['Descripción', cur.desc, c.to.desc], ['MCP', (cur.tools || []).join(', '), (c.to.tools || []).join(', ')], ['Entrega', (cur.outputs || []).join(', '), (c.to.outputs || []).join(', ')]].filter(([, a, b]) => a !== b) : [];
  const D = window.lineDiff;
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
      {fields.map(([k, a, b]) => <div key={k} style={{ fontSize: 12.5 }}><span className="g-diff-k">{k}</span> <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)' }}>{a || '—'}</span> → <span>{b || '—'}</span></div>)}
      {!cur && <div style={{ fontSize: 12.5 }}><span className="g-diff-k">MCP</span> {(c.to.tools || []).join(', ') || '—'}{(c.to.outputs || []).length > 0 && <> · <span className="g-diff-k">Entrega</span> {c.to.outputs.join(', ')}</>}</div>}
      <div className="row between"><span className="g-diff-k">{cmp ? 'Instrucciones · cambios desde v' + cur.version : 'Instrucciones' + (cur ? ' · v' + (cur.version + 1) : '')}</span>{cur && D && <button type="button" className="sr-link" onClick={() => setCmp(!cmp)}>{cmp ? 'Ver texto completo' : 'Comparar con v' + cur.version}</button>}</div>
      {cmp && D ? <pre className="mono" style={{ margin: 0, fontSize: 11.5, border: '1px solid var(--border)', borderRadius: 6, overflow: 'auto', maxHeight: 320, whiteSpace: 'pre-wrap' }}>{D(cur.instructions, c.to.instructions).map(([k, l], i) => <div key={i} style={{ padding: '1px 10px', background: k === '+' ? 'var(--green-soft)' : k === '-' ? 'var(--red-soft)' : 'transparent', color: k === ' ' ? 'var(--text-muted)' : 'var(--text)' }}>{k} {l || ' '}</div>)}</pre>
        : <div style={{ maxHeight: 320, overflow: 'auto' }}><SkInstructions text={c.to.instructions} /></div>}
    </div>
  );
}

skInit();
Object.assign(window, { SkillsCatalog, SkAgentSection, RvSkills, SkChangeBody });
