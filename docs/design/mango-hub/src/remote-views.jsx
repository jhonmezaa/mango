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
  const I = window.Icons; useRm();
  return <div style={{ display: 'grid', gap: 14 }}>
    <p className="rm-p" style={{ margin: 0, maxWidth: 720 }}>Servicios MCP de terceros revisados y firmados que trae esta versión de Mango. No se conectan por URL: se habilita un perfil para una organización, y cada persona conecta su propia cuenta.</p>
    <div className="rm-grid">
      {RM.PROFILES.map(p => { const list = RM.regsOf(p.id); const act = list.find(r => r.status === 'active'); const pend = list.filter(r => r.status === 'pending'); const dis = list.find(r => r.status === 'disabled'); const mid = list.find(r => r.status === 'creating' || r.status === 'failed');
        return <button key={p.id} className="card rm-pcard" onClick={() => onOpen(p.id)}>
          <div className="row gap-3" style={{ alignItems: 'flex-start' }}><RmTile p={p} /><div style={{ flex: 1, minWidth: 0 }}><div className="mk-name">{p.name}</div><div className="mk-meta">Operado por {p.operator} · <span className="mono">{p.host}</span></div></div><RmStatus r={act || mid || pend[0] || dis} /></div>
          <RmBadges p={p} compact />
          <div className="rm-sets">{p.toolsets.map(t => <span key={t.id} className="rm-set">{t.label}</span>)}</div>
          <div className="mk-meta rm-pcard-f">{act ? <>Habilitado para <span className="mono">{act.org}</span> · {act.groups.length} {act.groups.length === 1 ? 'grupo' : 'grupos'}</> : mid ? <>{mid.status === 'creating' ? 'Creándose' : 'Falló al habilitarse'} · <span className="mono">{mid.org}</span></> : pend.length ? <>Solicitud pendiente · <span className="mono">{pend[0].org}</span></> : dis ? <>Deshabilitado para <span className="mono">{dis.org}</span></> : 'Ninguna organización habilitada'}<span style={{ marginLeft: 'auto' }} className="row gap-1">Ver ficha <I.ArrowRight size={11} /></span></div>
        </button>; })}
    </div>
  </div>;
}
function RemoteRequests({ onOpen }) {
  const I = window.Icons; useRm(); const me = S.actor(); const list = RM.pending();
  if (!list.length) return null;
  return <div style={{ display: 'grid', gap: 10, marginBottom: 18 }}>
    <div className="mk-sec-t">servicios externos · {list.length}</div>
    {list.map(r => { const p = RM.profile(r.profile); return <div key={r.id} className="card mc-req">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row gap-2" style={{ flexWrap: 'wrap' }}><span className="mk-name">{p.name}</span><span className="badge">{r.replaces ? 'Cambiar tenant o app' : 'Habilitar'}</span><span className="badge mono">{r.org}</span></div>
        <div className="mk-meta" style={{ marginTop: 3 }}>Pedido por {r.by === me ? 'ti' : r.by} · {window.fmtAgo(r.at)} · {r.toolsets.length} toolsets · {r.groups.join(', ')}</div>
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
  const [why, setWhy] = useState(''); const [modal, setModal] = useState(null);
  useEffect(() => { const h = e => e.key === 'Escape' && !modal && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [modal]);
  const list = RM.regsOf(pid);
  const reg = mode?.id && list.find(r => r.id === mode.id);
  const openForm = (base, replaces) => { setF({ profile: pid, org: base?.org || '', tenantId: '', clientId: '', secret: '', secretExp: in90(), toolsets: base?.toolsets || p.toolsets.map(t => t.id), groups: base?.groups || [], replaces }); setTried(false); setErr(null); setMode({ k: 'form' }); };
  const fe = f && {
    org: !f.org.trim() ? 'Escribe el nombre de la organización' : /[/.:]/.test(f.org) ? 'Solo el nombre, sin la URL' : !ORG.test(f.org.trim()) ? 'Letras, números y guiones, hasta 49 caracteres' : null,
    tenantId: !GUID.test(f.tenantId.trim()) ? 'Debe ser un GUID, como 00000000-0000-0000-0000-000000000000' : null,
    clientId: !GUID.test(f.clientId.trim()) ? 'Debe ser un GUID, como 00000000-0000-0000-0000-000000000000' : null,
    secret: !f.secret.trim() ? 'Pega el secreto de la app' : null,
    secretExp: !f.secretExp ? 'Escribe la fecha de vencimiento' : new Date(f.secretExp) <= new Date() ? 'La fecha tiene que ser futura' : null,
    toolsets: !f.toolsets.length ? 'Elige al menos un toolset' : null,
    groups: !f.groups.length ? 'Elige al menos un grupo' : null,
  };
  const submit = () => { setTried(true); setErr(null); if (Object.values(fe).some(Boolean)) return; const res = RM.request({ ...f, org: f.org.trim(), tenantId: f.tenantId.trim(), clientId: f.clientId.trim() }, f.replaces); if (res.error) { setErr(res.error); return; } toast?.({ tone: 'success', msg: 'Solicitud enviada · otra persona administradora debe aprobarla' }); setMode({ k: 'reg', id: res.reg.id, sent: true }); };
  const tog = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v] });

  let body, foot;
  if (mode?.k === 'form') {
    const e = tried ? fe : {};
    body = <>
      <div className="rm-steps" aria-label="Paso 1 de 2"><span className="is-on">1 · Pedir</span><span>2 · Otra persona administradora aprueba</span></div>
      {f.replaces && <div className="mc-alert"><I.Info size={14} /><div>Cambiar el tenant o la app es una solicitud nueva. Mientras no se apruebe, sigue activa la configuración actual.</div></div>}
      <div className="rm-form">
        <RmField id="rf-org" label="Organización de Azure DevOps" hint="Solo el nombre. El host lo pone el perfil." error={e.org}><div className="rm-prefix"><span className="mono">{p.host}/</span><input id="rf-org" className="input mono" value={f.org} maxLength={49} disabled={!!f.replaces} onChange={x => setF({ ...f, org: x.target.value })} autoFocus /></div></RmField>
        <div className="rm-2col">
          <RmField id="rf-ten" label="Tenant de Entra (tenantId)" error={e.tenantId}><input id="rf-ten" className="input mono" value={f.tenantId} onChange={x => setF({ ...f, tenantId: x.target.value })} placeholder="00000000-0000-0000-0000-000000000000" /></RmField>
          <RmField id="rf-cli" label="Id de la app (clientId)" error={e.clientId}><input id="rf-cli" className="input mono" value={f.clientId} onChange={x => setF({ ...f, clientId: x.target.value })} placeholder="00000000-0000-0000-0000-000000000000" /></RmField>
        </div>
        <div className="rm-2col">
          <RmField id="rf-sec" label="Secreto de la app" hint="Solo escritura: no se vuelve a mostrar, ni a ti." error={e.secret}><input id="rf-sec" className="input mono" type="password" autoComplete="off" value={f.secret} onChange={x => setF({ ...f, secret: x.target.value })} /></RmField>
          <RmField id="rf-exp" label="Vence el" hint="El que muestra Entra. Mango avisa 30 y 7 días antes." error={e.secretExp}><input id="rf-exp" className="input" type="date" value={f.secretExp} onChange={x => setF({ ...f, secretExp: x.target.value })} /></RmField>
        </div>
        <div className={'rm-field' + (e.toolsets ? ' has-error' : '')}><span className="rm-label" id="rf-ts">Toolsets</span>
          <div className="rm-checks" role="group" aria-labelledby="rf-ts">{p.toolsets.map(t => <label key={t.id} className={'rm-check' + (f.toolsets.includes(t.id) ? ' is-on' : '')}><input type="checkbox" checked={f.toolsets.includes(t.id)} onChange={() => tog('toolsets', t.id)} /><span>{t.label}</span><span className="mk-meta">{t.tools.length}</span></label>)}</div>
          {e.toolsets ? <div className="rm-err" role="alert">{e.toolsets}</div> : <div className="rm-hint">Todas sus tools son de lectura.</div>}</div>
        <div className={'rm-field' + (e.groups ? ' has-error' : '')}><span className="rm-label" id="rf-gr">Grupos que pueden usarlo</span>
          <div className="rm-chips" role="group" aria-labelledby="rf-gr">{groupIds.map(g => <button key={g} type="button" className={'tweak-chip ab-chip mono' + (f.groups.includes(g) ? ' is-on' : '')} aria-pressed={f.groups.includes(g)} onClick={() => tog('groups', g)}>{f.groups.includes(g) && <I.Check size={10} />}{g}</button>)}</div>
          {e.groups ? <div className="rm-err" role="alert">{e.groups}</div> : <div className="rm-hint">Solo las personas de estos grupos pueden conectar su cuenta y dar sus tools a un agente.</div>}</div>
      </div>
    </>;
    foot = <>{err && <div className="g-err" role="alert" style={{ marginBottom: 10 }}>{err}</div>}<div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={submit}>Enviar solicitud</button><button className="btn btn-sm btn-ghost" onClick={() => setMode(null)}>Cancelar</button></div></>;
  } else if (reg) {
    const own = reg.by === me; const si = RM.secretInfo(reg);
    body = <>
      {mode.sent && <div className="mc-alert"><I.Check2 size={14} style={{ color: 'var(--green)' }} /><div><b>Solicitud enviada.</b> Mientras otra persona administradora la aprueba, pega la URL de redirección en la app de Entra.</div></div>}
      {reg.status === 'pending' && <div className="rm-steps" aria-label="Paso 2 de 2"><span className="is-done">1 · Pedido por {own ? 'ti' : reg.by}</span><span className="is-on">2 · Otra persona administradora aprueba</span></div>}
      {reg.status === 'pending' && <div className="rm-redirect"><RmCopy value={reg.redirect} /><div className="rm-hint">Pégala en la app de Entra como URI de redirección de plataforma <b>Web</b>. La genera Mango en AWS; es la única dirección de este flujo.</div></div>}
      {reg.status === 'active' && <SecretAlert r={reg} onRotate={isAdmin ? () => setModal('rotate') : null} />}
      {reg.status === 'creating' && <div className="mc-alert" role="status"><span className="g-spin" /><div><b>Creándose.</b> Aprobado por {reg.approvedBy === me ? 'ti' : reg.approvedBy}. Mango está creando la conexión con {p.name}; tarda unos segundos. Puedes cerrar este panel.</div></div>}
      {reg.status === 'failed' && <div className="mc-alert red" role="alert"><I.X2 size={14} /><div><b>No se pudo habilitar {p.name}</b><div>Revisa los datos de la app de Entra y vuelve a pedirlo.</div></div></div>}
      {reg.status === 'disabled' && <div className="mc-alert"><I.Info size={14} /><div>Deshabilitado por {reg.disabledBy} · {window.fmtAgo(reg.disabledAt)}{reg.reason ? <>: «{reg.reason}»</> : null}</div></div>}
      <Sec title="Registro">
        <KV k="Organización"><span className="mono">{p.host}/{reg.org}</span></KV>
        <KV k="Tenant de Entra"><span className="mono rm-wrap">{reg.tenantId}</span></KV>
        <KV k="Id de la app"><span className="mono rm-wrap">{reg.clientId}</span></KV>
        <KV k="Secreto de la app"><span className="row gap-2"><I.Lock size={11} /> Guardado · no se muestra</span></KV>
        {reg.status !== 'pending' && <KV k="Vencimiento del secreto"><SecretLine r={reg} /></KV>}
        {reg.status === 'pending' && <KV k="Vencimiento del secreto">{RM.fmtDay(reg.secretExp)}</KV>}
        <KV k="Toolsets"><span className="rm-sets" style={{ justifyContent: 'flex-end' }}>{RM.toolsOf(p, reg.toolsets).map(t => <span key={t.id} className="rm-set">{t.label}</span>)}</span></KV>
        <KV k="Grupos"><span className="rm-sets" style={{ justifyContent: 'flex-end' }}>{reg.groups.map(g => <span key={g} className="badge mono">{g}</span>)}</span></KV>
        <KV k="Pidió">{reg.by === me ? 'Tú' : reg.by} · {window.fmtAgo(reg.at)}</KV>
        {reg.approvedBy && <KV k="Aprobó">{reg.approvedBy === me ? 'Tú' : reg.approvedBy}</KV>}
      </Sec>
      {reg.status === 'active' && reg.redirect && <Sec title="URL de redirección"><RmCopy value={reg.redirect} label="Configurada en la app de Entra" /></Sec>}
    </>;
    if (!isAdmin) foot = <div className="ap-reason"><I.Lock size={12} /> Solo los administradores pueden habilitar, aprobar o deshabilitar servicios externos.</div>;
    else if (reg.status === 'pending' && mode.reject) foot = <div style={{ display: 'grid', gap: 8 }}><label htmlFor="rm-why" style={{ fontSize: 12.5, fontWeight: 500 }}>Motivo del rechazo</label><textarea id="rm-why" className="input" rows={2} value={why} onChange={e => setWhy(e.target.value)} autoFocus style={tried && !why.trim() ? { borderColor: 'var(--red)' } : null} />{tried && !why.trim() && <div style={{ fontSize: 12, color: 'var(--red)' }}>El motivo es obligatorio</div>}<div className="rm-hint">Rechazar borra lo que se creó con la solicitud, incluido el secreto.</div><div className="row gap-2"><button className="btn btn-sm mk-danger" onClick={() => { setTried(true); if (!why.trim()) return; RM.reject(reg.id, why.trim()); toast?.({ tone: 'success', msg: 'Solicitud rechazada' }); setMode(null); setWhy(''); setTried(false); }}>Rechazar</button><button className="btn btn-sm btn-ghost" onClick={() => { setMode({ ...mode, reject: false }); setTried(false); }}>Cancelar</button></div></div>;
    else if (reg.status === 'pending') foot = <>{err && <div className="g-err" role="alert" style={{ marginBottom: 10 }}>{err}</div>}{own
      ? <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><span className="ap-reason"><I.Lock size={12} /> Otra persona administradora tiene que aprobarlo.</span><button className="btn btn-sm" onClick={() => { RM.withdraw(reg.id); toast?.({ tone: 'success', msg: 'Solicitud retirada · se borró lo que se había creado' }); setMode(null); }}>Retirar solicitud</button></div>
      : <div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={() => { const r = RM.approve(reg.id); if (r.error) { setErr(r.error); return; } toast?.({ tone: 'success', msg: p.name + ' habilitado para ' + reg.org }); setMode({ k: 'reg', id: reg.id }); }}><I.Check size={12} /> Aprobar</button><button className="btn btn-sm" onClick={() => setMode({ ...mode, reject: true })}>Rechazar</button></div>}</>;
    else if (reg.status === 'creating') foot = <div className="ap-reason"><span className="g-spin" /> Creando la conexión · no hace falta hacer nada.</div>;
    else if (reg.status === 'failed') foot = <button className="btn btn-sm btn-primary" onClick={() => openForm(reg)}>Pedir de nuevo</button>;
    else if (reg.status === 'active') foot = <div className="row gap-2" style={{ flexWrap: 'wrap' }}><button className="btn btn-sm" onClick={() => setModal('rotate')}>Rotar secreto</button><button className="btn btn-sm" disabled={list.some(r => r.replaces === reg.id)} title={list.some(r => r.replaces === reg.id) ? 'Ya hay un cambio pendiente' : undefined} onClick={() => openForm(reg, reg.id)}>Cambiar tenant o app</button><button className="btn btn-sm" onClick={() => setModal('disable')}>Deshabilitar</button></div>;
    else foot = <button className="btn btn-sm btn-primary" onClick={() => openForm(reg)}>Pedir de nuevo</button>;
  } else {
    body = <>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{p.desc}</p>
      <div className="mc-alert amber"><I.Globe size={14} /><div><b>Los datos salen de AWS.</b> El servidor corre en {p.operator}: las consultas del agente y sus resultados pasan por fuera de AWS.</div></div>
      <div className="mc-alert"><I.User size={14} /><div>Cada persona conecta su propia cuenta de {p.idp} la primera vez que un agente lo usa, y el agente lee con sus permisos. Mango nunca ve su contraseña.</div></div>
      <Sec title={'Organizaciones · ' + list.length}>
        {list.length ? list.map(r => <button key={r.id} className="mk-line row between rm-regrow" onClick={() => setMode({ k: 'reg', id: r.id })}><span className="row gap-2" style={{ minWidth: 0 }}><span className="mono" style={{ fontSize: 12.5 }}>{r.org}</span>{r.replaces && <span className="badge">Cambio de tenant o app</span>}<span className="mk-meta">{r.toolsets.length} toolsets · {r.groups.length} {r.groups.length === 1 ? 'grupo' : 'grupos'}</span></span><span className="row gap-2"><RmStatus r={r} /><I.ChevronRight size={12} /></span></button>) : <div className="mk-meta">Ninguna organización habilitada todavía.</div>}
      </Sec>
      {RM.histOf(pid).length > 0 && <Sec title={'Historial de solicitudes · ' + RM.histOf(pid).length}>
        {RM.histOf(pid).map(r => <div key={r.id} className="mk-line rm-hist">
          <div className="row between" style={{ gap: 8 }}><span className="row gap-2" style={{ minWidth: 0 }}><span className="mono" style={{ fontSize: 12.5 }}>{r.org}</span><RmStatus r={r} /></span><span className="mk-meta">{window.fmtAgo(r.decidedAt || r.at)}</span></div>
          <div className="mk-meta">Pidió {r.by === me ? 'tú' : r.by} · {r.status === 'withdrawn' ? 'la retiró ' + (r.decidedBy === r.by ? 'quien la pidió' : r.decidedBy) : 'rechazó ' + (r.decidedBy === me ? 'tú' : r.decidedBy)} · {r.toolsets.length} toolsets · {r.groups.join(', ')}</div>
          {r.reason && <div className="rm-hist-why">«{r.reason}»</div>}
        </div>)}
        <div className="mk-meta" style={{ marginTop: 6 }}>Al rechazar o retirar se borra lo que se había creado, incluido el secreto. Queda el registro de quién pidió qué.</div>
      </Sec>}
      <Sec title={'Tools · ' + toolCount(p) + ' · todas de lectura'}>
        {p.toolsets.map(t => <div key={t.id} className="rm-tset"><div className="rm-tset-h">{t.label}</div>{t.tools.map(n => <div key={n} className="mk-line row between"><span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{n}</span><span className="badge">Lectura</span></div>)}</div>)}
        <div className="mk-meta" style={{ marginTop: 6 }}>Ningún perfil trae tools de escritura: no existen en Mango.</div>
      </Sec>
      <Sec title={'Permisos en ' + p.idp}>
        {p.scopes.map(([api, sc, d]) => <div key={sc} className="mk-line"><div className="row gap-2"><span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{sc}</span><span className="mk-meta">{api}</span></div><div className="mk-meta">{d}</div></div>)}
      </Sec>
      <Sec title="Host del servicio"><div className="row gap-2"><code className="mono rm-host">{p.host}</code><span className="mk-meta">Fijo en el perfil firmado. No se puede cambiar.</span></div></Sec>
      <Sec title="Requisitos">{p.reqs.map((x, i) => <div key={i} className="row gap-2 rm-req"><span className="rm-req-n">{i + 1}</span><span>{x}</span></div>)}</Sec>
    </>;
    foot = isAdmin ? <button className="btn btn-sm btn-primary" onClick={() => openForm()}><I.Plus size={12} /> Habilitar para una organización</button> : <div className="ap-reason"><I.Lock size={12} /> Solo los administradores pueden habilitar servicios externos.</div>;
  }
  return <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <aside className="mk-drawer" style={{ width: 540 }} role="dialog" aria-modal="true" aria-label={p.name}>
      <div className="mk-drawer-h">
        {mode ? <button className="btn btn-ghost btn-icon" aria-label="Volver a la ficha" onClick={() => { setMode(null); setErr(null); }}><I.ChevronLeft size={14} /></button> : null}
        <RmTile p={p} lg />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{mode?.k === 'form' ? (f.replaces ? 'Cambiar tenant o app' : 'Habilitar ' + p.name) : reg ? p.name + ' · ' + reg.org : p.name}</div>
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
  const [open, setOpen] = useState(false); const [already, setAlready] = useState({});
  useEffect(() => { const o = () => { setOpen(true); setAlready({}); }, c = () => setOpen(false); window.addEventListener('mango:my-connections', o); window.addEventListener('mango:close-connections', c); return () => { window.removeEventListener('mango:my-connections', o); window.removeEventListener('mango:close-connections', c); }; }, []);
  if (!open || S.get().avail) return null;
  const list = RM.mine();
  return <window.Modal open onClose={() => setOpen(false)} title="Mis conexiones" width={520}>
    <p className="rm-p">Servicios externos que tus grupos pueden usar. Tu cuenta se conecta una vez y los agentes leen con tus permisos, solo lectura. Mango no muestra tu token ni datos de tu cuenta.</p>
    {!list.length ? <div className="rm-empty"><I.Globe size={18} /><div>Ningún servicio externo está habilitado para tus grupos.</div></div> : <div className="rm-conns">{list.map(r => {
      const p = RM.profile(r.profile); const c = RM.conn(p.id); const off = r.status === 'disabled'; const exp = RM.secretInfo(r).level === 'expired';
      const state = off ? 'off' : c.status === 'connecting' ? 'opening' : c.status === 'connected' ? 'on' : exp ? 'blocked' : 'none';
      return <div key={r.id} className="rm-conn">
        <RmTile p={p} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}><span className="mk-name">{p.name}</span><span className="mk-meta mono">{r.org}</span></div>
          <div className="rm-conn-s" role="status">{already[p.id] && state === 'on' ? <span className="row gap-2"><span className="dot dot-green" /> Tu cuenta ya estaba conectada.</span> : state === 'off' ? <>Un administrador deshabilitó {p.name}.</> : state === 'opening' ? <span className="row gap-2"><span className="g-spin" /> Abriendo {p.idp}…</span> : state === 'on' ? <span className="row gap-2"><span className="dot dot-green" /> Conectado{c.at ? ' · ' + window.fmtAgo(c.at) : ''}.</span> : state === 'blocked' ? <>Por ahora no se puede conectar: un administrador tiene que renovar la configuración de {p.name}.</> : <>No has conectado tu cuenta.</>}</div>
        </div>
        {state === 'none' && <button className="btn btn-sm btn-primary" onClick={() => { if (RM.connect(p.id, 'connections') === 'already') setAlready({ ...already, [p.id]: true }); }}>Conectar</button>}
        {state === 'on' && <window.Soon on><button className="btn btn-sm">Desconectar</button></window.Soon>}
      </div>; })}</div>}
    {list.length > 0 && (idps => <div className="rm-hint" style={{ marginTop: 14 }}>Al conectar vas a iniciar sesión en {idps.join(' o ')}. Si tu cuenta ya estaba conectada, Mango lo confirma sin abrir {idps.length === 1 ? idps[0] : 'el proveedor'}.</div>)([...new Set(list.map(r => RM.profile(r.profile).idp))])}
  </window.Modal>;
}

