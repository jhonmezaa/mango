// MCP remotos de terceros (D93/D94) · piloto Azure DevOps. Datos, acciones y piezas compartidas.
// Solo en «Diseño completo»: en «Disponible hoy» siguen en Próximamente.
(() => {
const { useState, useEffect, useRef } = React;
const S = window.MangoStore;
const DAY = 864e5;
const PROFILES = [{
  id: 'azure-devops', name: 'Azure DevOps', short: 'AD', operator: 'Microsoft', idp: 'Microsoft', host: 'dev.azure.com', hosts: ['dev.azure.com', 'visualstudio.com'], version: '1.0',
  desc: 'Lee work items, repositorios, wiki y pipelines de Azure DevOps con la cuenta de Microsoft de cada persona.',
  toolsets: [
    { id: 'core', label: 'Proyectos y equipos', tools: ['core_list_projects', 'core_list_project_teams'] },
    { id: 'work-items', label: 'Work items', tools: ['wit_get_work_item', 'wit_my_work_items', 'wit_get_work_items_for_iteration'] },
    { id: 'repos', label: 'Repositorios', tools: ['repo_list_repos_by_project', 'repo_list_pull_requests_by_repo', 'repo_get_pull_request_by_id'] },
    { id: 'wiki', label: 'Wiki', tools: ['wiki_list_pages', 'wiki_get_page_content'] },
    { id: 'pipelines', label: 'Pipelines', tools: ['pipelines_get_builds', 'pipelines_get_build_log'] },
    { id: 'search', label: 'Búsqueda', tools: ['search_code', 'search_wiki', 'search_workitem'] },
  ],
  scopes: [['Azure DevOps', 'user_impersonation', 'Delegado: lee con los permisos de la persona'], ['Microsoft Entra', 'offline_access', 'Mantiene la conexión sin pedir el login cada vez']],
  reqs: ['Una organización de Azure DevOps conectada a Microsoft Entra.', 'Una app registrada en Entra, tipo Web, con permisos delegados de lectura.', 'Consentimiento de administrador en Entra para esos permisos.'],
}];
const REDIRECT = (pid) => 'https://api.mango.empresa.com/oauth/remote/' + pid + '/callback';
const SECRET_DAYS = { ok: 120, d30: 21, d7: 5, expired: -2 };
const iso = (ms) => new Date(Date.now() + ms).toISOString();

function seedRegs(kind = 'active', secret = 'd30') {
  if (kind === 'none') return [];
  const base = { id: 'RMT-7f3a2c10', profile: 'azure-devops', org: 'empresa', tenantId: '7c1e2a40-5b6d-4e8f-9a01-23456789abcd', clientId: '3b9d0c12-8e4f-4a6b-b7c8-0d1e2f3a4b5c', toolsets: ['core', 'work-items', 'repos', 'wiki', 'search'], groups: ['finops-central', 'mango-agent-creator'], secretExp: iso(SECRET_DAYS[secret] * DAY), redirect: REDIRECT('azure-devops') };
  if (kind === 'pending-other') return [{ ...base, status: 'pending', by: 'Usuario 6', at: iso(-3 * 36e5) }];
  if (kind === 'pending-mine') return [{ ...base, status: 'pending', by: 'Usuario 1', at: iso(-3 * 36e5) }];
  if (kind === 'disabled') return [{ ...base, status: 'disabled', by: 'Usuario 6', at: iso(-20 * DAY), approvedBy: 'Usuario 1', disabledBy: 'Usuario 6', disabledAt: iso(-1 * DAY), reason: 'Pausa mientras se revisan los permisos de la app en Entra' }];
  return [{ ...base, status: 'active', by: 'Usuario 6', at: iso(-20 * DAY), approvedBy: 'Usuario 1', approvedAt: iso(-19 * DAY) }];
}
if (!S.get().remoteRegs) S.set({ remoteRegs: seedRegs(), remoteConn: { 'azure-devops': { status: 'none' } } });

const get = () => S.get();
const profile = (id) => PROFILES.find(p => p.id === id);
const regs = () => get().remoteRegs || [];
const myGroups = () => (S.ROLES[get().role] || { groups: [] }).groups;
const inMyGroups = (r) => r.groups.some(g => myGroups().includes(g));
const conn = (pid) => (get().remoteConn || {})[pid] || { status: 'none' };
const secretInfo = (r) => { const d = Math.ceil((new Date(r.secretExp) - Date.now()) / DAY); return { days: d, level: d <= 0 ? 'expired' : d <= 7 ? 'd7' : d <= 30 ? 'd30' : 'ok' }; };
const fmtDay = (at) => new Date(at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
const toolsOf = (p, sets) => p.toolsets.filter(t => !sets || sets.includes(t.id));
const setRegs = (list) => S.set({ remoteRegs: list });
const upd = (id, patch) => setRegs(regs().map(r => r.id === id ? { ...r, ...patch } : r));
const newId = () => 'RMT-' + Math.random().toString(16).slice(2, 10);
const GONE = 'Este servicio ya no está en esta versión de Mango.';

const RM = {
  PROFILES, profile, regs, myGroups, inMyGroups, conn, secretInfo, fmtDay, toolsOf, seedRegs, SECRET_DAYS,
  regsOf: (pid) => regs().filter(r => r.profile === pid),
  active: (pid) => regs().find(r => r.profile === pid && r.status === 'active'),
  mine: () => regs().filter(r => (r.status === 'active' || r.status === 'disabled') && inMyGroups(r)),
  pending: () => regs().filter(r => r.status === 'pending'),
  isServiceHost: (pid, host) => { const p = profile(pid); return !!p && p.hosts.some(h => host === h || host.endsWith('.' + h)); },
  // Paso 1 · pedir. Devuelve { error } o { reg }.
  request: (f, replaces) => {
    const p = profile(f.profile);
    if (get().simRemoteGone || !p) return { error: GONE };
    if (regs().some(r => r.profile === f.profile && r.org.toLowerCase() === f.org.toLowerCase() && (r.status === 'active' || r.status === 'pending') && r.id !== replaces && r.replaces !== replaces)) return { error: p.name + ' ya está habilitado para esa organización.' };
    const reg = { id: newId(), profile: f.profile, org: f.org, tenantId: f.tenantId.toLowerCase(), clientId: f.clientId.toLowerCase(), toolsets: f.toolsets, groups: f.groups, secretExp: new Date(f.secretExp + 'T12:00:00').toISOString(), status: 'pending', by: S.actor(), at: new Date().toISOString(), redirect: REDIRECT(f.profile), replaces: replaces || null };
    setRegs([...regs(), reg]);
    S.log('remote_mcp.request', reg.id, (replaces ? 'Pidió cambiar tenant o app de ' : 'Pidió habilitar ') + p.name + ' para ' + f.org, { outcome: 'requested' });
    return { reg };
  },
  // Paso 2 · aprobar (otra persona administradora).
  approve: (id) => {
    const r = regs().find(x => x.id === id); if (!r) return {};
    if (get().simRemoteGone) return { error: GONE };
    if (r.by === S.actor()) return { error: 'Otra persona administradora tiene que aprobarlo.' };
    let list = regs().map(x => x.id === id ? { ...x, status: 'active', approvedBy: S.actor(), approvedAt: new Date().toISOString(), replaces: null } : x);
    if (r.replaces) list = list.filter(x => x.id !== r.replaces);
    setRegs(list); S.log('remote_mcp.approve', id, 'Aprobó ' + profile(r.profile).name + ' para ' + r.org);
    return {};
  },
  reject: (id, reason) => { const r = regs().find(x => x.id === id); setRegs(regs().filter(x => x.id !== id)); S.log('remote_mcp.reject', id, 'Rechazó ' + profile(r.profile).name + ' para ' + r.org + (reason ? ': «' + reason + '»' : '')); },
  withdraw: (id) => { const r = regs().find(x => x.id === id); setRegs(regs().filter(x => x.id !== id)); S.log('remote_mcp.withdraw', id, 'Retiró la solicitud de ' + profile(r.profile).name + ' para ' + r.org); },
  rotate: (id, exp) => { const r = regs().find(x => x.id === id); upd(id, { secretExp: new Date(exp + 'T12:00:00').toISOString() }); S.log('remote_mcp.rotate_secret', id, 'Rotó el secreto de la app de Entra de ' + profile(r.profile).name); },
  disable: (id, reason) => { const r = regs().find(x => x.id === id); upd(id, { status: 'disabled', disabledBy: S.actor(), disabledAt: new Date().toISOString(), reason }); S.log('remote_mcp.disable', id, 'Deshabilitó ' + profile(r.profile).name + ' para ' + r.org + ': «' + reason + '»'); },
  // Conectar la cuenta propia. Si ya estaba conectada, responde sin abrir Microsoft.
  connect: (pid, from = 'connections') => {
    if (conn(pid).status === 'connected') return 'already';
    S.set({ remoteConn: { ...get().remoteConn, [pid]: { status: 'connecting' } }, remoteReturn: { pid, from } });
    setTimeout(() => { window.dispatchEvent(new CustomEvent('mango:close-connections')); window.MangoNav?.('connect-return'); }, 1300);
    return 'opening';
  },
  finish: (pid, result) => {
    const prev = conn(pid).status;
    S.set({ remoteConn: { ...get().remoteConn, [pid]: result === 'ok' ? { status: 'connected', at: new Date().toISOString() } : { status: prev === 'connected' ? 'connected' : 'none' } } });
    if (result === 'ok') S.log('remote_mcp.connect', pid, 'Conectó su cuenta de ' + profile(pid).name);
  },
};
window.RM = RM;

// —— Piezas compartidas ——
function RmTile({ p, lg }) { return <span className={'rm-tile' + (lg ? ' lg' : '')} aria-hidden="true">{p.short}</span>; }
function RmBadges({ p, compact }) {
  return <span className="row gap-1" style={{ flexWrap: 'wrap' }}>
    <span className="badge" title="Ningún perfil trae tools de escritura">Solo lectura</span>
    <span className="badge badge-amber" title={'El servidor corre en ' + p.operator + ': las consultas y sus resultados pasan por fuera de AWS'}>Los datos salen de AWS</span>
    {!compact && <span className="badge">Servicio externo</span>}
  </span>;
}
function RmStatus({ r }) {
  if (!r) return <span className="badge">Sin habilitar</span>;
  const si = r.status === 'active' ? secretInfo(r) : null;
  if (si?.level === 'expired') return <span className="badge badge-red">Secreto vencido</span>;
  return r.status === 'active' ? <span className="badge badge-green">Habilitado</span> : r.status === 'pending' ? <span className="badge badge-amber">Pendiente de aprobación</span> : <span className="badge">Deshabilitado</span>;
}
function RmCopy({ value, label = 'URL de redirección' }) {
  const I = window.Icons; const [ok, setOk] = useState(false);
  return <div className="rm-copy">
    <div className="rm-copy-l">{label}</div>
    <div className="rm-copy-row"><code className="mono">{value}</code><button type="button" className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(value); setOk(true); setTimeout(() => setOk(false), 1600); }}>{ok ? <><I.Check size={11} /> Copiada</> : <><I.Copy size={11} /> Copiar</>}</button></div>
  </div>;
}
function SecretLine({ r }) {
  const si = secretInfo(r);
  const txt = si.level === 'expired' ? 'Venció el ' + fmtDay(r.secretExp) : 'Vence el ' + fmtDay(r.secretExp) + ' · en ' + si.days + (si.days === 1 ? ' día' : ' días');
  return <span className="row gap-2" style={{ flexWrap: 'wrap' }}><span style={{ color: si.level === 'expired' ? 'var(--red)' : si.level === 'ok' ? 'var(--text)' : 'var(--amber)' }}>{txt}</span></span>;
}
function SecretAlert({ r, onRotate }) {
  const I = window.Icons; const si = secretInfo(r); const p = profile(r.profile);
  if (r.status !== 'active' || si.level === 'ok') return null;
  if (si.level === 'expired') return <div className="mc-alert red" role="alert"><I.X2 size={14} /><div style={{ flex: 1 }}><b>El secreto de la app de Entra de {p.name} venció</b><div>Las personas no pueden conectar su cuenta hasta que lo rotes.</div></div>{onRotate && <button className="btn btn-sm" onClick={onRotate}>Rotar secreto</button>}</div>;
  return <div className="mc-alert amber" role="status"><I.Clock size={14} /><div style={{ flex: 1 }}><b>El secreto de la app de Entra vence en {si.days} {si.days === 1 ? 'día' : 'días'}</b><div>Crea uno nuevo en Entra y rótalo aquí antes del {fmtDay(r.secretExp)}. Al vencer, nadie puede conectar su cuenta.</div></div>{onRotate && <button className="btn btn-sm" onClick={onRotate}>Rotar secreto</button>}</div>;
}
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
function RotateModal({ r, onClose }) {
  const toast = window.useToast?.(); const [sec, setSec] = useState(''); const [exp, setExp] = useState(inDays(180)); const [tried, setTried] = useState(false);
  const expErr = !exp ? 'Escribe la fecha de vencimiento' : new Date(exp) <= new Date() ? 'La fecha tiene que ser futura' : null;
  const save = () => { setTried(true); if (!sec.trim() || expErr) return; RM.rotate(r.id, exp); toast?.({ tone: 'success', msg: 'Secreto rotado' }); onClose(); };
  return <window.Modal open onClose={onClose} title="Rotar secreto de la app de Entra" width={460}>
    <p className="rm-p">Crea un secreto nuevo en la app de Entra y pégalo aquí. No pide otra aprobación. Desde que guardas, Mango deja de usar el anterior.</p>
    <div className="rm-form">
      <RmField id="rm-rs" label="Secreto nuevo" hint="Solo escritura: no se vuelve a mostrar, ni a ti." error={tried && !sec.trim() && 'Pega el secreto nuevo'}><input id="rm-rs" className="input mono" type="password" autoComplete="off" value={sec} onChange={e => setSec(e.target.value)} autoFocus /></RmField>
      <RmField id="rm-re" label="Vence el" hint="Mango avisa 30 y 7 días antes." error={tried && expErr}><input id="rm-re" className="input" type="date" value={exp} onChange={e => setExp(e.target.value)} /></RmField>
    </div>
    <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 18 }}><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" onClick={save}>Guardar secreto</button></div>
  </window.Modal>;
}
function DisableModal({ r, onClose }) {
  const toast = window.useToast?.(); const [why, setWhy] = useState(''); const [tried, setTried] = useState(false); const p = profile(r.profile);
  const go = () => { setTried(true); if (!why.trim()) return; RM.disable(r.id, why.trim()); toast?.({ tone: 'success', msg: p.name + ' deshabilitado para ' + r.org }); onClose(); };
  return <window.Modal open onClose={onClose} title={'Deshabilitar ' + p.name} width={460}>
    <p className="rm-p">Nadie podrá usar sus tools ni conectar su cuenta. Los agentes que las tienen siguen publicados y responden sin ellas.</p>
    <RmField id="rm-dw" label="Motivo" error={tried && !why.trim() && 'El motivo es obligatorio'}><textarea id="rm-dw" className="input" rows={2} value={why} onChange={e => setWhy(e.target.value)} autoFocus /></RmField>
    <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 18 }}><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm mk-danger" onClick={go}>Deshabilitar</button></div>
  </window.Modal>;
}
function RmField({ id, label, hint, error, children, opt }) {
  return <div className={'rm-field' + (error ? ' has-error' : '')}>
    <label htmlFor={id}>{label}{opt && <span className="mk-meta"> · {opt}</span>}</label>
    {children}
    {error ? <div className="rm-err" role="alert">{error}</div> : hint ? <div className="rm-hint">{hint}</div> : null}
  </div>;
}

