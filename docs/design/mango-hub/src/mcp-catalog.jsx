// Catálogo de MCP: conectores de Mango + MCP packs de AWS
const MCP_SIM_ERR = {
  identity: 'El pack cambió de modo de identidad. Deshabilítalo y vuelve a habilitarlo para aplicar el cambio.',
  generic: 'No se pudo completar la acción. Inténtalo de nuevo.',
};
const mcpModeOf = (s) => s.level !== 'accounts' ? null : (s.mode === 'central' || s.tools.some(t => t.scope === 'org')) ? 'central' : 'user';
function McpMode({ s }) {
  const avail = window.useMango(st => st.avail); const md = mcpModeOf(s);
  if (!avail || !md) return null;
  return md === 'central' ? <span className="badge badge-violet" title="Responde por toda la organización. Solo usuarios centrales pueden usar sus tools.">Solo centrales</span> : <span className="badge" title="Filtra por el usuario que pregunta. Se puede compartir con grupos de área.">Por usuario</span>;
}
function McpCatalog({ agents, setView }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const cat = window.useMango(s => s.mcpCatalog);
  window.useMango(s => s.role);
  const [tab, setTab] = useState('catalog');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const [level, setLevel] = useState('all');
  const [sel, setSel] = useState(null);
  const isAdmin = S.get().role === 'admin';
  const requests = cat.filter(s => s.status === 'pending' || s.update || s.paramReq);
  const allTools = cat.flatMap(s => s.tools.map(t => ({ s, t })));
  const Q = q.trim().toLowerCase();
  const list = cat.filter(s => (kind === 'all' || s.kind === kind) && (status === 'all' || s.status === status) && (level === 'all' || s.level === level) && (!Q || (s.name + ' ' + s.id + ' ' + s.desc + ' ' + s.tools.map(t => t.name).join(' ')).toLowerCase().includes(Q)))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'pack' ? -1 : 1) || a.name.localeCompare(b.name, 'es'));
  const anyFilter = Q || kind !== 'all' || status !== 'all' || level !== 'all';
  const selected = sel && cat.find(s => s.id === sel);
  const stCount = (k) => cat.filter(s => s.status === k).length;

  return (
    <>
      <Topbar crumbs={['Construir', 'Catálogo de MCP']} actions={
        <button className="btn btn-sm" disabled title="Próximamente. Solo admitirá autenticación OAuth: sin Access Key/Secret ni Basic Auth."><I.Plus size={12} /> Conectar MCP por URL <span className="badge" style={{ fontSize: 10.5, marginLeft: 4 }}>Próximamente</span></button>
      } />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Catálogo de MCP</h1>
          <p className="page-subtitle">Conectores incluidos en Mango y MCP packs de AWS. Un pack lo pide un administrador y lo aprueba otro distinto; después la plataforma lo instala.</p>
        </div>
        <div className="ap-bar">
          <div className="mk-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'catalog'} className={tab === 'catalog' ? 'is-on' : ''} onClick={() => setTab('catalog')}>Catálogo<span className="mk-count">{cat.length}</span></button>
            <button role="tab" aria-selected={tab === 'tools'} className={tab === 'tools' ? 'is-on' : ''} onClick={() => setTab('tools')}>Tools<span className="mk-count">{allTools.length}</span></button>
            <button role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'is-on' : ''} onClick={() => setTab('requests')}>Solicitudes pendientes{requests.length > 0 && <span className="mk-count">{requests.length}</span>}</button>
          </div>
          {tab === 'catalog' && (
            <div className="ap-filters">
              <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar MCP o tool" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar en el catálogo" /></div>
              <div className="tk-quick" role="group" aria-label="Tipo">
                {[['all', 'Todos'], ['connector', 'Conectores de Mango'], ['pack', 'MCP packs']].map(([k, l]) => <button key={k} className={kind === k ? 'is-on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
              </div>
              <select className="input mk-sel" value={status} onChange={e => setStatus(e.target.value)} aria-label="Estado">
                <option value="all">Cualquier estado</option>{Object.entries(L.MCP_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l} · {stCount(k)}</option>)}
              </select>
              <select className="input mk-sel" value={level} onChange={e => setLevel(e.target.value)} aria-label="Nivel de datos">
                <option value="all">Cualquier nivel de datos</option>{Object.entries(L.DATA_LEVEL).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {anyFilter && <button className="btn btn-sm btn-ghost" onClick={() => { setQ(''); setKind('all'); setStatus('all'); setLevel('all'); }}>Limpiar</button>}
            </div>
          )}
        </div>

        <div className="mc-body">
          {tab === 'catalog' ? (
            list.length === 0 ? <div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600 }}>Nada coincide</div><div className="mk-meta">Prueba con otra búsqueda o quita algún filtro.</div></div> : (
              <div className="card mc-table">
                <div className="mc-tr mc-th"><span>mcp</span><span>estado</span><span>nivel de datos</span><span>tools</span><span>agentes</span><span>salud</span></div>
                {list.map(s => <McpRow key={s.id} s={s} onOpen={() => setSel(s.id)} />)}
              </div>
            )
          ) : (
            tab === 'tools' ? <McpToolsTable rows={allTools} onOpen={setSel} /> : <McpRequests requests={requests} isAdmin={isAdmin} onOpen={setSel} />
          )}
        </div>
      </div>
      {selected && <McpDetail s={selected} isAdmin={isAdmin} onClose={() => setSel(null)} setView={setView} />}
    </>
  );
}

