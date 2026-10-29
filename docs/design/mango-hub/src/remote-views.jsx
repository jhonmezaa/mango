// MCP remotos · vistas: catálogo › Servicios externos, ficha y alta en dos pasos, Mis conexiones, vuelta desde Microsoft,
// Ajustes › Conectividad, Agent Builder y avisos de la Bandeja.
(() => {
const { useState, useEffect } = React;
const S = window.MangoStore; const RM = window.RM;
const useRm = () => { window.useMango(s => s.remoteRegs); window.useMango(s => s.remoteConn); window.useMango(s => s.role); window.useMango(s => s.actorOverride); };
const Sec = ({ title, children }) => <section className="mk-sec"><div className="mk-sec-t">{String(title).toLowerCase()}</div>{children}</section>;
const KV = ({ k, children }) => <div className="mk-kv"><span>{k}</span><span>{children}</span></div>;
const toolCount = (p, sets) => RM.toolsOf(p, sets).reduce((n, t) => n + t.tools.length, 0);

// —— Catálogo › Servicios externos ——
function RemoteCatalogTab({ onOpen }) {
  const I = window.Icons; useRm(); window.useMango(s => s.simRemoteInstall); const on = RM.enabled();
  return <div style={{ display: 'grid', gap: 14 }}>
    {!on && <RemoteOffNote />}
    <p className="rm-p" style={{ margin: 0, maxWidth: 720 }}>Servicios MCP de terceros revisados y firmados que trae esta versión de Mango. No se conectan por URL: se habilita un perfil para una organización, y cada persona conecta su propia cuenta.</p>
    <div className="rm-grid">
      {RM.PROFILES.map(p => { const list = RM.regsOf(p.id); const act = list.find(r => r.status === 'active'); const pend = list.filter(r => r.status === 'pending'); const dis = list.find(r => r.status === 'disabled'); const mid = list.find(r => r.status === 'creating' || r.status === 'failed');
        return <button key={p.id} className="card rm-pcard" onClick={() => onOpen(p.id)}>
          <div className="row gap-3" style={{ alignItems: 'flex-start' }}><RmTile p={p} /><div style={{ flex: 1, minWidth: 0 }}><div className="mk-name">{p.name}</div><div className="mk-meta">Operado por {p.operator} · <span className="mono">{p.host}</span></div></div>{on ? <RmStatus r={act || mid || pend[0] || dis} /> : <span className="badge">Apagado en la instalación</span>}</div>
          <RmBadges p={p} compact />
          <div className="rm-sets">{p.toolsets.map(t => <span key={t.id} className="rm-set">{t.label}</span>)}</div>
          <div className="mk-meta rm-pcard-f">{act ? <>Habilitado para <span className="mono">{act.org}</span> · {act.groups.length} {act.groups.length === 1 ? 'grupo' : 'grupos'}</> : mid ? <>{mid.status === 'creating' ? 'Creándose' : 'Falló al habilitarse'} · <span className="mono">{mid.org}</span></> : pend.length ? <>Solicitud pendiente · <span className="mono">{pend[0].org}</span></> : dis ? <>Deshabilitado para <span className="mono">{dis.org}</span></> : 'Ninguna organización habilitada'}<span style={{ marginLeft: 'auto' }} className="row gap-1">Ver ficha <I.ArrowRight size={11} /></span></div>
        </button>; })}
    </div>
  </div>;
}
function RemoteOffNote() {
  const I = window.Icons;
  return <div className="mc-alert amber" role="status"><I.Lock size={14} /><div><b>Los servicios externos están apagados en esta instalación</b><div>Los enciende quien administra AWS con el parámetro <span className="mono">RemoteMcpEnabled</span> de la instalación. Mientras tanto puedes ver las fichas, pero no habilitar ni cambiar nada.</div></div></div>;
}
const RETRY_ERR = { release_changed: (p) => 'Esta versión de Mango cambió el perfil de ' + p.name + ' desde que se aprobó. Hay que pedirlo de nuevo.', busy: () => 'Ya se está reintentando. Espera unos segundos.' };
function FailAlert({ r }) {
  const I = window.Icons; const fi = RM.failInfo(r);
  return <div className="mc-alert red" role="alert"><I.X2 size={14} /><div><b>{fi.title}</b><div>{fi.body}</div>{fi.code && <div className="mk-meta" style={{ marginTop: 4 }}>Código: <span className="mono">{fi.code}</span></div>}</div></div>;
}
function RemoteRequests({ onOpen }) {
  const I = window.Icons; useRm(); const me = S.actor(); const list = RM.pending();
  if (!list.length) return null;
  return <div style={{ display: 'grid', gap: 10, marginBottom: 18 }}>
    <div className="mk-sec-t">servicios externos · {list.length}</div>
    {list.map(r => { const p = RM.profile(r.profile); return <div key={r.id} className="card mc-req">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row gap-2" style={{ flexWrap: 'wrap' }}><span className="mk-name">{p.name}</span><span className="badge">{r.kind === 'scope' ? 'Cambiar grupos' : r.replaces ? 'Cambiar tenant o app' : 'Habilitar'}</span><span className="badge mono">{r.org}</span></div>
        <div className="mk-meta" style={{ marginTop: 3 }}>Pedido por {r.by === me ? 'ti' : r.by} · {window.fmtAgo(r.at)} · {r.toolsets.length} grupos de tools · {r.groups.join(', ')}</div>
      </div>
      <button className="btn btn-sm" onClick={() => onOpen(p.id, r.id)}>Revisar <I.ArrowRight size={11} /></button>
    </div>; })}
  </div>;
}

// —— Ficha del perfil + alta en dos pasos ——
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,47}[A-Za-z0-9])?$/;
const in90 = () => new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10);
function RemoteDetail({ pid, regId, onClose }) {
  const I = window.Icons; useRm();
  const p = RM.profile(pid); const me = S.actor(); const isAdmin = S.get().role === 'admin';
  const toast = window.useToast?.();
  const groupIds = (window.useMango(s => s.groupDefs) || []).map(g => g.id);
  const [mode, setMode] = useState(regId ? { k: 'reg', id: regId } : null);
  const [f, setF] = useState(null); const [tried, setTried] = useState(false); const [err, setErr] = useState(null);
  const [why, setWhy] = useState(''); const [modal, setModal] = useState(null); const [busy, setBusy] = useState(false);
  window.useMango(s => s.simRemoteInstall); const on = RM.enabled();
  useEffect(() => { const h = e => e.key === 'Escape' && !modal && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [modal]);
  const list = RM.regsOf(pid);
  const reg = mode?.id && list.find(r => r.id === mode.id);
  const openScope = (base) => { setF({ kind: 'scope', target: base.id, profile: pid, org: base.org, toolsets: [...base.toolsets], groups: [...base.groups] }); setTried(false); setErr(null); setMode({ k: 'form' }); };
  const isScope = f?.kind === 'scope';
  const openForm = (base, replaces) => { setF({ profile: pid, org: base?.org || '', tenantId: '', clientId: '', secret: '', secretExp: in90(), toolsets: base?.toolsets || p.toolsets.map(t => t.id), groups: base?.groups || [], replaces }); setTried(false); setErr(null); setMode({ k: 'form' }); };
  const fe = f && (isScope ? {
    toolsets: !f.toolsets.length ? 'Elige al menos un grupo de tools' : null,
    groups: !f.groups.length ? 'Elige al menos un grupo' : null,
  } : {
    org: !f.org.trim() ? 'Escribe el nombre de la organización' : /[/.:]/.test(f.org) ? 'Solo el nombre, sin la URL' : !ORG.test(f.org.trim()) ? 'Letras, números y guiones, hasta 49 caracteres' : null,
    tenantId: !GUID.test(f.tenantId.trim()) ? 'Debe ser un GUID, como 00000000-0000-0000-0000-000000000000' : null,
    clientId: !GUID.test(f.clientId.trim()) ? 'Debe ser un GUID, como 00000000-0000-0000-0000-000000000000' : null,
    secret: !f.secret.trim() ? 'Pega el secreto de la app' : null,
    secretExp: !f.secretExp ? 'Escribe la fecha de vencimiento' : new Date(f.secretExp) <= new Date() ? 'La fecha tiene que ser futura' : null,
    toolsets: !f.toolsets.length ? 'Elige al menos un grupo de tools' : null,
    groups: !f.groups.length ? 'Elige al menos un grupo' : null,
  });
  const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const submit = () => { setTried(true); setErr(null); if (Object.values(fe).some(Boolean)) return;
    if (isScope) { const t = list.find(r => r.id === f.target); if (t && same(t.toolsets, f.toolsets) && same(t.groups, f.groups)) { setErr('No cambiaste ningún grupo.'); return; } const res = RM.requestScope(f.target, f.toolsets, f.groups); if (res.error) { setErr(res.error); return; } toast?.({ tone: 'success', msg: 'Solicitud enviada · otra persona administradora debe aprobarla' }); setMode({ k: 'reg', id: res.reg.id, sent: true }); return; }
    const res = RM.request({ ...f, org: f.org.trim(), tenantId: f.tenantId.trim(), clientId: f.clientId.trim() }, f.replaces); if (res.error) { setErr(res.error); return; } toast?.({ tone: 'success', msg: 'Solicitud enviada · otra persona administradora debe aprobarla' }); setMode({ k: 'reg', id: res.reg.id, sent: true }); };
  const tog = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v] });

  let body, foot;
  if (mode?.k === 'form') {
    const e = tried ? fe : {}; const lock = !!f.replaces;
    const setLabel = (id) => p.toolsets.find(t => t.id === id)?.label || id;
    body = <>
      <div className="rm-steps" aria-label="Paso 1 de 2"><span className="is-on">1 · Pedir</span><span>2 · Otra persona administradora aprueba</span></div>
      {isScope && <div className="mc-alert"><I.Info size={14} /><div>Es una solicitud con doble aprobación, como el alta. Nadie tiene que volver a conectar su cuenta. Mientras no se apruebe, siguen los grupos actuales.</div></div>}
      {lock && <div className="mc-alert amber"><I.Warn size={14} /><div><b>Al aprobarse, todas las personas tendrán que conectar su cuenta otra vez.</b> Las conexiones de ahora son con la app actual y dejan de servir.</div></div>}
      {lock && <div className="mc-alert"><I.Info size={14} /><div>Cambiar el tenant o la app es una solicitud nueva. Mientras no se apruebe, sigue activa la configuración actual.</div></div>}
      <div className="rm-form">
        {isScope ? <KV k="Organización"><span className="mono">{p.host}/{f.org}</span></KV> : <>
        <RmField id="rf-org" label="Organización de Azure DevOps" hint="Solo el nombre. El host lo pone el perfil." error={e.org}><div className="rm-prefix"><span className="mono">{p.host}/</span><input id="rf-org" className="input mono" value={f.org} maxLength={49} disabled={!!f.replaces} onChange={x => setF({ ...f, org: x.target.value })} autoFocus /></div></RmField>
        <div className="rm-2col">
          <RmField id="rf-ten" label="Tenant de Entra (tenantId)" error={e.tenantId}><input id="rf-ten" className="input mono" value={f.tenantId} onChange={x => setF({ ...f, tenantId: x.target.value })} placeholder="00000000-0000-0000-0000-000000000000" /></RmField>
          <RmField id="rf-cli" label="Id de la app (clientId)" error={e.clientId}><input id="rf-cli" className="input mono" value={f.clientId} onChange={x => setF({ ...f, clientId: x.target.value })} placeholder="00000000-0000-0000-0000-000000000000" /></RmField>
        </div>
        <div className="rm-2col">
          <RmField id="rf-sec" label="Secreto de la app" hint="Solo escritura: no se vuelve a mostrar, ni a ti." error={e.secret}><input id="rf-sec" className="input mono" type="password" autoComplete="off" value={f.secret} onChange={x => setF({ ...f, secret: x.target.value })} /></RmField>
          <RmField id="rf-exp" label="Vence el" hint="El que muestra Entra. Mango avisa 30 y 7 días antes." error={e.secretExp}><input id="rf-exp" className="input" type="date" value={f.secretExp} onChange={x => setF({ ...f, secretExp: x.target.value })} /></RmField>
        </div></>}
        {lock ? <>
          <div className="rm-field"><span className="rm-label">Grupos de tools</span><div className="rm-sets">{f.toolsets.map(id => <span key={id} className="rm-set">{setLabel(id)}</span>)}</div></div>
          <div className="rm-field"><span className="rm-label">Grupos de personas</span><div className="rm-sets">{f.groups.map(g => <span key={g} className="badge mono">{g}</span>)}</div><div className="rm-hint">Esta solicitud solo cambia tenant, app y secreto. Los grupos se cambian con «Cambiar grupos», sin que nadie reconecte.</div></div>
        </> : <>
        <div className={'rm-field' + (e.toolsets ? ' has-error' : '')}><span className="rm-label" id="rf-ts">Grupos de tools</span>
          <div className="rm-checks" role="group" aria-labelledby="rf-ts">{p.toolsets.map(t => <label key={t.id} className={'rm-check' + (f.toolsets.includes(t.id) ? ' is-on' : '')}><input type="checkbox" checked={f.toolsets.includes(t.id)} onChange={() => tog('toolsets', t.id)} /><span>{t.label}</span><span className="mk-meta">{t.tools.length}</span></label>)}</div>
          {e.toolsets ? <div className="rm-err" role="alert">{e.toolsets}</div> : <div className="rm-hint">Todas sus tools son de lectura.</div>}</div>
        <div className={'rm-field' + (e.groups ? ' has-error' : '')}><span className="rm-label" id="rf-gr">Grupos de personas que pueden usarlo</span>
          <div className="rm-chips" role="group" aria-labelledby="rf-gr">{groupIds.map(g => <button key={g} type="button" className={'tweak-chip ab-chip mono' + (f.groups.includes(g) ? ' is-on' : '')} aria-pressed={f.groups.includes(g)} onClick={() => tog('groups', g)}>{f.groups.includes(g) && <I.Check size={10} />}{g}</button>)}</div>
          {e.groups ? <div className="rm-err" role="alert">{e.groups}</div> : <div className="rm-hint">Solo las personas de estos grupos pueden conectar su cuenta y dar sus tools a un agente.</div>}</div>
        </>}
      </div>
    </>;
    foot = <>{err && <div className="g-err" role="alert" style={{ marginBottom: 10 }}>{err}</div>}<div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={submit}>Enviar solicitud</button><button className="btn btn-sm btn-ghost" onClick={() => setMode(null)}>Cancelar</button></div></>;
  } else if (reg) {
    const own = reg.by === me; const si = RM.secretInfo(reg);
    const t = RM.target(reg);
    const diff = (cur, next, lab, mono) => [...new Set([...(cur || []), ...next])].map(x => { const add = !(cur || []).includes(x), rem = !next.includes(x); return <span key={x} className={'badge' + (mono ? ' mono' : '') + (add ? ' badge-green' : rem ? ' badge-red rm-del' : '')} title={add ? 'Se agrega' : rem ? 'Se quita' : undefined}>{add ? '+ ' : rem ? '− ' : ''}{lab(x)}</span>; });
    body = reg.kind === 'scope' ? <>
      {mode.sent && <div className="mc-alert"><I.Check2 size={14} style={{ color: 'var(--green)' }} /><div><b>Solicitud enviada.</b> Otra persona administradora tiene que aprobarla.</div></div>}
      <div className="rm-steps" aria-label="Paso 2 de 2"><span className="is-done">1 · Pedido por {own ? 'ti' : reg.by}</span><span className="is-on">2 · Otra persona administradora aprueba</span></div>
      <div className="mc-alert"><I.Info size={14} /><div>Cambia los grupos de {p.name} para <span className="mono">{reg.org}</span>. Nadie tiene que volver a conectar su cuenta. Mientras no se apruebe, siguen los grupos actuales.</div></div>
      <Sec title="Cambios">
        <KV k="Grupos de tools"><span className="rm-sets" style={{ justifyContent: 'flex-end' }}>{diff(t?.toolsets, reg.toolsets, id => p.toolsets.find(x => x.id === id)?.label || id)}</span></KV>
        <KV k="Grupos de personas"><span className="rm-sets" style={{ justifyContent: 'flex-end' }}>{diff(t?.groups, reg.groups, g => g, true)}</span></KV>
        <KV k="Pidió">{own ? 'Tú' : reg.by} · {window.fmtAgo(reg.at)}</KV>
      </Sec>
    </> : <>
      {!on && <RemoteOffNote />}
      {mode.sent && <div className="mc-alert"><I.Check2 size={14} style={{ color: 'var(--green)' }} /><div><b>Solicitud enviada.</b> Mientras otra persona administradora la aprueba, pega la URL de redirección en la app de Entra.</div></div>}
      {reg.status === 'pending' && <div className="rm-steps" aria-label="Paso 2 de 2"><span className="is-done">1 · Pedido por {own ? 'ti' : reg.by}</span><span className="is-on">2 · Otra persona administradora aprueba</span></div>}
      {reg.status === 'pending' && reg.replaces && <div className="mc-alert amber"><I.Warn size={14} /><div><b>Al aprobarse, todas las personas tendrán que conectar su cuenta de {p.name} otra vez.</b></div></div>}
      {reg.status === 'pending' && <div className="rm-redirect"><RmCopy value={reg.redirect} /><div className="rm-hint">Pégala en la app de Entra como URI de redirección de plataforma <b>Web</b>. La da AWS al crear la conexión de este registro: es distinta para cada uno y no es una dirección de Mango.</div></div>}
      {reg.status === 'active' && <SecretAlert r={reg} onRotate={isAdmin ? () => setModal('rotate') : null} />}
      {reg.status === 'creating' && <div className="mc-alert" role="status"><span className="g-spin" /><div><b>Creándose.</b> Aprobado por {reg.approvedBy === me ? 'ti' : reg.approvedBy}. Mango está creando la conexión con {p.name}; tarda unos segundos. Puedes cerrar este panel.</div></div>}
      {reg.status === 'failed' && <FailAlert r={reg} />}
      {reg.status === 'disabled' && <div className="mc-alert"><I.Info size={14} /><div>Deshabilitado por {reg.disabledBy} · {window.fmtAgo(reg.disabledAt)}{reg.reason ? <>: «{reg.reason}»</> : null}<div className="mk-meta" style={{ marginTop: 3 }}>Se borraron la conexión y el secreto. Para volver a habilitarlo, pídelo de nuevo con el secreto.</div></div></div>}
      <Sec title="Registro">
        <KV k="Organización"><span className="mono">{p.host}/{reg.org}</span></KV>
        <KV k="Tenant de Entra"><span className="mono rm-wrap">{reg.tenantId}</span></KV>
        <KV k="Id de la app"><span className="mono rm-wrap">{reg.clientId}</span></KV>
        <KV k="Secreto de la app">{reg.status === 'disabled' && !reg.secretExp ? <span className="mk-meta">Borrado al deshabilitar</span> : <span className="row gap-2"><I.Lock size={11} /> Guardado · no se muestra</span>}</KV>
        {reg.status !== 'pending' && <KV k="Vencimiento del secreto"><SecretLine r={reg} /></KV>}
        {reg.status === 'pending' && <KV k="Vencimiento del secreto">{RM.fmtDay(reg.secretExp)}</KV>}
        <KV k="Grupos de tools"><span className="rm-sets" style={{ justifyContent: 'flex-end' }}>{RM.toolsOf(p, reg.toolsets).map(t => <span key={t.id} className="rm-set">{t.label}</span>)}</span></KV>
        <KV k="Grupos de personas"><span className="rm-sets" style={{ justifyContent: 'flex-end' }}>{reg.groups.map(g => <span key={g} className="badge mono">{g}</span>)}</span></KV>
        <KV k="Pidió">{reg.by === me ? 'Tú' : reg.by} · {window.fmtAgo(reg.at)}</KV>
        {reg.approvedBy && <KV k="Aprobó">{reg.approvedBy === me ? 'Tú' : reg.approvedBy}</KV>}
      </Sec>
      {reg.status === 'active' && reg.redirect && <Sec title="URL de redirección"><RmCopy value={reg.redirect} label="Configurada en la app de Entra" /></Sec>}
    </>;
    if (!isAdmin) foot = <div className="ap-reason"><I.Lock size={12} /> Solo los administradores pueden habilitar, aprobar o deshabilitar servicios externos.</div>;
    else if (!on) foot = <div className="ap-reason"><I.Lock size={12} /> Apagado en la instalación: no se puede aprobar ni cambiar nada.</div>;
    else if (reg.status === 'pending' && mode.reject) foot = <div style={{ display: 'grid', gap: 8 }}><label htmlFor="rm-why" style={{ fontSize: 12.5, fontWeight: 500 }}>Motivo del rechazo</label><textarea id="rm-why" className="input" rows={2} value={why} onChange={e => setWhy(e.target.value)} autoFocus style={tried && !why.trim() ? { borderColor: 'var(--red)' } : null} />{tried && !why.trim() && <div style={{ fontSize: 12, color: 'var(--red)' }}>El motivo es obligatorio</div>}<div className="rm-hint">Rechazar borra lo que se creó con la solicitud, incluido el secreto.</div><div className="row gap-2"><button className="btn btn-sm mk-danger" onClick={() => { setTried(true); if (!why.trim()) return; RM.reject(reg.id, why.trim()); toast?.({ tone: 'success', msg: 'Solicitud rechazada' }); setMode(null); setWhy(''); setTried(false); }}>Rechazar</button><button className="btn btn-sm btn-ghost" onClick={() => { setMode({ ...mode, reject: false }); setTried(false); }}>Cancelar</button></div></div>;
    else if (reg.status === 'pending') foot = <>{err && <div className="g-err" role="alert" style={{ marginBottom: 10 }}>{err}</div>}{own
      ? <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><span className="ap-reason"><I.Lock size={12} /> Otra persona administradora tiene que aprobarlo.</span><button className="btn btn-sm" onClick={() => { RM.withdraw(reg.id); toast?.({ tone: 'success', msg: 'Solicitud retirada · se borró lo que se había creado' }); setMode(null); }}>Retirar solicitud</button></div>
      : <div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={() => { const r = RM.approve(reg.id); if (r.error) { setErr(r.error); return; } toast?.({ tone: 'success', msg: r.scope ? 'Grupos de ' + p.name + ' cambiados para ' + reg.org : p.name + ' habilitado para ' + reg.org }); setMode({ k: 'reg', id: r.scope ? reg.changes : reg.id }); }}><I.Check size={12} /> Aprobar</button><button className="btn btn-sm" onClick={() => setMode({ ...mode, reject: true })}>Rechazar</button></div>}</>;
    else if (reg.status === 'creating') foot = <div className="ap-reason"><span className="g-spin" /> Creando la conexión · no hace falta hacer nada.</div>;
    else if (reg.status === 'failed') {
      const doRetry = () => { setErr(null); setBusy(true); setTimeout(() => { setBusy(false); const r = RM.retry(reg.id); if (r.error) { setErr((RETRY_ERR[r.error] || (() => r.error))(p)); return; } toast?.({ tone: 'success', msg: 'Reintentando · Mango vuelve a crear la conexión' }); }, 600); };
      const bRetry = <button key="r" className="btn btn-sm btn-primary" disabled={busy} onClick={doRetry}>{busy ? <><span className="g-spin" /> Reintentando…</> : 'Reintentar'}</button>;
      const bAgain = <button key="a" className="btn btn-sm" disabled={busy} onClick={() => openForm(reg)}>Pedir de nuevo</button>;
      foot = <>{err && <div className="g-err" role="alert" style={{ marginBottom: 10 }}>{err}</div>}<div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>{bRetry}{bAgain}</div><div className="rm-hint" style={{ marginTop: 8 }}>«Reintentar» usa la misma aprobación y no cambia nada de lo aprobado. «Pedir de nuevo» pide el secreto otra vez y otra aprobación.</div></>; }
    else if (reg.status === 'active') foot = <div className="row gap-2" style={{ flexWrap: 'wrap' }}><button className="btn btn-sm" onClick={() => setModal('rotate')}>Rotar secreto</button><button className="btn btn-sm" disabled={list.some(r => r.kind === 'scope' && r.changes === reg.id)} title={list.some(r => r.kind === 'scope' && r.changes === reg.id) ? 'Ya hay un cambio de grupos pendiente' : undefined} onClick={() => openScope(reg)}>Cambiar grupos</button><button className="btn btn-sm" disabled={list.some(r => r.replaces === reg.id)} title={list.some(r => r.replaces === reg.id) ? 'Ya hay un cambio pendiente' : undefined} onClick={() => openForm(reg, reg.id)}>Cambiar tenant o app</button><button className="btn btn-sm" onClick={() => setModal('disable')}>Deshabilitar</button></div>;
    else foot = <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><button className="btn btn-sm btn-primary" onClick={() => openForm(reg)}>Pedir de nuevo</button><span className="mk-meta">Pide el secreto otra vez y otra aprobación.</span></div>;
  } else {
    body = <>
      {!on && <RemoteOffNote />}
      <div className="mc-alert amber"><I.Globe size={14} /><div><b>Los datos salen de AWS.</b> El servidor corre en {p.operator}: las consultas del agente y sus resultados pasan por fuera de AWS.</div></div>
      <div className="mc-alert"><I.User size={14} /><div>Cada persona conecta su propia cuenta de {p.idp} la primera vez que un agente lo usa, y el agente lee con sus permisos. Mango nunca ve su contraseña.</div></div>
      <Sec title={'Organizaciones · ' + list.length}>
        {list.length ? list.map(r => <button key={r.id} className="mk-line row between rm-regrow" onClick={() => setMode({ k: 'reg', id: r.id })}><span className="row gap-2" style={{ minWidth: 0 }}><span className="mono" style={{ fontSize: 12.5 }}>{r.org}</span>{r.replaces && <span className="badge">Cambio de tenant o app</span>}{r.kind === 'scope' && <span className="badge">Cambio de grupos</span>}<span className="mk-meta">{r.toolsets.length} grupos de tools · {r.groups.length} {r.groups.length === 1 ? 'grupo' : 'grupos'}</span></span><span className="row gap-2"><RmStatus r={r} /><I.ChevronRight size={12} /></span></button>) : <div className="mk-meta">Ninguna organización habilitada todavía.</div>}
      </Sec>
      {RM.histOf(pid).length > 0 && <Sec title={'Historial de solicitudes · ' + RM.histOf(pid).length}>
        {RM.histOf(pid).map(r => <div key={r.id} className="mk-line rm-hist">
          <div className="row between" style={{ gap: 8 }}><span className="row gap-2" style={{ minWidth: 0 }}><span className="mono" style={{ fontSize: 12.5 }}>{r.org}</span><RmStatus r={r} /></span><span className="mk-meta">{window.fmtAgo(r.decidedAt || r.at)}</span></div>
          <div className="mk-meta">Pidió {r.by === me ? 'tú' : r.by} · {r.status === 'withdrawn' ? 'la retiró ' + (r.decidedBy === r.by ? 'quien la pidió' : r.decidedBy) : 'rechazó ' + (r.decidedBy === me ? 'tú' : r.decidedBy)}{r.kind === 'scope' ? ' · cambio de grupos' : ''} · {r.toolsets.length} grupos de tools · {r.groups.join(', ')}</div>
          {r.reason && <div className="rm-hist-why">«{r.reason}»</div>}
        </div>)}
        <div className="mk-meta" style={{ marginTop: 6 }}>Al rechazar o retirar se borra lo que se había creado, incluido el secreto. Queda el registro de quién pidió qué.</div>
      </Sec>}
      <Sec title={'Tools · ' + toolCount(p) + ' · todas de lectura'}>
        {p.toolsets.map(t => <div key={t.id} className="rm-tset"><div className="rm-tset-h">{t.label}</div>{t.tools.map(n => <div key={n} className="mk-line row between"><span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{n}</span><span className="badge">Lectura</span></div>)}</div>)}
        <div className="mk-meta" style={{ marginTop: 6 }}>Los grupos y los nombres salen del perfil del servicio. Ninguno trae tools de escritura.</div>
      </Sec>
      <Sec title={'Permisos en ' + p.idp}>
        {p.scopes.map(s => <div key={s.res} className="mk-line row between" style={{ gap: 8, flexWrap: 'wrap' }}><span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.res}</span><span className="rm-sets">{s.perms.map(x => <span key={x} className="badge mono">{x}</span>)}</span></div>)}
        <div className="mk-meta" style={{ marginTop: 6 }}>Los que pide el perfil del servicio.</div>
      </Sec>
      <Sec title="Host del servicio"><div className="row gap-2"><code className="mono rm-host">{p.host}</code><span className="mk-meta">Fijo en el perfil firmado. No se puede cambiar.</span></div></Sec>
    </>;
    foot = isAdmin && !on ? <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><button className="btn btn-sm btn-primary" disabled><I.Plus size={12} /> Habilitar para una organización</button><span className="ap-reason"><I.Lock size={12} /> Apagado en la instalación</span></div>
      : isAdmin ? <button className="btn btn-sm btn-primary" onClick={() => openForm()}><I.Plus size={12} /> Habilitar para una organización</button> : <div className="ap-reason"><I.Lock size={12} /> Solo los administradores pueden habilitar servicios externos.</div>;
  }
  return <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <aside className="mk-drawer" style={{ width: 540 }} role="dialog" aria-modal="true" aria-label={p.name}>
      <div className="mk-drawer-h">
        {mode ? <button className="btn btn-ghost btn-icon" aria-label="Volver a la ficha" onClick={() => { setMode(null); setErr(null); }}><I.ChevronLeft size={14} /></button> : null}
        <RmTile p={p} lg />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{mode?.k === 'form' ? (isScope ? 'Cambiar grupos · ' + f.org : f.replaces ? 'Cambiar tenant o app' : 'Habilitar ' + p.name) : reg ? p.name + ' · ' + reg.org : p.name}</div>
          <div className="row gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}>{reg ? <RmStatus r={reg} /> : null}<RmBadges p={p} compact /><span className="mk-meta">Operado por {p.operator} · perfil v{p.version}</span></div>
        </div>
        <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
      </div>
      <div className="mk-drawer-b">{body}</div>
      {foot && <div className="mc-foot">{foot}</div>}
    </aside>
    {modal === 'rotate' && reg && <RotateModal r={reg} onClose={() => setModal(null)} />}
    {modal === 'disable' && reg && <DisableModal r={reg} onClose={() => setModal(null)} />}
  </div>;
}

