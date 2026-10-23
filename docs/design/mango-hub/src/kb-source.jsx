// Knowledge Bases · propuesta de bucket: fila y detalle en Aprobaciones, tarjeta en la Bandeja.
// Lo propone un creador (o un admin) y lo aprueba o rechaza un administrador distinto de quien lo propuso.
function KbSourceRow({ r, active, onOpen }) {
  const I = window.Icons; const K = window.KB; const st = K.REQ_ST[r.status];
  const mine = K.needsMe(r);
  return (
    <button className={'card ap-row' + (active ? ' is-active' : '')} onClick={onOpen} role="option" aria-selected={!!active}>
      <span className="mk-avatar sm kb-req-av"><I.BookOpen size={14} /></span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="ap-row-t">{K.reqTitle(r)}</span>
        <span className="ap-row-s"><span className="mono">{r.id}</span> · Knowledge base · propuso {r.by} · {window.fmtAgo(r.at)}</span>
        <span className="row gap-1" style={{ marginTop: 6, flexWrap: 'wrap' }}><span className="badge">Bucket de S3</span>{r.status !== 'pending' && <span className={'badge ' + st[1]}>{st[0]}</span>}</span>
      </span>
      {mine && <span className="ap-dot" title="Espera tu firma" aria-label="Espera tu firma" />}
    </button>
  );
}

function KbSourceFacts({ r, compact }) {
  const K = window.KB; const k = K.get(r.kb);
  return (
    <div className="ap-facts">
      <div><span>Knowledge base</span><span>{k ? k.name : r.kb} <span className="mono mk-meta">{r.kb}</span></span></div>
      <div><span>{r.prev ? 'Bucket nuevo' : 'Bucket'}</span><span className="mono" style={{ overflowWrap: 'anywhere' }}>{r.ref}</span></div>
      {r.prev && <div><span>Ahora lee de</span><span className="mono" style={{ overflowWrap: 'anywhere' }}>{r.prev}</span></div>}
      <div><span>Propuso</span><span>{r.by} · {window.fmtAgo(r.at)}</span></div>
      {k && <div><span>La consultan</span><span className="mono" style={{ overflowWrap: 'anywhere' }}>{k.groups.join(', ')}</span></div>}
      {k && !compact && <div><span>Frecuencia</span><span>{K.freqLabel(k.freq)}</span></div>}
      <div><span>Comprobado</span><span>Es de la cuenta de AWS de la instalación y no es de Mango.</span></div>
    </div>
  );
}

function KbSourceDecision({ r, compact }) {
  const I = window.Icons; const S = window.MangoStore; const K = window.KB; const toast = window.useToast?.();
  window.useMango(s => s.role); window.useMango(s => s.actorOverride);
  const [mode, setMode] = React.useState(null); const [note, setNote] = React.useState(''); const [tried, setTried] = React.useState(false);
  const st = K.REQ_ST[r.status];
  if (r.status !== 'pending') return <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}><span className={'badge ' + st[1]} style={{ marginRight: 8 }}>{st[0]}</span>por {r.status === 'withdrawn' ? r.by : r.decidedBy} · {window.fmtAgo(r.decidedAt || r.at)}{r.note ? <> · «{r.note}»</> : null}</div>;
  if (r.by === S.actor()) return <div className="row gap-2" style={{ flexWrap: 'wrap' }}><span className="ap-reason" style={{ flex: '1 1 220px' }}><I.Lock size={12} /> Tú lo propusiste: lo aprueba otro administrador.</span><button className="btn btn-sm" onClick={() => { K.withdraw(r.id); toast?.({ tone: 'info', msg: 'Propuesta retirada' }); }}>Retirar propuesta</button></div>;
  if (!K.isAdmin()) return <div className="ap-reason"><I.Lock size={12} /> Espera la aprobación de un administrador.</div>;
  const approve = () => { K.decide(r.id, 'approved', note.trim() || undefined); toast?.({ tone: 'success', msg: 'Bucket aprobado · empieza la sincronización' }); };
  const reject = () => { setTried(true); if (!note.trim()) return; K.decide(r.id, 'rejected', note.trim()); toast?.({ tone: 'info', msg: 'Bucket rechazado' }); };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {mode === 'reject' && <div style={{ display: 'grid', gap: 6 }}>
        <label htmlFor={'kbrej-' + r.id} style={{ fontSize: 12.5, fontWeight: 500 }}>Motivo del rechazo</label>
        <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{K.REJECT.map(x => <button key={x} type="button" className="tk-chip" onClick={() => setNote(x)}>{x}</button>)}</div>
        <textarea id={'kbrej-' + r.id} className="input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Lo verá quien lo propuso" autoFocus style={tried && !note.trim() ? { borderColor: 'var(--red)' } : null} />
        {tried && !note.trim() && <div style={{ fontSize: 12, color: 'var(--red)' }}>Escribe o elige un motivo</div>}
      </div>}
      {mode === 'approve' && <div style={{ display: 'grid', gap: 6 }}>
        <label htmlFor={'kbapn-' + r.id} style={{ fontSize: 12.5, fontWeight: 500 }}>Nota <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· opcional</span></label>
        <textarea id={'kbapn-' + r.id} className="input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Contexto para Auditoría" autoFocus />
      </div>}
      <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
        {!mode && <><button className="btn btn-sm btn-primary" onClick={compact ? approve : () => setMode('approve')}><I.Check size={12} /> Aprobar</button><button className="btn btn-sm" onClick={() => setMode('reject')}>Rechazar</button></>}
        {mode === 'approve' && <><button className="btn btn-sm btn-primary" onClick={approve}><I.Check size={12} /> Confirmar aprobación</button><button className="btn btn-sm btn-ghost" onClick={() => { setMode(null); setNote(''); }}>Cancelar</button></>}
        {mode === 'reject' && <><button className="btn btn-sm mk-danger" onClick={reject}>Confirmar rechazo</button><button className="btn btn-sm btn-ghost" onClick={() => { setMode(null); setNote(''); setTried(false); }}>Cancelar</button></>}
        {!compact && <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>Al aprobar empieza la primera sincronización · firmas como {S.actor()}</span>}
      </div>
    </div>
  );
}

