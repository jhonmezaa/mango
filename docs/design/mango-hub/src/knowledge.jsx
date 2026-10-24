// Knowledge Bases · lista, detalle y alta. Primera versión (D88): solo S3, por archivos subidos o un bucket que ya existe.
function KnowledgeView({ agents }) {
  const I = window.Icons; const S = window.MangoStore; const K = window.KB;
  const kbs = window.useMango(s => s.kbs) || [];
  window.useMango(s => s.role); window.useMango(s => s.actorOverride);
  const metrics = window.useMango(s => s.simKbMetrics);
  const kbOpen = window.useMango(s => s.kbOpen);
  const canCreate = S.can('agent.create');
  const [q, setQ] = React.useState(''); const [st, setSt] = React.useState('all'); const [src, setSrc] = React.useState('all');
  const [sel, setSel] = React.useState(null); const [start, setStart] = React.useState(null); const [creating, setCreating] = React.useState(false);
  React.useEffect(() => { if (kbOpen) { setStart(null); setSel(kbOpen); S.set({ kbOpen: null }); } }, [kbOpen]);
  const Q = q.trim().toLowerCase();
  const inF = (k, f) => f === 'all' || (f === 'attention' ? K.ATTN.includes(k.status) : K.UNSYNCED.includes(k.status));
  const base = kbs.filter(k => (src === 'all' || k.origin === src) && (!Q || (k.name + ' ' + k.desc + ' ' + k.owner).toLowerCase().includes(Q)));
  const list = base.filter(k => inF(k, st));
  const docsN = kbs.reduce((s, k) => s + K.counts(k).total, 0); const bytesN = kbs.reduce((s, k) => s + K.counts(k).bytes, 0); const tokN = kbs.reduce((s, k) => s + (k.tokens || 0), 0);
  const att = kbs.filter(k => K.ATTN.includes(k.status)).length;
  const inUse = kbs.filter(k => K.agentsOf(k, agents).length).length;
  const open = (id) => { setStart(null); setSel(id); };
  return (
    <>
      <Topbar crumbs={['Construir', 'Knowledge Bases']} actions={canCreate && <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}><I.Plus size={12} /> Nueva knowledge base</button>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Knowledge Bases</h1>
          <p className="page-subtitle">Documentos que los agentes consultan para responder. Se indexan en Bedrock Knowledge Bases de tu instalación. Cada persona recibe solo lo de las knowledge bases en cuyos grupos está, también a través de un agente.</p>
        </div>
        <div className="bg-kpis">
          <div className="card bg-kpi"><span className="bg-kpi-l">Knowledge bases</span><span className="bg-kpi-v">{kbs.length}</span><span className="bg-kpi-s">{inUse} en uso por agentes</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Documentos</span><span className="bg-kpi-v">{K.n(docsN)}</span><span className="bg-kpi-s">{K.bytes(bytesN)}{metrics ? ' · ' + K.tok(tokN) + ' tokens' : ''}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Necesitan atención</span><span className="bg-kpi-v" style={att ? { color: 'var(--amber)' } : null}>{att}</span><span className="bg-kpi-s">{att ? 'Errores, avisos o sin empezar' : 'Todo al día'}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Consultas · 30 días</span>{metrics ? <><span className="bg-kpi-v">{K.tok(kbs.reduce((s, k) => s + (k.q30 || 0), 0))}</span><span className="bg-kpi-s">De los agentes que las usan</span></> : <><span className="bg-kpi-v" style={{ color: 'var(--text-muted)' }}>—</span><span className="bg-kpi-s"><window.SoonTag /></span></>}</div>
        </div>
        <div className="bg-toolbar">
          <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar knowledge base" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar" /></div>
          <div className="tk-quick" role="group" aria-label="Estado">{[['all', 'Todas'], ['attention', 'Necesitan atención'], ['unsynced', 'Sin sincronizar']].map(([f, l]) => <button key={f} className={st === f ? 'is-on' : ''} aria-pressed={st === f} onClick={() => setSt(f)}>{l}<span className="mk-count">{base.filter(k => inF(k, f)).length}</span></button>)}</div>
          <select className="input mk-sel" value={src} onChange={e => setSrc(e.target.value)} aria-label="Fuente"><option value="all">Todas las fuentes</option><option value="upload">S3 · archivos subidos</option><option value="bucket">S3 · bucket</option></select>
        </div>
        <div className="mc-body" style={{ paddingTop: 0 }}>
          <div className="card mc-table">
            <div className="kb-tr mc-th"><span>knowledge base</span><span>fuente</span><span>estado</span><span>tamaño</span><span>acceso</span><span>agentes</span></div>
            {list.map(k => { const Ic = I[k.icon] || I.BookOpen; const s = K.status(k); const sub = K.statusSub(k); const part = K.partial(k, agents); const n = K.agentsOf(k, agents).length; return (
              <button key={k.id} className={'kb-tr' + (k.status === 'deleting' ? ' is-deleting' : '')} onClick={() => open(k.id)}>
                <span className="row gap-3" style={{ minWidth: 0 }}><span className="mc-ic"><Ic size={14} /></span><span style={{ minWidth: 0 }}><span className="mk-name" style={{ display: 'block' }}>{k.name}</span><span className="kb-sub">{k.owner} · {k.desc}</span></span></span>
                <span className="mk-meta">{K.ORIGIN[k.origin]}</span>
                <span className="kb-st"><span className={'badge ' + s.cls}>{s.spin && <span className="g-spin" style={{ width: 9, height: 9, marginRight: 5 }} />}{s.label}</span>{sub && <span className="kb-sub">{sub}</span>}</span>
                <span className="mk-meta mono">{K.size(k)}</span>
                <span className="row gap-1" style={{ flexWrap: 'wrap', minWidth: 0 }}>{k.groups.slice(0, 2).map(g => <span key={g} className="mv-cap">{g}</span>)}{k.groups.length > 2 && <span className="mk-meta">+{k.groups.length - 2}</span>}{part.length > 0 && <span className="badge badge-amber" title={K.partialTip}>Acceso parcial</span>}</span>
                <span className="mk-meta">{n || '—'}</span>
              </button>
            ); })}
            {!list.length && <div className="mk-meta" style={{ padding: 16 }}>{kbs.length ? 'Ninguna coincide.' : 'Aún no hay knowledge bases.'}</div>}
          </div>
        </div>
      </div>
      {sel && <KbDetail key={sel} id={sel} agents={agents} start={start} onClose={() => { setSel(null); setStart(null); }} />}
      {creating && <KbCreate onClose={() => setCreating(false)} onCreated={(id, origin, notSent) => { setCreating(false); setStart(origin === 'upload' ? { tab: 'docs', sub: 'upload' } : notSent ? { tab: 'access', notice: 'Se creó la knowledge base, pero no se pudo enviar el bucket. Propónlo en «Acceso y sync».' } : null); setSel(id); }} />}
    </>
  );
}