// —— Mis conexiones (menú de la persona) ——
function MyConnections() {
  const I = window.Icons; useRm(); const toast = window.useToast?.();
  const [open, setOpen] = useState(false); const [already, setAlready] = useState({}); const [errs, setErrs] = useState({}); const [disc, setDisc] = useState(null);
  useEffect(() => { const o = () => { setOpen(true); setAlready({}); setErrs({}); }, c = () => setOpen(false); window.addEventListener('mango:my-connections', o); window.addEventListener('mango:close-connections', c); return () => { window.removeEventListener('mango:my-connections', o); window.removeEventListener('mango:close-connections', c); }; }, []);
  if (!open || S.get().avail) return null;
  const list = RM.enabled() ? RM.mine() : [];
  if (disc) return <DisconnectModal p={RM.profile(disc)} onClose={() => setDisc(null)} />;
  return <window.Modal open onClose={() => setOpen(false)} title="Mis conexiones" width={520}>
    <p className="rm-p">Servicios externos que tus grupos pueden usar. Tu cuenta se conecta una vez y los agentes leen con tus permisos, solo lectura. Mango no muestra tu token ni datos de tu cuenta.</p>
    {!RM.enabled() ? <div className="mc-alert amber" role="status"><I.Lock size={14} /><div><b>Los servicios externos están apagados en esta instalación</b><div>Cuando un administrador los encienda, aquí vas a poder conectar tu cuenta.</div></div></div>
      : !list.length ? <div className="rm-empty"><I.Globe size={18} /><div>Ningún servicio externo está habilitado para tus grupos.</div></div> : <div className="rm-conns">{list.map(r => {
      const p = RM.profile(r.profile); const c = RM.conn(p.id); const off = r.status === 'disabled'; const exp = RM.secretInfo(r).level === 'expired';
      const state = off ? 'off' : c.status === 'connecting' ? 'opening' : c.status === 'waiting' ? 'waiting' : c.status === 'finishing' ? 'finishing' : c.status === 'connected' ? (exp ? 'on-blocked' : 'on') : exp ? 'blocked' : 'none';
      const ce = state !== 'none' ? null : errs[p.id] ? (RM.CONNECT_ERR[errs[p.id]] || RM.CONNECT_ERR.error)(p) : c.err === 'expired' ? ['El enlace venció', 'Vuelve a pulsar «Conectar».'] : c.err ? (RM.FINISH_ERR[c.err] || RM.FINISH_ERR.error)(p) : null;
      const doConnect = () => { const r = RM.connect(p.id, 'connections'); if (r === 'already') setAlready({ ...already, [p.id]: true }); setErrs({ ...errs, [p.id]: typeof r === 'string' && r.startsWith('error:') ? r.slice(6) : null }); };
      return <div key={r.id} className="rm-conn">
        <RmTile p={p} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}><span className="mk-name">{p.name}</span><span className="mk-meta mono">{r.org}</span></div>
          <div className="rm-conn-s" role="status">{already[p.id] && state === 'on' ? <span className="row gap-2"><span className="dot dot-green" /> Tu cuenta ya estaba conectada.</span> : state === 'off' ? <>Un administrador deshabilitó {p.name}.</> : state === 'opening' ? <span className="row gap-2"><span className="g-spin" /> Abriendo {p.idp}…</span> : state === 'waiting' ? <>Inicia sesión en {p.idp} en la otra pestaña. Al terminar, la conexión se completa aquí.</> : state === 'finishing' ? <span className="row gap-2"><span className="g-spin" /> Terminando la conexión…</span> : state === 'on-blocked' ? <>Tu cuenta sigue conectada, pero los agentes no pueden leer {p.name} hasta que un administrador renueve su configuración.</> : state === 'on' ? <span className="row gap-2"><span className="dot dot-green" /> Conectado{c.at ? ' · ' + window.fmtAgo(c.at) : ''}.</span> : state === 'blocked' ? <>Por ahora no se puede conectar: un administrador tiene que renovar la configuración de {p.name}.</> : ce ? <span role="alert" style={{ color: 'var(--red)' }}><b>{ce[0]}.</b> {ce[1]}</span> : <>No has conectado tu cuenta.</>}</div>
        </div>
        {state === 'none' && <button className={'btn btn-sm' + (ce ? '' : ' btn-primary')} onClick={doConnect}>{ce ? 'Reintentar' : 'Conectar'}</button>}
        {state === 'waiting' && <button className="btn btn-sm" onClick={() => { RM.cancelWait(p.id); doConnect(); }}>Abrir de nuevo</button>}
        {(state === 'on' || state === 'on-blocked') && <button className="btn btn-sm" onClick={() => setDisc(p.id)}>Desconectar</button>}
      </div>; })}</div>}
    {list.length > 0 && (idps => <div className="rm-hint" style={{ marginTop: 14 }}>Al conectar vas a iniciar sesión en {idps.join(' o ')}. Si tu cuenta ya estaba conectada, Mango lo confirma sin abrir {idps.length === 1 ? idps[0] : 'el proveedor'}.</div>)([...new Set(list.map(r => RM.profile(r.profile).idp))])}
  </window.Modal>;
}