function KbSourceDetail({ r }) {
  const I = window.Icons; const K = window.KB; const st = K.REQ_ST[r.status];
  const tl = [
    { who: r.by, what: r.prev ? 'propuso cambiar el bucket' : 'propuso el bucket', t: window.fmtAgo(r.at), tone: 'var(--blue)' },
    ...(r.status === 'approved' ? [{ who: r.decidedBy, what: 'aprobó' + (r.note ? ': «' + r.note + '»' : ''), t: window.fmtAgo(r.decidedAt), tone: 'var(--green)' }] : []),
    ...(r.status === 'rejected' ? [{ who: r.decidedBy, what: 'rechazó: «' + r.note + '»', t: window.fmtAgo(r.decidedAt), tone: 'var(--red)' }] : []),
    ...(r.status === 'withdrawn' ? [{ who: r.by, what: 'retiró la propuesta', t: window.fmtAgo(r.decidedAt || r.at), tone: 'var(--text-muted)' }] : []),
  ];
  return (
    <>
      <div className="ap-detail-h"><span className="mono" style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{r.id}</span><span className={'badge ' + st[1]}>{st[0]}</span><span className="badge">Knowledge base</span></div>
      <div className="ap-detail-b"><div className="ap-sections">
        <div><h2 className="ap-h2">{K.reqTitle(r)}</h2><p className="ap-impact">{r.prev ? 'Si se aprueba, la siguiente sincronización lee el prefijo nuevo y saca lo que ya no esté ahí. Mientras se decide, sigue leyendo el actual.' : 'Si se aprueba, Mango copia lo que hay en ese prefijo en cada sincronización y lo indexa. Mientras tanto no se lee nada.'}</p></div>
        <KbSourceFacts r={r} />
        <div className="mk-meta" style={{ lineHeight: 1.5 }}>Solo reciben su contenido las personas de sus grupos, también a través de un agente. El cifrado se comprueba al sincronizar: un bucket con una llave propia del cliente (KMS) no se puede leer en esta versión.</div>
        <div><div className="mk-sec-t">historial</div><div className="tk-activity">{tl.map((e, i) => <div key={i} className="tk-act"><span className="tk-dot" style={{ background: e.tone, marginTop: 6 }} /><span style={{ flex: 1 }}><b style={{ fontWeight: 500, color: 'var(--text)' }}>{e.who}</b> {e.what}</span>{e.t && <span className="tk-meta">{e.t}</span>}</div>)}</div></div>
        {K.get(r.kb) && <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => { window.MangoStore.set({ kbOpen: r.kb }); window.MangoNav?.('knowledge'); }}>Abrir knowledge base <I.ArrowRight size={11} /></button>}
      </div></div>
      <div className="ap-detail-f"><KbSourceDecision r={r} /></div>
    </>
  );
}

Object.assign(window, { KbSourceRow, KbSourceFacts, KbSourceDecision, KbSourceDetail });