function KbDetail({ id, agents, start, onClose }) {
  const I = window.Icons; const K = window.KB; const toast = window.useToast?.();
  const k = window.useMango(s => (s.kbs || []).find(x => x.id === id));
  window.useMango(s => s.role); window.useMango(s => s.actorOverride);
  const reqs = window.useMango(s => s.kbReqs) || [];
  const [tab, setTab] = React.useState(start?.tab || 'info'); const [sub, setSub] = React.useState(start?.sub || null);
  const [syncErr, setSyncErr] = React.useState(null);
  const guard = React.useRef(null);
  const ask = (fn) => { if (guard.current && guard.current(fn) === false) return; fn(); };
  const tryClose = () => ask(onClose);
  const goTab = (t, s = null) => ask(() => { setTab(t); setSub(s); });
  React.useEffect(() => { if (!k) onClose(); }, [!k]);
  React.useEffect(() => { const h = e => { if (e.key === 'Escape') tryClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const [, tick] = React.useState(0);
  React.useEffect(() => { if (k?.status !== 'syncing') return; const t = setInterval(() => tick(x => x + 1), 250); return () => clearInterval(t); }, [k?.status]);
  if (!k) return null;
  const acc = K.access(k); const s = K.status(k); const c = K.counts(k);
  const users = K.agentsOf(k, agents); const part = K.partial(k, agents);
  const bucket = k.origin === 'bucket'; const del = k.status === 'deleting';
  const req = reqs.find(r => r.kb === k.id && r.status === 'pending'); const lastReq = reqs.find(r => r.kb === k.id);
  const Ic = I[k.icon] || I.BookOpen;
  const tabs = [['info', 'Resumen'], ['docs', 'Documentos' + (acc.seeDocs && c.failed ? ' · ' + c.failed + ' con error' : '')], ['test', 'Probar búsqueda'], ['access', bucket ? 'Acceso y sync' : 'Acceso']];
  const syncNow = () => { setSyncErr(null); const r = K.sync(k.id); if (r === 'busy') setSyncErr('Ya hay una sincronización en curso de esta knowledge base. Espera a que termine.'); else if (r === 'failed') setSyncErr('No se pudo empezar la sincronización. Inténtalo de nuevo.'); else if (r === 'started') toast?.({ tone: 'info', msg: 'Sincronizando ' + k.name }); };
  const noSync = ['syncing', 'approval', 'rejected', 'nosource'].includes(k.status);
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && tryClose()}>
      <aside className="mk-drawer kb-drawer" role="dialog" aria-modal="true" aria-label={k.name}>
        <div className="mk-drawer-h">
          <span className="mc-ic lg"><Ic size={20} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{k.name}</div>
            <div className="row gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}><span className={'badge ' + s.cls}>{s.spin && <span className="g-spin" style={{ width: 9, height: 9, marginRight: 5 }} />}{s.label}</span><span className="mk-meta">S3 · {bucket ? 'bucket' : 'archivos subidos'} · {k.owner}{acc.owner ? ' (tú)' : ''}</span></div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={tryClose}><I.Close size={14} /></button>
        </div>
        <div className="tk-tabs kb-tabs" role="tablist">{tabs.map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => goTab(t)}>{l}</button>)}</div>
        <div className="mk-drawer-b">
          {tab === 'info' && <KbSummary k={k} acc={acc} c={c} users={users} part={part} req={req} lastReq={lastReq} goTab={goTab} />}
          {tab === 'docs' && <window.KbDocsTab k={k} acc={acc} sub={sub} setSub={setSub} guard={guard} />}
          {tab === 'test' && <window.KbTestTab k={k} acc={acc} />}
          {tab === 'access' && <KbAccessTab k={k} acc={acc} users={users} req={req} lastReq={lastReq} notice={start?.notice} />}
        </div>
        {acc.canEdit && !del && (bucket
          ? <div className="mc-foot"><div className="row gap-2" style={{ flexWrap: 'wrap' }}><button className="btn btn-sm" disabled={noSync} onClick={syncNow}><I.Refresh size={12} /> {k.status === 'syncing' ? 'Sincronizando…' : 'Sincronizar ahora'}</button>{k.status === 'approval' && <span className="mk-meta">Se sincroniza sola cuando se apruebe el bucket.</span>}{['rejected', 'nosource'].includes(k.status) && <span className="mk-meta">Propón un bucket en «Acceso y sync».</span>}</div>{syncErr && <div className="kb-err" role="alert" style={{ marginTop: 8 }}>{syncErr}</div>}</div>
          : !(tab === 'docs' && sub === 'upload') && <div className="mc-foot"><button className="btn btn-sm" onClick={() => goTab('docs', 'upload')}><I.Document size={12} /> Subir archivos</button></div>)}
      </aside>
    </div>
  );
}

