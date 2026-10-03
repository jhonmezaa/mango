(() => {
const { useState, useEffect, useRef } = React;
const K = window.GovKit;
const clone = (o) => JSON.parse(JSON.stringify(o));
const AREA_RE = /^[a-z0-9-]+$/;
const OU_RE = /^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$/;

function Propose({ mapping, tree, me, sim, mobile, onClose, onSubmit }) {
  const Ic = window.Icons; const U = window.GovAreasUtil; const D = window.GovData;
  const [draft, setDraft] = useState(() => clone(mapping.areas));
  const [newArea, setNewArea] = useState('');
  const [areaTried, setAreaTried] = useState(false);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(null);
  const diff = U.diffMap(mapping.areas, draft);
  const names = [...Object.keys(mapping.areas).filter(n => draft[n]), ...Object.keys(draft).filter(n => !mapping.areas[n])];
  const v = newArea.trim();
  const areaErr = !v ? 'Escribe un nombre' : !AREA_RE.test(v) ? 'Solo minúsculas sin acentos, números y guiones' : (v.length < 2 || v.length > 32) ? 'Entre 2 y 32 caracteres'
    : (draft[v] || mapping.areas[v]) ? 'Ya existe un área con ese nombre' : names.length >= 20 ? 'Máximo 20 áreas por mapeo' : null;
  const reasonErr = !reason.trim() ? 'El motivo es obligatorio' : reason.length > 500 ? 'Máximo 500 caracteres' : null;

  const set = (n, list) => setDraft(d => ({ ...d, [n]: list }));
  const addArea = () => { setAreaTried(true); if (areaErr) return; setDraft(d => ({ ...d, [v]: [] })); setNewArea(''); setAreaTried(false); setPicker(v); };
  const removeArea = (n) => setDraft(d => { const x = { ...d }; delete x[n]; return x; });
  const restoreArea = (n) => setDraft(d => ({ ...d, [n]: [...mapping.areas[n]] }));
  const submit = () => {
    setTried(true); setErr(null);
    if (!diff.length) { setErr({ t: 'No hay cambios que proponer', b: 'Agrega o quita áreas u OUs antes de enviar.' }); return; }
    const empty = names.filter(n => (draft[n] || []).length === 0);
    if (empty.length) { setErr({ t: 'Agrega al menos una OU', b: (empty.length === 1 ? 'El área ' + empty[0] + ' no tiene' : 'Las áreas ' + empty.join(', ') + ' no tienen') + ' OUs. Cada área necesita al menos una.' }); return; }
    if (reasonErr) return;
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      const E = {
        ou: ['Alguna OU no existe en la organización', 'Revisa los ids que agregaste; puede que la OU se haya movido o eliminado en AWS.'],
        conflict: ['Otro administrador cambió el mapeo', 'Se aprobó otro cambio mientras editabas. Cierra y vuelve a proponer sobre la versión vigente.'],
        audit: ['No se pudo registrar la auditoría; el cambio no se aplicó', 'La propuesta no se guardó. Intenta de nuevo en unos minutos.'],
      };
      if (E[sim]) { setErr({ t: E[sim][0], b: E[sim][1] }); return; }
      onSubmit(draft, reason.trim());
    }, 700);
  };

  return (
    <K.Modal title="Proponer cambio del mapeo" sub="El cambio no se aplica hasta que otro administrador lo apruebe. Si nadie lo revisa, vence en 7 días." onClose={onClose} width={1000} sheet={mobile} autoFocus={false}
      footer={<>
        <span className="g-sub" style={{ marginRight: 'auto', whiteSpace: 'nowrap' }}>Sobre la versión {mapping.version}</span>
        <button className="btn btn-sm" onClick={onClose}>Cancelar</button>
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={submit}>{saving ? 'Enviando…' : 'Enviar propuesta'}</button>
      </>}>
      {err && <K.Banner tone="error" title={err.t}>{err.b}</K.Banner>}
      <div className="g-pgrid">
        <div className="g-pedit">
          <div className="g-sec-h" style={{ marginBottom: 8 }}><span className="g-sec-t">Áreas</span><span className="g-sec-meta g-num">{names.length} de 20</span></div>
          <div className="g-card">
            {names.map(n => {
              const list = draft[n]; const orig = mapping.areas[n] || [];
              const mine = n === me.area; const isNew = !mapping.areas[n]; const full = list.length >= 15;
              const removed = orig.filter(id => !list.includes(id));
              return (
                <div key={n} className="g-erow">
                  <div className="g-erow-h">
                    <span className="g-area">{n}</span>
                    {mine && <span className="badge badge-accent">Tu área</span>}
                    {isNew && <span className="g-dtag new">Nueva</span>}
                    <span className="g-sub g-num" style={{ marginLeft: 'auto' }}>{list.length} de 15</span>
                    {!mine && <button type="button" className="btn btn-ghost btn-icon" aria-label={'Eliminar área ' + n} title="Eliminar área" onClick={() => removeArea(n)}><Ic.Trash size={13} /></button>}
                  </div>
                  <div className="g-chips">
                    {list.map(id => <U.OuChip key={id} id={id} tree={tree} kind={orig.includes(id) ? undefined : 'add'} onRemove={mine ? null : () => set(n, list.filter(x => x !== id))} />)}
                    {removed.map(id => <U.OuChip key={id} id={id} tree={tree} kind="rem" onRestore={() => set(n, [...list, id])} />)}
                    {!mine && (
                      <span style={{ position: 'relative' }}>
                        <button type="button" className="g-addou" disabled={full} aria-expanded={picker === n} onClick={() => setPicker(picker === n ? null : n)}><Ic.Plus size={11} /> Agregar OU</button>
                        {picker === n && <OuPicker tree={tree} list={D.tree} draft={draft} area={n} onPick={(id) => set(n, [...draft[n], id])} onClose={() => setPicker(null)} />}
                      </span>
                    )}
                  </div>
                  {mine && <K.Reason>Es tu área: no puedes proponer cambios sobre ella.</K.Reason>}
                  {!mine && full && <div className="g-hint">Máximo 15 OUs por área.</div>}
                  {!mine && list.length === 0 && <div className={tried ? 'g-err' : 'g-hint'}>Agrega al menos una OU.</div>}
                </div>
              );
            })}
            {names.length === 0 && <div className="g-hint" style={{ padding: 16 }}>No hay áreas. Agrega la primera abajo.</div>}
          </div>
          <div className="g-field" style={{ marginTop: 14 }}>
            <label htmlFor="new-area">Nueva área</label>
            <div className="row gap-2">
              <input id="new-area" className={'input mono' + (areaTried && areaErr ? ' has-error' : '')} style={{ flex: 1, maxWidth: 280 }} placeholder="p. ej. logistica" value={newArea}
                onChange={e => setNewArea(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addArea(); } }} maxLength={40} aria-invalid={areaTried && !!areaErr} />
              <button type="button" className="btn btn-sm" onClick={addArea} disabled={names.length >= 20}><Ic.Plus size={11} /> Agregar área</button>
            </div>
            {areaTried && areaErr ? <div className="g-err">{areaErr}</div> : <div className="g-hint">Minúsculas, números y guiones, de 2 a 32 caracteres.</div>}
          </div>
        </div>

        <div className="g-pside">
          <div className="g-sec-t" style={{ marginBottom: 8 }}>Cambios propuestos</div>
          <U.DiffView diff={diff} tree={tree} onRestore={restoreArea} />
          <div className="g-field" style={{ marginTop: 18 }}>
            <div className="row between"><label htmlFor="prop-reason">Motivo del cambio</label><span className={'g-sub g-num' + (reason.length > 500 ? ' g-err' : '')}>{reason.length} / 500</span></div>
            <textarea id="prop-reason" className={'input' + (tried && reasonErr ? ' has-error' : '')} rows={4} value={reason} onChange={e => setReason(e.target.value)} placeholder="Por qué se necesita. Lo verá quien lo revise." />
            {tried && reasonErr ? <div className="g-err">{reasonErr}</div> : <div className="g-hint">Obligatorio. Queda registrado en Auditoría.</div>}
          </div>
        </div>
      </div>
    </K.Modal>
  );
}