// —— La vuelta desde Microsoft ——
const RET = {
  ok: ['Check', 'green', (p) => 'Listo, tu cuenta de ' + p.name + ' está conectada.', () => 'Vuelve al chat y repite tu pregunta.'],
  expired: ['Clock', 'amber', () => 'El enlace venció', () => 'Vuelve a pedir la conexión.'],
  nosession: ['Lock', 'muted', () => 'Inicia sesión en Mango para terminar', () => 'Este navegador no tiene tu sesión de Mango abierta. Después de ingresar vuelves aquí y la conexión se completa.'],
  notyours: ['Lock', 'red', () => 'Este enlace no es tuyo', () => 'Pide la conexión desde tu propia sesión.'],
  denied: ['X2', 'red', (p) => p.idp + ' no autorizó la conexión', (p) => 'Si no fuiste tú quien canceló, consulta con el administrador de ' + p.idp + ' de tu empresa.'],
  conditional: ['Shield', 'amber', () => 'Una regla de acceso de tu empresa bloqueó la conexión', (p) => 'El Acceso condicional de ' + p.idp + ' no dejó iniciar sesión desde este dispositivo o esta red, o pidió un paso que no se completó. Consulta con el administrador de ' + p.idp + ' de tu empresa.'],
  error: ['Warn', 'amber', () => 'No se pudo conectar tu cuenta', () => 'Inténtalo de nuevo en unos minutos.'],
};
function RemoteReturn({ setView }) {
  const I = window.Icons; window.useMango(s => s.simRemoteReturn);
  const ret = S.get().remoteReturn || { pid: 'azure-devops', from: 'connections' };
  const result = S.get().simRemoteReturn || 'ok';
  const p = RM.profile(ret.pid);
  useEffect(() => { RM.finish(ret.pid, result); }, [result]);
  const [ic, tone, t, b] = RET[result]; const Ic = I[ic];
  const toChat = () => setView('chat'); const toConn = () => { setView(ret.from === 'chat' ? 'chat' : 'chat'); setTimeout(() => window.dispatchEvent(new CustomEvent('mango:my-connections')), 60); };
  return <>
    <Topbar crumbs={['Mis conexiones', p.name]} />
    <div className="content"><div className="rm-ret" role={result === 'ok' ? 'status' : 'alert'}>
      <div className="row gap-2 rm-ret-svc"><RmTile p={p} /><span>{p.name}</span><span className="mk-meta">· vuelta desde {p.idp}</span></div>
      <span className={'rm-ret-ic ' + tone}><Ic size={18} /></span>
      <h1 className="rm-ret-t">{t(p)}</h1>
      <p className="rm-ret-b">{b(p)}</p>
      <div className="row gap-2" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        {result === 'nosession' ? <button className="btn btn-sm btn-primary" onClick={() => setView('login')}>Iniciar sesión</button>
          : result === 'ok' ? <><button className="btn btn-sm btn-primary" onClick={toChat}>Volver al chat</button><button className="btn btn-sm" onClick={toConn}>Mis conexiones</button></>
          : result === 'notyours' ? <button className="btn btn-sm btn-primary" onClick={toChat}>Ir al chat</button>
          : <><button className="btn btn-sm btn-primary" onClick={toConn}>Mis conexiones</button><button className="btn btn-sm" onClick={toChat}>Volver al chat</button></>}
      </div>
    </div></div>
  </>;
}