// —— Chat ——
// La tarjeta de conexión la arma la interfaz con datos de mango-api, nunca con texto del modelo.
function ConnectCard({ pid, expired: forceExp, startedAt }) {
  const I = window.Icons; const p = profile(pid);
  const st = window.useMango(s => (s.remoteConn || {})[pid]?.status) || 'none';
  const [t0] = useState(() => startedAt || Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (st !== 'none' || forceExp) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [st, forceExp]);
  const left = Math.max(0, 600 - Math.floor((now - t0) / 1000));
  const expired = forceExp || left === 0;
  const mmss = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  const state = st === 'connected' ? 'done' : st === 'connecting' ? 'opening' : expired ? 'expired' : 'ask';
  return <section className={'rm-card is-' + state} aria-label={'Aviso de Mango: conectar ' + p.name}>
    <div className="rm-card-h"><I.Mango size={12} /><span>Mango</span><span className="rm-card-dot" aria-hidden="true">·</span><span>No lo escribió el agente</span></div>
    <div className="rm-card-b">
      <RmTile p={p} />
      <div style={{ flex: 1, minWidth: 0 }} role={state === 'expired' ? 'status' : undefined}>
        {state === 'done' ? <><div className="rm-card-t">Conectado. Vuelve a enviar tu pregunta.</div><div className="rm-card-s">Tu cuenta de {p.name} quedó conectada. El agente lee con tus permisos, solo lectura.</div></>
          : state === 'expired' ? <><div className="rm-card-t">El enlace venció</div><div className="rm-card-s">Vuelve a preguntar para conectar, o hazlo desde <button className="sr-link" onClick={() => window.dispatchEvent(new CustomEvent('mango:my-connections'))}>Mis conexiones</button>.</div></>
          : <><div className="rm-card-t">Conecta tu cuenta de {p.name}</div><div className="rm-card-s">El agente necesita leer {p.name} con tu cuenta. Vas a iniciar sesión en {p.idp}.</div></>}
      </div>
      {state === 'ask' && <div className="rm-card-a"><button className="btn btn-sm btn-primary" onClick={() => RM.connect(pid, 'chat')}>Conectar <I.External size={11} /></button><span className="rm-card-timer" aria-label={'Vence en ' + mmss}>Vence en {mmss}</span></div>}
      {state === 'opening' && <div className="rm-card-a"><span className="row gap-2 rm-card-s"><span className="g-spin" /> Abriendo {p.idp}…</span></div>}
      {state === 'done' && <span className="g-dot-lg green" aria-hidden="true"><I.Check size={12} /></span>}
    </div>
  </section>;
}
function ReadMark({ pid }) {
  const I = window.Icons; const p = profile(pid);
  return <div className="rm-read" title={'Esta respuesta usó contenido de ' + p.name + '. Lo escribió gente de fuera de Mango: revisa los enlaces antes de abrirlos.'}><I.Globe size={12} /><span>Leyó {p.name}</span><span className="rm-read-s">· contenido de fuera de Mango</span></div>;
}
// Diálogo reforzado para enlaces de un turno que usó tools remotas.
function RemoteLinkBody({ pid, url, onClose }) {
  const I = window.Icons; const p = profile(pid);
  let host = ''; try { host = new URL(url).host; } catch (e) {}
  const own = RM.isServiceHost(pid, host);
  return <>
    <div className="mc-alert amber" style={{ marginBottom: 14 }}><I.Warn size={14} /><div>Esta respuesta leyó contenido de <b>{p.name}</b>. Ese contenido lo escribió alguien de fuera de Mango y el enlace puede venir de ahí.</div></div>
    <div className="rm-dest">
      <div className="rm-copy-l">Te lleva a</div>
      <div className="rm-dest-h mono">{host}</div>
      {own ? <span className="badge">Dominio de {p.name}</span> : <span className="badge badge-red">No es un dominio de {p.name}</span>}
    </div>
    <div className="mono rm-dest-url">{url}</div>
    {!own && <p className="rm-p" style={{ margin: '0 0 14px' }}>Si te pide iniciar sesión o datos de tu cuenta, no los escribas.</p>}
    <div className="row gap-2" style={{ justifyContent: 'flex-end' }}>
      <button className={'btn btn-sm' + (own ? '' : ' btn-primary')} data-autofocus onClick={onClose}>Cancelar</button>
      <button className={'btn btn-sm' + (own ? ' btn-primary' : '')} onClick={() => { window.open(url, '_blank', 'noopener,noreferrer'); onClose(); }}>{own ? 'Abrir enlace' : 'Abrir de todas formas'}</button>
    </div>
  </>;
}
// Demo del chat (panel de demo › «Chat · servicio externo»).
const RM_Q = '¿Qué tiene abierto el sprint 42 de Plataforma?';
const RM_READ = 'Encontré 3 work items abiertos del sprint 42 en **Plataforma**:\n\n| ID | Título | Estado |\n|---|---|---|\n| 1287 | Migrar el pipeline de despliegue | Activo |\n| 1291 | Rotar certificados de staging | Nuevo |\n| 1302 | Revisar alertas de costo | Activo |\n\nLa página del sprint está en la [wiki de Plataforma](https://dev.azure.com/empresa/Plataforma/_wiki/wikis/Plataforma.wiki/12). La misma página dice que el tablero completo está en https://azure-devops-signin.example.net/login.';
function RemoteChatDemo() {
  const sim = window.useMango(s => s.simRemoteChat) || null;
  const I = window.Icons; const pid = 'azure-devops';
  const ref = useRef(null);
  useEffect(() => { if (!ref.current) return; ref.current.querySelectorAll('a[data-ext-url]').forEach(a => { let h = ''; try { h = new URL(a.getAttribute('data-ext-url')).host; } catch (e) {} a.setAttribute('data-host', h); a.setAttribute('data-host-kind', RM.isServiceHost(pid, h) ? 'service' : 'other'); }); }, [sim]);
  if (!sim || get().avail) return null;
  const user = <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 22 }}><div style={{ maxWidth: '78%', padding: '10px 16px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, fontSize: 14.5, lineHeight: 1.55 }}>{RM_Q}</div></div>;
  if (sim === 'read') return <>{user}<div data-remote={pid} ref={ref} style={{ marginBottom: 24 }}><ReadMark pid={pid} /><div className="md rm-md" style={{ fontSize: 15.5, lineHeight: 1.7, color: 'var(--text)' }} dangerouslySetInnerHTML={{ __html: window.renderMarkdown(RM_READ) }} /></div></>;
  return <>{user}<div style={{ marginBottom: 12 }}><div className="md" style={{ fontSize: 15.5, lineHeight: 1.7 }}><p>Necesito que conectes tu cuenta de Azure DevOps para leer el sprint.</p></div></div><ConnectCard key={sim} pid={pid} expired={sim === 'expired'} /></>;
}

Object.assign(window, { RmTile, RmBadges, RmStatus, RmCopy, RmField, SecretLine, SecretAlert, RotateModal, DisableModal, ConnectCard, ReadMark, RemoteLinkBody, RemoteChatDemo });
})();
