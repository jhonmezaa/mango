// Knowledge Bases — fuentes de documentos indexadas en Bedrock Knowledge Bases
const KB_STATUS = { ok: ['Sincronizada', 'badge-green'], warn: ['Con avisos', 'badge-amber'], error: ['Error', 'badge-red'], syncing: ['Sincronizando', 'badge-blue'], pending: ['Sin sincronizar', 'badge'] };
const KB_SOURCES = { 'Confluence': ['confluence', 'Espacio'], 'Google Drive': ['google-drive', 'Carpeta'], 'GitHub': ['github', 'Repositorio'], 'Custom S3': [null, 'Bucket'], 'S3': [null, 'Bucket'] };
const KB_FREQ = [['manual', 'Manual'], ['6h', 'Cada 6 h'], ['24h', 'Diaria'], ['7d', 'Semanal']];
const kbNum = (n) => n >= 1e6 ? (n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' M' : n >= 1e3 ? (n / 1e3).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' k' : String(n);
const KB_GROUPS = { 'kb-01': ['mango-admin', 'devops'], 'kb-02': ['people'], 'kb-03': ['mango-admin', 'finops-central'], 'kb-04': ['mango-admin', 'security'], 'kb-05': ['mango-admin', 'bu-retail'], 'kb-06': ['mango-admin', 'bu-plataforma', 'finops-central'], 'kb-07': ['devops', 'people'], 'kb-08': ['mango-admin'] };

function kbInit() {
  const S = window.MangoStore; if (S.get().kbs) return;
  const list = (window.MangoData.knowledgeBases || []).map((k, i) => ({
    ...k, groups: KB_GROUPS[k.id] || ['mango-admin'], freq: ['6h', '24h', '24h', '6h', '6h', '24h', '6h', 'manual'][i] || '24h',
    queries30d: k.syncStatus === 'pending' ? null : [1240, 860, 412, 530, 0, 2210, 190, null][i],
    sourceRef: { 'Confluence': 'Espacio ' + k.name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4), 'Google Drive': '/Compartido/' + k.owner, 'GitHub': 'empresa/releases', 'Custom S3': k.bucket }[k.source],
    errors: k.syncStatus === 'warn' ? [{ doc: 'PO-template-2019.pdf', msg: 'OCR sin texto legible' }, { doc: 'Vendor-list-scan.pdf', msg: 'OCR sin texto legible' }, { doc: 'Anexo-B.tiff', msg: 'Formato no soportado' }, { doc: 'Contrato-marco.pdf', msg: 'PDF protegido con contraseña' }, { doc: 'Firma-digital.png', msg: 'Imagen sin texto' }] : [],
  }));
  S.set({ kbs: list });
}