// «Desconectar»: Mango borra la conexión de esa persona. No dice que Microsoft quitó el permiso: no lo hace.
function DisconnectModal({ p, onClose }) {
  const I = window.Icons; const toast = window.useToast?.(); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const go = () => { setBusy(true); setErr(null); setTimeout(() => { const r = RM.disconnect(p.id); setBusy(false); if (r.error) { setErr(r.error); return; } toast?.({ tone: 'success', msg: 'Desconectaste tu cuenta de ' + p.name }); onClose(); }, 700); };
  return <window.Modal open onClose={onClose} title={'Desconectar ' + p.name} width={460}>
    <p className="rm-p">Mango borra tu conexión ahora y deja de leer {p.name} con tu cuenta en el chat, en tus tareas y en el Playground.</p>
    <ul className="rm-ul"><li>Si un agente lo necesita, el chat te ofrece «Conectar» otra vez.</li><li>Tus tareas que lo usan van a fallar, y la Bandeja te avisa.</li><li>Para volver a conectar, inicias sesión en {p.idp} otra vez.</li></ul>
    <div className="rm-hint">Mango no cambia nada en tu cuenta de {p.idp}.</div>
    {err && <div className="mc-alert red" role="alert" style={{ marginTop: 14 }}><I.X2 size={14} /><div><b>No se pudo confirmar que se desconectó</b><div>Tu conexión puede seguir activa. Inténtalo de nuevo.</div></div></div>}
    <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 18 }}><button className="btn btn-sm" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn-sm mk-danger" onClick={go} disabled={busy}>{busy ? <><span className="g-spin" /> Desconectando…</> : err ? 'Reintentar' : 'Desconectar'}</button></div>
  </window.Modal>;
}