function McpLevel({ level }) { const L = window.Lifecycle; const [l, c] = L.DATA_LEVEL[level]; return <span className={'badge ' + c} title={level === 'accounts' ? 'Solo roles centrales; nunca líderes de área' : level === 'write' ? 'Incluye tools que modifican recursos' : 'Información pública'}>{l}</span>; }
function McpStatus({ s }) { const L = window.Lifecycle; if (s.status === 'soon') return <window.SoonTag />; const [l, c] = L.MCP_STATUS[s.status]; return <span className={'badge ' + c}>{s.status === 'installing' && <span className="g-spin" style={{ width: 9, height: 9, marginRight: 5 }} />}{l}</span>; }
function McpHealth({ s }) {
  if (window.MangoStore.get().avail) return <window.SoonTag />;
  if (!s.metrics || s.status !== 'enabled') return <span className="mk-meta">Sin datos</span>;
  const m = s.metrics;
  return <span className="row gap-2" style={{ fontSize: 12 }}><span className={`dot dot-${m.health === 'ok' ? 'green' : m.health === 'warn' ? 'amber' : 'red'}`} /><span className="mono">{m.latency} ms</span><span className="mk-meta">· {m.calls24h?.toLocaleString('es-MX')}/24 h</span></span>;
}

function McpRow({ s, onOpen }) {
  const L = window.Lifecycle; const I = window.Icons;
  const w = s.tools.filter(t => t.write).length;
  const used = L.usedBy(s.id).length;
  return (
    <button className="mc-tr" onClick={onOpen}>
      <span className="row gap-3" style={{ minWidth: 0 }}>
        <span className={'mc-ic ' + s.kind}>{s.kind === 'pack' ? <I.Cloud size={14} /> : <I.Command size={14} />}</span>
        <span style={{ minWidth: 0 }}>
          <span className="mk-name" style={{ display: 'block' }}>{s.name}</span>
          <span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.kind === 'pack' ? 'MCP pack · ' + s.provider : 'Conector de Mango'} · <span className="mono">{s.id}</span></span>
        </span>
      </span>
      <span className="row gap-1" style={{ flexWrap: 'wrap' }}><McpStatus s={s} />{s.update && <span className="badge badge-amber" title="Actualización con cambios en tools pendiente de aprobación">Actualización</span>}</span>
      <span className="row gap-1" style={{ flexWrap: 'wrap' }}><McpLevel level={s.level} /><McpMode s={s} /></span>
      <span className="mk-meta">{s.tools.length}{w ? <> · <span style={{ color: 'var(--amber)' }}>{w} de escritura</span></> : ' · lectura'}</span>
      <span className="mk-meta">{used || '—'}</span>
      <McpHealth s={s} />
    </button>
  );
}