function KbSummary({ k, acc, c, users, part, req, lastReq, goTab }) {
  const I = window.Icons; const K = window.KB;
  const metrics = window.useMango(s => s.simKbMetrics);
  const bucket = k.origin === 'bucket';
  const prep = k.status === 'syncing' && k.prepUntil > Date.now();
  const elapsed = k.syncStarted ? Math.max(0, Math.min(0.95, (Date.now() - k.syncStarted) / 3200)) : 0;
  const partIds = part.map(x => x.a.id);
  const used = k.lastSync ? 'Los agentes siguen usando lo indexado ' + K.ago(k.lastSync) + '.' : 'Todavía no hay nada indexado.';
  return (
    <>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{k.desc}</p>
      {k.status === 'deleting' && <div className="mc-alert" role="status"><span className="g-spin" /><div><b>Borrando.</b> Ya no se usa en respuestas nuevas. Sale de la lista cuando se comprueba que ningún agente puede recibir sus fragmentos.</div></div>}
      {prep && <div className="mc-alert" role="status"><span className="g-spin" /><div>Preparando el acceso al bucket aprobado: puede tardar hasta 2 minutos. Después empieza la sincronización.</div></div>}
      {k.status === 'syncing' && !prep && <div className="mc-alert" role="status"><span className="g-spin" /><div style={{ flex: 1, minWidth: 0 }}>{bucket ? <>Sincronizando desde <span className="mono" style={{ overflowWrap: 'anywhere' }}>{k.ref}</span>…</> : 'Indexando los archivos guardados…'}<div className="mk-bar-track" style={{ marginTop: 6 }}><span style={{ width: elapsed * 100 + '%', background: 'var(--blue)' }} /></div></div></div>}
      {k.status === 'warn' && k.capped && <div className="mc-alert amber"><I.Warn size={14} /><div>{K.capText}{acc.canEdit && K.capHint}</div></div>}
      {k.status === 'warn' && acc.seeDocs && c.failed > 0 && <div className="mc-alert amber"><I.Warn size={14} /><div>{c.failed} {c.failed === 1 ? 'documento no se pudo indexar: los agentes no lo ven.' : 'documentos no se pudieron indexar: los agentes no los ven.'} <button className="sr-link" onClick={() => goTab('docs')}>Ver cuáles</button></div></div>}
      {k.status === 'warn' && !acc.seeDocs && !k.capped && <div className="mc-alert amber"><I.Warn size={14} /><div>Algunos documentos no se pudieron indexar: los agentes no los ven.</div></div>}
      {k.status === 'error' && <div className="mc-alert red"><I.X2 size={14} /><div>{K.errText(k)} {used}{acc.canEdit && ' Vuelve a intentarlo con «Sincronizar ahora». Si sigue fallando, pide a quien administra AWS que revise el bucket.'}</div></div>}
      {k.status === 'blocked' && <div className="mc-alert amber"><I.Warn size={14} /><div>{K.blockText(k)} {used}{acc.canEdit && K.blockHint}</div></div>}
      {k.status === 'pending' && <div className="mc-alert"><I.Info size={14} /><div>{bucket ? 'Nunca se ha sincronizado: los agentes aún no pueden consultarla.' : 'Todavía no tiene documentos.'}{!bucket && acc.canEdit && <> <button className="sr-link" onClick={() => goTab('docs', 'upload')}>Subir archivos</button></>}</div></div>}
      {k.status === 'approval' && <div className="mc-alert amber"><I.Clock size={14} /><div><b>Pendiente de aprobación.</b> {req?.by === acc.me ? 'Propusiste' : (req?.by || 'Alguien') + ' propuso'} leer <span className="mono" style={{ overflowWrap: 'anywhere' }}>{k.ref}</span>. Lo aprueba un administrador distinto de quien lo propuso; mientras tanto no se lee nada.</div></div>}
      {k.status === 'rejected' && <div className="mc-alert red"><I.X2 size={14} /><div><b>Bucket rechazado.</b> {lastReq?.decidedBy || 'Un administrador'} rechazó leer <span className="mono" style={{ overflowWrap: 'anywhere' }}>{k.ref}</span>{lastReq?.note ? ': «' + lastReq.note + '»' : ''}. {acc.canEdit && <button className="sr-link" onClick={() => goTab('access')}>Proponer otro bucket</button>}</div></div>}
      {k.status === 'nosource' && <div className="mc-alert"><I.Info size={14} /><div><b>Sin bucket.</b> {k.noSource === 'notsent' ? 'La propuesta del bucket no llegó a enviarse: no se lee nada.' : k.noSource === 'withdrawn' || lastReq?.status === 'withdrawn' ? 'Se retiró la propuesta: no se lee nada.' : 'No tiene un bucket propuesto: no se lee nada.'} {acc.canEdit && <button className="sr-link" onClick={() => goTab('access')}>Proponer un bucket</button>}</div></div>}
      {part.length > 0 && <div className="mc-alert amber"><I.Warn size={14} /><div style={{ minWidth: 0 }}><b>Acceso parcial.</b> Estos grupos usan un agente que la consulta pero no están en esta knowledge base. A esas personas el agente les responde sin su contenido: la búsqueda se hace con la identidad de quien pregunta.
        <div className="kb-gaps">{part.map(x => <div key={x.a.id}><span>{x.a.name}</span><span className="mono">{x.groups.join(', ')}</span></div>)}</div>
        Si deben recibirlo, agrega esos grupos en «Acceso».</div></div>}
      <MkSec title="Contenido">
        <div className="mk-kv"><span>Documentos</span><span className="mono">{acc.seeDocs ? K.n(c.indexed) + (c.failed ? ' · ' + c.failed + ' sin indexar' : '') + (c.busy ? ' · ' + c.busy + ' en curso' : '') : K.n(c.total)}</span></div>
        {metrics && <div className="mk-kv"><span>Fragmentos</span><span className="mono">{k.chunks ? K.n(k.chunks) : '—'}</span></div>}
        <div className="mk-kv"><span>Tamaño</span><span className="mono">{metrics && k.tokens ? K.tok(k.tokens) + ' tokens' : c.total ? K.bytes(c.bytes) + (metrics ? ' · los tokens se conocen al indexar' : '') : '—'}</span></div>
        <div className="mk-kv"><span>Topes</span><span>{K.n(c.total)} de {K.n(K.LIMITS.docs)} documentos · {K.bytes(c.bytes)} de 5 GB</span></div>
        <div className="mk-kv"><span>Embeddings</span><span>Amazon Titan Embeddings v2 · Bedrock</span></div>
      </MkSec>
      <MkSec title="Fuente">
        <div className="mk-kv"><span>Origen</span><span>S3 · {bucket ? 'un bucket que ya existe' : 'archivos subidos desde Mango'}</span></div>
        {bucket && <div className="mk-kv"><span>Bucket</span><span className="mono" style={{ fontSize: 12 }}>{k.ref}</span></div>}
        {bucket && <div className="mk-kv"><span>Última sincronización</span><span>{k.lastSync ? K.ago(k.lastSync) : 'Nunca'}</span></div>}
        {bucket && k.lastTry && <div className="mk-kv"><span>Último intento</span><span>{K.ago(k.lastTry)}</span></div>}
        {bucket ? <div className="mk-kv"><span>Frecuencia</span><span>{K.freqLabel(k.freq)}</span></div> : <div className="mk-kv"><span>Indexación</span><span>Al guardar cada archivo{k.lastSync ? ' · la última ' + K.ago(k.lastSync) : ''}</span></div>}
      </MkSec>
      <MkSec title={`Agentes que la usan · ${users.length}`}>
        {users.length ? users.map(a => <div key={a.id} className="mk-line row between"><span>{a.name}</span><span className="mk-meta">{partIds.includes(a.id) ? 'Lo usan grupos sin acceso' : a.cat}</span></div>) : <div className="mk-meta">Ninguno todavía. Se asocia en el Agent Builder, con una versión nueva del agente.</div>}
        {users.length > 0 && !c.indexed && <div className="mk-meta" style={{ marginTop: 4 }}>Mientras no tenga nada indexado, responden sin ella.</div>}
      </MkSec>
      <MkSec title="Uso · 30 días"><div className="mk-kv"><span>Consultas de agentes</span>{metrics ? <span className="mono">{K.n(k.q30 || 0)}</span> : <span><window.SoonTag /></span>}</div></MkSec>
    </>
  );
}