// —— La vuelta desde Microsoft (D100) ——
// Llega en otra pestaña. No termina la conexión: avisa a la pestaña de Mango que pidió «Conectar», que es la que la termina
// (AgentCore Identity solo acepta el token de esa pestaña). Siempre a pantalla completa, con la marca arriba.
// Solo nombra el servicio cuando la otra pestaña confirma que terminó: antes no lo sabe.
const RET = {
  ok: ['Check', 'green', () => 'Listo, vuelve a tu pestaña de Mango', (p) => 'Tu cuenta de ' + p.name + ' quedó conectada. En la pestaña donde pulsaste «Conectar», envía tu pregunta otra vez. Esta ya no hace falta.'],
  orphan: ['Refresh', 'amber', () => 'Pídelo de nuevo desde Mango', () => 'La conexión solo se termina en la pestaña de Mango donde pulsaste «Conectar», y esa pestaña se cerró o cambió de sesión. Tu cuenta no quedó conectada.'],
  expired: ['Clock', 'amber', () => 'El enlace venció', () => 'Pasaron más de 10 minutos desde que pulsaste «Conectar». Vuelve a pulsarlo en Mango.'],
  cancelled: ['X2', 'muted', () => 'Cancelaste el inicio de sesión', () => 'Tu cuenta no quedó conectada. Puedes intentarlo otra vez desde Mango.'],
  denied: ['X2', 'red', (p) => p.idp + ' no autorizó la conexión', (p) => 'Tu cuenta no quedó conectada. Si no fuiste tú quien canceló, consulta con el administrador de ' + p.idp + ' de tu empresa.'],
  conditional: ['Shield', 'amber', () => 'Una regla de acceso de tu empresa bloqueó la conexión', (p) => 'El Acceso condicional de ' + p.idp + ' no dejó iniciar sesión desde este dispositivo o esta red, o pidió un paso que no se completó. Consulta con el administrador de ' + p.idp + ' de tu empresa.'],
  ambiguous: ['Warn', 'amber', () => 'No se pudo saber qué conexión terminar', () => 'Tienes más de una conexión a medias en Mango. Vuelve a pulsar «Conectar» en la que quieras terminar.'],
  notyours: ['Lock', 'red', () => 'Este enlace no es tuyo', () => 'Pide la conexión desde tu propia sesión de Mango.'],
  error: ['Warn', 'amber', () => 'No se pudo conectar tu cuenta', () => 'Inténtalo de nuevo en unos minutos.'],
};
// Sin pestaña que avisar no hay espera.
const NOWAIT = ['notyours'];
function RemoteReturn({ setView }) {
  const I = window.Icons; window.useMango(s => s.simRemoteReturn);
  const ret = S.get().remoteReturn || { pid: 'azure-devops', from: 'connections' };
  const result = S.get().simRemoteReturn || 'ok';
  const p = RM.profile(ret.pid);
  const [doneFor, setDoneFor] = useState(NOWAIT.includes(result) ? result : null);
  const [noClose, setNoClose] = useState(false);
  // Sin window.opener (reverse tabnabbing) el navegador decide si deja cerrarla: se intenta a los 2 s de «Listo».
  const tryClose = () => { try { window.close(); } catch (e) {} setTimeout(() => setNoClose(true), 300); };
  useEffect(() => { setNoClose(false); if (result !== 'ok' || doneFor !== 'ok') return; const t = setTimeout(tryClose, 2000); return () => clearTimeout(t); }, [result, doneFor]);
  useEffect(() => {
    if (result === 'relaying') return;
    if (NOWAIT.includes(result)) { setDoneFor(result); return; }
    const t = setTimeout(() => setDoneFor(result), 1400); return () => clearTimeout(t);
  }, [result]);
  const phase = result === 'relaying' || !RET[result] || doneFor !== result ? 'relaying' : 'done';
  const toMango = () => setView('chat');
  let inner;
  if (phase === 'relaying') inner = <>
    <span className="rm-ret-ic muted"><span className="g-spin" /></span>
    <h1 className="rm-ret-t">Terminando la conexión…</h1>
    <p className="rm-ret-b">Mango la termina en la pestaña donde pulsaste «Conectar». No cierres esta página.</p>
  </>;
  else { const [ic, tone, t, b] = RET[result]; const Ic = I[ic]; inner = <>
    <span className={'rm-ret-ic ' + tone}><Ic size={18} /></span>
    <h1 className="rm-ret-t">{t(p)}</h1>
    <p className="rm-ret-b">{b(p)}</p>
    <div className="row gap-2" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
      {result === 'ok' ? (noClose ? <span className="rm-ret-n">El navegador no deja que Mango cierre esta pestaña. Ciérrala tú: tu pestaña de Mango ya está al día.</span> : <button className="btn btn-sm" onClick={tryClose}>Cerrar esta pestaña</button>)
        : <button className="btn btn-sm btn-primary" onClick={toMango}>Abrir Mango</button>}
    </div>
  </>; }
  return <div className="rm-ret-full"><div className="rm-ret-brand"><I.Mango size={18} /><span>Mango</span></div>
    <div className="rm-ret" role={phase === 'relaying' || result === 'ok' ? 'status' : 'alert'} aria-busy={phase === 'relaying' || undefined}>
      {phase === 'done' && result === 'ok' && <div className="row gap-2 rm-ret-svc"><RmTile p={p} /><span>{p.name}</span><span className="mk-meta">· vuelta desde {p.idp}</span></div>}
      {inner}
    </div>
  </div>;
}
// —— Ajustes › Conectividad ——
function RemoteConnBlock() {
  const I = window.Icons; useRm(); window.useMango(s => s.simRemoteInstall); const [modal, setModal] = useState(null);
  const list = RM.regs().filter(r => ['active', 'disabled', 'creating', 'failed'].includes(r.status));
  const pend = RM.pending().length;
  const open = (pid, id) => { S.set({ rmOpen: { pid, id } }); window.MangoNav?.('mcp'); };
  return <div style={{ marginTop: 28 }}>
    <div className="g-sec-h" style={{ marginBottom: 8 }}><div><div className="g-sec-t" style={{ fontSize: 13.5 }}>Servicios externos</div><div className="g-sec-meta">MCP de terceros habilitados con perfil. Corren fuera de AWS; el secreto de cada app de Entra lo guarda Mango y no se vuelve a mostrar.</div></div>{pend > 0 && <button className="btn btn-sm" onClick={() => open(RM.pending()[0].profile, RM.pending()[0].id)}>{pend} {pend === 1 ? 'solicitud pendiente' : 'solicitudes pendientes'} <I.ArrowRight size={11} /></button>}</div>
    {!RM.enabled() && <div style={{ marginBottom: 10 }}><RemoteOffNote /></div>}
    {!list.length ? <div className="g-card" style={{ padding: 16 }}><div className="mk-meta">Ningún servicio externo habilitado. Se habilitan desde <button className="sr-link" onClick={() => { S.set({ rmOpen: { tab: true } }); window.MangoNav?.('mcp'); }}>Catálogo de MCP › Servicios externos</button>.</div></div>
      : <div style={{ display: 'grid', gap: 10 }}>{list.map(r => { const p = RM.profile(r.profile); return <div key={r.id} className="g-card rm-setrow">
        <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
          <RmTile p={p} />
          <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
            <div className="row gap-2" style={{ flexWrap: 'wrap' }}><span className="mk-name">{p.name}</span><span className="mono mk-meta">{p.host}/{r.org}</span><RmStatus r={r} /></div>
            <div className="rm-sets">{RM.toolsOf(p, r.toolsets).map(t => <span key={t.id} className="rm-set">{t.label}</span>)}</div>
            <div className="mk-meta">Grupos: <span className="mono">{r.groups.join(', ')}</span></div>
            {r.status === 'active' && <div className="row gap-2" style={{ fontSize: 12.5 }}><I.Lock size={11} /><span className="mk-meta">Secreto de la app de Entra ·</span><SecretLine r={r} /></div>}
            {r.status === 'disabled' && <div className="mk-meta">Deshabilitado por {r.disabledBy} · {window.fmtAgo(r.disabledAt)}</div>}
            {r.status === 'creating' && <div className="mk-meta row gap-2"><span className="g-spin" /> Creando la conexión · unos segundos</div>}
            {r.status === 'failed' && (fi => <div style={{ fontSize: 12.5 }}><span style={{ color: 'var(--red)' }}>{fi.title}.</span> <span className="mk-meta">{fi.kind === 'platform' ? 'Reinténtalo desde el catálogo.' : fi.kind === 'app' ? 'Revisa la app de Entra y pídelo de nuevo.' : 'Reinténtalo desde el catálogo.'}</span></div>)(RM.failInfo(r))}
          </div>
        </div>
        {r.status === 'active' && <SecretAlert r={r} />}
        <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
          {r.status === 'active' && <button className="btn btn-sm" onClick={() => setModal({ k: 'rotate', r })}>Rotar secreto</button>}
          {r.status === 'active' && <button className="btn btn-sm" onClick={() => setModal({ k: 'disable', r })}>Deshabilitar</button>}
          <button className="btn btn-sm btn-ghost" onClick={() => open(r.profile, r.id)}>Ver en el catálogo <I.ArrowRight size={11} /></button>
        </div>
      </div>; })}</div>}
    {modal?.k === 'rotate' && <RotateModal r={modal.r} onClose={() => setModal(null)} />}
    {modal?.k === 'disable' && <DisableModal r={modal.r} onClose={() => setModal(null)} />}
  </div>;
}

