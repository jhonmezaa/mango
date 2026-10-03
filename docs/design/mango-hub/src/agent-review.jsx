// Revisión de agentes: cola de cambios con diff contra lo publicado + historial
const RV_DECIDE_ERR = {
  'same-approver': 'No puedes aprobar una versión que enviaste tú. La debe aprobar otro administrador.',
  changed: 'La versión cambió mientras la revisabas. Vuelve a cargarla para ver lo que se envió.',
  rules: 'La versión no cumple las reglas de publicación. Revisa los problemas de arriba.',
  'pub-unavailable': 'El servicio de publicación no está disponible. Inténtalo de nuevo en unos minutos.',
  'audit-unavailable': 'No se pudo registrar la decisión en Auditoría, así que no se aplicó. Inténtalo de nuevo.',
  'rules-uneval': 'No se pudieron evaluar las reglas de publicación. No se puede aprobar hasta que se evalúen.',
  network: 'Sin conexión. Revisa tu red e inténtalo de nuevo.',
};

function AgentReview({ agents, setView }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle; const K = window.GovKit;
  const revs = window.useMango(s => s.agentRevs);
  const role = window.useMango(s => s.role);
  const avail = window.useMango(s => s.avail);
  const sim = window.useMango(s => s.simReview) || null;
  const narrow = window.useMedia('(max-width: 760px)');
  const [tab, setTab] = useState('review');
  const [sel, setSel] = useState(null);
  const [open, setOpen] = useState(false);
  const queue = revs.filter(r => r.status === 'review' || r.status === 'approved').sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
  const history = revs.filter(r => !r.hidden && ['published', 'rejected', 'failed', 'retired'].includes(r.status)).sort((a, b) => new Date(b.decidedAt || b.submittedAt) - new Date(a.decidedAt || a.submittedAt));
  useEffect(() => { if (tab === 'review' && !queue.find(r => r.id === sel)) { setSel(queue[0]?.id || null); setOpen(false); } }, [tab, revs]);
  const selected = sel && revs.find(r => r.id === sel);
  const head = (
    <div className="page-head">
      <h1 className="page-title">Revisión de agentes</h1>
      <p className="page-subtitle">Cada agente nuevo y cada cambio a uno publicado necesita la aprobación de un administrador distinto de quien lo hizo. Lo publicado sigue activo hasta que se apruebe el cambio.</p>
    </div>
  );
  if (avail && role !== 'admin') return <><Topbar crumbs={['Gobernanza', 'Revisión de agentes']} /><div className="content"><div className="g-denied"><K.Empty icon="Lock" title="No tienes acceso a esta sección">Revisar agentes es solo para administradores de Mango.</K.Empty></div></div></>;
  const showDetail = narrow && open && selected;

  let body;
  if (avail && sim === 'loading') body = <div className="ap-body" role="status" aria-label="Cargando revisiones"><div className="ap-list">{[0, 1, 2].map(i => <div key={i} className="card ap-row" style={{ display: 'grid', gap: 8 }}><K.Skel w="55%" h={13} /><K.Skel w="80%" h={11} /></div>)}</div></div>;
  else if (avail && sim === 'load-error') body = <div className="ap-body"><K.ErrorState title="No se pudieron cargar las revisiones" body="No se pudo completar la acción. Inténtalo de nuevo." onRetry={() => S.set({ simReview: null })} /></div>;
  else if (tab === 'history') body = <ReviewHistory list={history} setView={setView} />;
  else if (!queue.length) body = <div className="mk-empty"><I.Check2 size={22} style={{ color: 'var(--green)' }} /><div style={{ fontSize: 14, fontWeight: 600 }}>Nada por revisar</div><div className="mk-meta">Cuando alguien envíe un agente o un cambio a aprobación, aparecerá aquí.</div></div>;
  else body = (
    <div className={'ap-body is-split' + (showDetail ? ' show-detail' : '')}>
      <div className="ap-list" role="listbox" aria-label="Agentes en revisión">
        {queue.map(r => {
          const d = L.diff(r.base, r.snap); const n = L.diffCount(d); const errs = L.validate(r.snap);
          return (
            <button key={r.id} role="option" aria-selected={r.id === sel} className={'card ap-row' + (r.id === sel ? ' is-active' : '')} onClick={() => { setSel(r.id); setOpen(true); }}>
              <span className="mk-avatar sm" style={{ background: 'var(--row-hover)', color: 'var(--text-muted)' }}>{(I[r.snap.icon] || I.Bot)({ size: 14 })}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="ap-row-t">{r.snap.name}</span>
                <span className="ap-row-s"><span className="mono">{L.revLabel(r)}</span> · {r.by} · {window.fmtAgo(r.submittedAt)}</span>
                <span className="row gap-1" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <span className="badge">{r.kind === 'new' ? 'Agente nuevo' : n + (n === 1 ? ' cambio' : ' cambios')}</span>
                  {r.status === 'approved' && <span className="badge badge-blue">Publicando…</span>}
                  {!avail && errs.length > 0 && <span className="badge badge-red">{errs.length} {errs.length === 1 ? 'problema' : 'problemas'}</span>}
                  {r.by === S.actor() && <span className="badge">Tuyo</span>}
                </span>
              </span>
              {narrow && <I.ChevronRight size={14} style={{ color: 'var(--text-muted)', alignSelf: 'center' }} />}
            </button>
          );
        })}
      </div>
      {(!narrow || showDetail) && <div className="ap-detail card">
        {narrow && <button className="ap-back" onClick={() => setOpen(false)}><I.ChevronLeft size={13} /> Volver a la cola</button>}
        {selected ? <ReviewDetail key={selected.id} r={selected} agents={agents} setView={setView} /> : null}
      </div>}
    </div>
  );

  return (
    <>
      <Topbar crumbs={['Gobernanza', 'Revisión de agentes']} />
      <div className="content">
        {!showDetail && head}
        {!showDetail && <div className="ap-bar">
          <div className="mk-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'is-on' : ''} onClick={() => setTab('review')}>En revisión{queue.length > 0 && <span className="mk-count">{queue.length}</span>}</button>
            <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'is-on' : ''} onClick={() => setTab('history')}>Historial</button>
          </div>
        </div>}
        {body}
      </div>
    </>
  );
}