function OuPicker({ tree, list, draft, area, onPick, onClose }) {
  const Ic = window.Icons;
  const [q, setQ] = useState('');
  const [manual, setManual] = useState('');
  const [mTried, setMTried] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.g-addou')) onClose(); };
    document.addEventListener('mousedown', h);
    ref.current?.querySelector('input')?.focus({ preventScroll: true });
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onClose(); } };
  const current = draft[area] || [];
  const full = current.length >= 15;

  if (!tree) {
    const mv = manual.trim(); const mErr = !OU_RE.test(mv) ? 'Formato: ou-xxxx-xxxxxxxx' : current.includes(mv) ? 'Ya está en esta área' : null;
    return (
      <div className="g-pop" ref={ref} onKeyDown={onKey}>
        <div className="g-sub" style={{ marginBottom: 8 }}>No se pudo leer la organización. Escribe el id de la OU.</div>
        <div className="row gap-2">
          <input className={'input mono' + (mTried && mErr ? ' has-error' : '')} style={{ flex: 1 }} placeholder="ou-xxxx-xxxxxxxx" value={manual} onChange={e => setManual(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setMTried(true); if (!mErr && !full) { onPick(mv); setManual(''); setMTried(false); } } }} />
          <button type="button" className="btn btn-sm" disabled={full} onClick={() => { setMTried(true); if (!mErr) { onPick(mv); setManual(''); setMTried(false); } }}>Agregar</button>
        </div>
        {mTried && mErr && <div className="g-err" style={{ marginTop: 6 }}>{mErr}</div>}
      </div>
    );
  }
  const Q = q.trim().toLowerCase();
  const items = list.filter(o => !Q || (o.name + ' ' + o.id + ' ' + o.path).toLowerCase().includes(Q));
  const where = (id) => Object.keys(draft).filter(n => n !== area && draft[n].includes(id));
  return (
    <div className="g-pop" ref={ref} onKeyDown={onKey} role="dialog" aria-label={'Agregar OU a ' + area}>
      <div className="search-wrap"><Ic.Search size={12} /><input className="input" placeholder="Buscar por nombre, id o ruta" value={q} onChange={e => setQ(e.target.value)} /></div>
      {full && <div className="g-hint" style={{ padding: '8px 2px 0' }}>Esta área ya tiene 15 OUs, el máximo.</div>}
      <div className="g-pop-list" role="listbox">
        {items.map(o => {
          const has = current.includes(o.id); const others = where(o.id);
          return (
            <button key={o.id} type="button" role="option" aria-selected={has} disabled={has || full} onClick={() => onPick(o.id)} style={{ paddingLeft: 10 + (Q ? 0 : o.depth * 16) }}>
              <span className="g-pop-main"><span className="g-ou-n">{o.name}</span><span className="g-id">{o.id}</span></span>
              {Q && <span className="g-pop-path">{o.path}</span>}
              {has ? <span className="g-pop-path">Ya agregada</span> : others.length > 0 && <span className="g-pop-path">También en {others.join(', ')}</span>}
            </button>
          );
        })}
        {!items.length && <div className="g-hint" style={{ padding: 12 }}>Ninguna OU coincide.</div>}
      </div>
    </div>
  );
}

window.GovPropose = Propose;
})();