function KnowledgeView({ agents }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const kbs = window.useMango(s => s.kbs) || [];
  window.useMango(s => s.role);
  const canEdit = S.can('agent.create');
  const [q, setQ] = useState(''); const [st, setSt] = useState('all'); const [src, setSrc] = useState('all');
  const [sel, setSel] = useState(null); const [creating, setCreating] = useState(false);
  const Q = q.trim().toLowerCase();
  const base = kbs.filter(k => (src === 'all' || k.source === src) && (!Q || (k.name + ' ' + k.desc + ' ' + k.owner).toLowerCase().includes(Q)));
  const list = base.filter(k => st === 'all' || k.syncStatus === st || (st === 'attention' && ['warn', 'error'].includes(k.syncStatus)));
  const tot = { docs: kbs.reduce((s, k) => s + k.docs, 0), tokens: kbs.reduce((s, k) => s + k.tokens, 0), att: kbs.filter(k => ['warn', 'error'].includes(k.syncStatus)).length };
  const sources = [...new Set(kbs.map(k => k.source))];
  const selected = sel && kbs.find(k => k.id === sel);
  const exposure = (k) => (k.usedBy || []).map(id => agents.find(a => a.id === id)).filter(Boolean).filter(a => (window.sharesOf?.(a).everyone) || ((a.groups || []).some(g => !k.groups.includes(g) && !k.groups.includes('all-staff'))));
  return (
    <>
      <Topbar crumbs={['Construir', 'Knowledge Bases']} actions={canEdit && <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}><I.Plus size={12} /> Nueva knowledge base</button>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Knowledge Bases</h1>
          <p className="page-subtitle">Documentos que los agentes pueden consultar. Se indexan en Bedrock Knowledge Bases de tu instalación y solo los ven los grupos con acceso.</p>
        </div>
        <div className="bg-kpis">
          <div className="card bg-kpi"><span className="bg-kpi-l">Knowledge bases</span><span className="bg-kpi-v">{kbs.length}</span><span className="bg-kpi-s">{kbs.filter(k => (k.usedBy || []).length).length} en uso por agentes</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Documentos indexados</span><span className="bg-kpi-v">{tot.docs.toLocaleString('es-ES', { useGrouping: 'always' })}</span><span className="bg-kpi-s">{kbNum(tot.tokens)} tokens</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Necesitan atención</span><span className="bg-kpi-v" style={tot.att ? { color: 'var(--amber)' } : null}>{tot.att}</span><span className="bg-kpi-s">{tot.att ? 'Con errores de indexación' : 'Todo sincronizado'}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Consultas · 30 días</span><span className="bg-kpi-v">{kbNum(kbs.reduce((s, k) => s + (k.queries30d || 0), 0))}</span><span className="bg-kpi-s">De los agentes que las usan</span></div>
        </div>
        <div className="bg-toolbar">
          <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar knowledge base" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar" /></div>
          <div className="tk-quick" role="group">{[['all', 'Todas', base.length], ['attention', 'Necesitan atención', base.filter(k => ['warn', 'error'].includes(k.syncStatus)).length], ['pending', 'Sin sincronizar', base.filter(k => k.syncStatus === 'pending').length]].map(([k, l, n]) => <button key={k} className={st === k ? 'is-on' : ''} onClick={() => setSt(k)}>{l}<span className="mk-count">{n}</span></button>)}</div>
          <select className="input mk-sel" value={src} onChange={e => setSrc(e.target.value)} aria-label="Fuente"><option value="all">Todas las fuentes</option>{sources.map(s => <option key={s}>{s}</option>)}</select>
        </div>
        <div className="mc-body" style={{ paddingTop: 0 }}>
          <div className="card mc-table">
            <div className="kb-tr mc-th"><span>knowledge base</span><span>fuente</span><span>estado</span><span>tamaño</span><span>acceso</span><span>agentes</span></div>
            {list.map(k => { const Ic = I[k.icon] || I.BookOpen; const ex = exposure(k); return (
              <button key={k.id} className="kb-tr" onClick={() => setSel(k.id)}>
                <span className="row gap-3" style={{ minWidth: 0 }}><span className="mc-ic"><Ic size={14} /></span><span style={{ minWidth: 0 }}><span className="mk-name" style={{ display: 'block' }}>{k.name}</span><span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.owner} · {k.desc}</span></span></span>
                <span className="mk-meta">{k.source}</span>
                <span className="row gap-1" style={{ flexWrap: 'wrap' }}><span className={'badge ' + KB_STATUS[k.syncStatus][1]}>{k.syncStatus === 'syncing' && <span className="g-spin" style={{ width: 9, height: 9, marginRight: 5 }} />}{KB_STATUS[k.syncStatus][0]}</span><span className="mk-meta">{k.syncStatus === 'pending' ? '' : k.lastSync}</span></span>
                <span className="mk-meta mono">{k.docs} docs · {kbNum(k.tokens)}</span>
                <span className="row gap-1" style={{ flexWrap: 'wrap', minWidth: 0 }}>{k.groups.slice(0, 2).map(g => <span key={g} className="mv-cap">{g}</span>)}{k.groups.length > 2 && <span className="mk-meta">+{k.groups.length - 2}</span>}{ex.length > 0 && <span className="badge badge-amber" title="Algún agente que la usa es visible para grupos sin acceso a esta knowledge base">Exposición</span>}</span>
                <span className="mk-meta">{(k.usedBy || []).length || '—'}</span>
              </button>
            ); })}
            {!list.length && <div className="mk-meta" style={{ padding: 16 }}>Ninguna coincide.</div>}
          </div>
        </div>
      </div>
      {selected && <KbDetail k={selected} agents={agents} exposure={exposure(selected)} canEdit={canEdit} onClose={() => setSel(null)} />}
      {creating && <KbCreate onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSel(id); }} />}
    </>
  );
}