function KbAccessTab({ k, acc, users, req, lastReq, notice }) {
  const I = window.Icons; const S = window.MangoStore; const K = window.KB; const L = window.Lifecycle; const toast = window.useToast?.();
  const reqs = window.useMango(s => s.kbReqs) || [];
  const groupNames = (S.get().groupDefs || []).map(g => g.id);
  const [groups, setGroups] = React.useState(k.groups); const [freq, setFreq] = React.useState(k.freq || '24h');
  const reopen = !!notice && k.status === 'nosource';
  const [editRef, setEditRef] = React.useState(reopen); const [ref, setRef] = React.useState(reopen ? k.ref || '' : ''); const [refErr, setRefErr] = React.useState(null); const [sending, setSending] = React.useState(false);
  const [confirmDel, setConfirmDel] = React.useState(false);
  const bucket = k.origin === 'bucket'; const edit = acc.canEdit && k.status !== 'deleting';
  const dirty = JSON.stringify(groups) !== JSON.stringify(k.groups) || (bucket && freq !== k.freq);
  const mineIn = groups.some(g => acc.groups.includes(g));
  const okReq = reqs.find(r => r.kb === k.id && r.status === 'approved' && r.ref === k.ref);
  const canPropose = edit && bucket && !req;
  const save = () => { K.updateCfg(k.id, { groups, ...(bucket ? { freq } : {}) }); toast?.({ tone: 'success', msg: 'Cambios guardados' }); };
  const sendRef = () => {
    const v = ref.trim(); const e = K.refErr(v) || (L.findSecret(v) && 'No pegues credenciales en la ubicación');
    if (e) { setRefErr(e); return; }
    setSending(true);
    setTimeout(() => { setSending(false); const se = K.checkRef(k.id, v); if (se) { setRefErr(se); return; } K.propose(k.id, v); setEditRef(false); setRef(''); toast?.({ tone: 'success', msg: 'Propuesta enviada · la aprueba otro administrador' }); }, 600);
  };
  const names = users.map(a => a.name).join(', ');
  return (
    <>
      {notice && k.status === 'nosource' && <div className="mc-alert amber" role="alert"><I.Warn size={14} /><div>{notice}</div></div>}
      <MkSec title="Grupos que pueden consultarla">
        <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{groupNames.map(g => { const on = groups.includes(g); return <button key={g} type="button" disabled={!edit} aria-pressed={on} className={'tweak-chip ab-chip' + (on ? ' is-on' : '')} onClick={() => setGroups(on ? groups.filter(x => x !== g) : [...groups, g])}>{on && <I.Check size={10} />}{g}</button>; })}</div>
        {edit && groups.length > 0 && !mineIn && <div className="mc-alert amber" style={{ marginTop: 8 }}><I.Warn size={14} /><div>No estás en ninguno de estos grupos: verás sus documentos, pero no podrás probar la búsqueda ni recibir su contenido en el chat.</div></div>}
        <div className="mk-meta" style={{ marginTop: 6, lineHeight: 1.5 }}>Solo las personas de estos grupos reciben su contenido, también a través de un agente: la búsqueda se hace con la identidad de quien pregunta. Si un agente que la consulta lo usan otros grupos, se marca «Acceso parcial».</div>
      </MkSec>
      {bucket && <MkSec title="Bucket">
        <div className="mk-kv"><span>{k.status === 'approval' ? 'Propuesto' : k.status === 'rejected' ? 'Rechazado' : k.status === 'nosource' ? (k.noSource === 'notsent' ? 'No se envió' : 'Retirado') : 'Lee de'}</span><span className="mono" style={{ fontSize: 12 }}>{k.ref || '—'}</span></div>
        {k.bucketOk && okReq && <div className="mk-kv"><span>Lo aprobó</span><span>{okReq.decidedBy} · {K.ago(okReq.decidedAt)}</span></div>}
        {req && <div className="mc-alert amber" style={{ marginTop: 6 }}><I.Clock size={14} /><div style={{ minWidth: 0 }}>{req.prev ? <>Cambio propuesto a <span className="mono" style={{ overflowWrap: 'anywhere' }}>{req.ref}</span>. Mientras otro administrador lo decide, sigue sincronizando desde el actual.</> : 'Espera a que lo apruebe un administrador distinto de quien lo propuso.'}{req.by === acc.me && <div style={{ marginTop: 8 }}><button type="button" className="btn btn-sm" onClick={() => { K.withdraw(req.id); toast?.({ tone: 'info', msg: 'Propuesta retirada' }); }}>Retirar propuesta</button></div>}</div></div>}
        {!req && lastReq?.prev && lastReq.status === 'rejected' && <div className="mk-meta">Se rechazó el cambio a <span className="mono">{lastReq.ref}</span>{lastReq.note ? ': «' + lastReq.note + '»' : ''}.</div>}
        {canPropose && !editRef && <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => { setEditRef(true); setRef(k.bucketOk || k.status === 'nosource' ? k.ref || '' : ''); setRefErr(null); }}>{k.bucketOk ? 'Cambiar bucket o prefijo' : k.status === 'nosource' ? 'Proponer un bucket' : 'Proponer otro bucket'}</button>}
        {editRef && <div className="kb-ref-form">
          <label htmlFor="kb-ref" style={{ fontSize: 12.5, fontWeight: 500 }}>Bucket y prefijo</label>
          <input id="kb-ref" className="input mono" value={ref} onChange={e => { setRef(e.target.value); setRefErr(null); }} placeholder="s3://bucket/prefijo/" autoFocus aria-invalid={!!refErr} />
          {refErr && <div className="kb-err" role="alert">{refErr}</div>}
          <div className="mk-meta" style={{ lineHeight: 1.5 }}>Es una propuesta nueva: la aprueba un administrador distinto de ti.{k.bucketOk ? ' Mientras tanto sigue sincronizando desde el actual.' : ''}</div>
          <div className="row gap-2"><button type="button" className="btn btn-sm btn-primary" disabled={sending || !ref.trim()} onClick={sendRef}>{sending ? 'Enviando…' : 'Enviar a aprobación'}</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditRef(false)}>Cancelar</button></div>
        </div>}
        <div className="mk-meta" style={{ marginTop: 6, lineHeight: 1.5 }}>Solo buckets de la cuenta de AWS de la instalación. Lo que hay en el prefijo se copia a Mango en cada sincronización; lo que se borra del bucket sale en la siguiente. Al proponerlo se rechazan los buckets de Mango, los de otras cuentas y los cifrados con una llave propia del cliente (KMS), que esta versión no puede leer.</div>
      </MkSec>}
      {bucket ? <MkSec title="Sincronización">
        <div className="tk-quick" style={{ display: 'inline-flex', flexWrap: 'wrap' }}>{K.FREQS.map(([f, l]) => <button key={f} type="button" disabled={!edit} aria-pressed={freq === f} className={freq === f ? 'is-on' : ''} onClick={() => setFreq(f)}>{l}</button>)}</div>
        <div className="mk-meta" style={{ marginTop: 6 }}>Solo para el bucket. «Sincronizar ahora» está abajo.</div>
      </MkSec> : <MkSec title="Indexación"><div className="mk-meta" style={{ lineHeight: 1.5 }}>Cada archivo se indexa al guardarlo; no hay sincronización. Para actualizar un documento, quítalo y vuelve a subirlo.</div></MkSec>}
      {edit && <div className="row gap-2"><button type="button" className="btn btn-sm btn-primary" disabled={!dirty || !groups.length} onClick={save}>Guardar cambios</button>{!groups.length && <span style={{ fontSize: 12, color: 'var(--red)' }}>Elige al menos un grupo</span>}</div>}
      {edit && <div className="kb-danger">
        <div className="mk-sec-t">borrar</div>
        <div className="mk-meta" style={{ lineHeight: 1.5 }}>{users.length ? <>No se puede borrar: la usa {names}, ya {users.length === 1 ? 'publicado' : 'publicados'}. Quítala en una versión nueva de {users.length === 1 ? 'ese agente' : 'esos agentes'} y vuelve a intentarlo.</> : <>Se borran sus documentos indexados de Mango{bucket ? '; el bucket no se toca' : ''}. Sale de la lista cuando se comprueba que ningún agente puede recibir sus fragmentos.</>}</div>
        {!confirmDel ? <button type="button" className="btn btn-sm mk-danger" disabled={users.length > 0} onClick={() => setConfirmDel(true)}><I.Trash size={12} /> Borrar knowledge base</button>
          : <div className="kb-confirm"><span>¿Borrar {k.name}? No se puede deshacer.</span><span className="row gap-2"><button type="button" className="btn btn-sm mk-danger" onClick={() => { K.remove(k.id); setConfirmDel(false); toast?.({ tone: 'info', msg: 'Borrando ' + k.name }); }}>Borrar</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmDel(false)}>Cancelar</button></span></div>}
      </div>}
    </>
  );
}

