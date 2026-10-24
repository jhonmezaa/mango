// Knowledge Bases en el agente: sección del Agent Builder, bloque de la Revisión y citas del chat.
function KbAgentSection({ snap, set, setView }) {
  const I = window.Icons; const K = window.KB;
  const kbs = window.useMango(s => s.kbs) || [];
  window.useMango(s => s.role); window.useMango(s => s.actorOverride);
  const loadErr = window.useMango(s => s.simKbBuilder) === 'error';
  const sel = snap.kbs || [];
  const toggle = (id) => set({ kbs: sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id] });
  // Sin la lista no se sabe qué puede usar quien edita: las que ya tiene el agente se conservan (solo su id) y se pueden quitar.
  if (loadErr) return (
    <>
      <div className="mc-alert amber" role="alert"><I.Warn size={14} /><div style={{ flex: 1, minWidth: 0 }}>No se pudieron cargar las knowledge bases. Las que ya tiene el agente se conservan.<div style={{ marginTop: 8 }}><button type="button" className="btn btn-sm" onClick={() => window.MangoStore.set({ simKbBuilder: null })}>Reintentar</button></div></div></div>
      {sel.length > 0 && <div className="mc-alert" style={{ display: 'block' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{sel.length === 1 ? 'Tiene 1 knowledge base' : 'Tiene ' + sel.length + ' knowledge bases'} · se conservan</div>
        {sel.map(id => <div key={id} className="row between" style={{ fontSize: 12.5, padding: '3px 0', gap: 8 }}><span className="mono">{id}</span><button type="button" className="sr-link" onClick={() => toggle(id)}>Quitar</button></div>)}
      </div>}
      <div className="mk-meta">{sel.length} de {K.LIMITS.perAgent}</div>
    </>
  );
  const usable = kbs.filter(k => K.access(k).inGroups && k.status !== 'deleting');
  const kept = sel.filter(id => !usable.some(k => k.id === id));
  const full = sel.length >= K.LIMITS.perAgent;
  const gaps = sel.map(id => kbs.find(k => k.id === id)).filter(Boolean).map(k => ({ k, groups: (snap.groups || []).filter(g => !k.groups.includes(g)) })).filter(x => x.groups.length);
  return (
    <>
      {kept.length > 0 && <div className="mc-alert" style={{ display: 'block' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{kept.length === 1 ? 'Esta knowledge base ya estaba y no puedes usarla' : 'Estas knowledge bases ya estaban y no puedes usarlas'}</div>
        {kept.map(id => { const k = kbs.find(x => x.id === id); return <div key={id} className="row between" style={{ fontSize: 12.5, padding: '3px 0', gap: 8 }}><span>{k ? k.name : <span className="mono">{id}</span>}</span><span className="row gap-2"><span className="mk-meta">{!k ? 'Ya no existe' : k.status === 'deleting' ? 'Se está borrando' : 'No estás en sus grupos · se conserva'}</span><button type="button" className="sr-link" onClick={() => toggle(id)}>Quitar</button></span></div>; })}
      </div>}
      {usable.length ? <div className="ab-list" style={{ maxHeight: 320 }}>{usable.map(k => { const on = sel.includes(k.id); const st = K.status(k); const dis = !on && full; return (
        <button key={k.id} type="button" className={'ab-item' + (on ? ' is-on' : '') + (dis ? ' is-off' : '')} disabled={dis} aria-pressed={on} title={dis ? 'Máximo ' + K.LIMITS.perAgent + ' por agente' : undefined} onClick={() => toggle(k.id)}>
          <span className="ab-check">{on && <I.Check size={10} />}</span>
          <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 12.5, fontWeight: 500 }}>{k.name}</span><span className="ab-sub">{K.ORIGIN[k.origin]} · {K.size(k)} · <span className="mono">{k.groups.join(', ')}</span></span></span>
          {k.status !== 'ok' && <span className={'badge ' + st.cls}>{st.label}</span>}
        </button>
      ); })}</div> : <div className="mk-meta">No hay knowledge bases que puedas usar: solo aparecen las de grupos en los que estás.</div>}
      {gaps.map(x => <div key={x.k.id} className="mc-alert amber"><I.Warn size={14} /><div><b>{x.k.name}:</b> <span className="mono">{x.groups.join(', ')}</span> {x.groups.length === 1 ? 'usa este agente pero no está' : 'usan este agente pero no están'} en esa knowledge base. A esas personas el agente les responde sin su contenido: la búsqueda se hace con la identidad de quien pregunta.</div></div>)}
      {sel.length > 0 && (snap.users || []).length > 0 && <div className="mk-meta">Las personas agregadas por correo reciben su contenido solo si están en sus grupos.</div>}
      <div className="row between" style={{ fontSize: 12, color: 'var(--text-muted)', gap: 8, flexWrap: 'wrap' }}>
        <span>{sel.length} de {K.LIMITS.perAgent} · solo aparecen las que puedes usar: estás en sus grupos</span>
        <button type="button" className="sr-link" onClick={() => setView('knowledge')}>Ver Knowledge Bases</button>
      </div>
    </>
  );
}

function RvKbs({ r, d, isNew }) {
  const K = window.KB;
  const kbs = window.useMango(s => s.kbs) || [];
  if (!K) return null;
  const all = r.snap.kbs || []; const add = isNew ? all : d.kbs.add; const rem = isNew ? [] : d.kbs.rem;
  if (isNew && !all.length) return null;
  const row = (id, kind) => { const k = kbs.find(x => x.id === id); const gap = k && kind === 'add' ? (r.snap.groups || []).filter(g => !k.groups.includes(g)) : []; const st = k && K.status(k); return (
    <div key={id} className={'rv-tool ' + kind}><span className="rv-sign">{kind === 'add' ? '+' : '−'}</span>
      <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block' }}>{k ? k.name : id}</span>{k && <span className="mono mk-meta" style={{ fontSize: 11.5 }}>{k.groups.join(', ')}</span>}{gap.length > 0 && <span className="rv-kb-gap"><span className="mono">{gap.join(', ')}</span> {gap.length === 1 ? 'usa el agente y no está' : 'usan el agente y no están'} en sus grupos: les responde sin su contenido.</span>}</span>
      {!k ? <span className="badge badge-red">Ya no existe</span> : kind === 'add' && k.status !== 'ok' && <span className={'badge ' + st.cls}>{st.label}</span>}
    </div>); };
  return (
    <div>
      <div className="mk-sec-t">knowledge bases {isNew ? '· ' + all.length : `· ${add.length} agregadas, ${rem.length} quitadas`}</div>
      <div className="rv-tools">{add.map(id => row(id, 'add'))}{rem.map(id => row(id, 'rem'))}{!isNew && !add.length && !rem.length && <div className="mk-meta" style={{ padding: '6px 0' }}>Sin cambios en knowledge bases ({all.length}).</div>}</div>
    </div>
  );
}

// Fuentes de una respuesta: una línea por cita con knowledge base, documento y página. No se abren: el texto del fragmento nunca llega al navegador.
// Se guardan con la respuesta. Sin enlace al original en esta versión.
function KbCitations({ cites }) {
  const kbs = window.useMango(s => s.kbs) || [];
  const nameOf = (id) => (kbs.find(k => k.id === id) || {}).name || id;
  const names = [...new Set(cites.map(c => nameOf(c.kb)))];
  return (
    <div className="kb-cites" role="group" aria-label="Fuentes">
      <div className="kb-cites-h">Fuentes{names.length === 1 ? ' · ' + names[0] : ''}</div>
      {cites.map(c => <div key={c.n} className="kb-cite"><span className="kb-cite-n">[{c.n}]</span><span className="kb-cite-d" title={c.doc}>{c.doc}</span>{c.page && <span className="kb-cite-m">· p. {c.page}</span>}{names.length > 1 && <span className="kb-cite-m">· {nameOf(c.kb)}</span>}</div>)}
    </div>
  );
}

// «Buscó en…» se ve solo durante el turno: no se guarda con la conversación. Sin fragmentos, no nombra la knowledge base.
function KbStep({ msg }) {
  const I = window.Icons; const none = !msg.hits;
  return <div style={{ marginBottom: 10, maxWidth: 760 }}><span className={'kb-step' + (none ? ' is-empty' : '')}><I.BookOpen size={11} /> Buscó en {none ? 'las knowledge bases' : <b style={{ fontWeight: 500, color: 'var(--text)' }}>{msg.kb}</b>} · {none ? 'ningún fragmento' : msg.hits + (msg.hits === 1 ? ' fragmento' : ' fragmentos')}</span></div>;
}

Object.assign(window, { KbAgentSection, RvKbs, KbCitations, KbStep });