function McpRequests({ requests, isAdmin, onOpen }) {
  const I = window.Icons;
  if (!requests.length) return <div className="mk-empty"><I.Check2 size={22} style={{ color: 'var(--green)' }} /><div style={{ fontSize: 14, fontWeight: 600 }}>No hay solicitudes pendientes</div><div className="mk-meta">Cuando un administrador pida habilitar un pack o llegue una actualización con cambios en tools, aparecerá aquí.</div></div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {[['theirs', 'Esperan tu aprobación'], ['mine', 'Pediste tú']].map(([grp, title]) => { const me = window.MangoStore.actor(); const byOf = (s) => (s.status === 'pending' ? s.request?.by : s.update ? s.update.by : s.paramReq?.by); const part = requests.filter(s => (byOf(s) === me) === (grp === 'mine')); if (!part.length) return null; return <React.Fragment key={grp}><div className="mk-sec-t" style={{ marginTop: grp === 'mine' ? 12 : 0 }}>{title.toLowerCase()} · {part.length}</div>{part.map(s => {
        const isUpd = s.status !== 'pending' && !!s.update; const isPar = s.status !== 'pending' && !s.update && !!s.paramReq;
        return (
          <div key={s.id + (isUpd ? '-u' : '')} className="card mc-req">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row gap-2" style={{ flexWrap: 'wrap' }}><span className="mk-name">{s.name}</span><span className="badge">{isUpd ? 'Actualización ' + s.version + ' → ' + s.update.version : isPar ? 'Cambio de parámetros' : 'Habilitar'}</span><McpLevel level={s.level} /><McpMode s={s} /></div>
              <div className="mk-meta" style={{ marginTop: 3 }}>Pedido por {isUpd ? s.update.by : isPar ? s.paramReq.by : s.request.by} · {window.fmtAgo(isUpd ? s.update.at : isPar ? s.paramReq.at : s.request.at)}{isPar ? ' · región ' + s.params[0]?.value + ' → ' + s.paramReq.params.region : !isUpd && s.request?.params?.region ? ' · región ' + s.request.params.region : ''}</div>
              {!isUpd && !isPar && s.request?.reason && <div style={{ fontSize: 13, marginTop: 6 }}>“{s.request.reason}”</div>}
              {isUpd && <div style={{ fontSize: 13, marginTop: 6 }}>{s.update.added.length > 0 && <>Agrega {s.update.added.map(t => <code key={t.name} className="mc-tool-chip add">{t.name}{t.write ? ' · escritura' : ''}</code>)}</>}{s.update.removed.length > 0 && <> Quita {s.update.removed.map(t => <code key={t.name} className="mc-tool-chip rem">{t.name}</code>)}</>}</div>}
            </div>
            <button className="btn btn-sm" onClick={() => onOpen(s.id)}>Revisar <I.ArrowRight size={11} /></button>
          </div>
        );
      })}</React.Fragment>; })}
    </div>
  );
}