function RvDiffLines({ a = '', b = '' }) {
  const A = a.split('\n'), B = b.split('\n');
  const setA = new Set(A), setB = new Set(B);
  const rows = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { rows.push([' ', A[i]]); i++; j++; }
    else if (i < A.length && !setB.has(A[i])) { rows.push(['-', A[i]]); i++; }
    else if (j < B.length && !setA.has(B[j])) { rows.push(['+', B[j]]); j++; }
    else { if (i < A.length) rows.push(['-', A[i++]]); if (j < B.length) rows.push(['+', B[j++]]); }
  }
  return <pre className="rv-diff">{rows.map(([k, t], n) => <div key={n} className={k === '+' ? 'add' : k === '-' ? 'rem' : ''}><span>{k}</span>{t || ' '}</div>)}</pre>;
}

function RvTool({ id, kind, approval }) {
  const L = window.Lifecycle; const i = L.toolInfo(id); const avail = window.MangoStore.get().avail;
  const off = !i.server || i.server.status !== 'enabled';
  return (
    <div className={'rv-tool ' + kind}>
      <span className="rv-sign">{kind === 'add' ? '+' : kind === 'rem' ? '−' : ''}</span>
      <span className="mono" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{id}</span>
      {i.server && !(avail && i.missing) && <span className={'badge ' + L.levelOf(i.server.level)[1]}>{L.levelOf(i.server.level)[0]}</span>}
      {avail && i.missing ? null : i.tool.write ? <span className="badge badge-amber">Escritura · confirmación o aprobación en cada uso</span> : approval ? <span className="badge badge-amber">Aprobación en cada uso</span> : <span className="badge">Lectura</span>}
      {off && <span className="badge badge-red">No habilitada</span>}
    </div>
  );
}

const rvFmt = (v) => v == null || v === '' ? '—' : Array.isArray(v) ? (v.join(', ') || '—') : typeof v === 'object' ? JSON.stringify(v) : String(v);
function RvFact({ label, ch, value, mono }) {
  return <div><span>{label}</span><span className={mono ? 'mono' : undefined} style={{ overflowWrap: 'anywhere' }}>{ch ? <><s className="rv-old">{rvFmt(ch[0])}</s> → <b>{rvFmt(ch[1])}</b></> : rvFmt(value)}</span></div>;
}

