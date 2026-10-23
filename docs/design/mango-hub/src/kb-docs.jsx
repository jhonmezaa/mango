// Knowledge Bases · pestañas «Documentos» (con la subida de archivos) y «Probar búsqueda»
function KbLocked({ title, children }) {
  const I = window.Icons;
  return <div className="kb-lock" role="status"><div className="kb-lock-t"><I.Lock size={14} />{title}</div><div className="kb-lock-b">{children}</div></div>;
}

function KbDocRow({ d, k, edit, ask, setAsk }) {
  const K = window.KB; const toast = window.useToast?.();
  const meta = [K.bytes(d.bytes), d.pages ? d.pages + ' págs.' : null, d.status === 'indexed' ? K.ago(d.at) : null].filter(Boolean).join(' · ');
  return (
    <div className="kb-doc">
      <div style={{ minWidth: 0 }}><div className="kb-doc-n">{d.name}</div><div className="kb-doc-m">{meta}</div></div>
      <div className="row gap-2" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {d.status === 'failed' && <span className="badge badge-red">{d.reason}</span>}
        {d.status === 'indexing' && <span className="badge badge-blue"><span className="g-spin" style={{ width: 9, height: 9, marginRight: 5 }} />Indexando</span>}
        {d.status === 'deleting' && <span className="badge"><span className="g-spin" style={{ width: 9, height: 9, marginRight: 5 }} />Borrando</span>}
        {edit && (d.status === 'indexed' || d.status === 'failed') && ask !== d.id && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsk(d.id)} aria-label={'Quitar ' + d.name}>Quitar</button>}
      </div>
      {ask === d.id && <div className="kb-confirm"><span>Deja de aparecer en las respuestas de los agentes.</span><span className="row gap-2"><button type="button" className="btn btn-sm mk-danger" onClick={() => { K.removeDoc(k.id, d.id); setAsk(null); toast?.({ tone: 'info', msg: 'Quitando ' + d.name }); }}>Quitar</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsk(null)}>Cancelar</button></span></div>}
    </div>
  );
}

function KbDocsTab({ k, acc, sub, setSub, guard }) {
  const I = window.Icons; const K = window.KB;
  const [shown, setShown] = React.useState(20); const [ask, setAsk] = React.useState(null);
  if (!acc.seeDocs) return <KbLocked title="No ves los documentos de esta knowledge base">Los ven quien la creó, los administradores y los creadores de agentes que están en sus grupos: <span className="mono">{k.groups.join(', ')}</span>.</KbLocked>;
  if (sub === 'upload') return <KbUpload k={k} onBack={() => setSub(null)} guard={guard} />;
  const docs = k.docs || []; const upload = k.origin === 'upload'; const edit = acc.canEdit && k.status !== 'deleting';
  const failed = docs.filter(d => d.status === 'failed'); const busy = docs.filter(d => d.status === 'indexing' || d.status === 'deleting');
  const ok = docs.filter(d => d.status === 'indexed').sort((a, b) => new Date(b.at) - new Date(a.at));
  const c = K.counts(k);
  return (
    <>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}><span className="mk-meta">{K.n(c.total)} de {K.n(K.LIMITS.docs)} documentos · {K.bytes(c.bytes)} de 5 GB</span>{upload && edit && <button type="button" className="btn btn-sm" onClick={() => setSub('upload')}><I.Upload size={12} /> Subir archivos</button>}</div>
      {!upload && <div className="mc-alert"><I.Info size={14} /><div>Vienen de <span className="mono" style={{ overflowWrap: 'anywhere' }}>{k.ref}</span>. Para agregar, cambiar o quitar documentos, hazlo en el bucket: se refleja en la próxima sincronización.</div></div>}
      {!docs.length && <div className="mk-meta">{upload ? 'Todavía no tiene documentos.' : k.status === 'approval' ? 'Se leen cuando se apruebe el bucket.' : 'Aún no se ha leído nada del bucket.'}</div>}
      {failed.length > 0 && <MkSec title={`No indexados · ${failed.length}`}>{failed.map(d => <KbDocRow key={d.id} d={d} k={k} edit={edit && upload} ask={ask} setAsk={setAsk} />)}<div className="mk-meta" style={{ marginTop: 4 }}>{upload ? 'Los agentes no los ven. Corrígelos y vuelve a subirlos.' : 'Los agentes no los ven. Corrígelos en el bucket: se vuelven a intentar en la próxima sincronización.'}</div></MkSec>}
      {busy.length > 0 && <MkSec title={`En curso · ${busy.length}`}>{busy.map(d => <KbDocRow key={d.id} d={d} k={k} />)}</MkSec>}
      {ok.length > 0 && <MkSec title={`Indexados · ${K.n(ok.length)}`}>{ok.slice(0, shown).map(d => <KbDocRow key={d.id} d={d} k={k} edit={edit && upload} ask={ask} setAsk={setAsk} />)}{ok.length > shown && <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => setShown(x => x + 20)}>Mostrar más</button>}</MkSec>}
      {docs.length > 0 && <div className="mk-meta">Los originales no se descargan desde Mango en esta versión.</div>}
    </>
  );
}