function KbCreate({ onClose, onCreated }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle; const K = window.KB; const toast = window.useToast?.();
  const me = K.me();
  const [f, setF] = React.useState({ name: '', desc: '', origin: 'upload', ref: '', groups: [], freq: '24h' });
  const [tried, setTried] = React.useState(false); const [srvErr, setSrvErr] = React.useState(null); const [sending, setSending] = React.useState(false);
  const bucket = f.origin === 'bucket'; const refErr = bucket ? K.refErr(f.ref) : null;
  const errs = [!f.name.trim() && 'Escribe un nombre', refErr, !f.groups.length && 'Elige al menos un grupo', (L.findSecret(f.ref) || L.findSecret(f.desc) || L.findSecret(f.name)) && 'No pegues credenciales'].filter(Boolean);
  const mineIn = f.groups.some(g => me.groups.includes(g));
  React.useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const save = () => {
    setTried(true); setSrvErr(null); if (errs.length) return;
    if (!bucket) { const { id } = K.create(f); toast?.({ tone: 'success', msg: 'Creada · sube sus archivos' }); onCreated(id, 'upload'); return; }
    setSending(true);
    setTimeout(() => { setSending(false); const se = K.checkRef(null, f.ref.trim()); if (se) { setSrvErr(se); return; } const { id, notSent } = K.create(f); if (!notSent) toast?.({ tone: 'success', msg: 'Creada · el bucket espera aprobación' }); onCreated(id, 'bucket', notSent); }, 650);
  };
  const groupNames = (S.get().groupDefs || []).map(g => g.id);
  const Lb = ({ children, htmlFor }) => <label htmlFor={htmlFor} className="kb-lb">{children}</label>;
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div className="card kb-create" role="dialog" aria-modal="true" aria-labelledby="kb-create-t" onClick={e => e.stopPropagation()}>
        <div className="row between kb-create-h"><div><div id="kb-create-t" style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>Nueva knowledge base</div><div className="mk-meta" style={{ marginTop: 2 }}>Se indexa en Bedrock Knowledge Bases de tu instalación. No hay credenciales que ingresar.</div></div><button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button></div>
        <div className="kb-create-b">
          <div><Lb htmlFor="kb-n">Nombre</Lb><input id="kb-n" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus maxLength={48} /></div>
          <div><Lb htmlFor="kb-d">Descripción</Lb><input id="kb-d" className="input" value={f.desc} onChange={e => setF({ ...f, desc: e.target.value })} maxLength={140} placeholder="Qué contiene y para qué sirve" /></div>
          <div><Lb>Fuente</Lb><div className="kb-src" role="group" aria-label="Fuente"><button type="button" className="tweak-chip ab-chip is-on" aria-pressed="true"><I.Check size={10} />S3</button>{['Confluence', 'Google Drive', 'GitHub'].map(x => <button key={x} type="button" className="tweak-chip ab-chip" disabled aria-disabled="true" title="Próximamente">{x} <window.SoonTag /></button>)}</div></div>
          <div><Lb>Cómo llegan los documentos</Lb>
            <div className="kb-origin-opts" role="radiogroup" aria-label="Cómo llegan los documentos">{[['upload', 'Subir archivos', 'PDF, DOCX, TXT, MD, CSV o XLSX desde tu equipo. Se indexan al guardarlos.'], ['bucket', 'Un bucket que ya existe', 'Un prefijo de la cuenta de AWS de la instalación. Lo aprueba otro administrador y se sincroniza con la frecuencia que elijas.']].map(([v, t, d]) => <button key={v} type="button" role="radio" aria-checked={f.origin === v} className={'kb-opt' + (f.origin === v ? ' is-on' : '')} onClick={() => { setF({ ...f, origin: v }); setSrvErr(null); }}><b>{t}</b><span>{d}</span></button>)}</div>
            <div className="mk-meta" style={{ marginTop: 6, lineHeight: 1.5 }}>No se cambia después. Para combinar las dos, crea una de cada una y asócialas al mismo agente (hasta {K.LIMITS.perAgent} por agente).</div>
          </div>
          {bucket && <div><Lb htmlFor="kb-r">Bucket y prefijo</Lb><input id="kb-r" className="input mono" value={f.ref} onChange={e => { setF({ ...f, ref: e.target.value }); setSrvErr(null); }} placeholder="s3://bucket/prefijo/" aria-invalid={!!(srvErr || (tried && refErr))} />
            {(srvErr || (tried && refErr)) && <div className="kb-err" role="alert">{srvErr || refErr}</div>}
            <div className="mk-meta" style={{ marginTop: 6, lineHeight: 1.5 }}>Solo buckets de la cuenta de AWS de la instalación. Al enviar se rechazan los de Mango, los de otras cuentas y los cifrados con una llave propia del cliente (KMS), que esta versión no puede leer.</div>
          </div>}
          {bucket && <div><Lb>Sincronización</Lb><div className="tk-quick" style={{ display: 'inline-flex', flexWrap: 'wrap' }}>{K.FREQS.map(([v, l]) => <button key={v} type="button" aria-pressed={f.freq === v} className={f.freq === v ? 'is-on' : ''} onClick={() => setF({ ...f, freq: v })}>{l}</button>)}</div></div>}
          <div><Lb>Grupos que pueden consultarla</Lb><div className="row gap-1" style={{ flexWrap: 'wrap' }}>{groupNames.map(g => { const on = f.groups.includes(g); return <button key={g} type="button" aria-pressed={on} className={'tweak-chip ab-chip' + (on ? ' is-on' : '')} onClick={() => setF({ ...f, groups: on ? f.groups.filter(x => x !== g) : [...f.groups, g] })}>{on && <I.Check size={10} />}{g}</button>; })}</div>
            {f.groups.length > 0 && !mineIn && <div className="mc-alert amber" style={{ marginTop: 8 }}><I.Warn size={14} /><div>No estás en ninguno de estos grupos: verás sus documentos, pero no podrás probar la búsqueda ni recibir su contenido en el chat.</div></div>}
            <div className="mk-meta" style={{ marginTop: 6, lineHeight: 1.5 }}>Solo sus personas reciben el contenido, también a través de un agente.</div>
          </div>
        </div>
        {tried && errs.length > 0 && <div className="kb-create-err" role="alert">{errs.join(' · ')}</div>}
        <div className="row gap-2 kb-create-f">{bucket && <span className="mk-meta" style={{ marginRight: 'auto' }}>Lo aprueba un administrador distinto de ti.</span>}<button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={sending} onClick={save}>{sending ? 'Enviando…' : bucket ? 'Crear y enviar a aprobación' : 'Crear y subir archivos'}</button></div>
      </div>
    </div>
  );
}

Object.assign(window, { KnowledgeView });