function ReviewDetail({ r, agents, setView }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const avail = window.useMango(s => s.avail);
  const sim = window.useMango(s => s.simReview) || null;
  const simDecide = window.useMango(s => s.simReviewDecide) || null;
  const [mode, setMode] = useState(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [decErr, setDecErr] = useState(null);
  const [pubStuck, setPubStuck] = useState(false);
  const d = L.diff(r.base, r.snap);
  const uneval = avail && sim === 'rules-uneval';
  const gone = avail && sim === 'gone';
  const errs = uneval ? [] : [...L.validate(r.snap), ...(!avail && (window.evalBlocks?.(r.agentId) || []).length ? [{ code: 'evals', msg: 'Hay evals obligatorias que no pasan.' }] : [])];
  const mine = r.by === S.actor();
  const isAdmin = S.get().role === 'admin';
  const LIM = { tokens: 'Tokens por respuesta', iterations: 'Iteraciones', seconds: 'Tiempo máximo (s)' };
  const money = (n) => window.GovKit ? window.GovKit.usd(n) : '$' + n;
  const failSim = (kind) => { if (!avail || !simDecide || (kind === 'reject' && ['same-approver', 'rules', 'rules-uneval', 'pub-unavailable', 'pub-not-started'].includes(simDecide))) return false; if (simDecide === 'pub-not-started') { if (kind !== 'approve') return false; setPubStuck(true); return true; } setDecErr(RV_DECIDE_ERR[simDecide]); return true; };
  const reject = () => { setTried(true); setDecErr(null); if (!reason.trim()) return; if (failSim('reject')) return; L.decideRev(r.id, 'rejected', reason.trim()); toast?.({ tone: 'info', msg: `${r.snap.name} rechazado` }); };
  const approve = () => { setDecErr(null); if (failSim('approve')) return; L.decideRev(r.id, 'approved'); toast?.({ tone: 'success', msg: `Aprobado · publicando ${r.snap.name}` }); };
  const isNew = r.kind === 'new';
  const unchangedTools = (r.snap.tools || []).filter(t => (r.base?.tools || []).includes(t));
  const approvalSet = r.snap.approval || [];
  const blocked = mine || errs.length > 0 || uneval || gone;

  if (gone) return (
    <div className="ap-detail-b"><div className="g-empty"><span className="g-empty-i"><I.Info size={18} /></span><div className="g-empty-t">Esta versión ya no está en revisión</div><p className="g-empty-b">Quien la envió la retiró o la cambió, u otro administrador ya la decidió. Vuelve a la cola para ver lo pendiente.</p><button className="btn btn-sm" onClick={() => S.set({ simReview: null })}><I.Refresh size={12} /> Actualizar</button></div></div>
  );

  return (
    <>
      <div className="ap-detail-h">
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{L.revLabel(r)}</span>
        <span className={'badge ' + L.REV_STATUS[r.status][1]}>{L.REV_STATUS[r.status][0]}</span>
        <span className="badge">{isNew ? 'Agente nuevo' : 'Cambio a publicado'}</span>
      </div>
      <div className="ap-detail-b">
        <div className="ap-sections">
          <div>
            <h2 className="ap-h2">{r.snap.name}</h2>
            <p className="ap-impact">{r.snap.desc}</p>
            <div className="mk-meta" style={{ marginTop: 6 }}>Hecho por <b style={{ color: 'var(--text)', fontWeight: 500 }}>{r.by}</b> · enviado {window.fmtAgo(r.submittedAt)}{!isNew && ' · lo publicado sigue activo mientras tanto'}</div>
          </div>

          {uneval && <div className="mc-alert amber" style={{ display: 'block' }} role="status"><div style={{ fontWeight: 600, marginBottom: 4 }}>No se pudieron evaluar las reglas de publicación</div><div style={{ fontSize: 12.5 }}>No sabemos si esta versión las cumple. No se puede aprobar hasta que se evalúen.</div><button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => S.set({ simReview: null })}><I.Refresh size={12} /> Volver a evaluar</button></div>}
          {errs.length > 0 && (
            <div className="mc-alert red" style={{ display: 'block' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No cumple las reglas de publicación</div>
              {errs.map(e => <div key={e.code} style={{ fontSize: 12.5, marginTop: 2 }}>· {e.msg}</div>)}
            </div>
          )}

          {(isNew || d.manager || d.role) && (
            <div><div className="mk-sec-t">organización</div>
              <div className="ap-facts">
                {isNew || !d.manager ? <div><span>Reporta a</span><span>{L.managerName(r.snap.manager)}</span></div> : <div><span>Reporta a</span><span><s className="rv-old">{L.managerName(d.manager[0])}</s> → {L.managerName(d.manager[1])}</span></div>}
                {isNew || !d.role ? <div><span>Rol</span><span>{r.snap.role || '—'}</span></div> : <div><span>Rol</span><span><s className="rv-old">{d.role[0] || '—'}</s> → {d.role[1] || '—'}</span></div>}
              </div></div>
          )}

          {!isNew && (d.name || d.desc || d.model || (avail && (d.cat || d.icon || d.color || d.allowed.add.length || d.allowed.rem.length))) && (
            <div><div className="mk-sec-t">información</div>
              <div className="ap-facts">
                {d.name && <div><span>Nombre</span><span><s className="rv-old">{d.name[0]}</s> → {d.name[1]}</span></div>}
                {d.desc && <div><span>Descripción</span><span><s className="rv-old">{d.desc[0]}</s><br />{d.desc[1]}</span></div>}
                {avail && d.cat && <RvFact label="Categoría" ch={d.cat} />}
                {avail && d.icon && <RvFact label="Ícono" ch={d.icon} />}
                {avail && d.color && <RvFact label="Color" ch={d.color} />}
                {d.model && <div><span>Modelo</span><span className="mono" style={{ overflowWrap: 'anywhere' }}><s className="rv-old">{L.modelLabel(d.model[0])}</s> → {L.modelLabel(d.model[1])}</span></div>}
                {avail && (d.allowed.add.length > 0 || d.allowed.rem.length > 0) && <div><span>Modelos permitidos</span><span className="mono" style={{ overflowWrap: 'anywhere' }}>{d.allowed.add.map(m => <div key={m} style={{ color: 'var(--green)' }}>+ {L.modelLabel(m)}</div>)}{d.allowed.rem.map(m => <div key={m} style={{ color: 'var(--red)' }}>− {L.modelLabel(m)}</div>)}</span></div>}
              </div></div>
          )}
          {isNew && <div><div className="mk-sec-t">información</div><div className="ap-facts"><div><span>Categoría</span><span>{r.snap.cat}</span></div><div><span>Modelo</span><span className="mono" style={{ overflowWrap: 'anywhere' }}>{L.modelLabel(r.snap.model)}</span></div>{avail && <div><span>Modelos permitidos</span><span className="mono" style={{ overflowWrap: 'anywhere' }}>{(r.snap.allowedModels?.length ? r.snap.allowedModels : [r.snap.model]).map(m => <div key={m}>{L.modelLabel(m)}</div>)}</span></div>}</div></div>}

          {!avail && window.EvalGate && <window.EvalGate agentId={r.agentId} />}
          <div>
            <div className="mk-sec-t">system prompt {!isNew && (d.prompt ? '· modificado' : '· sin cambios')}</div>
            {isNew ? <RvDiffLines a="" b={r.snap.prompt} /> : d.prompt ? <RvDiffLines a={r.base.prompt} b={r.snap.prompt} /> : <div className="mk-meta">Sin cambios.</div>}
          </div>

          <div>
            <div className="mk-sec-t">tools {isNew ? '· ' + r.snap.tools.length : `· ${d.tools.add.length} agregadas, ${d.tools.rem.length} quitadas`}</div>
            <div className="rv-tools">
              {(isNew ? r.snap.tools : d.tools.add).map(t => <RvTool key={t} id={t} kind="add" approval={avail && approvalSet.includes(t)} />)}
              {d.tools.rem.map(t => <RvTool key={t} id={t} kind="rem" />)}
              {!isNew && !d.tools.add.length && !d.tools.rem.length && <div className="mk-meta" style={{ padding: '6px 0' }}>Sin cambios en tools ({unchangedTools.length}).</div>}
            </div>
            {avail && !isNew && (d.approval.add.length > 0 || d.approval.rem.length > 0) && <div style={{ marginTop: 10 }}>
              <div className="mk-meta" style={{ marginBottom: 4 }}>Aprobación en cada uso</div>
              <div className="rv-tools">{d.approval.add.map(t => <div key={t} className="rv-tool add"><span className="rv-sign">+</span><span className="mono" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{t}</span><span className="badge badge-amber">Pide aprobación</span></div>)}{d.approval.rem.map(t => <div key={t} className="rv-tool rem"><span className="rv-sign">−</span><span className="mono" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{t}</span><span className="badge">Ya no pide aprobación</span></div>)}</div>
            </div>}
          </div>

          <div>
            <div className="mk-sec-t">{avail ? 'acceso' : 'grupos que pueden usarlo'}</div>
            {avail && <div className="mk-meta" style={{ marginBottom: 4 }}>Grupos</div>}
            <div className="row gap-1" style={{ flexWrap: 'wrap' }}>
              {(r.snap.groups || []).map(g => <span key={g} className={'rv-chip' + (d.groups.add.includes(g) ? ' add' : '')}>{d.groups.add.includes(g) && '+ '}{g}{L.isRestricted(g) && <em>{L.groupDef(g)?.type === 'area' ? 'área' : 'general'}</em>}</span>)}
              {d.groups.rem.map(g => <span key={g} className="rv-chip rem">− {g}</span>)}
            </div>
            {avail && ((r.snap.users || []).length > 0 || d.users.rem.length > 0) && <>
              <div className="mk-meta" style={{ margin: '10px 0 4px' }}>Usuarios</div>
              <div className="row gap-1" style={{ flexWrap: 'wrap' }}>
                {(r.snap.users || []).map(u => <span key={u} className={'rv-chip' + (d.users.add.includes(u) ? ' add' : '')}>{d.users.add.includes(u) && '+ '}{u}</span>)}
                {d.users.rem.map(u => <span key={u} className="rv-chip rem">− {u}</span>)}
              </div>
            </>}
          </div>

          <div>
            <div className="mk-sec-t">{avail ? 'límites' : 'límites y presupuesto'}</div>
            <div className="ap-facts">
              {['tokens', 'iterations', 'seconds'].map(k => { const ch = d.limits.find(x => x[0] === k); return (
                <div key={k}><span>{LIM[k]}</span><span className="mono">{ch && !isNew ? <><s className="rv-old">{ch[1]}</s> → <b>{ch[2]}</b></> : r.snap.limits[k]}</span></div>
              ); })}
              {avail && <RvFact label="Tokens por llamada" ch={!isNew && d.perCall} value={r.snap.perCall} mono />}
              {avail && <RvFact label="Temperatura" ch={!isNew && d.temperature} value={r.snap.temperature} mono />}
              {!avail && <div><span>Presupuesto mensual</span><span className="mono">{d.budget && !isNew ? <><s className="rv-old">{money(d.budget[0])}</s> → <b>{money(d.budget[1])}</b></> : money(r.snap.budget)}</span></div>}
            </div>
          </div>

          {avail && !isNew && d.extra.length > 0 && (
            <div><div className="mk-sec-t">otros cambios · {d.extra.length}</div>
              <div className="mk-meta" style={{ marginBottom: 6 }}>Campos sin sección propia. Revísalos antes de aprobar.</div>
              <div className="ap-facts">{d.extra.map(([k, a, b]) => <RvFact key={k} label={<span className="mono">{k}</span>} ch={[a, b]} mono />)}</div>
            </div>
          )}
        </div>
      </div>
      <div className="ap-detail-f">
        {decErr && <div className="g-err" role="alert" style={{ marginBottom: 10 }}>{decErr}</div>}
        {pubStuck ? <div className="mc-alert amber" role="alert" style={{ display: 'block' }}><div style={{ fontWeight: 600, marginBottom: 2 }}>Aprobación registrada · la publicación no arrancó</div><div style={{ fontSize: 12.5 }}>Lo publicado sigue activo. Si no arranca, podrás reintentarla desde el Historial pasados 45 minutos.</div></div>
          : r.status === 'approved' ? <div className="ap-reason"><span className="g-spin" /> Aprobado por {avail ? L.reviewerLabel(r) : r.reviewer}. Publicando…</div>
          : !isAdmin ? <div className="ap-reason"><I.Lock size={12} /> Solo un administrador puede aprobar o rechazar.</div>
          : mode === 'reject' ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <label htmlFor="rv-why" style={{ fontSize: 12.5, fontWeight: 500 }}>Motivo del rechazo</label>
              {errs.length > 0 && <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{errs.map(e => <button key={e.code} className="tk-chip" onClick={() => setReason(e.msg)}>Usar: {e.msg.split('.')[0]}</button>)}</div>}
              <textarea id="rv-why" className="input" rows={2} value={reason} onChange={e => setReason(e.target.value)} autoFocus placeholder="Lo verá quien lo envió" aria-invalid={tried && !reason.trim()} style={tried && !reason.trim() ? { borderColor: 'var(--red)' } : null} />
              {tried && !reason.trim() && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>El motivo es obligatorio</div>}
              <div className="row gap-2" style={{ flexWrap: 'wrap' }}><button className="btn btn-sm mk-danger" onClick={reject}>Confirmar rechazo</button><button className="btn btn-sm btn-ghost" onClick={() => { setMode(null); setTried(false); }}>Cancelar</button></div>
            </div>
          ) : (
            <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-sm btn-primary" disabled={blocked} onClick={approve} title={mine ? 'No puedes aprobar un cambio que hiciste tú' : uneval ? 'Las reglas no se pudieron evaluar' : errs.length ? 'Corrige los problemas antes de aprobar' : undefined}><I.Check size={12} /> Aprobar y publicar</button>
              <button className="btn btn-sm" disabled={mine} onClick={() => setMode('reject')}>Rechazar</button>
              {mine && <span className="ap-reason"><I.Lock size={12} /> Lo hiciste tú: lo debe aprobar otro administrador.</span>}
              {!mine && uneval && <span className="ap-reason"><I.Warn size={12} /> No se puede aprobar hasta que se evalúen las reglas.</span>}
              {!mine && errs.length > 0 && <span className="ap-reason"><I.Warn size={12} /> No se puede aprobar mientras incumpla las reglas.</span>}
              {!mine && !errs.length && !uneval && <span className="mk-meta" style={{ marginLeft: 'auto' }}>Apruebas como {avail ? S.actorEmail() : S.actor()}</span>}
            </div>
          )}
      </div>
    </>
  );
}

function ReviewHistory({ list, setView }) {
  const I = window.Icons; const L = window.Lifecycle; const S = window.MangoStore;
  const toast = window.useToast?.();
  const avail = window.useMango(s => s.avail);
  const [q, setQ] = useState('');
  const Q = q.trim().toLowerCase();
  const rows = list.filter(r => !Q || (r.snap.name + ' ' + r.by + ' ' + L.reviewerLabel(r)).toLowerCase().includes(Q));
  const nChanges = (r) => { const n = L.diffCount(L.diff(r.base, r.snap)); return r.kind === 'new' ? 'Agente nuevo' : n + (n === 1 ? ' cambio' : ' cambios'); };
  return (
    <div className="mc-body">
      <div className="search-wrap" style={{ maxWidth: 300, marginBottom: 12 }}><I.Search size={13} /><input className="input" placeholder="Buscar agente o persona" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar en el historial" /></div>
      <div className="card mc-table rh-table">
        <div className="rh-tr mc-th"><span>agente</span><span>cambio</span><span>estado</span><span>hecho por</span><span>revisado por</span><span>detalle</span></div>
        {rows.map(r => (
          <div key={r.id} className="rh-tr">
            <span style={{ minWidth: 0 }}><span className="mk-name" style={{ display: 'block' }}>{r.snap.name}</span><span className="mk-meta mono" style={{ overflowWrap: 'anywhere' }}>{L.revLabel(r)} · {window.fmtAgo(r.decidedAt || r.submittedAt)}</span></span>
            <span className="mk-meta">{nChanges(r)}</span>
            <span><span className={'badge ' + L.REV_STATUS[r.status][1]}>{L.REV_STATUS[r.status][0]}</span></span>
            <span style={{ fontSize: 13 }} data-label="Hecho por">{r.by}</span>
            <span style={{ fontSize: 13, overflowWrap: 'anywhere' }} className={avail && r.legacy ? 'mono' : undefined} data-label="Revisado por" title={avail && r.legacy ? 'Decisión anterior al registro de correos: se muestra el identificador interno' : undefined}>{L.reviewerLabel(r)}</span>
            <span className="mk-meta" style={{ minWidth: 0 }}>
              {r.status === 'failed' ? <>Falló en «{avail ? (r.failedCode || 'publication_expired') : r.failedStep}» {S.get().role === 'admin' && <button className="sr-link" onClick={() => { L.retryPublish(r.id); toast?.({ tone: 'info', msg: 'Reintentando publicación' }); }}>Reintentar</button>}</>
                : r.reason ? (r.status === 'retired' && avail ? 'Retirado · ' : '') + '“' + r.reason + '”' : r.status === 'published' ? 'Publicado' : '—'}
            </span>
          </div>
        ))}
        {!rows.length && <div className="mk-meta" style={{ padding: 16 }}>Sin resultados.</div>}
      </div>
    </div>
  );
}

Object.assign(window, { AgentReview });