// —— Ajustes › Conectividad ——
function RemoteConnBlock() {
  const I = window.Icons; useRm(); const [modal, setModal] = useState(null);
  const list = RM.regs().filter(r => ['active', 'disabled', 'creating', 'failed'].includes(r.status));
  const pend = RM.pending().length;
  const open = (pid, id) => { S.set({ rmOpen: { pid, id } }); window.MangoNav?.('mcp'); };
  return <div style={{ marginTop: 28 }}>
    <div className="g-sec-h" style={{ marginBottom: 8 }}><div><div className="g-sec-t" style={{ fontSize: 13.5 }}>Servicios externos</div><div className="g-sec-meta">MCP de terceros habilitados con perfil. Corren fuera de AWS; el secreto de cada app de Entra lo guarda Mango y no se vuelve a mostrar.</div></div>{pend > 0 && <button className="btn btn-sm" onClick={() => open(RM.pending()[0].profile, RM.pending()[0].id)}>{pend} {pend === 1 ? 'solicitud pendiente' : 'solicitudes pendientes'} <I.ArrowRight size={11} /></button>}</div>
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
            {r.status === 'failed' && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>No se pudo habilitar {p.name}. Revisa los datos de la app de Entra y vuelve a pedirlo.</div>}
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
function RemoteBuilderTools({ snap, set }) {
  const I = window.Icons; useRm();
  const act = RM.regs().filter(r => r.status === 'active');
  if (!act.length) return null;
  const sel = snap.remoteTools || [];
  const tog = (id) => set({ remoteTools: sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id] });
  return <div style={{ display: 'grid', gap: 10 }}>
    <div className="ab-list">{act.map(r => { const p = RM.profile(r.profile); const ok = RM.inMyGroups(r);
      const ids = RM.toolsOf(p, r.toolsets).flatMap(t => t.tools.map(n => p.id + '.' + n)); const nOn = ids.filter(id => sel.includes(id)).length;
      const outside = [...snap.groups.filter(g => !r.groups.includes(g))];
      return <React.Fragment key={r.id}>
        <div className="ab-group row between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="row gap-2" style={{ minWidth: 0, flexWrap: 'wrap' }}><span style={{ color: 'var(--text)', fontWeight: 600, fontSize: 12.5 }}>{p.name}</span><span>servicio externo · {r.org}</span><RmBadges p={p} compact /></span>
          {ok && <button type="button" className="sr-link" onClick={() => set({ remoteTools: nOn === ids.length ? sel.filter(x => !ids.includes(x)) : [...new Set([...sel, ...ids])] })}>{nOn === ids.length ? 'Quitar todas' : 'Todas'}</button>}
        </div>
        {!ok ? <div className="ab-item is-off" aria-disabled="true"><span className="ab-check" /><span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 12.5 }}>{p.name} no está habilitado para tus grupos.</span><span className="ab-sub">Lo habilitaron para {r.groups.join(', ')}.</span></span></div>
          : RM.toolsOf(p, r.toolsets).map(t => t.tools.map(n => { const id = p.id + '.' + n; const on = sel.includes(id); return <button key={id} type="button" className={'ab-item' + (on ? ' is-on' : '')} aria-pressed={on} onClick={() => tog(id)}>
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
  const pinned = isAdmin ? RM.pending().filter(r => r.by !== me).map(r => { const p = RM.profile(r.profile); return { id: 'rmreq-' + r.id, type: 'remoteReq', pid: p.id, regId: r.id, title: 'Te piden aprobar: ' + p.name + ' para ' + r.org, body: (r.replaces ? 'Cambio de tenant o app · ' : '') + r.toolsets.length + ' toolsets · ' + r.groups.join(', '), at: r.at }; }) : [];
  const rest = [];
  RM.mine().filter(r => r.status === 'active').forEach(r => { const p = RM.profile(r.profile); if (RM.conn(p.id).status !== 'connected') rest.push({ id: 'rmtask-' + r.id, type: 'remoteTask', pid: p.id, title: 'Conecta tu cuenta de ' + p.name, body: 'La tarea "Resumen semanal del sprint" no pudo leer ' + p.name + ' porque no has conectado tu cuenta.', at: ago(95) }); });
  if (isAdmin) RM.regs().filter(r => r.status === 'active' && RM.secretInfo(r).level !== 'ok').forEach(r => { const p = RM.profile(r.profile); const si = RM.secretInfo(r); rest.push({ id: 'rmsec-' + r.id + '-' + si.level, type: 'remoteSecret', pid: p.id, regId: r.id, expired: si.level === 'expired', title: si.level === 'expired' ? 'El secreto de la app de Entra de ' + p.name + ' venció' : 'El secreto de la app de Entra de ' + p.name + ' vence en ' + si.days + (si.days === 1 ? ' día' : ' días'), body: si.level === 'expired' ? 'Las personas no pueden conectar su cuenta hasta que lo rotes.' : 'Rótalo antes del ' + RM.fmtDay(r.secretExp) + '. Al vencer, nadie puede conectar su cuenta.', at: ago(30) }); });
  return { pinned, rest };
};

Object.assign(window, { RemoteCatalogTab, RemoteRequests, RemoteDetail, MyConnections, RemoteReturn, RemoteConnBlock, RemoteBuilderTools });
})();
