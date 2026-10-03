(() => {
const { useState } = React;
const K = window.GovKit;
const clone = (o) => JSON.parse(JSON.stringify(o));
const MAX_PENDING = 10;

function diffMap(from, to) {
  const names = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  const out = [];
  names.forEach(n => {
    const a = from[n], b = to[n];
    if (!a) out.push({ area: n, kind: 'new', add: b, remove: [] });
    else if (!b) out.push({ area: n, kind: 'removed', add: [], remove: a });
    else {
      const add = b.filter(x => !a.includes(x)), remove = a.filter(x => !b.includes(x));
      if (add.length || remove.length) out.push({ area: n, kind: 'changed', add, remove });
    }
  });
  return out;
}

function OuChip({ id, tree, kind, onRemove, onRestore }) {
  const Ic = window.Icons;
  const name = tree?.[id]?.name;
  return (
    <span className={'g-ou' + (kind ? ' ' + kind : '')} title={tree?.[id]?.path || id}>
      {kind === 'add' && <span className="g-ou-sign" aria-label="agrega">+</span>}
      {kind === 'rem' && <span className="g-ou-sign" aria-label="quita">−</span>}
      {name && <span className="g-ou-n">{name}</span>}
      <span className="g-id">{id}</span>
      {onRemove && <button type="button" aria-label={'Quitar ' + (name || id)} onClick={onRemove}><Ic.Close size={11} /></button>}
      {onRestore && <button type="button" aria-label={'Restaurar ' + (name || id)} title="Restaurar" onClick={onRestore}><Ic.Refresh size={11} /></button>}
    </span>
  );
}

const KIND = { new: 'Área nueva', removed: 'Área eliminada', changed: 'Área modificada' };
function DiffView({ diff, tree, onRestore }) {
  if (!diff.length) return <div className="g-hint">Aún no hay cambios.</div>;
  return (
    <div className="g-diff">
      {diff.map(d => (
        <div key={d.area} className="g-diff-row">
          <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="g-area">{d.area}</span>
            <span className={'g-dtag ' + d.kind}>{KIND[d.kind]}</span>
            {onRestore && d.kind === 'removed' && <button type="button" className="g-link" onClick={() => onRestore(d.area)}>Restaurar</button>}
          </div>
          {d.add.length > 0 && <div className="g-diff-line"><span className="g-diff-k">Agrega</span><div className="g-chips">{d.add.map(id => <OuChip key={id} id={id} tree={tree} kind="add" />)}</div></div>}
          {d.remove.length > 0 && <div className="g-diff-line"><span className="g-diff-k">Quita</span><div className="g-chips">{d.remove.map(id => <OuChip key={id} id={id} tree={tree} kind="rem" />)}</div></div>}
        </div>
      ))}
    </div>
  );
}

function Areas({ state, retry, sim, notify, mobile }) {
  const Ic = window.Icons; const D = window.GovData; const me = D.me;
  const [mapping, setMapping] = useState(() => state === 'empty' ? { version: 1, areas: {} } : clone(D.mapping));
  const [props, setProps] = useState(() => state === 'empty' ? [] : clone(D.proposals));
  const [modal, setModal] = useState(null);
  const tree = sim === 'tree' ? null : D.treeIndex;

  if (state === 'loading') return <AreasSkeleton />;
  if (state === 'error') return <K.ErrorState title="No pudimos cargar el mapeo de áreas" body="El servicio no respondió. El mapeo vigente no cambió." onRetry={retry} />;

  const isExpired = (p) => K.NOW - new Date(p.createdAt) > 7 * K.DAY;
  const pending = sim === 'toomany' ? MAX_PENDING : props.filter(p => !isExpired(p)).length;
  const names = Object.keys(mapping.areas);
  const blocked = pending >= MAX_PENDING;

  const submit = (draft, reason) => {
    const p = { id: 'prop-0000-' + String(7 + props.length).padStart(4, '0'), by: me.email, createdAt: K.NOW.toISOString(), baseVersion: mapping.version, reason, mapping: draft };
    setProps([p, ...props]); setModal(null);
    window.MangoStore?.log('mapping.propose', p.id, 'Propuso cambio del mapeo de áreas: ' + reason);
    notify('Propuesta enviada · la debe aprobar otro administrador');
  };
  const approve = (p) => { window.MangoStore?.log('mapping.approve', p.id, `Aprobó cambio del mapeo · versión ${mapping.version + 1}`); setMapping({ version: mapping.version + 1, areas: clone(p.mapping) }); setProps(props.filter(x => x.id !== p.id)); setModal(null); notify(`Cambio aprobado · mapeo en versión ${mapping.version + 1}`); };
  const bump = () => setMapping(m => ({ ...m, version: m.version + 1 }));
  const drop = (p, msg) => { window.MangoStore?.log(msg.includes('retirada') ? 'mapping.withdraw' : 'mapping.reject', p.id, msg); setProps(props.filter(x => x.id !== p.id)); setModal(null); notify(msg); };

  return (
    <>
      {!tree && <div style={{ marginBottom: 20 }}><K.Banner tone="warn" title="No se pudo leer la organización de AWS">Mostramos el mapeo con los ids de OU, sin nombres. Puedes revisar propuestas; para agregar OUs tendrás que escribir su id.</K.Banner></div>}

      <section className="g-sec" style={{ marginTop: 0 }}>
        <div className="g-sec-h">
          <div>
            <div className="g-sec-t">Mapeo vigente</div>
            <div className="g-sec-meta">Versión {mapping.version} · {names.length} de 20 áreas · cada área solo ve el gasto de sus OUs</div>
          </div>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-ghost" onClick={() => notify('Abre Auditoría filtrada por cambios del mapeo', 'info')}>Historial en Auditoría <Ic.External size={11} /></button>
            <button className="btn btn-sm btn-primary" disabled={blocked} aria-describedby={blocked ? 'why-propose' : undefined} onClick={() => setModal({ kind: 'propose' })}><Ic.Plus size={12} /> Proponer cambio</button>
          </div>
        </div>
        {blocked && <div id="why-propose" style={{ margin: '-2px 0 10px' }}><K.Reason>Hay {MAX_PENDING} propuestas pendientes, el máximo. Aprueba, rechaza o retira alguna para proponer otra.</K.Reason></div>}
        <div className="g-card">
          {names.length === 0 ? (
            <K.Empty icon="Org" title="Aún no hay áreas" action={<button className="btn btn-sm btn-primary" onClick={() => setModal({ kind: 'propose' })}><Ic.Plus size={12} /> Proponer la primera</button>}>Un área agrupa OUs de la organización. Sus líderes solo ven el gasto de esas cuentas.</K.Empty>
          ) : (
            <>
              <div className="g-thead" style={{ '--cols': 'var(--mcols)' }}><span>área</span><span>ous</span><span /></div>
              {names.map(n => (
                <div key={n} className="g-tr m" style={{ '--cols': 'var(--mcols)' }}>
                  <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}><span className="g-area">{n}</span>{n === me.area && <span className="badge badge-accent">Tu área</span>}</div>
                  <div className="g-chips">{mapping.areas[n].map(id => <OuChip key={id} id={id} tree={tree} />)}</div>
                  <div className="g-sub g-num c-count">{mapping.areas[n].length} de 15</div>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="g-sec">
        <div className="g-sec-h">
          <div>
            <div className="g-sec-t">Cambios pendientes</div>
            <div className="g-sec-meta">{pending} de {MAX_PENDING} · los propone un administrador y los aprueba otro distinto · vencen a los 7 días</div>
          </div>
        </div>
        {props.length === 0
          ? <div className="g-card"><K.Empty icon="Check2" title="No hay cambios pendientes">Cuando alguien proponga un cambio del mapeo, aparecerá aquí para que otro administrador lo revise.</K.Empty></div>
          : <div className="g-props">{props.map(p => (
              <ProposalCard key={p.id} p={p} mapping={mapping} tree={tree} me={me} expired={isExpired(p)}
                onApprove={() => setModal({ kind: 'approve', p })} onReject={() => setModal({ kind: 'reject', p })} onWithdraw={() => setModal({ kind: 'withdraw', p })} />
            ))}</div>}
      </section>

      {modal?.kind === 'propose' && <window.GovPropose mapping={mapping} tree={tree} me={me} sim={sim} mobile={mobile} onClose={() => setModal(null)} onSubmit={submit} />}
      {modal?.kind === 'approve' && <ApproveModal p={modal.p} mapping={mapping} tree={tree} sim={sim} mobile={mobile} onClose={() => setModal(null)} onApprove={approve} onConflict={bump} />}
      {modal?.kind === 'reject' && <RejectModal p={modal.p} mobile={mobile} onClose={() => setModal(null)} onReject={() => drop(modal.p, 'Propuesta rechazada')} />}
      {modal?.kind === 'withdraw' && (
        <K.Modal title="¿Retirar tu propuesta?" sub="Se descarta y el mapeo no cambia. Puedes proponerla de nuevo más tarde." onClose={() => setModal(null)}
          footer={<><button className="btn btn-sm" onClick={() => setModal(null)}>Cancelar</button><button className="btn btn-sm btn-primary" onClick={() => drop(modal.p, 'Propuesta retirada')}>Retirar propuesta</button></>}>
          <DiffView diff={diffMap(mapping.areas, modal.p.mapping)} tree={tree} />
        </K.Modal>
      )}
    </>
  );
}

function ProposalCard({ p, mapping, tree, me, expired, onApprove, onReject, onWithdraw }) {
  const Ic = window.Icons;
  const diff = diffMap(mapping.areas, p.mapping);
  const expires = new Date(new Date(p.createdAt).getTime() + 7 * K.DAY);
  const mine = p.by === me.email;
  const stale = p.baseVersion !== mapping.version;
  const touchesMine = diff.some(d => d.area === me.area);
  const approveWhy = expired ? `Venció el ${K.fmtDate(expires)}. Ya no se puede aprobar.`
    : mine ? 'No puedes aprobar tu propia propuesta: la debe revisar otro administrador.'
    : touchesMine ? `Toca tu área (${me.area}): no puedes aprobarla ni rechazarla.`
    : stale ? `Se hizo sobre la versión ${p.baseVersion} y la vigente es la ${mapping.version}. Aprobarla fallaría; recházala para que se proponga de nuevo.`
    : null;
  const rejectDisabled = touchesMine && !mine;
  return (
    <article className={'g-card g-prop' + (expired ? ' is-expired' : '')}>
      <div className="g-prop-h">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="g-prop-by">{mine ? 'Tu propuesta' : <>Propuesta de <span className="g-email">{p.by}</span></>}</span>
            {expired && <span className="badge">Vencida</span>}
            {!expired && stale && <span className="badge badge-amber"><Ic.Warn size={10} style={{ marginRight: 4 }} />Desactualizada</span>}
            {touchesMine && <span className="badge badge-accent">Toca tu área</span>}
          </div>
          <div className="g-meta">
            <span>Creada {K.rel(p.createdAt)}</span>
            <span>{expired ? 'Venció' : 'Vence'} {K.fmtDate(expires)}</span>
            <span>Sobre la versión {p.baseVersion}</span>
            <span className="g-id">{p.id}</span>
          </div>
        </div>
        <div className="g-prop-act">
          {mine
            ? <button className="btn btn-sm" onClick={onWithdraw}>Retirar</button>
            : <>
                <button className="btn btn-sm" disabled={rejectDisabled} title={rejectDisabled ? approveWhy : undefined} onClick={onReject}><Ic.Close size={11} /> Rechazar</button>
                <button className="btn btn-sm btn-primary" disabled={!!approveWhy} title={approveWhy || undefined} onClick={onApprove}><Ic.Check size={12} /> Aprobar</button>
              </>}
        </div>
      </div>
      <div className="g-motivo"><span className="g-diff-k">Motivo</span><p>{p.reason}</p></div>
      <DiffView diff={diff} tree={tree} />
      {approveWhy && <div className="g-prop-why"><K.Reason tone={stale && !expired && !mine && !touchesMine ? 'warn' : undefined}>{approveWhy}</K.Reason></div>}
    </article>
  );
}

function ApproveModal({ p, mapping, tree, sim, mobile, onClose, onApprove, onConflict }) {
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const diff = diffMap(mapping.areas, p.mapping);
  const go = () => {
    setSaving(true); setErr(null);
    setTimeout(() => {
      setSaving(false);
      if (sim === 'conflict') { onConflict(); setErr({ t: 'Otro administrador cambió el mapeo', b: 'Se aprobó otro cambio antes. Esta propuesta quedó desactualizada y ya no se puede aprobar.', lock: true }); return; }
      if (sim === 'audit') { setErr({ t: 'No se pudo registrar la auditoría; el cambio no se aplicó', b: 'El mapeo sigue igual. Intenta de nuevo en unos minutos.' }); return; }
      onApprove(p);
    }, 700);
  };
  return (
    <K.Modal title="Aprobar cambio del mapeo" sub={'Propuesta de ' + p.by} onClose={onClose} width={600} sheet={mobile}
      footer={<><button className="btn btn-sm" onClick={onClose}>{err?.lock ? 'Cerrar' : 'Cancelar'}</button>{!err?.lock && <button className="btn btn-sm btn-primary" disabled={saving} onClick={go}>{saving ? 'Aprobando…' : 'Aprobar cambio'}</button>}</>}>
      {err && <K.Banner tone="error" title={err.t}>{err.b}</K.Banner>}
      <div className="g-motivo"><span className="g-diff-k">Motivo</span><p>{p.reason}</p></div>
      <DiffView diff={diff} tree={tree} />
      <K.Banner tone="info">Al aprobar, el mapeo pasa de la versión {mapping.version} a la {mapping.version + 1} y los líderes de las áreas afectadas ven el gasto con el nuevo mapeo. Queda registrado en Auditoría.</K.Banner>
    </K.Modal>
  );
}

function RejectModal({ p, mobile, onClose, onReject }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const err = !reason.trim() ? 'Escribe el motivo del rechazo' : reason.length > 500 ? 'Máximo 500 caracteres' : null;
  return (
    <K.Modal title="Rechazar cambio del mapeo" sub={'Propuesta de ' + p.by} onClose={onClose} sheet={mobile}
      footer={<><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" onClick={() => { setTried(true); if (!err) onReject(reason.trim()); }}>Rechazar propuesta</button></>}>
      <div className="g-field">
        <div className="row between"><label htmlFor="rej-reason">Motivo del rechazo</label><span className={'g-sub g-num' + (reason.length > 500 ? ' g-err' : '')}>{reason.length} / 500</span></div>
        <textarea id="rej-reason" className={'input' + (tried && err ? ' has-error' : '')} rows={4} value={reason} onChange={e => setReason(e.target.value)} placeholder="Explica por qué no se aplica. Lo verá quien lo propuso." />
        {tried && err ? <div className="g-err">{err}</div> : <div className="g-hint">Obligatorio. Queda registrado en Auditoría.</div>}
      </div>
    </K.Modal>
  );
}

function AreasSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando áreas">
      <K.Skel w={140} h={14} /><K.Skel w={320} h={10} style={{ marginTop: 8, marginBottom: 14 }} />
      <div className="g-card">{[0, 1, 2, 3].map(i => <div key={i} className="g-tr m" style={{ '--cols': 'var(--mcols)' }}><K.Skel w={90} /><div className="row gap-2"><K.Skel w={180} h={22} /><K.Skel w={150} h={22} /></div><span /></div>)}</div>
      <div className="g-card" style={{ marginTop: 32, padding: 20 }}><K.Skel w="40%" /><K.Skel w="60%" h={10} style={{ marginTop: 10 }} /><K.Skel w="30%" h={22} style={{ marginTop: 16 }} /></div>
    </div>
  );
}

window.GovAreas = Areas;
window.GovAreasUtil = { diffMap, OuChip, DiffView };
})();