// Cada archivo sube directo a S3 y queda «Subido»; al guardar entra en la knowledge base y empieza a indexarse.
function KbUpload({ k, onBack, guard }) {
  const I = window.Icons; const S = window.MangoStore; const K = window.KB; const toast = window.useToast?.();
  const [files, setFiles] = React.useState([]); const [drag, setDrag] = React.useState(false); const [trim, setTrim] = React.useState(false); const [leaving, setLeaving] = React.useState(null);
  const inputRef = React.useRef(null); const timers = React.useRef([]); const filesRef = React.useRef(files); filesRef.current = files;
  const demo = window.useMango(s => s.kbDemoDrop); const demo0 = React.useRef(demo);
  const up = files.filter(f => f.state === 'uploaded'); const going = files.filter(f => f.state === 'uploading');
  const c = K.counts(k); const busyKb = k.status === 'syncing';
  React.useEffect(() => { guard.current = (fn) => { if (!filesRef.current.some(f => f.state === 'uploaded')) return true; setLeaving(() => fn); return false; }; return () => { guard.current = null; timers.current.forEach(clearInterval); }; }, []);
  const add = (list) => {
    const arr = Array.from(list || []); if (!arr.length) return;
    setTrim(arr.length > K.LIMITS.batch);
    const cur = filesRef.current.filter(f => f.state !== 'rejected');
    let docs = c.total + cur.length; let bytes = c.bytes + cur.reduce((s, f) => s + f.bytes, 0);
    let mism = S.get().simKbUpload === 'mismatch';
    const next = arr.slice(0, K.LIMITS.batch).map((file, i) => {
      const name = file.name; const size = file.size || 0; const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      let reason = null;
      if (!K.TYPES.includes(ext)) reason = 'Tipo no admitido';
      else if (size > K.LIMITS.fileMB * 1e6) reason = 'Supera ' + K.LIMITS.fileMB + ' MB';
      else if (docs + 1 > K.LIMITS.docs) reason = 'La knowledge base pasaría de ' + K.n(K.LIMITS.docs) + ' documentos';
      else if (bytes + size > K.LIMITS.bytes) reason = 'La knowledge base pasaría de 5 GB';
      if (!reason) { docs++; bytes += size; }
      const bad = !reason && mism && ext === 'pdf'; if (bad) mism = false;
      return { id: 'f' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 5), name, bytes: size, state: reason ? 'rejected' : 'uploading', reason, pct: 0, bad };
    });
    setFiles(fs => [...fs, ...next]);
    next.filter(f => f.state === 'uploading').forEach(f => {
      const dur = Math.min(2600, 600 + f.bytes / 5e4); const t0 = Date.now();
      const t = setInterval(() => {
        const p = Math.min(1, (Date.now() - t0) / dur);
        setFiles(fs => fs.map(x => x.id !== f.id ? x : p < 1 ? { ...x, pct: p } : f.bad ? { ...x, state: 'rejected', reason: 'El contenido no es del tipo que dice', pct: 1 } : { ...x, state: 'uploaded', pct: 1 }));
        if (p >= 1) clearInterval(t);
      }, 120);
      timers.current.push(t);
    });
  };
  React.useEffect(() => { if (demo && demo !== demo0.current) add(K.DEMO_FILES.map(([name, size]) => ({ name, size }))); }, [demo]);
  const back = () => { if (guard.current && guard.current(onBack) === false) return; onBack(); };
  const save = () => { K.saveUploads(k.id, up.map(f => ({ name: f.name, bytes: f.bytes }))); toast?.({ tone: 'success', msg: (up.length === 1 ? '1 archivo guardado' : up.length + ' archivos guardados') + ' · indexando' }); filesRef.current = []; setFiles([]); onBack(); };
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost sc-res-back" onClick={back}><I.ChevronLeft size={12} /> Documentos</button>
      <div className="sc-res-h">Subir archivos</div>
      <div className={'kb-drop' + (drag ? ' is-drag' : '')} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}>
        <I.Upload size={18} />
        <div>Arrastra archivos aquí o <button type="button" className="sr-link kb-pick" onClick={() => inputRef.current?.click()}>elígelos en tu equipo</button></div>
        <div className="mk-meta">PDF, DOCX, TXT, MD, CSV o XLSX · hasta {K.LIMITS.fileMB} MB cada uno · {K.LIMITS.batch} por vez</div>
        <input ref={inputRef} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.csv,.xlsx" onChange={e => { add(e.target.files); e.target.value = ''; }} />
      </div>
      <div className="mk-meta">Esta knowledge base: {K.n(c.total)} de {K.n(K.LIMITS.docs)} documentos · {K.bytes(c.bytes)} de 5 GB.</div>
      {trim && <div className="mc-alert amber" role="status"><I.Warn size={14} /><div>Puedes subir {K.LIMITS.batch} archivos por vez: se tomaron los primeros {K.LIMITS.batch}.</div></div>}
      {files.length > 0 && <div className="kb-files" aria-live="polite">{files.map(f => (
        <div key={f.id} className="kb-file">
          <I.Document size={14} style={{ color: 'var(--text-muted)' }} />
          <div style={{ minWidth: 0 }}>
            <div className="kb-file-n">{f.name}</div>
            <div className="kb-file-s">{f.state === 'uploading' ? <><span className="mk-bar-track"><span style={{ width: Math.round(f.pct * 100) + '%', background: 'var(--blue)' }} /></span><span>Subiendo {Math.round(f.pct * 100)} %</span></> : f.state === 'uploaded' ? <span className="kb-ok"><I.Check size={11} /> Subido · {K.bytes(f.bytes)}</span> : <span className="kb-bad">Rechazado · {f.reason}</span>}</div>
          </div>
          {f.state !== 'uploading' && <button type="button" className="btn btn-ghost btn-icon" aria-label={'Quitar ' + f.name} onClick={() => setFiles(fs => fs.filter(x => x.id !== f.id))}><I.Close size={12} /></button>}
        </div>
      ))}</div>}
      {leaving && <div className="mc-alert amber" role="alert"><I.Warn size={14} /><div style={{ flex: 1 }}>Tienes {up.length} {up.length === 1 ? 'archivo subido' : 'archivos subidos'} sin guardar. Si sales, no se agregan a la knowledge base y se descartan mañana.<div className="row gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}><button type="button" className="btn btn-sm" onClick={() => { const fn = leaving; filesRef.current = []; setFiles([]); setLeaving(null); fn(); }}>Salir sin guardar</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setLeaving(null)}>Seguir aquí</button></div></div></div>}
      <div className="kb-up-foot">
        <button type="button" className="btn btn-sm btn-primary" disabled={!up.length || going.length > 0 || busyKb} onClick={save}>{up.length ? 'Guardar ' + up.length + (up.length === 1 ? ' archivo' : ' archivos') : 'Guardar'}</button>
        <span className="mk-meta">{busyKb ? 'Espera a que termine la indexación en curso para guardar.' : going.length ? 'Espera a que terminen de subir.' : 'Al guardar empieza la indexación. Lo que subas y no guardes se descarta mañana.'}</span>
      </div>
    </>
  );
}

