// MCP remotos de terceros (D93/D94) · piloto Azure DevOps. Datos, acciones y piezas compartidas.
// Solo en «Diseño completo»: en «Disponible hoy» siguen en Próximamente.
(() => {
const { useState, useEffect, useRef } = React;
const S = window.MangoStore;
const DAY = 864e5;
const PROFILES = [{
  id: 'azure-devops', name: 'Azure DevOps', short: 'AD', operator: 'Microsoft', idp: 'Microsoft', host: 'dev.azure.com', hosts: ['dev.azure.com', 'visualstudio.com'], version: '1.0',
  // Grupos de tools, nombres y permisos salen del perfil del servicio: aquí son un ejemplo. El perfil no trae descripción ni requisitos.
  toolsets: [
    { id: 'core', label: 'Proyectos', tools: ['core_project'] },
    { id: 'work-items', label: 'Work items', tools: ['wit_work_item', 'wit_query'] },
    { id: 'wiki', label: 'Wiki', tools: ['wiki', 'search_wiki'] },
    { id: 'pipelines', label: 'Pipelines', tools: ['pipelines_build'] },
    { id: 'code-search', label: 'Búsqueda de código', tools: ['search_code'], requirement: 'Necesita la extensión Code Search de Microsoft instalada en la organización. Sin ella, la búsqueda no encuentra nada y el agente responde que no hubo resultados.' },
    { id: 'repos', label: 'Repositorios', tools: ['repo_list_repos', 'repo_list_branches', 'repo_get_file', 'repo_list_commits', 'repo_list_pull_requests', 'repo_list_pr_threads'], sensitivity: 'source_code', note: 'El agente lee archivos, commits y pull requests de los repositorios a los que llega la cuenta de cada persona.' },
  ],
  // Pares de recurso y permiso, como los trae el perfil. El tipo (delegado, lectura) viene dentro del permiso.
  scopes: [{ res: 'Azure DevOps MCP', perms: ['.default (delegado, lectura)'] }, { res: 'Microsoft Entra', perms: ['offline_access'] }],
}];
// La URL de callback la da AWS al crear la conexión de cada registro. No es una dirección de Mango.
const REDIRECT = (uuid) => 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/' + (uuid || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '6b1f0c2e-4d7a-4e19-9c3b-' + Math.random().toString(16).slice(2, 14)));
const SECRET_DAYS = { ok: 120, d30: 21, d7: 5, expired: -2 };
const iso = (ms) => new Date(Date.now() + ms).toISOString();

function seedRegs(kind = 'active', secret = 'd30') {
  const hist = [{ id: 'RMT-1c9e0b44', profile: 'azure-devops', org: 'empresa-labs', tenantId: '7c1e2a40-5b6d-4e8f-9a01-23456789abcd', clientId: '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', toolsets: ['work-items', 'wiki'], groups: ['mango-agent-creator'], status: 'rejected', by: 'Usuario 1', at: iso(-26 * DAY), decidedBy: 'Usuario 6', decidedAt: iso(-25 * DAY), reason: 'La app de Entra pedía permisos de escritura en Azure DevOps' }, { id: 'RMT-5d2f8a71', profile: 'azure-devops', org: 'empresa', tenantId: '7c1e2a40-5b6d-4e8f-9a01-23456789abcd', clientId: '3b9d0c12-8e4f-4a6b-b7c8-0d1e2f3a4b5c', toolsets: ['work-items'], groups: ['finops-central'], status: 'withdrawn', by: 'Usuario 6', at: iso(-22 * DAY), decidedBy: 'Usuario 6', decidedAt: iso(-22 * DAY) }];
  if (kind === 'none') return [];
  const base = { id: 'RMT-7f3a2c10', profile: 'azure-devops', org: 'empresa', tenantId: '7c1e2a40-5b6d-4e8f-9a01-23456789abcd', clientId: '3b9d0c12-8e4f-4a6b-b7c8-0d1e2f3a4b5c', toolsets: ['core', 'work-items', 'wiki', 'code-search'], groups: ['finops-central', 'mango-agent-creator'], secretExp: iso(SECRET_DAYS[secret] * DAY), redirect: REDIRECT('5f2c8e1a-9b3d-4c7e-a1f0-2d6e8b4c0a97') };
  if (kind === 'pending-other') return [...hist, { ...base, status: 'pending', by: 'Usuario 6', at: iso(-3 * 36e5) }];
  if (kind === 'pending-mine') return [...hist, { ...base, status: 'pending', by: 'Usuario 1', at: iso(-3 * 36e5) }];
  if (kind === 'creating') return [...hist, { ...base, status: 'creating', by: 'Usuario 6', at: iso(-1 * 36e5), approvedBy: 'Usuario 1', approvedAt: iso(-6e4) }];
  if (kind === 'failed') return [...hist, { ...base, status: 'failed', failCode: S.get().simRemoteFail || 'target_timeout', by: 'Usuario 6', at: iso(-1 * 36e5), approvedBy: 'Usuario 1', approvedAt: iso(-5 * 6e4) }];
  if (kind === 'disabled') return [...hist, { ...base, status: 'disabled', secretExp: null, redirect: null, by: 'Usuario 6', at: iso(-20 * DAY), approvedBy: 'Usuario 1', disabledBy: 'Usuario 6', disabledAt: iso(-1 * DAY), reason: 'Pausa mientras se revisan los permisos de la app en Entra' }];
  const act = { ...base, status: 'active', by: 'Usuario 6', at: iso(-20 * DAY), approvedBy: 'Usuario 1', approvedAt: iso(-19 * DAY) };
  if (kind === 'scope-other' || kind === 'scope-mine') return [...hist, act, { id: 'RMT-a4e19c0b', kind: 'scope', changes: act.id, profile: act.profile, org: act.org, toolsets: [...act.toolsets, 'pipelines'], groups: ['finops-central', 'mango-agent-creator', 'bu-plataforma'], status: 'pending', by: kind === 'scope-mine' ? 'Usuario 1' : 'Usuario 6', at: iso(-2 * 36e5) }];
  return [...hist, { ...base, status: 'active', by: 'Usuario 6', at: iso(-20 * DAY), approvedBy: 'Usuario 1', approvedAt: iso(-19 * DAY) }];
}
if (!S.get().remoteRegs || S.get().remoteRegs.some(r => (r.toolsets || []).includes('repositories') || /api\.mango/.test(r.redirect || ''))) S.set({ remoteRegs: seedRegs(), remoteConn: { 'azure-devops': { status: 'none' } } });

const get = () => S.get();
const profile = (id) => PROFILES.find(p => p.id === id);
const regs = () => get().remoteRegs || [];
const myGroups = () => (S.ROLES[get().role] || { groups: [] }).groups;
const inMyGroups = (r) => r.groups.some(g => myGroups().includes(g));
const conn = (pid) => (get().remoteConn || {})[pid] || { status: 'none' };
const secretInfo = (r) => { if (!r.secretExp) return { days: 0, level: 'none' }; const d = Math.ceil((new Date(r.secretExp) - Date.now()) / DAY); return { days: d, level: d <= 0 ? 'expired' : d <= 7 ? 'd7' : d <= 30 ? 'd30' : 'ok' }; };
const fmtDay = (at) => new Date(at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
const toolsOf = (p, sets) => p.toolsets.filter(t => !sets || sets.includes(t.id));
const setRegs = (list) => S.set({ remoteRegs: list });
const upd = (id, patch) => setRegs(regs().map(r => r.id === id ? { ...r, ...patch } : r));
const newId = () => 'RMT-' + Math.random().toString(16).slice(2, 10);
const GONE = 'Este servicio ya no está en esta versión de Mango.';
const LIVE = ['active', 'pending', 'creating'];
const HIST = ['rejected', 'withdrawn'];
// Enlaces: solo una organización registrada en la instalación se presenta como del servicio.
// Solo cuentan las organizaciones de los servicios que esa persona puede usar, no todas las de la empresa.
function classifyLink(pid, url) {
  const p = profile(pid); let u; try { u = new URL(url); } catch (e) { return { kind: 'other', host: '', label: '' }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let org = null, label = host;
  if (host === 'dev.azure.com') { org = (u.pathname.split('/')[1] || '').toLowerCase() || null; label = org ? host + '/' + org : host; }
  else if (host.endsWith('.visualstudio.com')) org = host.split('.')[0];
  const svc = !!p && p.hosts.some(h => host === h || host.endsWith('.' + h));
  if (!svc) return { kind: 'other', host, label };
  const own = org && regs().some(r => r.profile === pid && r.status === 'active' && r.kind !== 'scope' && inMyGroups(r) && r.org.toLowerCase() === org);
  return { kind: own ? 'own' : 'other-org', host, org, label };
}

// Errores al pulsar «Conectar» (tarjeta del chat y del Playground, Mis conexiones).
const CONNECT_ERR = {
  error: () => ['No se pudo iniciar la conexión', 'Inténtalo de nuevo en unos segundos.'],
  identity_unavailable: (p) => ['El servicio de identidad no responde', 'Mango no pudo pedir el inicio de sesión en ' + p.idp + '. Inténtalo de nuevo en unos minutos.'],
  rate_limited: () => ['Demasiados intentos seguidos', 'Espera un minuto y vuelve a pulsar «Conectar».'],
  popup_blocked: (p) => ['El navegador bloqueó la pestaña de ' + p.idp, 'Permite las ventanas emergentes de Mango en este navegador y vuelve a pulsar «Conectar».'],
};
// Cuando la pestaña que pidió «Conectar» no pudo terminar la conexión (D100). Se ven en la tarjeta y en Mis conexiones.
const FINISH_ERR = {
  session_changed: (p) => ['No se pudo terminar la conexión', 'Tu sesión de Mango cambió mientras iniciabas sesión en ' + p.idp + '. Vuelve a pulsar «Conectar».'],
  denied: (p) => [p.idp + ' no autorizó la conexión', 'Tu cuenta no quedó conectada. Si no fuiste tú quien canceló, consulta con el administrador de ' + p.idp + ' de tu empresa.'],
  conditional: (p) => ['Una regla de acceso de tu empresa bloqueó la conexión', 'Consulta con el administrador de ' + p.idp + ' de tu empresa.'],
  error: () => ['No se pudo conectar tu cuenta', 'Inténtalo de nuevo en unos minutos.'],
};
// Resultado de la vuelta (panel de demo) → lo que ve la pestaña que pidió «Conectar».
const RET_TO_TAB = { ok: 'ok', expired: 'expired', cancelled: 'denied', denied: 'denied', conditional: 'conditional', orphan: 'session_changed', lost: 'session_changed', notyours: 'error', ambiguous: 'error', error: 'error' };
// Código de fallo del registro. El producto solo tiene códigos de plataforma: un dato de la app de Entra mal puesto se nota al conectar, no al crear.
const FAIL = {
  target_timeout: { kind: 'platform', t: (p) => 'No se pudo habilitar ' + p.name + ': el servicio no quedó listo a tiempo' },
  target_failed: { kind: 'platform', t: (p) => 'No se pudo habilitar ' + p.name + ': la plataforma no pudo crear el servicio' },
};
const FAIL_BODY = { platform: 'Fue un fallo de la plataforma, no de los datos de la app de Entra. Reinténtalo: no pide el secreto ni otra aprobación.', unknown: 'Reinténtalo. Si vuelve a fallar, revisa los datos de la app de Entra y pídelo de nuevo.' };
const failInfo = (r) => { const p = profile(r.profile); const f = FAIL[r.failCode]; return f ? { kind: f.kind, title: f.t(p), body: FAIL_BODY[f.kind], code: r.failCode } : { kind: 'unknown', title: 'No se pudo habilitar ' + p.name, body: FAIL_BODY.unknown, code: r.failCode || null }; };
// RemoteMcpEnabled: parámetro de la instalación, apagado por defecto. Cada perfil dice si está encendido.
const OFF_MSG = 'Los servicios externos están apagados en esta instalación. Los enciende quien administra AWS con un parámetro de la instalación.';
const installOn = () => !['off', 'off-late'].includes(get().simRemoteInstall) || false;
const profileSaysOn = () => get().simRemoteInstall !== 'off';
const resetConn = (pid) => S.set({ remoteConn: { ...get().remoteConn, [pid]: { status: 'none' } } });
const setConn = (pid, v) => S.set({ remoteConn: { ...get().remoteConn, [pid]: v } });
const RM = {
  PROFILES, CONNECT_ERR, FINISH_ERR, failInfo, OFF_MSG, enabled: profileSaysOn, profile, regs, myGroups, inMyGroups, conn, secretInfo, fmtDay, toolsOf, seedRegs, SECRET_DAYS,
  classifyLink, HIST,
  // Campos del perfil por toolset (sensitivity, note, requirement). Mango pone la insignia, el tono y el título según sensitivity; note y requirement se muestran tal cual.
  tsMeta: (t) => get().simRemoteNoTsFields ? {} : { sens: t.sensitivity === 'source_code' ? 'Código fuente' : null, note: t.note || null, req: t.requirement || null },
  target: (r) => r.kind === 'scope' ? regs().find(x => x.id === r.changes) : null,
  regsOf: (pid) => regs().filter(r => r.profile === pid && !HIST.includes(r.status)),
  histOf: (pid) => regs().filter(r => r.profile === pid && HIST.includes(r.status)).sort((a, b) => new Date(b.decidedAt || b.at) - new Date(a.decidedAt || a.at)),
  active: (pid) => regs().find(r => r.profile === pid && r.status === 'active'),
  mine: () => regs().filter(r => (r.status === 'active' || r.status === 'disabled') && inMyGroups(r)),
  pending: () => regs().filter(r => r.status === 'pending'),
  isServiceHost: (pid, host) => { const p = profile(pid); return !!p && p.hosts.some(h => host === h || host.endsWith('.' + h)); },
  // Paso 1 · pedir. Devuelve { error } o { reg }.
  request: (f, replaces) => {
    const p = profile(f.profile);
    if (!installOn()) return { error: OFF_MSG };
    if (get().simRemoteGone || !p) return { error: GONE };
    if (regs().some(r => r.profile === f.profile && r.org.toLowerCase() === f.org.toLowerCase() && LIVE.includes(r.status) && r.kind !== 'scope' && r.id !== replaces && r.replaces !== replaces)) return { error: p.name + ' ya está habilitado para esa organización.' };
    const reg = { id: newId(), profile: f.profile, org: f.org, tenantId: f.tenantId.toLowerCase(), clientId: f.clientId.toLowerCase(), toolsets: f.toolsets, groups: f.groups, secretExp: new Date(f.secretExp + 'T12:00:00').toISOString(), status: 'pending', by: S.actor(), at: new Date().toISOString(), redirect: REDIRECT(), replaces: replaces || null };
    setRegs([...regs(), reg]);
    S.log('remote_mcp.request', reg.id, (replaces ? 'Pidió cambiar tenant o app de ' : 'Pidió habilitar ') + p.name + ' para ' + f.org, { outcome: 'requested' });
    return { reg };
  },
  // Cambiar grupos de tools o de personas de un servicio activo: doble aprobación, nadie reconecta.
  requestScope: (regId, toolsets, groups) => {
    const t = regs().find(x => x.id === regId); const p = profile(t.profile);
    if (!installOn()) return { error: OFF_MSG };
    if (get().simRemoteGone || !p) return { error: GONE };
    const reg = { id: newId(), kind: 'scope', changes: regId, profile: t.profile, org: t.org, toolsets, groups, status: 'pending', by: S.actor(), at: new Date().toISOString() };
    setRegs([...regs(), reg]);
    S.log('remote_mcp.request', reg.id, 'Pidió cambiar los grupos de ' + p.name + ' para ' + t.org, { outcome: 'requested' });
    return { reg };
  },
  // Paso 2 · aprobar (otra persona administradora).
  approve: (id) => {
    const r = regs().find(x => x.id === id); if (!r) return {};
    if (!installOn()) return { error: OFF_MSG };
    if (get().simRemoteGone) return { error: GONE };
    if (r.by === S.actor()) return { error: 'Otra persona administradora tiene que aprobarlo.' };
    if (r.kind === 'scope') {
      setRegs(regs().filter(x => x.id !== id).map(x => x.id === r.changes ? { ...x, toolsets: r.toolsets, groups: r.groups } : x));
      S.log('remote_mcp.approve', id, 'Aprobó cambiar los grupos de ' + profile(r.profile).name + ' para ' + r.org);
      return { scope: true };
    }
    // «Creándose» unos segundos, hasta que la conexión existe; después «Habilitado» o «Falló».
    upd(id, { status: 'creating', approvedBy: S.actor(), approvedAt: new Date().toISOString() });
    S.log('remote_mcp.approve', id, 'Aprobó ' + profile(r.profile).name + ' para ' + r.org);
    RM._create(id, get().simRemoteCreate === 'fail');
    return {};
  },
  // Reintentar un registro en «Falló»: una sola persona administradora, la misma aprobación, nada cambia de lo aprobado.
  retry: (id) => {
    const r = regs().find(x => x.id === id); if (!r || r.status !== 'failed') return {};
    if (!installOn()) return { error: OFF_MSG };
    const sim = get().simRemoteRetry;
    if (sim === 'release_changed') return { error: 'release_changed' };
    if (sim === 'busy') return { error: 'busy' };
    upd(id, { status: 'creating' });
    S.log('remote_mcp.retry', id, 'Reintentó habilitar ' + profile(r.profile).name + ' para ' + r.org);
    RM._create(id, sim === 'fail');
    return {};
  },
  _create: (id, fail) => {
    const r = regs().find(x => x.id === id);
    setTimeout(() => {
      const cur = regs().find(x => x.id === id); if (!cur || cur.status !== 'creating') return;
      if (fail) { upd(id, { status: 'failed', failCode: get().simRemoteFail || cur.failCode || 'target_timeout' }); S.log('remote_mcp.create_failed', id, 'No se pudo habilitar ' + profile(r.profile).name + ' para ' + r.org, { outcome: 'failed' }); return; }
      let list = regs().map(x => x.id === id ? { ...x, status: 'active', replaces: null } : x);
      if (r.replaces) list = list.filter(x => x.id !== r.replaces);
      setRegs(list);
      if (r.replaces) resetConn(r.profile); // otro tenant o app: todas las personas conectan otra vez
    }, 2600);
  },
  // Rechazar y retirar borran lo que se creó (secreto incluido); queda la solicitud en el historial.
  reject: (id, reason) => { const r = regs().find(x => x.id === id); upd(id, { status: 'rejected', decidedBy: S.actor(), decidedAt: new Date().toISOString(), reason, secretExp: null, redirect: null }); S.log('remote_mcp.reject', id, 'Rechazó ' + profile(r.profile).name + ' para ' + r.org + (reason ? ': «' + reason + '»' : '')); },
  withdraw: (id) => { const r = regs().find(x => x.id === id); upd(id, { status: 'withdrawn', decidedBy: S.actor(), decidedAt: new Date().toISOString(), secretExp: null, redirect: null }); S.log('remote_mcp.withdraw', id, 'Retiró la solicitud de ' + profile(r.profile).name + ' para ' + r.org); },
  rotate: (id, exp) => { const r = regs().find(x => x.id === id); upd(id, { secretExp: new Date(exp + 'T12:00:00').toISOString() }); S.log('remote_mcp.rotate_secret', id, 'Rotó el secreto de la app de Entra de ' + profile(r.profile).name); },
  // Deshabilitar borra la conexión y el secreto. «Pedir de nuevo» pide el secreto otra vez.
  disable: (id, reason) => { const r = regs().find(x => x.id === id); upd(id, { status: 'disabled', disabledBy: S.actor(), disabledAt: new Date().toISOString(), reason, secretExp: null, redirect: null }); resetConn(r.profile); S.log('remote_mcp.disable', id, 'Deshabilitó ' + profile(r.profile).name + ' para ' + r.org + ': «' + reason + '»'); },
  // Conectar la cuenta propia. Si ya estaba conectada, responde sin abrir Microsoft.
  // D100: Microsoft se abre en otra pestaña; esta pestaña (la que pidió «Conectar») espera y es la que termina la conexión.
  // En la demo, la vuelta llega sola a los pocos segundos con el resultado de «Vuelta desde Microsoft».
  connect: (pid, from = 'connections') => {
    if (conn(pid).status === 'connected') return 'already';
    if (get().simRemoteConnectErr) return 'error:' + get().simRemoteConnectErr;
    if (conn(pid).server) { setConn(pid, { status: 'connected', at: conn(pid).at || new Date().toISOString() }); return 'already'; }
    setConn(pid, { status: 'connecting' }); S.set({ remoteReturn: { pid, from } });
    const still = (st) => conn(pid).status === st;
    setTimeout(() => { if (still('connecting')) setConn(pid, { status: 'waiting' }); }, 1300);
    setTimeout(() => {
      if (!still('waiting')) return;
      const out = RET_TO_TAB[get().simRemoteReturn || 'ok'] || 'error';
      if (out === 'expired') { setConn(pid, { status: 'none', err: 'expired' }); return; }
      setConn(pid, { status: 'finishing' });
      setTimeout(() => { if (still('finishing')) RM.finish(pid, out); }, 1100);
    }, 4200);
    return 'opening';
  },
  cancelWait: (pid) => resetConn(pid),
  // Desconectar: Mango borra la conexión de esa persona. No revoca nada en Microsoft.
  disconnect: (pid) => {
    if (get().simRemoteDisconnect === 'fail') return { error: 'disconnect_not_confirmed' };
    resetConn(pid); S.log('remote_mcp.disconnect', pid, 'Desconectó su cuenta de ' + profile(pid).name);
    return {};
  },
  finish: (pid, result) => {
    setConn(pid, result === 'ok' ? { status: 'connected', at: new Date().toISOString(), justNow: true } : { status: 'none', err: result });
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
  if (r.status === 'creating') return <span className="badge badge-blue"><span className="g-spin" style={{ width: 9, height: 9, marginRight: 5 }} />Creándose</span>;
  if (r.status === 'failed') return <span className="badge badge-red">Falló</span>;
  if (r.status === 'rejected') return <span className="badge badge-red">Rechazada</span>;
  if (r.status === 'withdrawn') return <span className="badge">Retirada</span>;
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
  if (!r.secretExp) return <span className="mk-meta">Borrado al deshabilitar</span>;
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
    <p className="rm-p">Mango borra la conexión con {p.name} y el secreto de la app de Entra. Nadie podrá usar sus tools ni conectar su cuenta, y quienes ya la conectaron pierden la conexión. Los agentes que las tienen siguen publicados y responden sin ellas.</p>
    <p className="rm-p">Para volver a habilitarlo hay que pedirlo de nuevo, con el secreto, y otra persona administradora tiene que aprobarlo.</p>
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
// resent: ya se envió de nuevo en esta pantalla, o la conversación tiene una pregunta posterior (sobrevive a recargar). busy: otro turno responde.
function ConnectCard({ pid, expired: forceExp, startedAt, onResend, resent, busy }) {
  window.useMango(s => s.simRemoteInstall);
  const I = window.Icons; const p = profile(pid);
  const st = window.useMango(s => (s.remoteConn || {})[pid]?.status) || 'none';
  const connErr = window.useMango(s => (s.remoteConn || {})[pid]?.err) || null;
  const [t0] = useState(() => startedAt || Date.now());
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState(null);
  useEffect(() => { if (!['none', 'waiting'].includes(st) || forceExp) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [st, forceExp]);
  const left = Math.max(0, 600 - Math.floor((now - t0) / 1000));
  const expired = forceExp || left === 0 || connErr === 'expired';
  const mmss = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  const fe = connErr && connErr !== 'expired' ? (FINISH_ERR[connErr] || FINISH_ERR.error)(p) : null;
  const state = !RM.enabled() ? 'off' : st === 'connected' ? 'done' : st === 'connecting' ? 'opening' : st === 'waiting' ? 'waiting' : st === 'finishing' ? 'finishing' : expired ? 'expired' : (err || fe) ? 'error' : 'ask';
  const go = () => { const r = RM.connect(pid, 'chat'); setErr(typeof r === 'string' && r.startsWith('error:') ? r.slice(6) : null); };
  const ce = err ? (CONNECT_ERR[err] || CONNECT_ERR.error)(p) : fe;
  return <section className={'rm-card is-' + state} aria-label={'Aviso de Mango: conectar ' + p.name}>
    <div className="rm-card-h"><I.Mango size={12} /><span>Mango</span><span className="rm-card-dot" aria-hidden="true">·</span><span>No lo escribió el agente</span></div>
    <div className="rm-card-b">
      <RmTile p={p} />
      <div style={{ flex: 1, minWidth: 0 }} role={state === 'error' ? 'alert' : state === 'ask' ? undefined : 'status'}>
        {state === 'done' ? <><div className="rm-card-t">Conectado</div><div className="rm-card-s">Tu cuenta de {p.name} quedó conectada. {resent ? 'Enviaste tu pregunta otra vez.' : 'Envía tu pregunta otra vez para que el agente lea ' + p.name + '.'}</div>{busy && !resent && onResend && <div className="rm-card-s" style={{ marginTop: 4 }}>Podrás enviarla cuando termine la respuesta en curso.</div>}</>
          : state === 'off' ? <><div className="rm-card-t">Los servicios externos están apagados</div><div className="rm-card-s">Esta instalación de Mango tiene apagados los servicios externos, así que el agente no puede leer {p.name}. Si lo necesitas, avisa a un administrador de Mango.</div></>
          : state === 'waiting' ? <><div className="rm-card-t">Inicia sesión en {p.idp} en la otra pestaña</div><div className="rm-card-s">Al terminar, la conexión se completa aquí. No cierres esta pestaña.</div></>
          : state === 'finishing' ? <><div className="rm-card-t">Terminando la conexión…</div><div className="rm-card-s">Mango está guardando tu conexión con {p.name}.</div></>
          : state === 'error' ? <><div className="rm-card-t">{ce[0]}</div><div className="rm-card-s">{ce[1]}</div></>
          : state === 'expired' ? <><div className="rm-card-t">El enlace venció</div><div className="rm-card-s">Vuelve a preguntar para conectar, o hazlo desde <button className="sr-link" onClick={() => window.dispatchEvent(new CustomEvent('mango:my-connections'))}>Mis conexiones</button>.</div></>
          : <><div className="rm-card-t">Conecta tu cuenta de {p.name}</div><div className="rm-card-s">El agente necesita leer {p.name} con tu cuenta. Vas a iniciar sesión en {p.idp}.</div></>}
      </div>
      {(state === 'ask' || state === 'error') && <div className="rm-card-a"><button className={'btn btn-sm' + (state === 'ask' ? ' btn-primary' : '')} onClick={go}>{state === 'error' ? 'Reintentar' : <>Conectar <I.External size={11} /></>}</button><span className="rm-card-timer" aria-label={'Vence en ' + mmss}>Vence en {mmss}</span></div>}
      {state === 'opening' && <div className="rm-card-a"><span className="row gap-2 rm-card-s"><span className="g-spin" /> Abriendo {p.idp}…</span></div>}
      {state === 'waiting' && <div className="rm-card-a"><button className="btn btn-sm" onClick={() => { RM.cancelWait(pid); go(); }} title={'Si cerraste la pestaña de ' + p.idp}>Abrir de nuevo <I.External size={11} /></button><span className="rm-card-timer" aria-label={'Vence en ' + mmss}>Vence en {mmss}</span></div>}
      {state === 'finishing' && <div className="rm-card-a"><span className="g-spin" /></div>}
      {state === 'done' && (onResend && !resent ? <div className="rm-card-a"><button className="btn btn-sm btn-primary" disabled={busy} onClick={onResend}>Enviar de nuevo</button></div> : <span className="g-dot-lg green" aria-hidden="true"><I.Check size={12} /></span>)}
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
  const k = classifyLink(pid, url); const own = k.kind === 'own';
  return <>
    <div className="mc-alert amber" style={{ marginBottom: 14 }}><I.Warn size={14} /><div>Esta respuesta leyó contenido de <b>{p.name}</b>. Ese contenido lo escribió alguien de fuera de Mango y el enlace puede venir de ahí.</div></div>
    <div className="rm-dest">
      <div className="rm-copy-l">Te lleva a</div>
      <div className="rm-dest-h mono">{k.label || k.host}</div>
      {own ? <span className="rm-dest-n">Tu organización de {p.name} ({k.org}). Mango solo comprueba la dirección, no lo que hay en la página.</span>
        : k.kind === 'other-org' ? <><span className="badge badge-red">Otra organización</span><span className="rm-dest-n">{k.org ? <><span className="mono">{k.org}</span> está</> : 'Está'} en {p.name}, pero no es una organización que puedas usar en Mango.</span></>
        : <><span className="badge badge-red">Otro dominio</span><span className="rm-dest-n">No es un dominio de {p.name}.</span></>}
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
const RM_READ = 'Encontré 3 work items abiertos del sprint 42 en **Plataforma**:\n\n| ID | Título | Estado |\n|---|---|---|\n| 1287 | Migrar el pipeline de despliegue | Activo |\n| 1291 | Rotar certificados de staging | Nuevo |\n| 1302 | Revisar alertas de costo | Activo |\n\nLa página del sprint está en la [wiki de Plataforma](https://dev.azure.com/empresa/Plataforma/_wiki/wikis/Plataforma.wiki/12). La misma página dice que el tablero completo está en https://dev.azure.com/plataforma-tableros/_signin y que, si no carga, entres por https://azure-devops-signin.example.net/login.';
const RM_ASK = 'Necesito que conectes tu cuenta de Azure DevOps para leer el sprint.';
const RM_ASK_LINK = RM_ASK + ' Autoriza el acceso aquí: [Autorizar Azure DevOps](https://azdevops-authorize.example.com/oauth/consent).';
// En un turno con la tarjeta «Conectar», los enlaces del agente que no son de una organización registrada no se pueden abrir:
// el agente nunca recibe la URL real para conectar, así que un enlace para «autorizar» siempre es inventado o viene del contenido.
// Mientras no se leyó Mis conexiones no se sabe qué organizaciones son de la persona: ningún enlace se abre, pero no se marca nada.
function StripLinks({ pid, md, loading, failed }) {
  const ref = useRef(null); const [n, setN] = useState(0);
  useEffect(() => { if (!ref.current) return; let c = 0; ref.current.querySelectorAll('a').forEach(a => { const u = a.getAttribute('data-ext-url') || a.getAttribute('href'); if (loading || failed) { const s = document.createElement('span'); s.className = 'rm-linkwait'; s.textContent = a.textContent; a.replaceWith(s); return; } if (classifyLink(pid, u).kind === 'own') return; const s = document.createElement('span'); s.className = 'rm-nolink'; s.textContent = a.textContent; s.title = 'Enlace quitado por Mango · ' + (classifyLink(pid, u).label || u); a.replaceWith(s); c++; }); setN(c); }, [md, loading, failed]);
  return <div style={{ marginBottom: 12 }}><div ref={ref} className="md" style={{ fontSize: 15.5, lineHeight: 1.7 }} key={loading || failed ? 'w' : 'k'} dangerouslySetInnerHTML={{ __html: window.renderMarkdown(md) }} />{failed && <div className="rm-nolink-note"><window.Icons.Shield size={12} /><span>Mango no pudo comprobar los enlaces del agente, así que no se pueden abrir. <button className="sr-link" onClick={() => S.set({ simRemoteTurn: null })}>Volver a comprobar</button></span></div>}{n > 0 && !loading && !failed && <div className="rm-nolink-note"><window.Icons.Shield size={12} /><span>Mango desactivó {n === 1 ? 'un enlace' : n + ' enlaces'} del agente. Para conectar tu cuenta usa solo «Conectar», en el aviso de Mango.</span></div>}</div>;
}
function RemoteChatDemo() {
  const sim = window.useMango(s => s.simRemoteChat) || null;
  const I = window.Icons; const pid = 'azure-devops';
  const ref = useRef(null); const [resent, setResent] = useState(false);
  const turn = window.useMango(s => s.simRemoteTurn) || null;
  useEffect(() => setResent(turn === 'later'), [sim, turn]);
  useEffect(() => { if (!ref.current) return; ref.current.querySelectorAll('a[data-ext-url]').forEach(a => { const k = classifyLink(pid, a.getAttribute('data-ext-url')); a.setAttribute('data-host', k.label); a.setAttribute('data-host-kind', k.kind === 'own' ? 'service' : 'other'); }); }, [sim]);
  if (!sim || get().avail) return null;
  const user = <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 22 }}><div style={{ maxWidth: '78%', padding: '10px 16px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, fontSize: 14.5, lineHeight: 1.55 }}>{RM_Q}</div></div>;
  if (sim === 'read') return <>{user}<div data-remote={pid} ref={ref} style={{ marginBottom: 24 }}><ReadMark pid={pid} /><div className="md rm-md" style={{ fontSize: 15.5, lineHeight: 1.7, color: 'var(--text)' }} dangerouslySetInnerHTML={{ __html: window.renderMarkdown(RM_READ) }} /></div></>;
  return <>{user}<StripLinks pid={pid} loading={turn === 'loading'} failed={turn === 'connfail'} md={sim === 'consent-link' ? RM_ASK_LINK : RM_ASK} /><ConnectCard key={sim} pid={pid} expired={sim === 'expired'} resent={resent} busy={turn === 'busy'} onResend={() => setResent(true)} />{resent && turn !== 'later' && <RemoteChatContinue pid={pid} user={user} />}</>;
}
// El turno terminó al faltar la conexión: «Enviar de nuevo» manda la misma pregunta como un turno nuevo.
function RemoteChatContinue({ pid, user }) {
  return <div data-remote={pid} style={{ margin: '22px 0 24px' }}>{user}<ReadMark pid={pid} /><div className="md rm-md" style={{ fontSize: 15.5, lineHeight: 1.7, color: 'var(--text)' }} dangerouslySetInnerHTML={{ __html: window.renderMarkdown(RM_READ.split('\n\nLa página')[0]) }} /></div>;
}

Object.assign(window, { RmTile, RmBadges, RmStatus, RmCopy, RmField, SecretLine, SecretAlert, RotateModal, DisableModal, ConnectCard, ReadMark, RemoteLinkBody, RemoteChatDemo });
})();
