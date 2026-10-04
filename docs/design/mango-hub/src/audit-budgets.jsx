// Audit log + Budgets & alerts
const { useState: useStateAB, useMemo: useMemoAB, useEffect } = React;

const AUDIT_ACTIONS = {
  'agent.create': 'Agente creado', 'agent.update': 'Agente editado', 'agent.clone': 'Agente duplicado', 'agent.rollback': 'Versión restaurada', 'agent.archive': 'Agente archivado', 'agent.restore': 'Agente restaurado', 'agent.delete': 'Agente eliminado', 'agent.share': 'Acceso a agente cambiado',
  'agent.draft': 'Borrador guardado', 'agent.submit': 'Enviado a aprobación', 'agent.approve': 'Agente aprobado', 'agent.reject': 'Agente rechazado', 'agent.publish': 'Agente publicado', 'agent.retry': 'Publicación reintentada', 'agent.reopen': 'Reabierto como borrador', 'agent.publish_start': 'Publicación iniciada', 'agent.publish_failed': 'Publicación fallida', 'directory.lookup': 'Búsqueda en el directorio', 'directory.signup': 'Persona registrada', 'directory.list': 'Lectura del directorio', 'directory.invite': 'Persona invitada', 'directory.group_add': 'Grupo asignado a persona', 'directory.group_remove': 'Grupo quitado a persona', 'directory.disable': 'Acceso deshabilitado', 'directory.enable': 'Acceso rehabilitado', 'directory.member_propose': 'Cambio de persona propuesto', 'directory.member_approve': 'Cambio de persona aprobado', 'directory.member_reject': 'Cambio de persona rechazado', 'directory.member_withdraw': 'Cambio de persona retirado',
  'approval.request': 'Aprobación solicitada', 'approval.execute': 'Acción ejecutada', 'approval.execute_failed': 'La ejecución falló', 'approval.cancel': 'Solicitud cancelada', 'approval.expire': 'Solicitud vencida', 'approval.self_confirm': 'Acción confirmada por el usuario', 'approval.self_cancel': 'Acción cancelada por el usuario', 'policy.propose': 'Cambio de política propuesto', 'policy.approve': 'Política aprobada', 'policy.reject': 'Cambio de política rechazado', 'policy.withdraw': 'Cambio de política retirado', 'group.propose': 'Cambio de grupo propuesto', 'group.approve': 'Cambio de grupo aprobado', 'group.reject': 'Cambio de grupo rechazado', 'group.withdraw': 'Cambio de grupo retirado', 'skill.propose': 'Versión de skill propuesta', 'skill.approve': 'Versión de skill aprobada', 'skill.reject': 'Versión de skill rechazada', 'skill.withdraw': 'Versión de skill retirada', 'eval.real_conversations': 'Evals con conversaciones reales', 'approval.approve': 'Aprobación concedida', 'approval.reject': 'Aprobación rechazada',
  'budget.alert': 'Alerta de presupuesto', 'budget.pause': 'Pausa por presupuesto', 'budget.update': 'Presupuesto editado', 'budget.create': 'Presupuesto creado', 'budget.delete': 'Presupuesto eliminado', 'budget.user': 'Límite de usuario', 'budget.default': 'Límite por defecto',
  'mcp.connect': 'MCP conectado', 'mcp.request': 'MCP solicitado', 'mcp.approve': 'MCP aprobado', 'mcp.reject': 'MCP rechazado', 'mcp.enable': 'MCP habilitado', 'mcp.disable_request': 'Deshabilitación de MCP pedida', 'mcp.disable': 'MCP deshabilitado', 'mcp.retry': 'Instalación reintentada', 'mcp.install_error': 'Instalación fallida', 'mcp.update_approve': 'Actualización de MCP aprobada', 'mcp.params_request': 'Cambio de parámetros pedido', 'mcp.params_approve': 'Parámetros de MCP aprobados', 'mcp.params_reject': 'Parámetros de MCP rechazados', 'mcp.update_reject': 'Actualización de MCP rechazada',
  'mapping.propose': 'Cambio de áreas propuesto', 'mapping.approve': 'Cambio de áreas aprobado', 'mapping.reject': 'Cambio de áreas rechazado', 'mapping.withdraw': 'Cambio de áreas retirado',
  'model.enable': 'Modelo habilitado', 'model.disable': 'Modelo deshabilitado', 'model.price': 'Precio de modelo cambiado', 'model.catalog_sync': 'Catálogo de Bedrock consultado', 'mcp.withdraw': 'Solicitud de MCP retirada', 'mcp.update_request': 'Actualización de MCP pedida',
  'group.create': 'Grupo creado', 'group.update': 'Grupo editado', 'group.delete': 'Grupo eliminado',
  'skill.update': 'Skill actualizada', 'eval.run': 'Eval ejecutada', 'eval.create': 'Suite de evals creada', 'eval.update': 'Eval configurada', 'schedule.create': 'Schedule creado', 'schedule.update': 'Schedule editado', 'schedule.pause': 'Schedule pausado', 'schedule.resume': 'Schedule reanudado', 'schedule.run': 'Ejecución manual', 'schedule.retire': 'Schedule retirado', 'schedule.autopause': 'Schedule pausado automáticamente', 'kb.create': 'Knowledge base creada', 'kb.sync': 'Knowledge base sincronizada', 'kb.update': 'Knowledge base editada', 'kb.query': 'Búsqueda de prueba', 'role.assign': 'Rol asignado', 'role.switch': 'Cambio de rol', 'settings.update': 'Ajuste cambiado', 'skill.create': 'Skill creada',
  'tool.execute': 'Tool ejecutada', 'playground.publish': 'Publicado desde playground', 'access.request': 'Solicitud de acceso', 'client.error': 'Error de cliente', 'chat.attach': 'Archivo adjuntado',
  'settings.propose': 'Cambio de ajuste propuesto', 'settings.approve': 'Cambio de ajuste aprobado', 'settings.reject': 'Cambio de ajuste rechazado', 'settings.withdraw': 'Propuesta de ajuste retirada',
  'agent.share_propose': 'Cambio de acceso propuesto', 'agent.share_approve': 'Cambio de acceso aprobado', 'agent.share_reject': 'Cambio de acceso rechazado', 'agent.share_withdraw': 'Cambio de acceso retirado', 'agent.retire': 'Agente retirado',
  'conversation.read': 'Conversación leída por admin', 'account.login': 'Inicio de sesión', 'account.mfa_enroll': 'MFA configurado', 'account.mfa_reset': 'MFA restablecido · sesiones cerradas', 'account.mfa_reset_propose': 'Restablecer MFA propuesto', 'account.mfa_reset_approve': 'Restablecer MFA aprobado', 'account.mfa_reset_reject': 'Restablecer MFA rechazado', 'account.mfa_reset_withdraw': 'Restablecer MFA retirado', 'account.logout': 'Cierre de sesión',
  'access.view': 'Acceso de lectura', 'access.denied': 'Acceso denegado', 'chat.query': 'Consulta del agente', 'agent.invoke': 'Inicio de turno del agente',
  'ticket.comment': 'Comentario en ticket', 'ticket.update': 'Ticket actualizado', 'ticket.create': 'Ticket creado', 'account.create': 'Cuenta creada', 'account.password_set': 'Contraseña creada (primer ingreso)',
};
// Acciones de permiso tal como las registra el backend (recurso de access.view / access.denied)
const AUDIT_PERMS = { 'audit.view': 'Ver auditoría', 'admin.view': 'Ver administración', 'agent.invoke': 'Usar agente', 'groups.view': 'Ver grupos' };
const AUDIT_CATS = [
  ['agents', 'Agentes', /^agent\./], ['approvals', 'Aprobaciones', /^(approval|policy)\./], ['budgets', 'Presupuestos', /^budget\./],
  ['access', 'Acceso y grupos', /^(role|group|access|account|conversation|directory)\./], ['mcp', 'MCP, modelos y tools', /^(mcp|tool|model)\./], ['config', 'Ajustes', /^(settings|mapping|kb|schedule)\./],
  ['chat', 'Chat', /^chat\.query$/], ['tickets', 'Tickets', /^ticket\./], ['system', 'Otros', /^(chat|client|playground|skill)\./],
];
// Con "Ver disponibilidad actual": solo eventos de funciones disponibles hoy (Presupuestos, Áreas y OUs, cuenta, accesos, chat con FinOps)
const AUDIT_OUTCOME = { requested: 'solicitado', applied: 'aplicado', rejected: 'no se aplicó' };
const auditOutcome = (r) => !r.outcome ? '' : AUDIT_OUTCOME[r.outcome] + (r.error ? ' · ' + r.error : '');
const AUDIT_AVAILABLE = /^(budget|mapping|account|access|directory|approval)\./;
// Contraseña y MFA van directo al proveedor de identidad y aún no se registran en Mango
const auditAvail = (r) => (AUDIT_AVAILABLE.test(r.action) && !/^account\.(password_set|mfa_enroll)$/.test(r.action)) || (/^(chat\.query|agent\.invoke)$/.test(r.action) && r.target === 'fin-01');
const auditCat = (action) => (AUDIT_CATS.find(c => c[2].test(action)) || AUDIT_CATS[AUDIT_CATS.length - 1])[0];
const actionTone = (a) => /[._]request$/.test(a) ? 'var(--amber)' : /reject|fail|pause|error|denied|delete|disable|retire/.test(a) ? 'var(--red)' : /alert|request|submit|propose/.test(a) ? 'var(--amber)' : /approve|create|publish|enable|restore/.test(a) ? 'var(--green)' : 'var(--text-dim)';
const auditHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ('00000000' + (h >>> 0).toString(16)).slice(-8); };
const ROLE_L = { lead_admin: 'Líder de área · Admin', admin: 'FinOps central · Admin', owner: 'FinOps central', central: 'FinOps central · Usuario', user: 'Líder de área', agent: 'Agente', system: 'Sistema' };
const AUDIT_LINK = [[/^agent\.(submit|approve|reject|publish)/, 'review', 'Abrir en Revisión'], [/^agent\./, 'marketplace', 'Ver agentes'], [/^approval\./, 'approvals', 'Abrir Aprobaciones'], [/^budget\./, 'budgets', 'Abrir Presupuestos'], [/^mcp\./, 'mcp', 'Abrir Catálogo de MCP'], [/^model\./, 'models', 'Abrir Brains'], [/^skill\./, 'skills', 'Abrir Skills'], [/^kb\./, 'knowledge', 'Abrir Knowledge Bases'], [/^schedule\./, 'schedules', 'Abrir Schedules'], [/^eval\./, 'evals', 'Abrir Evals'], [/^(mapping|group|settings|directory)\./, 'settings', 'Abrir Ajustes'], [/^ticket\./, 'tickets', 'Abrir ticket']];