function KbTestTab({ k, acc }) {
  const K = window.KB;
  const [q, setQ] = React.useState(''); const [res, setRes] = React.useState(null); const [busy, setBusy] = React.useState(false);
  const g = <span className="mono">{k.groups.join(', ')}</span>;
  if (!acc.seeDocs) return <KbLocked title="No puedes probar la búsqueda">La prueba devuelve contenido de la knowledge base: solo la usan quienes ven sus documentos y están en sus grupos ({g}).</KbLocked>;
  if (!acc.inGroups) return <KbLocked title="No estás en los grupos de esta knowledge base">La búsqueda se hace con tu identidad, igual que la de un agente: sin estar en {g} no recibirías nada. {acc.owner && acc.admin ? 'Haberla creado o ser administrador no basta.' : acc.owner ? 'Haberla creado no basta.' : 'Ser administrador no basta.'} Sus documentos están en «Documentos».</KbLocked>;
  const c = K.counts(k);
  if (k.status === 'deleting') return <div className="mk-meta">Se está borrando: ya no se puede consultar.</div>;
  if (!c.indexed) return <div className="mk-meta">{k.status === 'approval' ? 'Aún no hay nada indexado: el bucket espera aprobación.' : k.origin === 'upload' ? 'Aún no hay nada indexado: sube archivos para probarla.' : 'Aún no hay nada indexado.'}</div>;
  const run = () => { if (!q.trim() || busy) return; setBusy(true); setTimeout(() => { setRes(K.search(k.id, q)); setBusy(false); }, 500); };
  return (
    <>
      <div className="mk-meta" style={{ lineHeight: 1.5 }}>Busca como lo haría un agente, con tu identidad, para ver qué fragmentos recibiría. Queda en Auditoría, sin el texto que buscas.</div>
      <div className="row gap-2"><input className="input" style={{ flex: 1, minWidth: 0 }} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && run()} placeholder={'p. ej. ' + (K.SAMPLE_Q[k.id] || 'procedimiento de rollback')} aria-label="Consulta de prueba" autoFocus /><button type="button" className="btn btn-sm btn-primary" onClick={run} disabled={!q.trim() || busy}>{busy ? 'Buscando…' : 'Buscar'}</button></div>
      {res && (res.length ? <div className="kb-hits" aria-live="polite">{res.map((r, i) => (
        <div key={i} className="kb-hit">
          <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}><span className="kb-doc-n" style={{ minWidth: 0 }}>{r.doc}{r.page ? <span className="mk-meta" style={{ fontFamily: 'var(--font-sans)' }}> · p. {r.page}</span> : null}</span><span className="mono mk-meta" title="Puntaje de la búsqueda">{r.score.toFixed(2).replace('.', ',')}</span></div>
          <p className="kb-hit-t">{r.text}</p>
        </div>
      ))}</div> : <div className="mk-meta">Sin resultados.</div>)}
    </>
  );
}

Object.assign(window, { KbDocsTab, KbTestTab });