// —— Agent Builder › Tools ——
// El catálogo del Builder solo trae los servicios de los grupos de quien edita: los demás no aparecen.
// Si el agente ya tiene tools de un servicio que no es de sus grupos, no puede guardar (remote_not_usable).
function RemoteBuilderTools({ snap, set }) {
  const I = window.Icons; useRm(); const simStray = window.useMango(s => s.simBuilderRemote) === 'stray';
  const act = RM.regs().filter(r => r.status === 'active' && r.kind !== 'scope');
  const sel0 = snap.remoteTools || [];
  const usable = simStray ? [] : act.filter(r => RM.inMyGroups(r));
  const sel = simStray && !sel0.length ? ['azure-devops.wit_work_item', 'azure-devops.wiki'] : sel0;
  const stray = RM.PROFILES.filter(p => !usable.some(r => r.profile === p.id)).map(p => ({ p, ids: sel.filter(id => id.startsWith(p.id + '.')) })).filter(x => x.ids.length);
  if (!usable.length && !stray.length) return null;
  const tog = (id) => set({ remoteTools: sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id] });
  return <div style={{ display: 'grid', gap: 10 }}>
    {stray.map(({ p, ids }) => <div key={p.id} className="mc-alert red" role="alert"><I.X2 size={14} /><div style={{ flex: 1 }}><b>Este agente tiene {ids.length === 1 ? '1 tool' : ids.length + ' tools'} de {p.name}, que no está habilitado para tus grupos</b><div>Para guardar una versión, quítalas o pide a un administrador que agregue uno de tus grupos al servicio. <span className="mono">{ids.map(x => x.split('.')[1]).join(', ')}</span></div></div><button className="btn btn-sm" onClick={() => { set({ remoteTools: sel0.filter(x => !ids.includes(x)) }); if (simStray) S.set({ simBuilderRemote: null }); }}>Quitarlas</button></div>)}
    <div className="ab-list">{usable.map(r => { const p = RM.profile(r.profile); const ok = true;
      const ids = RM.toolsOf(p, r.toolsets).flatMap(t => t.tools.map(n => p.id + '.' + n)); const nOn = ids.filter(id => sel.includes(id)).length;
      const outside = [...snap.groups.filter(g => !r.groups.includes(g))];
      return <React.Fragment key={r.id}>
        <div className="ab-group row between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="row gap-2" style={{ minWidth: 0, flexWrap: 'wrap' }}><span style={{ color: 'var(--text)', fontWeight: 600, fontSize: 12.5 }}>{p.name}</span><span>servicio externo · {r.org}</span><RmBadges p={p} compact /></span>
          {ok && <button type="button" className="sr-link" onClick={() => set({ remoteTools: nOn === ids.length ? sel.filter(x => !ids.includes(x)) : [...new Set([...sel, ...ids])] })}>{nOn === ids.length ? 'Quitar todas' : 'Todas'}</button>}
        </div>
        {RM.toolsOf(p, r.toolsets).map(t => t.tools.map(n => { const id = p.id + '.' + n; const on = sel.includes(id); return <button key={id} type="button" className={'ab-item' + (on ? ' is-on' : '')} aria-pressed={on} onClick={() => tog(id)}>
            <span className="ab-check">{on && <I.Check size={10} />}</span>
            <span style={{ flex: 1, minWidth: 0 }}><span className="mono" style={{ display: 'block', fontSize: 12.5, fontWeight: 500 }}>{n}</span><span className="ab-sub">{t.label} · lee con la cuenta de cada persona</span></span>
            <span className="badge">Lectura</span>
          </button>; }))}
        {ok && nOn > 0 && (outside.length > 0 || (snap.users || []).length > 0) && <div className="mc-alert amber" style={{ margin: '6px 8px' }}><I.Warn size={14} /><div>Este agente es visible para {outside.length ? <>grupos que no tienen {p.name} (<span className="mono">{outside.join(', ')}</span>)</> : null}{outside.length && (snap.users || []).length ? ' y ' : ''}{(snap.users || []).length ? 'personas sueltas' : ''}. Esas personas no podrán conectar su cuenta: el agente les responderá sin estas tools.</div></div>}
      </React.Fragment>; })}</div>
  </div>;
}