function kbSync(id) {
  const S = window.MangoStore; const set = (fn) => S.set({ kbs: S.get().kbs.map(k => k.id === id ? { ...k, ...fn(k) } : k) });
  const k0 = S.get().kbs.find(k => k.id === id);
  set(() => ({ syncStatus: 'syncing', syncStarted: Date.now() }));
  S.log('kb.sync', id, 'Inició la sincronización de ' + k0.name);
  setTimeout(() => {
    const k = S.get().kbs.find(x => x.id === id);
    const add = k.docs ? Math.round(Math.random() * 3) : 12 + Math.round(Math.random() * 20);
    set(x => ({ syncStatus: x.errors?.length ? 'warn' : 'ok', lastSync: 'ahora', docs: x.docs + add, chunks: x.chunks + add * 22, tokens: x.tokens + add * 9800, syncStarted: null }));
    S.log('kb.sync', id, `Sincronizó ${k.name}: ${add} documentos nuevos`);
  }, 3000);
}

function KbDetail({ k, agents, exposure, canEdit, onClose }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const [tab, setTab] = useState('info');
  const [q, setQ] = useState(''); const [res, setRes] = useState(null);
  const [freq, setFreq] = useState(k.freq); const [groups, setGroups] = useState(k.groups);
  const users = (k.usedBy || []).map(id => agents.find(a => a.id === id)).filter(Boolean);
  const groupNames = (S.get().groupDefs || []).map(g => g.id);
  const dirty = freq !== k.freq || JSON.stringify(groups) !== JSON.stringify(k.groups);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const search = () => {
    if (!q.trim()) return;
    const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const docs = [k.name + ' — guía general', k.desc.split(',')[0], 'Procedimiento: ' + (words[0] || 'consulta'), 'Preguntas frecuentes de ' + k.owner];
    setRes(k.syncStatus === 'pending' ? [] : docs.map((d, i) => ({ doc: d, score: Math.max(0.41, 0.92 - i * 0.13 - (words.length ? 0 : 0.2)), text: `…${k.desc} ${words.length ? 'Coincide con «' + words.join(' ') + '».' : ''}…` })));
    S.log('kb.query', k.id, 'Probó una búsqueda en ' + k.name);
  };
  const saveCfg = () => { S.set({ kbs: S.get().kbs.map(x => x.id === k.id ? { ...x, freq, groups } : x) }); S.log('kb.update', k.id, `Cambió acceso o frecuencia de ${k.name}: ${groups.join(', ')} · ${KB_FREQ.find(f => f[0] === freq)[1].toLowerCase()}`, { before: { groups: k.groups.join(', '), freq: k.freq }, after: { groups: groups.join(', '), freq } }); toast?.({ tone: 'success', msg: 'Cambios guardados' }); };
  const [, setTick] = useState(0);
  useEffect(() => { if (k.syncStatus !== 'syncing') return; const t = setInterval(() => setTick(x => x + 1), 250); return () => clearInterval(t); }, [k.syncStatus]);
  const Ic = I[k.icon] || I.BookOpen;
  const elapsed = k.syncStarted ? Math.min(0.95, (Date.now() - k.syncStarted) / 3000) : 0;
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" style={{ width: 560 }} role="dialog" aria-modal="true" aria-label={k.name}>
        <div className="mk-drawer-h">
          <span className="mc-ic lg"><Ic size={20} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{k.name}</div>
            <div className="row gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}><span className={'badge ' + KB_STATUS[k.syncStatus][1]}>{KB_STATUS[k.syncStatus][0]}</span><span className="mk-meta">{k.source} · {k.owner}</span></div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="tk-tabs" style={{ padding: '0 20px', marginTop: 0 }} role="tablist">{[['info', 'Resumen'], ['docs', 'Documentos' + (k.errors?.length ? ' · ' + k.errors.length + ' con error' : '')], ['test', 'Probar búsqueda'], ['access', 'Acceso y sync']].map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)}>{l}</button>)}</div>
        <div className="mk-drawer-b">
          {tab === 'info' && <>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{k.desc}</p>
            {k.syncStatus === 'syncing' && <div className="mc-alert"><span className="g-spin" /><div style={{ flex: 1 }}>Sincronizando desde {k.source}…<div className="mk-bar-track" style={{ marginTop: 6 }}><span style={{ width: elapsed * 100 + '%', background: 'var(--blue)' }} /></div></div></div>}
            {k.syncStatus === 'warn' && <div className="mc-alert amber"><I.Warn size={14} /><div>{k.errors.length} documentos no se pudieron indexar; los agentes no los ven. <button className="sr-link" onClick={() => setTab('docs')}>Ver cuáles</button></div></div>}
            {k.syncStatus === 'pending' && <div className="mc-alert"><I.Info size={14} /><div>Nunca se ha sincronizado: los agentes aún no pueden consultarla.</div></div>}
            {exposure.length > 0 && <div className="mc-alert amber"><I.Warn size={14} /><div><b>Exposición:</b> {exposure.map(a => a.name).join(', ')} {exposure.length === 1 ? 'es visible' : 'son visibles'} para grupos sin acceso a esta knowledge base. Esos usuarios podrían ver su contenido a través del agente.</div></div>}
            <MkSec title="Contenido">
              <div className="mk-kv"><span>Documentos</span><span className="mono">{k.docs.toLocaleString('es-ES', { useGrouping: 'always' })}</span></div>
              <div className="mk-kv"><span>Fragmentos</span><span className="mono">{k.chunks.toLocaleString('es-ES', { useGrouping: 'always' })}</span></div>
              <div className="mk-kv"><span>Tamaño</span><span className="mono">{kbNum(k.tokens)} tokens</span></div>
              <div className="mk-kv"><span>Embeddings</span><span>Amazon Titan Embeddings v2 · Bedrock</span></div>
            </MkSec>
            <MkSec title="Fuente">
              <div className="mk-kv"><span>Origen</span><span>{k.source}</span></div>
              <div className="mk-kv"><span>{KB_SOURCES[k.source]?.[1] || 'Ubicación'}</span><span className="mono" style={{ fontSize: 12 }}>{k.sourceRef}</span></div>
              <div className="mk-kv"><span>Última sincronización</span><span>{k.syncStatus === 'pending' ? 'Nunca' : k.lastSync}</span></div>
              <div className="mk-kv"><span>Frecuencia</span><span>{KB_FREQ.find(f => f[0] === k.freq)?.[1]}</span></div>
            </MkSec>
            <MkSec title={`Agentes que la usan · ${users.length}`}>{users.length ? users.map(a => <div key={a.id} className="mk-line row between"><span>{a.name}</span><span className="mk-meta">{exposure.includes(a) ? 'Visible para más grupos' : a.cat}</span></div>) : <div className="mk-meta">Ninguno todavía.</div>}</MkSec>
            <MkSec title="Uso · 30 días"><div className="mk-kv"><span>Consultas</span><span className="mono">{k.queries30d != null ? k.queries30d.toLocaleString('es-ES', { useGrouping: 'always' }) : 'Sin datos'}</span></div></MkSec>
          </>}
          {tab === 'docs' && <>
            {k.errors?.length > 0 && <MkSec title={`No indexados · ${k.errors.length}`}>{k.errors.map(e => <div key={e.doc} className="mk-line row between" style={{ alignItems: 'flex-start' }}><span className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{e.doc}</span><span className="badge badge-red">{e.msg}</span></div>)}<div className="mk-meta" style={{ marginTop: 6 }}>Corrígelos en {k.source} y vuelve a sincronizar.</div></MkSec>}
            <MkSec title={`Indexados · ${k.docs}`}>{[k.name + ' — guía general.md', 'Procedimientos 2026.pdf', 'Preguntas frecuentes.docx', 'Glosario.md', 'Plantillas.xlsx'].slice(0, Math.min(5, k.docs)).map((d, i) => <div key={d} className="mk-line row between"><span className="mono" style={{ fontSize: 12.5 }}>{d}</span><span className="mk-meta">{['hace 2 d', 'hace 1 sem', 'hace 3 sem', 'hace 1 mes', 'hace 2 meses'][i]}</span></div>)}{k.docs > 5 && <div className="mk-meta" style={{ marginTop: 4 }}>y {k.docs - 5} más.</div>}</MkSec>
          </>}
          {tab === 'test' && <>
            <div className="mk-meta">Busca como lo haría un agente para ver qué fragmentos recupera. No cuenta como consulta de usuario.</div>
            <div className="row gap-2"><input className="input" style={{ flex: 1 }} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder={'p. ej. ' + (k.id === 'kb-02' ? 'días de vacaciones el primer año' : 'procedimiento de rollback')} aria-label="Consulta de prueba" autoFocus /><button className="btn btn-sm btn-primary" onClick={search} disabled={!q.trim()}>Buscar</button></div>
            {res && (res.length ? res.map((r, i) => <div key={i} className="kb-hit"><div className="row between" style={{ gap: 8 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{r.doc}</span><span className="mono mk-meta">{r.score.toFixed(2).replace('.', ',')}</span></div><div className="mk-meta" style={{ marginTop: 3, lineHeight: 1.5 }}>{r.text}</div><div className="mk-bar-track" style={{ marginTop: 6 }}><span style={{ width: r.score * 100 + '%', background: r.score > 0.7 ? 'var(--green)' : 'var(--amber)' }} /></div></div>) : <div className="mk-meta">Sin resultados: la knowledge base aún no está sincronizada.</div>)}
          </>}
          {tab === 'access' && <>
            <MkSec title="Grupos que pueden consultarla">
              <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{groupNames.map(g => { const on = groups.includes(g); return <button key={g} type="button" disabled={!canEdit} className={'tweak-chip ab-chip' + (on ? ' is-on' : '')} onClick={() => setGroups(on ? groups.filter(x => x !== g) : [...groups, g])}>{on && <I.Check size={10} />}{g}</button>; })}</div>
              <div className="mk-meta" style={{ marginTop: 6 }}>Un agente que la usa solo debería ser visible para estos grupos. Si no, se marca como «Exposición».</div>
            </MkSec>
            <MkSec title="Sincronización">
              <div className="tk-quick" style={{ display: 'inline-flex' }}>{KB_FREQ.map(([f, l]) => <button key={f} disabled={!canEdit} className={freq === f ? 'is-on' : ''} onClick={() => setFreq(f)}>{l}</button>)}</div>
            </MkSec>
            {canEdit && <div className="row gap-2"><button className="btn btn-sm btn-primary" disabled={!dirty || !groups.length} onClick={saveCfg}>Guardar cambios</button>{!groups.length && <span style={{ fontSize: 12, color: 'var(--red)' }}>Elige al menos un grupo</span>}</div>}
          </>}
        </div>
        {canEdit && <div className="mc-foot row gap-2"><button className="btn btn-sm" disabled={k.syncStatus === 'syncing'} onClick={() => { kbSync(k.id); toast?.({ tone: 'info', msg: 'Sincronizando ' + k.name }); }}><I.Refresh size={12} /> {k.syncStatus === 'syncing' ? 'Sincronizando…' : 'Sincronizar ahora'}</button></div>}
      </aside>
    </div>
  );
}

function KbCreate({ onClose, onCreated }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const [f, setF] = useState({ name: '', desc: '', source: 'Confluence', ref: '', groups: ['mango-admin'], freq: '24h' });
  const [tried, setTried] = useState(false);
  const conn = KB_SOURCES[f.source][0]; const server = conn && L.serverOf(conn);
  const connOff = conn && (!server || server.status !== 'enabled');
  const errs = [!f.name.trim() && 'Escribe un nombre', !f.ref.trim() && 'Indica la ubicación', f.source === 'S3' && f.ref && !/^s3:\/\/[a-z0-9.-]{3,63}(\/.*)?$/.test(f.ref) && 'El bucket debe ser s3://nombre/…', connOff && 'El conector no está habilitado', !f.groups.length && 'Elige al menos un grupo', L.findSecret(f.ref) && 'No pegues credenciales en la ubicación'].filter(Boolean);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const save = () => {
    setTried(true); if (errs.length) return;
    const id = 'kb-' + String((S.get().kbs || []).length + 1).padStart(2, '0') + '-' + Date.now().toString(36).slice(-3);
    S.set({ kbs: [...S.get().kbs, { id, name: f.name.trim(), desc: f.desc.trim() || 'Sin descripción', owner: S.actor(), source: f.source, sourceRef: f.ref.trim(), icon: 'BookOpen', docs: 0, chunks: 0, tokens: 0, embedding: 'titan-v2', lastSync: 'nunca', syncStatus: 'pending', usedBy: [], groups: f.groups, freq: f.freq, queries30d: null, errors: [] }] });
    S.log('kb.create', id, `Creó la knowledge base ${f.name.trim()} (${f.source})`);
    kbSync(id); toast?.({ tone: 'success', msg: 'Creada · primera sincronización en curso' }); onCreated(id);
  };
  const groupNames = (S.get().groupDefs || []).map(g => g.id);
  const Lb = ({ children, htmlFor }) => <label htmlFor={htmlFor} style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 6 }}>{children}</label>;
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div className="card" role="dialog" aria-modal="true" aria-label="Nueva knowledge base" onClick={e => e.stopPropagation()} style={{ width: 540, maxWidth: '94vw', padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}>
        <div className="row between" style={{ padding: '18px 20px 4px', alignItems: 'flex-start' }}><div><div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>Nueva knowledge base</div><div className="mk-meta" style={{ marginTop: 2 }}>Se indexa en Bedrock Knowledge Bases con los conectores de Mango. No hay credenciales que ingresar.</div></div><button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button></div>
        <div style={{ padding: '14px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div><Lb htmlFor="kb-n">Nombre</Lb><input id="kb-n" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus maxLength={48} /></div>
          <div><Lb htmlFor="kb-d">Descripción</Lb><input id="kb-d" className="input" value={f.desc} onChange={e => setF({ ...f, desc: e.target.value })} maxLength={140} placeholder="Qué contiene y para qué sirve" /></div>
          <div><Lb>Fuente</Lb><div className="ab-seg">{['Confluence', 'Google Drive', 'GitHub', 'S3'].map(s => <button key={s} type="button" className={f.source === s ? 'is-on' : ''} onClick={() => setF({ ...f, source: s, ref: '' })}>{s}</button>)}</div>
            {connOff && <div className="mc-alert red" style={{ marginTop: 8, fontSize: 12.5 }}><I.X2 size={13} /><div>El conector de {f.source} no está habilitado. <button className="sr-link" onClick={() => { onClose(); window.MangoNav?.('mcp'); }}>Ver catálogo</button></div></div>}</div>
          <div><Lb htmlFor="kb-r">{KB_SOURCES[f.source][1]}</Lb><input id="kb-r" className="input mono" value={f.ref} onChange={e => setF({ ...f, ref: e.target.value })} placeholder={{ Confluence: 'Clave del espacio, p. ej. OPS', 'Google Drive': '/Compartido/Equipo', GitHub: 'org/repositorio', S3: 's3://bucket/prefijo/' }[f.source]} /></div>
          <div><Lb>Grupos que pueden consultarla</Lb><div className="row gap-1" style={{ flexWrap: 'wrap' }}>{groupNames.map(g => { const on = f.groups.includes(g); return <button key={g} type="button" className={'tweak-chip ab-chip' + (on ? ' is-on' : '')} onClick={() => setF({ ...f, groups: on ? f.groups.filter(x => x !== g) : [...f.groups, g] })}>{on && <I.Check size={10} />}{g}</button>; })}</div></div>
          <div><Lb>Sincronización</Lb><div className="tk-quick" style={{ display: 'inline-flex' }}>{KB_FREQ.map(([k, l]) => <button key={k} type="button" className={f.freq === k ? 'is-on' : ''} onClick={() => setF({ ...f, freq: k })}>{l}</button>)}</div></div>
        </div>
        {tried && errs.length > 0 && <div style={{ padding: '0 20px 10px', fontSize: 12.5, color: 'var(--red)' }}>{errs.join(' · ')}</div>}
        <div className="row gap-2" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" onClick={save}>Crear y sincronizar</button></div>
      </div>
    </div>
  );
}

kbInit();
Object.assign(window, { KnowledgeView });