function AuditLog() {
  const role = window.useMango(s => s.role);
  useEffect(() => { const S = window.MangoStore; if (role === 'admin') S.log('access.view', 'audit.view', 'Ver auditoría · permitido', { read: true }); else S.log('access.denied', 'audit.view', 'Ver auditoría · denegado (403)'); }, [role]);
  if (role !== 'admin') return <><Topbar crumbs={['Audit log']} /><div className="content"><window.GovKit.Denied /></div></>;
  return <AuditLogInner />;
}

function AuditLogInner() {
  const I = window.Icons;
  const toast = window.useToast?.();
  const auditAll = window.useMango(s => s.audit);
  const avail = window.useMango(s => s.avail);
  const agentIds = new Set((window.MangoData?.agents || []).map(x => x.id));
  const [reads, setReads] = useStateAB(false);
  const auditFull = avail ? auditAll.filter(r => auditAvail(r) && !(/^budget\./.test(r.action) && agentIds.has(r.target) && r.target !== 'fin-01')) : auditAll;
  // Inicio y autorización de un turno completado se agrupan en su «Consulta del agente»; si el turno falló, quedan sueltos
  const doneTurns = new Set(auditFull.filter(r => r.action === 'chat.query' && r.turn).map(r => r.turn));
  const audit = auditFull.filter(r => !(r.turn && r.action !== 'chat.query' && doneTurns.has(r.turn)));
  const [q, setQ] = useStateAB('');
  const [actor, setActor] = useStateAB('all');
  const [cat, setCat] = useStateAB('all');
  const [range, setRange] = useStateAB('all');
  const [target, setTarget] = useStateAB(null);
  const [sel, setSel] = useStateAB(null);
  const [limit, setLimit] = useStateAB(40);
  const [verify, setVerify] = useStateAB(null);
  const actors = [...new Set(audit.map(a => a.actor))].sort((x, y) => x.localeCompare(y, 'es'));
  const RANGES = [['24h', '24 h', 864e5], ['7d', '7 días', 7 * 864e5], ['30d', '30 días', 30 * 864e5], ['all', 'Todo', Infinity]];
  const since = Date.now() - RANGES.find(r => r[0] === range)[2];
  const Q = q.trim().toLowerCase();
  const base = audit.filter(r => (reads || !r.read) && new Date(r.at).getTime() >= since && (actor === 'all' || r.actor === actor) && (!target || r.target === target)
    && (!Q || [r.id, r.actor, r.target, r.detail, AUDIT_ACTIONS[r.action], r.action, auditOutcome(r)].join(' ').toLowerCase().includes(Q)));
  const rows = base.filter(r => cat === 'all' || auditCat(r.action) === cat);
  const anyFilter = Q || actor !== 'all' || cat !== 'all' || range !== 'all' || target || reads;
  const clear = () => { setQ(''); setActor('all'); setCat('all'); setRange('all'); setTarget(null); setReads(false); };
  useEffect(() => setLimit(40), [q, actor, cat, range, target, reads]);

  const runVerify = () => {
    const chron = [...auditFull].reverse();
    let prev = 'genesis', broken = null;
    for (const e of chron) { if (auditHash(prev + e.id + e.action + e.at) !== e.hash) { broken = e; break; } prev = e.hash; }
    setVerify({ ok: !broken, broken, n: chron.length, at: new Date() });
  };
  const exportCsv = () => {
    const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const csv = ['id,fecha,actor,rol,evento,accion,recurso,detalle,resultado,antes,despues,hash', ...rows.map(r => [r.id, r.at, r.actor, r.role, AUDIT_ACTIONS[r.action] || r.action, r.action, r.target, r.detail, auditOutcome(r), r.before ? JSON.stringify(r.before) : '', r.after ? JSON.stringify(r.after) : '', r.hash].map(esc).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    const el = document.createElement('a'); el.href = url; el.download = 'mango-audit-' + new Date().toISOString().slice(0, 10) + '.csv'; el.click(); URL.revokeObjectURL(url);
    toast?.({ tone: 'success', msg: rows.length + ' eventos exportados' });
  };
  const dayKey = (iso) => { const d = new Date(iso); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = dayKey(new Date().toISOString());
  const dayLabel = (k) => { if (k === today) return 'Hoy'; if (k === today - 864e5) return 'Ayer'; const s = new Date(k).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }); return s[0].toUpperCase() + s.slice(1); };
  const shown = rows.slice(0, limit);
  const groups = []; shown.forEach(r => { const k = dayKey(r.at); const g = groups[groups.length - 1]; if (g && g.k === k) g.items.push(r); else groups.push({ k, items: [r] }); });
  const selected = sel && auditFull.find(r => r.id === sel);
  const catCount = (k) => base.filter(r => auditCat(r.action) === k).length;

  return (
    <>
      <Topbar crumbs={['Gobernanza', 'Audit log']} actions={<>
        <window.Soon on={avail}><button className="btn btn-sm" onClick={runVerify}><I.Shield size={12} /> Verificar integridad</button></window.Soon>
        <button className="btn btn-sm" onClick={exportCsv} disabled={!rows.length}><I.Download size={12} /> Exportar CSV</button>
      </>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Audit log</h1>
          <p className="page-subtitle">Registro de quién cambió qué y cuándo. No se puede editar ni borrar.{avail ? ' Se muestran solo eventos de funciones disponibles hoy.' : ''}</p>
        </div>
        {verify && (
          <div className={'mc-alert ' + (verify.ok ? '' : 'red')} style={{ margin: '16px 28px 0', ...(verify.ok ? { background: 'var(--green-soft)', borderColor: 'color-mix(in oklab, var(--green) 25%, transparent)' } : {}) }} role="status">
            {verify.ok ? <I.Check2 size={14} style={{ color: 'var(--green)' }} /> : <I.X2 size={14} />}
            <div style={{ flex: 1 }}>{verify.ok ? <><b>Cadena íntegra.</b> {verify.n} eventos verificados, del primero al último, sin huecos ni modificaciones.</> : <><b>La cadena se rompe en {verify.broken.id}.</b> El hash no coincide con el esperado: ese evento o uno anterior pudo alterarse.</>} <span className="mk-meta">· {verify.at.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })}</span></div>
            <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={() => setVerify(null)}><I.Close size={12} /></button>
          </div>
        )}
        <div className="au-bar">
          <div className="au-row">
            <div className="search-wrap" style={{ flex: '1 1 240px', maxWidth: 340 }}><I.Search size={13} /><input className="input" aria-label="Buscar en el audit log" placeholder="Buscar por detalle, recurso, persona o ID" value={q} onChange={e => setQ(e.target.value)} /></div>
            <div className="tk-quick" role="group" aria-label="Periodo">{RANGES.map(([k, l]) => <button key={k} className={range === k ? 'is-on' : ''} aria-pressed={range === k} onClick={() => setRange(k)}>{l}</button>)}</div>
            <select className="input mk-sel" aria-label="Persona o agente" value={actor} onChange={e => setActor(e.target.value)}><option value="all">Cualquier actor</option>{actors.map(a => <option key={a}>{a}</option>)}</select>
            {target && <span className="au-pill">Recurso: <span className="mono">{target}</span><button aria-label="Quitar filtro de recurso" onClick={() => setTarget(null)}><I.Close size={10} /></button></span>}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer' }} title="Accesos de solo lectura permitidos. Los denegados y los cambios se ven siempre.">
              <button role="switch" aria-checked={reads} onClick={() => setReads(!reads)} style={{ width: 32, height: 18, borderRadius: 9, background: reads ? 'var(--accent)' : 'var(--border-strong)', border: 'none', position: 'relative', flexShrink: 0, cursor: 'pointer' }}><span style={{ position: 'absolute', top: 2, left: reads ? 16 : 2, width: 14, height: 14, borderRadius: '50%', background: 'white', transition: 'left 0.2s' }} /></button>
              Mostrar lecturas
            </label>
            <div style={{ flex: 1 }} />
            <span className="tk-meta">{rows.length} {rows.length === 1 ? 'evento' : 'eventos'}</span>
            {anyFilter && <button className="btn btn-sm btn-ghost" onClick={clear}>Limpiar</button>}
          </div>
          <div className="au-cats" role="group" aria-label="Categoría">
            <button className={cat === 'all' ? 'is-on' : ''} aria-pressed={cat === 'all'} onClick={() => setCat('all')}>Todo<span>{base.length}</span></button>
            {AUDIT_CATS.map(([k, l]) => { const n = catCount(k); return n || cat === k ? <button key={k} className={cat === k ? 'is-on' : ''} aria-pressed={cat === k} onClick={() => setCat(k)}>{l}<span>{n}</span></button> : null; })}
          </div>
        </div>

        <div className="au-body">
          {!rows.length ? (
            <div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600 }}>Sin eventos</div><div className="mk-meta">{anyFilter ? 'Nada coincide con los filtros.' : 'Aún no hay actividad registrada.'}</div>{anyFilter && <button className="btn btn-sm" onClick={clear}>Limpiar filtros</button>}</div>
          ) : groups.map(g => (
            <section key={g.k} className="au-day">
              <div className="au-day-h">{dayLabel(g.k)}<span>{g.items.length}</span></div>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {g.items.map(r => (
                  <button key={r.id} className={'au-tr' + (sel === r.id ? ' is-on' : '')} onClick={() => setSel(r.id)}>
                    <span className="mono au-time" title={new Date(r.at).toLocaleString('es-MX')}>{new Date(r.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                    <span className="au-ev"><span className="tk-dot" style={{ background: actionTone(r.action) }} />{AUDIT_ACTIONS[r.action] || r.action}</span>
                    <span className="au-actor"><span className="au-name">{r.actor}</span><span className="au-role">{ROLE_L[r.role] || r.role}</span></span>
                    <span className="mono au-target">{r.target}</span>
                    <span className="au-detail">{r.detail}{r.outcome && <span className={'au-outcome' + (r.outcome === 'rejected' ? ' fail' : '')}> · {auditOutcome(r)}</span>}</span>
                    {(r.before || r.after) && <span className="au-diff" title="Incluye valores antes y después">Δ</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {rows.length > limit && <button className="btn btn-sm" style={{ margin: '4px auto 0', display: 'flex' }} onClick={() => setLimit(l => l + 40)}>Mostrar más</button>}
        </div>
      </div>
      {selected && <AuditDetail r={selected} audit={auditFull} onClose={() => setSel(null)} onActor={(a) => { setActor(a); setSel(null); }} onTarget={(t) => { setTarget(t); setSel(null); }} />}
    </>
  );
}

function AuditDetail({ r, audit, onClose, onActor, onTarget }) {
  const I = window.Icons;
  const toast = window.useToast?.();
  const idx = audit.findIndex(x => x.id === r.id);
  const prev = audit[idx + 1];
  const link = AUDIT_LINK.find(l => l[0].test(r.action));
  const keys = [...new Set([...Object.keys(r.before || {}), ...Object.keys(r.after || {})])];
  const turnEv = r.action === 'chat.query' && r.turn ? audit.filter(x => x.turn === r.turn && x.id !== r.id) : [];
  const start = turnEv.find(x => x.action === 'agent.invoke');
  const auth = turnEv.find(x => /^access\./.test(x.action) && x.target === 'agent.invoke');
  const denied = auth ? auth.action === 'access.denied' : false;
  const fmt = (v) => v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const copy = () => { navigator.clipboard?.writeText(JSON.stringify(r, null, 2)); toast?.({ tone: 'success', msg: 'Evento copiado como JSON' }); };
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" role="dialog" aria-modal="true" aria-label={r.id}>
        <div className="mk-drawer-h">
          <span className="gv-ic" style={{ color: actionTone(r.action), background: 'color-mix(in oklab, ' + actionTone(r.action) + ' 12%, transparent)' }}><I.Lock size={14} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>{AUDIT_ACTIONS[r.action] || r.action}</div>
            <div className="mk-meta" style={{ marginTop: 2 }}><span className="mono">{r.id}</span> · {new Date(r.at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'medium' })}</div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Copiar JSON" title="Copiar JSON" onClick={copy}><I.Copy size={13} /></button>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="mk-drawer-b">
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{r.detail}</p>
          <MkSec title="Evento">
            <div className="mk-kv"><span>Actor</span><span className="row gap-2">{r.actor} <span className="au-role">{ROLE_L[r.role] || r.role}</span></span></div>
            <div className="mk-kv"><span>Acción</span><span className="mono" style={{ fontSize: 12 }}>{r.action}</span></div>
            {r.agentVersion && <div className="mk-kv"><span>Versión del agente</span><span className="mono" style={{ fontSize: 12 }}>v{r.agentVersion}</span></div>}
            {r.model && <div className="mk-kv"><span>Modelo</span><span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{r.model}</span></div>}
            <div className="mk-kv"><span>Recurso</span><span className="mono" style={{ fontSize: 12 }}>{r.target}{AUDIT_PERMS[r.target] && /^access\./.test(r.action) ? <span style={{ fontFamily: 'var(--font-sans)', color: 'var(--text-muted)' }}> · {AUDIT_PERMS[r.target]}</span> : null}</span></div>
            {r.outcome && <div className="mk-kv"><span>Resultado</span><span className={'au-outcome' + (r.outcome === 'rejected' ? ' fail' : '')} style={{ color: r.outcome === 'rejected' ? undefined : 'var(--text)' }}>{auditOutcome(r)}</span></div>}
            <div className="mk-kv"><span>Hace</span><span>{window.fmtAgo(r.at)}</span></div>
          </MkSec>
          {start && <MkSec title="Inicio del turno">
            <div className="mk-kv"><span>Turno</span><span className="mono" style={{ fontSize: 12 }}>{r.turn}</span></div>
            <div className="mk-kv"><span>Evento</span><span className="mono" style={{ fontSize: 12 }}>{start.id} · {start.action}</span></div>
            <div className="mk-kv"><span>Hora</span><span>{new Date(start.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span></div>
          </MkSec>}
          {r.action === 'chat.query' && (auth || r.perm) && <MkSec title="Autorización">
            <div className="mk-kv"><span>Acción</span><span>{AUDIT_PERMS[auth?.target || r.perm] || auth?.target || r.perm} <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{auth?.target || r.perm}</span></span></div>
            <div className="mk-kv"><span>Resultado</span>{auth ? <span style={{ color: denied ? 'var(--red)' : 'var(--green)' }}>{denied ? 'Denegado' : 'Permitido'}</span> : <span style={{ color: 'var(--text-muted)' }}>Sin registro</span>}</div>
            {auth && <div className="mk-kv"><span>Evento</span><span className="mono" style={{ fontSize: 12 }}>{auth.id} · {auth.action}</span></div>}
            <div className="mk-meta" style={{ marginTop: 4 }}>Cada turno del chat registra su inicio y verifica el permiso de uso del agente. Si el turno termina, ambos se agrupan aquí; si falla antes, se ven como filas sueltas.</div>
          </MkSec>}
          {keys.length > 0 && (
            <MkSec title="Qué cambió">
              <div className="au-chg"><div className="au-chg-h"><span>campo</span><span>antes</span><span>después</span></div>
                {keys.map(k => <div key={k}><span className="mono">{k}</span><span className="mono au-old">{fmt(r.before?.[k])}</span><span className="mono au-new">{fmt(r.after?.[k])}</span></div>)}
              </div>
            </MkSec>
          )}
          {!window.MangoStore.get().avail && <MkSec title="Integridad">
            <div className="mk-kv"><span>Hash</span><span className="mono" style={{ fontSize: 12 }}>{r.hash}</span></div>
            <div className="mk-kv"><span>Anterior</span><span className="mono" style={{ fontSize: 12 }}>{prev ? prev.hash + ' · ' + prev.id : 'genesis'}</span></div>
            <div className="mk-meta" style={{ marginTop: 4 }}>El hash se calcula con el hash anterior, el ID, la acción y la fecha. Si alguien alterara un evento, la cadena dejaría de coincidir.</div>
          </MkSec>}
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-sm" onClick={() => onActor(r.actor)}><I.User size={12} /> Todo de {r.actor.split(' ')[0]}</button>
            <button className="btn btn-sm" onClick={() => onTarget(r.target)}><I.Filter size={12} /> Historial de este recurso</button>
            {link && <button className="btn btn-sm" onClick={() => { onClose(); window.MangoNav?.(link[1], link[1] === 'tickets' ? r.target : undefined); }}>{link[2]} <I.ArrowRight size={11} /></button>}
          </div>
        </div>
      </aside>
    </div>
  );
}

const money = (n) => window.GovKit ? window.GovKit.usd(n) : '$' + n.toLocaleString();
const BUDGET_ACTIONS = { block: 'Bloquear', alert: 'Solo alertar', pause: 'Pausar agente', approval: 'Pedir aprobación' };
const BUDGET_ACTION_DESC = { block: 'Se rechazan las nuevas consultas hasta el próximo mes o hasta ampliar el límite.', alert: 'Sigue funcionando; solo se envía un aviso al canal.', pause: 'Se detienen nuevas consultas hasta el próximo mes o hasta ampliar el límite.', approval: 'Cada nueva consulta necesita que alguien la apruebe.' };
const bPct = (b) => b.limit ? Math.round(b.spent / b.limit * 100) : 0;
const monthInfo = () => { const d = new Date(); const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); return { day: d.getDate(), days, frac: d.getDate() / days, label: d.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }) }; };
// Serie diaria de ejemplo: días hábiles pesan más que fines de semana; suma = gasto del mes
const bDaily = (b, M) => {
  let seed = [...b.id].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const d0 = new Date(); d0.setDate(1);
  const w = Array.from({ length: M.day }, (_, i) => { const dow = new Date(d0.getFullYear(), d0.getMonth(), i + 1).getDay(); return (dow === 0 || dow === 6 ? 0.35 : 1) * (0.7 + rnd() * 0.6) * (1 + i / M.day * 0.3); });
  const sum = w.reduce((s, x) => s + x, 0) || 1;
  return w.map(x => x / sum * b.spent);
};
const bForecast = (b, M) => {
  const rem = M.days - M.day;
  if (M.day < 5) return { enough: false };
  const last = bDaily(b, M).slice(-7);
  const avg = last.reduce((s, x) => s + x, 0) / last.length;
  const sorted = [...last].sort((x, y) => x - y);
  const lo = (sorted[0] + sorted[1] + sorted[2]) / 3, hi = (sorted[4] + sorted[5] + sorted[6]) / 3;
  const low = b.spent + lo * rem, mid = b.spent + avg * rem, high = b.spent + hi * rem;
  let hit = null;
  if (b.spent < b.limit && avg > 0) { const days = Math.ceil((b.limit - b.spent) / avg); if (days <= rem) { const d = new Date(); d.setDate(d.getDate() + days); hit = d; } }
  const pc = (x) => b.limit ? Math.round(x / b.limit * 100) : 0;
  return { enough: true, low, mid, high, pLow: pc(low), pMid: pc(mid), pHigh: pc(high), hit, avg };
};
const fmtDay = (d) => d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
const bState = (b) => { const p = bPct(b); return p >= 100 ? 'out' : p >= b.warn ? 'warn' : 'ok'; };
const B_TONE = { ok: 'var(--green)', warn: 'var(--amber)', out: 'var(--red)' };
const bBadge = (b) => { const s = bState(b); if (s === 'out') return ['badge-red', b.action === 'pause' ? 'Pausado' : b.action === 'approval' ? 'Con aprobación' : 'Excedido']; if (s === 'warn') return ['badge-amber', 'En alerta']; return ['badge-green', 'OK']; };

function BudgetsView({ agents }) {
  const I = window.Icons;
  const S = window.MangoStore;
  const toast = window.useToast?.();
  const stored = window.useMango(s => s.budgets);
  const gov = window.useMango(s => s.govBudgets);
  const avail = window.useMango(s => s.avail);
  const role = window.useMango(s => s.role);
  const defAgent = gov?.defaults?.agent ?? 0;
  const agentsIn = avail ? agents.filter(a => a.id === 'fin-01') : agents;
  // Disponible hoy: FinOps usa el límite por defecto; su gasto viene de gov (agents[finops])
  const finSpent = (gov?.agents || []).find(x => x.id === 'finops')?.spent ?? 0;
  const agentDefaults = avail ? agentsIn.map(a => ({ id: 'D-' + a.id, scope: 'agent', target: a.id, limit: defAgent, spent: finSpent, warn: 80, action: 'block', channel: '', isDefault: true, onDefault: true }))
    : agentsIn.filter(a => !stored.some(b => b.scope === 'agent' && b.target === a.id)).map(a => ({ id: 'D-' + a.id, scope: 'agent', target: a.id, limit: a.budgetDefault ? defAgent : a.budgetMax, spent: a.budget || 0, warn: 80, action: 'block', channel: '', isDefault: true, onDefault: !!a.budgetDefault }));
  const budgets = [...(avail ? [] : stored), ...agentDefaults];
  const canEdit = S.can('budget.edit');
  const [edit, setEdit] = useStateAB(null);
  const [q, setQ] = useStateAB('');
  const [filter, setFilter] = useStateAB('all');
  const M = monthInfo();
  const name = (b) => b.scope === 'agent' ? (agents.find(a => a.id === b.target)?.name || b.target) : 'Equipo ' + b.target;
  const fc = (b) => bForecast(b, M);
  const proj = (b) => { const f = fc(b); return f.enough ? f.pMid : 0; };
  const alerts = budgets.filter(b => bState(b) !== 'ok' && (!avail || b.scope === 'agent')).sort((x, y) => bPct(y) - bPct(x));
  const teams = budgets.filter(b => b.scope === 'team');
  const total = teams.reduce((s, b) => s + b.limit, 0);
  const spent = teams.reduce((s, b) => s + b.spent, 0);
  const teamFc = teams.map(fc);
  const enough = M.day >= 5;
  const projLow = teamFc.reduce((s, f) => s + (f.low || 0), 0), projHigh = teamFc.reduce((s, f) => s + (f.high || 0), 0), projTotal = teamFc.reduce((s, f) => s + (f.mid || 0), 0);
  const kShort = (n) => n >= 1000 ? 'USD ' + (n / 1000).toFixed(1).replace('.', ',') + 'k' : money(n);
  const willExceed = budgets.filter(b => bState(b) !== 'out' && fc(b).hit);
  const Q = q.trim().toLowerCase();
  const visible = (b) => (!Q || name(b).toLowerCase().includes(Q)) && (filter === 'all' || (filter === 'risk' ? bState(b) !== 'ok' || !!fc(b).hit : bState(b) === 'out'));
  const save = (b) => {
    const exists = stored.some(x => x.id === b.id);
    S.set({ budgets: exists ? stored.map(x => x.id === b.id ? b : x) : [...stored, b] });
    S.log(exists ? 'budget.update' : 'budget.create', b.target, `${name(b)} · límite ${money(b.limit)} · alerta ${b.warn}% · al 100%: ${BUDGET_ACTIONS[b.action]}`);
    toast?.({ tone: 'success', msg: exists ? 'Presupuesto actualizado' : 'Presupuesto creado' });
    setEdit(null);
  };
  const remove = (b) => {
    S.set({ budgets: stored.filter(x => x.id !== b.id) });
    S.log('budget.delete', b.target, `Eliminó el presupuesto de ${name(b)}`);
    toast?.({ tone: 'info', msg: 'Vuelve al límite por defecto' });
    setEdit(null);
  };
  const newBudget = () => {
    const free = agentsIn.find(a => !budgets.some(x => x.scope === 'agent' && x.target === a.id));
    setEdit({ id: 'B-' + String(Math.max(0, ...stored.map(x => parseInt(x.id.slice(2)) || 0)) + 1).padStart(2, '0'), scope: 'agent', target: (free || agents[0]).id, limit: defAgent || 1000, spent: 0, warn: 80, action: 'block', channel: '#finops-alerts', isNew: true });
  };

  if (avail && role !== 'admin') return <><Topbar crumbs={['Presupuestos']} /><div className="content"><window.GovKit.Denied /></div></>;
  const Section = ({ title, list, soon }) => {
    const shown = list.filter(visible);
    const lim = list.reduce((s, b) => s + b.limit, 0), sp = list.reduce((s, b) => s + b.spent, 0);
    if (!shown.length && (Q || filter !== 'all')) return null;
    return (
      <window.Soon on={!!soon} block><div style={{ marginBottom: 28 }}>
        <div className="row between" style={{ marginBottom: 10, gap: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{title} <span style={{ color: 'var(--text-dim)' }}>· {list.length}</span></div>
          {list.length > 0 && <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{money(sp)} de {money(lim)}</div>}
        </div>
        <div className="card" style={{ padding: 0 }}>
          {shown.length === 0 && <div style={{ padding: '16px', fontSize: 12.5, color: 'var(--text-muted)' }}>Aún no hay presupuestos aquí.</div>}
          {shown.map((b, i) => {
            const p = bPct(b); const st = bState(b); const tone = B_TONE[st]; const f = fc(b); const pr = f.enough ? f.pMid : 0; const [bc, bl] = bBadge(b);
            return (
              <div key={b.id} className="bg-row" style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(b)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={BUDGET_ACTION_DESC[avail ? 'block' : b.action]}>{b.onDefault ? 'Límite por defecto · ' : ''}Al 100%: {BUDGET_ACTIONS[avail ? 'block' : b.action].toLowerCase()}{!avail && b.channel ? <> · <span className="mono">{b.channel}</span></> : null}</div>
                </div>
                <div>
                  <div role="progressbar" aria-valuenow={Math.min(p, 100)} aria-valuemin={0} aria-valuemax={100} aria-label={'Consumo ' + name(b)} style={{ position: 'relative', height: 6, borderRadius: 3, background: 'var(--border)' }}>
                    <span style={{ position: 'absolute', inset: 0, width: Math.min(p, 100) + '%', background: tone, borderRadius: 3 }} />
                    {!avail && st !== 'out' && f.enough && f.pHigh > p && <span title={`Proyección a fin de mes: ${f.pLow}–${f.pHigh}% (${money(f.low)} – ${money(f.high)})`} style={{ position: 'absolute', top: 0, bottom: 0, left: Math.min(f.pLow, 100) + '%', width: Math.max(1, Math.min(f.pHigh, 100) - Math.min(f.pLow, 100)) + '%', background: `repeating-linear-gradient(90deg, color-mix(in oklab, ${pr >= 100 ? 'var(--red)' : tone} 45%, transparent) 0 3px, transparent 3px 5px)`, borderRadius: '0 3px 3px 0' }} />}
                    {!avail && <span title={'Alerta al ' + b.warn + '%'} style={{ position: 'absolute', left: b.warn + '%', top: -3, bottom: -3, width: 2, background: 'var(--text-muted)' }} />}
                  </div>
                  <div className="row between mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, gap: 8 }}>
                    <span style={{ whiteSpace: 'nowrap' }}>{money(b.spent)} / {money(b.limit)}</span>
                    <span style={{ whiteSpace: 'nowrap' }}>{!avail && st !== 'out' && f.hit && <span style={{ color: 'var(--red)', marginRight: 8 }} title={`Al ritmo de los últimos 7 días (${money(f.avg)}/día)`}>llega al límite el {fmtDay(f.hit)}</span>}<span style={{ color: tone }}>{p}%</span></span>
                  </div>
                </div>
                <span style={{ justifySelf: 'start' }} className={'badge ' + bc}>{bl}</span>
                {avail && b.scope === 'agent' ? <window.Soon on><button className="btn btn-sm btn-ghost" aria-label={'Editar ' + name(b)}><I.Edit size={12} /></button></window.Soon> : <button className="btn btn-sm btn-ghost" disabled={!canEdit} onClick={() => setEdit(b)} aria-label={'Editar ' + name(b)} title={canEdit ? 'Editar' : 'Solo admins pueden editar'}><I.Edit size={12} /></button>}
              </div>
            );
          })}
        </div>
      </div></window.Soon>
    );
  };

  const Kpi = ({ label, value, sub, tone }) => (
    <div className="card bg-kpi"><span className="bg-kpi-l">{label}</span><span className="bg-kpi-v" style={tone ? { color: tone } : null}>{value}</span><span className="bg-kpi-s">{sub}</span></div>
  );

  return (
    <>
      <Topbar crumbs={['Gobernanza', 'Presupuestos']} actions={canEdit && (avail ? <window.Soon on><button className="btn btn-sm btn-primary"><I.Plus size={12} /> Nuevo presupuesto</button></window.Soon> : <button className="btn btn-sm btn-primary" onClick={newBudget}><I.Plus size={12} /> Nuevo presupuesto</button>)} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Presupuestos y alertas</h1>
          <p className="page-subtitle">Límites de gasto mensual por equipo, agente y usuario · {M.label}, día {M.day} de {M.days}.</p>
        </div>
        {avail ? <window.Soon on block><div className="bg-kpis">{['Gasto de equipos', 'Proyección a fin de mes', 'En alerta o excedidos', 'Superarán el límite'].map(l => <Kpi key={l} label={l} value="—" sub="Aún no hay datos suficientes" />)}</div></window.Soon> : <div className="bg-kpis">
          <Kpi label="Gasto de equipos" value={total ? Math.round(spent / total * 100) + '%' : '—'} sub={`${money(spent)} de ${money(total)}`} />
          <Kpi label="Proyección a fin de mes" value={enough ? kShort(projLow) + ' – ' + kShort(projHigh) : '—'} sub={!enough ? 'Aún no hay datos suficientes (menos de 5 días)' : projHigh > total ? 'Podría superar lo asignado · ritmo de 7 días' : 'Dentro de lo asignado · ritmo de 7 días'} tone={enough && projLow > total ? 'var(--red)' : undefined} />
          <Kpi label="En alerta o excedidos" value={alerts.length} sub={alerts.length ? (n => n + (n === 1 ? ' excedido' : ' excedidos'))(alerts.filter(b => bState(b) === 'out').length) : 'Todo dentro de límites'} tone={alerts.length ? 'var(--amber)' : undefined} />
          <Kpi label="Superarán el límite" value={willExceed.length} sub={!enough ? 'Aún no hay datos suficientes' : willExceed.length ? 'Primero: ' + (() => { const x = [...willExceed].sort((a, b) => fc(a).hit - fc(b).hit)[0]; return name(x) + ', ' + fmtDay(fc(x).hit); })() : 'Ninguno al ritmo actual'} tone={willExceed.length ? 'var(--red)' : undefined} />
        </div>}
        <div className="bg-toolbar">
          <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar equipo o agente" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar presupuestos" /></div>
          <div className="tk-quick" role="group" aria-label="Filtrar">
            {[['all', 'Todos'], ['risk', 'En riesgo'], ['out', 'Excedidos']].map(([k, l]) => <button key={k} className={filter === k ? 'is-on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          <div style={{ flex: 1 }} />
          {!avail && <span className="bg-legend"><i className="bg-lg-bar" /> gastado <i className="bg-lg-proj" /> rango proyectado <i className="bg-lg-warn" /> umbral de alerta</span>}
        </div>
        {!avail && <div className="bg-note">La proyección usa el ritmo de los últimos 7 días y solo se muestra aquí: los avisos a Slack y las pausas dependen del gasto real. Datos diarios de ejemplo.</div>}
        <div style={{ padding: '4px 28px 40px', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 24, alignItems: 'start' }} className="budgets-grid">
          <div>
            {filter === 'all' && !Q && window.GovBudgetDefaults && <window.GovBudgetDefaults isAdmin={S.get().role === 'admin'} agentsOnDefault={agentDefaults.filter(b => b.onDefault).length} notify={(msg) => toast?.({ tone: 'success', msg })} />}
            <Section title="Por agente" list={budgets.filter(b => b.scope === 'agent')} />
            {filter === 'all' && !Q && window.GovUserBudgets && <window.GovUserBudgets isAdmin={S.get().role === 'admin'} notify={(msg, tone) => toast?.({ tone: tone === 'info' ? 'info' : 'success', msg })} />}
            <Section title="Por equipo" list={avail ? [] : teams} soon={avail} />
            {(Q || filter !== 'all') && !budgets.some(visible) && <div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600 }}>Nada coincide</div><button className="btn btn-sm" onClick={() => { setQ(''); setFilter('all'); }}>Limpiar filtros</button></div>}
          </div>
          <div className="card" style={{ padding: 0, position: 'sticky', top: 16 }}>
            <div className="row gap-2" style={{ padding: '14px 16px 10px' }}><I.Warn size={13} style={{ color: 'var(--amber)' }} /><span style={{ fontSize: 13, fontWeight: 600 }}>Alertas activas · {alerts.length}</span></div>
            {alerts.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '0 16px 16px' }}>Todo dentro de límites.</div>}
            {alerts.map(b => (
              <button key={b.id} className="bg-alert" onClick={() => canEdit && !avail && setEdit(b)} disabled={!canEdit || avail}>
                <div className="row between" style={{ gap: 8 }}><span style={{ fontWeight: 500, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(b)}</span><span className="mono" style={{ fontSize: 11.5, color: B_TONE[bState(b)] }}>{bPct(b)}%</span></div>
                {!avail && <div style={{ color: 'var(--text-muted)', marginTop: 2, fontSize: 12, lineHeight: 1.45, textWrap: 'pretty' }}>{bState(b) === 'out' ? (b.action === 'pause' ? 'Pausado automáticamente. Amplía el límite para reactivarlo.' : b.action === 'approval' ? 'Cada nueva consulta requiere aprobación.' : 'Excedido; solo se notificó a ' + b.channel + '.') : `Superó el ${b.warn}%. Aviso enviado a ${b.channel}.`}</div>}
                {canEdit && !avail && <span className="bg-alert-cta">Ajustar límite <I.ArrowRight size={10} /></span>}
              </button>
            ))}
          </div>
        </div>
      </div>
      {edit && <BudgetModal avail={avail} agentsIn={agentsIn} b={edit.isDefault ? { ...edit, id: 'B-' + String(Math.max(0, ...stored.map(x => parseInt(x.id.slice(2)) || 0)) + 1).padStart(2, '0'), channel: '#finops-alerts', isDefault: false, fromDefault: true } : edit} agents={agents} budgets={stored} onClose={() => setEdit(null)} onSave={save} onDelete={remove} />}
    </>
  );
}

function BudgetModal({ b, agents: allAgents, agentsIn, budgets, onClose, onSave, onDelete, avail }) {
  const agents = agentsIn || allAgents;
  const I = window.Icons;
  const [f, setF] = useStateAB(() => ({ ...b, limitStr: String(b.limit) }));
  const [tried, setTried] = useStateAB(false);
  const [confirmDel, setConfirmDel] = useStateAB(false);
  const teams = [...new Set(agents.map(a => a.cat))];
  const lim = Number(String(f.limitStr).replace(/[^\d.]/g, ''));
  const limErr = !(lim > 0) ? 'Escribe un monto mayor que 0' : lim > 1e6 ? 'El máximo es USD 1.000.000,00' : null;
  const dup = budgets.some(x => x.id !== f.id && x.scope === f.scope && x.target === f.target);
  const chErr = !avail && !/^#[a-z0-9-_]{2,}$/.test(f.channel || '') ? 'Usa un canal de Slack, p. ej. #finops-alerts' : null;
  const p = lim > 0 ? Math.round(f.spent / lim * 100) : 0;
  const L = ({ id, children, hint }) => <div className="row between" style={{ margin: '14px 0 6px' }}><label htmlFor={id} style={{ fontSize: 12.5, fontWeight: 500 }}>{children}</label>{hint && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{hint}</span>}</div>;
  const submit = () => { setTried(true); if (limErr || dup || chErr) return; const { limitStr, isNew, fromDefault, ...rest } = f; onSave({ ...rest, ...(avail ? { action: 'block' } : {}), limit: Math.round(lim * 100) / 100 }); };
  return (
    <window.Modal open onClose={onClose} title={b.isNew ? 'Nuevo presupuesto' : b.fromDefault ? 'Límite propio del agente' : 'Editar presupuesto'}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: 12 }}>
        <div><L id="bg-scope">Alcance</L>
          <select id="bg-scope" className="input" style={{ width: '100%' }} value={f.scope} disabled={!b.isNew} onChange={e => setF({ ...f, scope: e.target.value, target: e.target.value === 'agent' ? agents[0].id : teams[0] })}>
            <option value="agent">Agente</option><option value="team" disabled={avail}>Equipo{avail ? ' · Próximamente' : ''}</option>
          </select></div>
        <div><L id="bg-target">{f.scope === 'agent' ? 'Agente' : 'Equipo'}</L>
          <select id="bg-target" className="input" style={{ width: '100%' }} value={f.target} disabled={!b.isNew} onChange={e => setF({ ...f, target: e.target.value })}>
            {f.scope === 'agent' ? agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>) : teams.map(t => <option key={t}>{t}</option>)}
          </select></div>
      </div>
      {dup && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>Ya existe un presupuesto para {f.scope === 'agent' ? 'este agente' : 'este equipo'}. Edítalo desde la lista.</div>}
      <L id="bg-limit" hint={f.spent ? 'Gastado este mes: ' + money(f.spent) : null}>Límite mensual</L>
      <div className={'g-money' + (tried && limErr ? ' has-error' : '')} style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 8, paddingLeft: 10, background: 'var(--card)' }}>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>USD</span>
        <input id="bg-limit" inputMode="decimal" value={f.limitStr} onChange={e => setF({ ...f, limitStr: e.target.value })} style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, padding: '8px 10px', font: 'inherit', fontSize: 14, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }} />
      </div>
      {tried && limErr && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{limErr}</div>}
      {lim > 0 && f.spent > 0 && <div style={{ fontSize: 12, color: p >= 100 ? 'var(--red)' : p >= f.warn ? 'var(--amber)' : 'var(--text-muted)', marginTop: 6 }}>Con este límite quedaría en {p}%{p >= 100 ? ' · se aplicaría la acción de 100% de inmediato' : ''}.</div>}
      <window.Soon on={avail} block><L id="bg-warn" hint={lim > 0 ? 'Aviso al llegar a ' + money(lim * f.warn / 100) : null}>Alertar al {f.warn}%</L>
      <input id="bg-warn" type="range" min="50" max="95" step="5" value={f.warn} onChange={e => setF({ ...f, warn: Number(e.target.value) })} style={{ width: '100%', accentColor: 'var(--accent)' }} /></window.Soon>
      <L id="bg-action">Al llegar al 100%</L>
      <div id="bg-action" role="radiogroup" style={{ display: 'grid', gap: 6 }}>
        {Object.entries(BUDGET_ACTIONS).map(([k, l]) => avail && k !== 'block' ? (
          <window.Soon key={k} on block><label className="g-radio" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 10 }}><input type="radio" disabled style={{ marginTop: 3 }} /><span><span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{l}</span><span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{BUDGET_ACTION_DESC[k]}</span></span></label></window.Soon>
        ) : (
          <label key={k} className={'g-radio' + (f.action === k ? ' is-on' : '')} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', border: '1px solid ' + (f.action === k ? 'var(--accent-border)' : 'var(--border)'), background: f.action === k ? 'var(--accent-soft)' : 'transparent', borderRadius: 10, cursor: 'pointer' }}>
            <input type="radio" name="bg-act" checked={(avail ? 'block' : f.action) === k} onChange={() => setF({ ...f, action: k })} style={{ accentColor: 'var(--accent-ink)', marginTop: 3 }} />
            <span><span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{l}</span><span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{BUDGET_ACTION_DESC[k]}</span></span>
          </label>
        ))}
      </div>
      <window.Soon on={avail} block><L id="bg-ch">Canal de notificación</L>
      <input id="bg-ch" className="input mono" style={{ width: '100%', borderColor: tried && chErr ? 'var(--red)' : undefined }} value={f.channel} onChange={e => setF({ ...f, channel: e.target.value })} /></window.Soon>
      {tried && chErr && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{chErr}</div>}
      <div className="row gap-2" style={{ marginTop: 20, alignItems: 'center' }}>
        {!b.isNew && !b.fromDefault && (confirmDel
          ? <><span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>¿Usar el límite por defecto?</span><button className="btn btn-sm" onClick={() => onDelete(b)}>Sí</button><button className="btn btn-sm btn-ghost" onClick={() => setConfirmDel(false)}>No</button></>
          : <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDel(true)}><I.Refresh size={12} /> Volver al límite por defecto</button>)}
        <div style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={onClose}>Cancelar</button>
        <button className="btn btn-sm btn-primary" onClick={submit}>{b.isNew ? 'Crear presupuesto' : 'Guardar'}</button>
      </div>
    </window.Modal>
  );
}

Object.assign(window, { AuditLog, BudgetsView });