function McpDetail({ s, isAdmin, onClose, setView }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const me = S.actor();
  const [mode, setMode] = useState(null);
  const [params, setParams] = useState(() => Object.fromEntries(s.params.map(p => [p.key, p.value])));
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const avail = window.useMango(st => st.avail);
  const simMcp = window.useMango(st => st.simMcp) || null;
  const [actErr, setActErr] = useState(null);
  const guard = (fn, install) => { setActErr(null); if (avail && simMcp) { setActErr(MCP_SIM_ERR[simMcp]); return; } fn(); };
  const md = mcpModeOf(s);
  const svcs = [...new Set((s.tools || []).map(t => t.service).filter(Boolean))];
  const used = L.usedBy(s.id);
  const skillsUsing = (window.MangoStore.get().skills || []).filter(k => (k.tools || []).includes(s.id));
  const revsUsing = (window.MangoStore.get().agentRevs || []).filter(r => !r.hidden && ['draft', 'review'].includes(r.status) && (r.snap.tools || []).some(t => t.startsWith(s.id + '.')));
  const enabledPerms = new Set(window.MangoStore.get().mcpCatalog.filter(x => x.status === 'enabled' && x.id !== s.id).flatMap(x => x.perms));
  const newPerms = s.perms.filter(p => !enabledPerms.has(p));
  const [tick, setTick] = useState(0);
  useEffect(() => { if (s.status !== 'installing') return; const t = setInterval(() => setTick(x => x + 1), 400); return () => clearInterval(t); }, [s.status]);
  const ownPar = s.paramReq?.by === me;
  const ownReq = s.request?.by === me;
  const ownUpd = s.update?.by === me;
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const done = (msg) => { toast?.({ tone: 'success', msg }); setMode(null); setReason(''); setTried(false); };
  const need = (fn) => { setTried(true); if (!reason.trim()) return; fn(); };

  let actions = null;
  if (!isAdmin) actions = <div className="ap-reason"><I.Lock size={12} /> Solo los administradores pueden habilitar, aprobar o deshabilitar MCP.</div>;
  else if (mode === 'request') actions = (
    <div style={{ display: 'grid', gap: 10 }}>
      {s.params.map(p => (
        <div key={p.key}><label htmlFor={'p-' + p.key} style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 5 }}>{p.label}</label>
          <select id={'p-' + p.key} className="input" value={params[p.key]} onChange={e => setParams({ ...params, [p.key]: e.target.value })} style={{ width: 'auto' }}>{p.options.map(o => <option key={o}>{o}</option>)}</select></div>
      ))}
      <div><label htmlFor="mc-reason" style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 5 }}>Para qué se necesita <span className="mk-meta">· opcional</span></label>
        <textarea id="mc-reason" className="input" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Lo verá el administrador que lo apruebe" /></div>
      <div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={() => guard(() => { L.requestPack(s.id, params, reason.trim()); done('Solicitud enviada · otro administrador debe aprobarla'); })}>Enviar solicitud</button><button className="btn btn-sm btn-ghost" onClick={() => setMode(null)}>Cancelar</button></div>
    </div>
  );
  else if (mode === 'reject' || mode === 'reject-upd' || mode === 'disable') actions = (
    <div style={{ display: 'grid', gap: 8 }}>
      {mode === 'disable' && (used.length + (avail ? 0 : skillsUsing.length + revsUsing.length)) > 0 && <div className="mc-alert amber" style={{ display: 'block', fontSize: 12.5 }}><div style={{ fontWeight: 600, marginBottom: 4 }}>Qué queda afectado</div>{used.length > 0 && <div>· {used.length} {used.length === 1 ? 'agente publicado' : 'agentes publicados'} con tools no disponibles: {used.map(a => a.name).join(', ')}</div>}{!avail && skillsUsing.length > 0 && <div>· {skillsUsing.length} {skillsUsing.length === 1 ? 'skill' : 'skills'} dejará de estar disponible: {skillsUsing.map(k => k.name).join(', ')}</div>}{!avail && revsUsing.length > 0 && <div>· {revsUsing.length} {revsUsing.length === 1 ? 'borrador o envío fallará' : 'borradores o envíos fallarán'} al enviarse: {revsUsing.map(r => r.snap.name).join(', ')}</div>}</div>}
      <label htmlFor="mc-why" style={{ fontSize: 12.5, fontWeight: 500 }}>{mode === 'disable' ? 'Motivo para deshabilitar' : 'Motivo del rechazo'}</label>
      <textarea id="mc-why" className="input" rows={2} value={reason} onChange={e => setReason(e.target.value)} autoFocus style={tried && !reason.trim() ? { borderColor: 'var(--red)' } : null} />
      {tried && !reason.trim() && <div style={{ fontSize: 12, color: 'var(--red)' }}>El motivo es obligatorio</div>}
      <div className="row gap-2">
        <button className="btn btn-sm mk-danger" onClick={() => need(() => { if (mode === 'disable') { L.disablePack(s.id, reason.trim()); done(s.name + ' deshabilitado'); } else if (mode === 'reject') { L.decidePack(s.id, 'rejected', reason.trim()); done('Solicitud rechazada'); } else { L.decideUpdate(s.id, 'rejected', reason.trim()); done('Actualización rechazada'); } })}>{mode === 'disable' ? 'Deshabilitar' : 'Rechazar'}</button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setMode(null); setTried(false); }}>Cancelar</button>
      </div>
    </div>
  );
  else if (mode === 'params') actions = (
    <div style={{ display: 'grid', gap: 10 }}>
      {s.params.map(p => <div key={p.key}><label htmlFor={'pp-' + p.key} style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 5 }}>{p.label} <span className="mk-meta">· hoy {p.value}</span></label><select id={'pp-' + p.key} className="input" value={params[p.key]} onChange={e => setParams({ ...params, [p.key]: e.target.value })} style={{ width: 'auto' }}>{p.options.map(o => <option key={o}>{o}</option>)}</select></div>)}
      <div className="mk-meta">Cambiar la región puede cambiar qué datos se leen: otro administrador debe aprobarlo. Mientras tanto sigue activa la configuración actual.</div>
      <div className="row gap-2"><button className="btn btn-sm btn-primary" disabled={s.params.every(p => params[p.key] === p.value)} onClick={() => { L.requestParams(s.id, params); done('Cambio de parámetros enviado a aprobación'); }}>Pedir cambio</button><button className="btn btn-sm btn-ghost" onClick={() => setMode(null)}>Cancelar</button></div>
    </div>
  );
  else if (s.paramReq && s.status === 'enabled' && mode !== 'disable') actions = ownPar
    ? <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><span className="ap-reason"><I.Lock size={12} /> Pediste cambiar la región a {s.paramReq.params.region}: lo debe aprobar otro administrador.</span><button className="btn btn-sm" onClick={() => { L.withdrawPack(s.id, 'params'); done('Solicitud retirada'); }}>Retirar solicitud</button></div>
    : <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><span className="mk-meta" style={{ flexBasis: '100%' }}>{s.paramReq.by} pide cambiar la región de {s.params[0]?.value} a {s.paramReq.params.region}.</span><button className="btn btn-sm btn-primary" onClick={() => { L.decideParams(s.id, 'approved'); done('Parámetros actualizados'); }}>Aprobar cambio</button><button className="btn btn-sm" onClick={() => { L.decideParams(s.id, 'rejected'); done('Cambio rechazado'); }}>Rechazar</button></div>;
  else if (s.status === 'pending') actions = ownReq
    ? <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><span className="ap-reason"><I.Lock size={12} /> Tú pediste habilitarlo: lo debe aprobar otro administrador.</span><button className="btn btn-sm" onClick={() => { L.withdrawPack(s.id, 'request'); done('Solicitud retirada'); }}>Retirar solicitud</button></div>
    : <div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={() => guard(() => { L.decidePack(s.id, 'approved'); done('Aprobado · instalando ' + s.name); }, true)}><I.Check size={12} /> Aprobar e instalar</button><button className="btn btn-sm" onClick={() => setMode('reject')}>Rechazar</button></div>;
  else if (s.status === 'available' || s.status === 'disabled') actions = s.kind === 'pack' ? <button className="btn btn-sm btn-primary" onClick={() => setMode('request')}>Solicitar habilitación</button> : null;
  else if (s.status === 'installing' && avail) actions = <div className="ap-reason"><span className="g-spin" /> Instalando · empezó {window.fmtAgo(s.installStarted)}. Puedes cerrar este panel.</div>;
  else if (s.status === 'disabling') actions = <div className="ap-reason"><span className="g-spin" /> Deshabilitando. Los agentes que lo usan siguen publicados y responderán sin estas tools.</div>;
  else if (s.status === 'installing') { const el = (Date.now() - new Date(s.installStarted).getTime()) / 1000; const steps = ['Crear rol de lectura en la cuenta', 'Registrar tools en Mango', 'Verificar conexión']; actions = <div style={{ display: 'grid', gap: 6 }}>{steps.map((st, i) => { const idx = Math.min(steps.length - 1, Math.floor(el / 1.1)); const done_ = i < idx; const cur = i === idx; return <div key={st} className="row gap-2" style={{ fontSize: 13, color: done_ ? 'var(--text)' : cur ? 'var(--text-strong)' : 'var(--text-muted)' }}>{done_ ? <span className="g-dot-lg green sm" style={{ width: 16, height: 16, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--green-soft)', color: 'var(--green)' }}><I.Check size={9} /></span> : cur ? <span className="g-spin" /> : <span style={{ width: 16, height: 16, borderRadius: '50%', border: '1.5px solid var(--border-strong)', display: 'inline-block' }} />}{st}</div>; })}<div className="mk-meta">Empezó {window.fmtAgo(s.installStarted)}. Puedes cerrar este panel.</div></div>; }
  else if (s.status === 'error') actions = <div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={() => { L.retryPack(s.id); done('Reintentando instalación'); }}><I.Refresh size={12} /> Reintentar instalación</button><button className="btn btn-sm" onClick={() => setMode('disable')}>Deshabilitar</button></div>;
  else if (s.status === 'soon') actions = <div className="ap-reason"><I.Clock size={12} /> Este conector todavía no está disponible en Mango.</div>;
  else if (s.status === 'enabled') actions = s.kind === 'pack' ? <div className="row gap-2" style={{ flexWrap: 'wrap' }}>{avail && s.latest && !s.update && <button className="btn btn-sm" onClick={() => guard(() => { L.requestUpdate(s.id); done('Actualización pedida · otro administrador debe aprobarla'); })}>Pedir actualización a {s.latest.version}</button>}{s.params.length > 0 && <button className="btn btn-sm" onClick={() => { setParams(Object.fromEntries(s.params.map(p => [p.key, p.value]))); setMode('params'); }}>Cambiar parámetros</button>}<button className="btn btn-sm" onClick={() => setMode('disable')}>Deshabilitar</button></div> : <div className="ap-reason"><I.Info size={12} /> Los conectores de Mango vienen instalados y no se deshabilitan desde aquí.</div>;

  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" style={{ width: 520 }} role="dialog" aria-modal="true" aria-label={s.name}>
        <div className="mk-drawer-h">
          <span className={'mc-ic lg ' + s.kind}>{s.kind === 'pack' ? <I.Cloud size={20} /> : <I.Command size={20} />}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{s.name}</div>
            <div className="row gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}><McpStatus s={s} /><McpLevel level={s.level} /><McpMode s={s} /><span className="mk-meta">{s.kind === 'pack' ? 'MCP pack · ' + s.provider : 'Conector de Mango'} · v{s.version}</span></div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="mk-drawer-b">
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{s.desc}</p>
          {s.status === 'error' && <div className="mc-alert red"><I.X2 size={14} /><div><b>No se pudo instalar.</b> {s.error}</div></div>}
          {avail && md === 'central' && <div className="mc-alert" style={{ display: 'block', fontSize: 12.5 }}><div style={{ fontWeight: 600, marginBottom: 2 }}>Solo usuarios centrales</div>Sus tools responden por toda la organización. El servidor niega a cualquier usuario que no sea central, aunque el agente tenga la tool. Un agente con estas tools solo se comparte con grupos centrales, nunca con grupos de área ni personas sueltas.</div>}
          {avail && md === 'user' && <div className="mc-alert" style={{ display: 'block', fontSize: 12.5 }}><div style={{ fontWeight: 600, marginBottom: 2 }}>Filtra por usuario</div>Cada persona ve solo lo que su rol permite. Un agente con estas tools sí puede compartirse con grupos de área.</div>}
          {avail && svcs.length > 0 && s.status === 'enabled' && <div className="mc-alert amber"><I.Warn size={14} /><div>{svcs.join(' y ')} se {svcs.length === 1 ? 'activa' : 'activan'} aparte en la cuenta pagadora, y Mango no comprueba si {svcs.length === 1 ? 'lo está' : 'lo están'}. Sus tools responden con error hasta que se activen en AWS; las demás funcionan.</div></div>}
          {s.status === 'pending' && s.request && <div className="mc-alert amber"><I.Clock size={14} /><div><b>{s.request.by}</b> pidió habilitarlo {window.fmtAgo(s.request.at)}{s.request.params?.region ? ' en ' + s.request.params.region : ''}.{s.request.reason && <> “{s.request.reason}”</>}</div></div>}
          {s.status === 'disabled' && used.length > 0 && <div className="mc-alert amber"><I.Warn size={14} /><div>Deshabilitado. {used.length === 1 ? 'Un agente tiene' : used.length + ' agentes tienen'} sus tools como <b>no disponibles</b>: {used.map(a => a.name).join(', ')}.{avail && ' Siguen publicados y responden sin ellas; al volver a habilitarlo las recuperan sin nueva revisión.'}</div></div>}
          {s.rejected && s.status !== 'pending' && <div className="mc-alert"><I.Info size={14} /><div>Última solicitud rechazada por {s.rejected.by}: “{s.rejected.reason}”</div></div>}
          {s.update && (
            <div className="mc-alert amber" style={{ display: 'block' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Actualización {s.version} → {s.update.version} cambia sus tools</div>
              <div style={{ fontSize: 12.5 }}>Agrega: {s.update.added.map(t => <code key={t.name} className="mc-tool-chip add">{t.name}{t.write ? ' · escritura' : ''}</code>)}{s.update.removed.length ? <> · Quita: {s.update.removed.map(t => <code key={t.name} className="mc-tool-chip rem">{t.name}</code>)}</> : null}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 8px' }}>Pedida por {s.update.by} · {window.fmtAgo(s.update.at)}. Hasta aprobarla, sigue activa la versión {s.version}.</div>
              {isAdmin && mode !== 'reject-upd' && (ownUpd
                ? <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><span className="ap-reason"><I.Lock size={12} /> Tú la pediste: la debe aprobar otro administrador.</span><button className="btn btn-sm" onClick={() => { L.withdrawPack(s.id, 'update'); done('Solicitud retirada'); }}>Retirar solicitud</button></div>
                : <div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={() => { L.decideUpdate(s.id, 'approved'); done('Actualización aprobada'); }}>Aprobar actualización</button><button className="btn btn-sm" onClick={() => setMode('reject-upd')}>Rechazar</button></div>)}
            </div>
          )}

          {s.params.length > 0 && (
            <MkSec title="Parámetros">
              {s.params.map(p => <div key={p.key} className="mk-kv"><span>{p.label}</span><span className="mono">{p.value}</span></div>)}
            </MkSec>
          )}

          <MkSec title={`Tools · ${s.tools.length}`}>
            {s.tools.map(t => (
              <div key={t.name} className="mk-line row between" style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}><div className="mono" style={{ fontSize: 12.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{t.name}</div>{!(avail && s.kind === 'pack') && <div className="mk-meta">{t.desc}</div>}</div>
                <span className="row gap-1" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>{avail && t.service && <span className="badge badge-amber" title={'Responde con error si la cuenta pagadora no tiene activado ' + t.service + '; Mango no lo comprueba'}>Requiere {t.service}</span>}{avail && s.kind === 'connector' && s.level === 'accounts' && <span className={'badge' + (t.scope === 'org' ? ' badge-violet' : '')}>{t.scope === 'org' ? 'Solo grupos centrales' : 'Por usuario'}</span>}{t.write ? <span className="badge badge-amber" title="Confirmación o aprobación, según su política">Escritura · confirmación o aprobación</span> : <span className="badge">Lectura</span>}</span>
              </div>
            ))}
            {avail && s.kind === 'pack' && <div className="mk-meta" style={{ marginTop: 6 }}>El manifiesto firmado del pack solo trae nombre y tipo de acceso de cada tool.</div>}
          </MkSec>

          {s.status === 'pending' && isAdmin && !ownReq && <div className="mc-alert amber" style={{ display: 'block', fontSize: 12.5 }}><div style={{ fontWeight: 600, marginBottom: 4 }}>Antes de aprobar</div>{newPerms.length ? <div>Suma {newPerms.length} {newPerms.length === 1 ? 'permiso de AWS nuevo' : 'permisos de AWS nuevos'}: {newPerms.map(p => <code key={p} className="mc-tool-chip">{p}</code>)}</div> : <div>No suma permisos de AWS nuevos.</div>}{s.level === 'accounts' && <div style={{ marginTop: 4 }}>Nivel «Datos de cuentas»: solo lo podrán usar agentes de roles centrales.</div>}{s.tools.some(t => t.write) && <div style={{ marginTop: 4 }}>Incluye tools de escritura: cada uso pedirá confirmación o aprobación, según su política.</div>}</div>}
          <MkSec title="Permisos de AWS">
            {s.perms.length ? <><div className="mk-meta" style={{ marginBottom: 6 }}>Lectura</div><div className="mc-perms">{s.perms.map(p => <code key={p}>{p}</code>)}</div></> : <div className="mk-meta">No usa permisos de AWS.</div>}
            {(s.wperms || []).length > 0 && <><div className="row gap-2" style={{ margin: '12px 0 6px', alignItems: 'center' }}><span className="badge badge-amber">Escritura</span><span className="mk-meta">Se usan solo tras una confirmación o aprobación, según su política</span></div><div className="mc-perms">{s.wperms.map(p => <code key={p}>{p}</code>)}</div></>}
            {s.update?.addedWperms?.length > 0 && <div className="mk-meta" style={{ marginTop: 8 }}>La versión {s.update.version} agrega: {s.update.addedWperms.map(p => <code key={p} style={{ marginLeft: 4 }}>{p}</code>)}</div>}
            {s.perms.length > 0 && !(s.wperms || []).length && <div className="mk-meta" style={{ marginTop: 6 }}>Solo lectura.</div>}
          </MkSec>

          {skillsUsing.length > 0 && <MkSec title={`Skills que dependen de él · ${skillsUsing.length}`}>{skillsUsing.map(k => <div key={k.id} className="mk-line row between"><span>{k.name}</span><button className="sr-link" onClick={() => { onClose(); window.MangoNav?.('skills'); }}>Ver</button></div>)}</MkSec>}
          <MkSec title={`Agentes que lo usan · ${used.length}`}>
            {used.length ? used.map(a => <div key={a.id} className="mk-line row between"><span>{a.name}</span><span className="mk-meta">{s.status === 'disabled' || s.status === 'error' ? 'Tools no disponibles' : a.cat}</span></div>) : <div className="mk-meta">Ningún agente publicado lo usa.</div>}
          </MkSec>

          <MkSec title={<span className="row gap-2" style={{ alignItems: 'center' }}>Salud{avail && <window.SoonTag />}</span>}>
            {avail ? <div className="mk-meta">Todavía no hay datos de salud de los servidores MCP.</div> : s.metrics && s.status === 'enabled'
              ? <><div className="mk-kv"><span>Estado</span><span>{s.metrics.health === 'ok' ? 'Operativo' : s.metrics.health === 'warn' ? 'Degradado' : 'Caído'}</span></div><div className="mk-kv"><span>Latencia media</span><span className="mono">{s.metrics.latency} ms</span></div><div className="mk-kv"><span>Llamadas · 24 h</span><span className="mono">{s.metrics.calls24h?.toLocaleString('es-MX')}</span></div>{s.metrics.lastCheck && <div className="mk-kv"><span>Último chequeo</span><span>{s.metrics.lastCheck}</span></div>}</>
              : <div className="mk-meta">Sin datos. Aparecerán cuando haya métricas reales de uso.</div>}
          </MkSec>

          {(s.approvedBy || s.disabledBy) && (
            <MkSec title="Historial">
              {s.request && <div className="mk-kv"><span>Solicitado</span><span>{s.request.by} · {window.fmtAgo(s.request.at)}</span></div>}
              {s.approvedBy && <div className="mk-kv"><span>Aprobado</span><span>{s.approvedBy}</span></div>}
              {s.disabledBy && <div className="mk-kv"><span>Deshabilitado</span><span>{s.disabledBy} · {window.fmtAgo(s.disabledAt)}</span></div>}
            </MkSec>
          )}
        </div>
        {(actions || actErr) && <div className="mc-foot">{actErr && <div className="g-err" role="alert" style={{ marginBottom: 10 }}>{actErr}</div>}{actions}</div>}
      </aside>
    </div>
  );
}

function McpToolsTable({ rows, onOpen }) {
  const I = window.Icons; const L = window.Lifecycle;
  const [q, setQ] = useState(''); const [kind, setKind] = useState('all'); const [onlyOn, setOnlyOn] = useState(false);
  const Q = q.trim().toLowerCase();
  const list = rows.filter(({ s, t }) => (kind === 'all' || (kind === 'write' ? t.write : !t.write)) && (!onlyOn || s.status === 'enabled') && (!Q || (t.name + ' ' + t.desc + ' ' + s.name).toLowerCase().includes(Q)));
  const w = rows.filter(r => r.t.write && r.s.status === 'enabled').length;
  return (
    <>
      <div className="row gap-2" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar tool" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar tools" /></div>
        <div className="tk-quick" role="group">{[['all', 'Todas'], ['read', 'Lectura'], ['write', 'Escritura']].map(([k, l]) => <button key={k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>{l}</button>)}</div>
        <label className="row gap-2" style={{ fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={onlyOn} onChange={e => setOnlyOn(e.target.checked)} style={{ accentColor: 'var(--accent)' }} /> Solo habilitadas</label>
        <div style={{ flex: 1 }} /><span className="mk-meta">{w} tools de escritura habilitadas</span>
      </div>
      <div className="card mc-table">
        <div className="mt-tr mc-th"><span>tool</span><span>mcp</span><span>tipo</span><span>nivel de datos</span><span>estado</span></div>
        {list.map(({ s, t }) => (
          <button key={s.id + t.name} className="mt-tr" onClick={() => onOpen(s.id)}>
            <span style={{ minWidth: 0 }}><span className="mono" style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t.name}</span><span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.desc}</span></span>
            <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            <span>{t.write ? <span className="badge badge-amber">Escritura · confirmación o aprobación</span> : <span className="badge">Lectura</span>}</span>
            <span className="row gap-1" style={{ flexWrap: 'wrap' }}><McpLevel level={s.level} /><McpMode s={s} /></span>
            <span><McpStatus s={s} /></span>
          </button>
        ))}
        {!list.length && <div className="mk-meta" style={{ padding: 16 }}>Ninguna tool coincide.</div>}
      </div>
    </>
  );
}

Object.assign(window, { McpCatalog, McpLevel });