// —— Bandeja ——
RM.inboxItems = (me, isAdmin) => {
  if (S.get().avail) return { pinned: [], rest: [] };
  const ago = (m) => new Date(Date.now() - m * 6e4).toISOString();
  const pinned = isAdmin ? RM.pending().filter(r => r.by !== me).map(r => { const p = RM.profile(r.profile); return { id: 'rmreq-' + r.id, type: 'remoteReq', pid: p.id, regId: r.id, title: 'Te piden aprobar: ' + p.name + ' para ' + r.org, body: (r.kind === 'scope' ? 'Cambio de grupos · ' : r.replaces ? 'Cambio de tenant o app · ' : '') + r.toolsets.length + ' grupos de tools · ' + r.groups.join(', '), at: r.at }; }) : [];
  const rest = [];
  // Tarea que necesita conexión (remote_connect). Si el servicio ya no está en Mis conexiones, es un aviso propio, no una ejecución fallida.
  if (S.get().simRemoteTask === 'gone') { const p = RM.PROFILES[0]; rest.push({ id: 'rmgone-' + p.id, type: 'remoteGone', pid: p.id, title: 'Tu tarea no pudo leer un servicio externo', body: 'La tarea "Resumen semanal del sprint" usa un servicio externo que ya no está en tus conexiones: lo deshabilitaron o ya no es de tus grupos. Va a fallar mientras el agente use sus tools.', at: ago(95) }); }
  else RM.mine().filter(r => r.status === 'active').forEach(r => { const p = RM.profile(r.profile); if (RM.conn(p.id).status !== 'connected') rest.push({ id: 'rmtask-' + r.id, type: 'remoteTask', pid: p.id, title: 'Conecta tu cuenta de ' + p.name, body: 'La tarea "Resumen semanal del sprint" no pudo leer ' + p.name + ' porque no has conectado tu cuenta.', at: ago(95) }); });
  if (isAdmin) RM.regs().filter(r => r.status === 'active' && RM.secretInfo(r).level !== 'ok').forEach(r => { const p = RM.profile(r.profile); const si = RM.secretInfo(r); rest.push({ id: 'rmsec-' + r.id + '-' + si.level, type: 'remoteSecret', pid: p.id, regId: r.id, expired: si.level === 'expired', title: si.level === 'expired' ? 'El secreto de la app de Entra de ' + p.name + ' venció' : 'El secreto de la app de Entra de ' + p.name + ' vence en ' + si.days + (si.days === 1 ? ' día' : ' días'), body: si.level === 'expired' ? 'Las personas no pueden conectar su cuenta hasta que lo rotes.' : 'Rótalo antes del ' + RM.fmtDay(r.secretExp) + '. Al vencer, nadie puede conectar su cuenta.', at: ago(30) }); });
  return { pinned, rest };
};

Object.assign(window, { RemoteCatalogTab, RemoteRequests, RemoteDetail, MyConnections, RemoteReturn, RemoteConnBlock, RemoteBuilderTools });
})();
