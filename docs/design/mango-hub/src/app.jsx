// Tweaks panel + main app
const EDIT_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "comfortable",
  "persona": "admin",
  "live_stream": true
}/*EDITMODE-END*/;

function TweaksPanel({ visible, onClose, settings, setSettings, view, setView }) {
  const I = window.Icons;

  const set = (k, v) => {
    const next = { ...settings, [k]: v };
    setSettings(next);
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v }}, '*');
    if (k === 'theme') document.documentElement.setAttribute('data-theme', v);
    if (k === 'persona') window.MangoStore.set({ role: v });
  };
  const simError = window.useMango(st => st.simError);
  const role = window.useMango(st => st.role);
  const avail = window.useMango(st => st.avail);
  const accountState = window.useMango(st => st.accountState);
  const authCfg = window.useMango(st => st.authCfg);
  const actorOverride = window.useMango(st => st.actorOverride);
  const simChat = window.useMango(st => st.simChat);
  const simConn = window.useMango(st => st.simConn);
  const S = window.MangoStore;
  const Chips = ({ label, opts, value, onPick }) => (
    <div className="tweak-row">
      <div className="tweak-label">{label}</div>
      <div className="tweak-chips">{opts.map(([k, l]) => <button key={String(k)} className={`tweak-chip ${value === k ? 'active' : ''}`} onClick={() => onPick(k)}>{l}</button>)}</div>
    </div>
  );

  const views = [
    ["dashboard", "Dashboard"], ["marketplace", "Marketplace"], ["chat", "Chat"],
    ["tickets", "Tickets"], ["admin", "Admin"], ["skills", "Skills"], ["mcp", "MCP"],
    ["knowledge", "Knowledge"], ["schedules", "Schedules"], ["evals", "Evals"],
    ["observability", "Observability"],
    ["governance", "Governance"], ["approvals", "Aprobaciones"], ["audit", "Audit"], ["budgets", "Presupuestos"], ["playground", "Playground"], ["search", "Búsqueda"],
    ["org", "Org Chart"], ["inbox", "Bandeja"], ["activity", "Actividad"], ["login", "Login"], ["no-existe", "404"],
  ];

  if (!visible) return null;
  return (
    <div className="tweaks-panel">
      <div className="tweaks-head">
        <div className="row gap-2"><I.Sliders size={12} /> Tweaks</div>
        <button className="btn btn-ghost btn-icon" onClick={onClose}><I.Close size={13} /></button>
      </div>
      <div className="tweaks-body">
        <div className="tweak-row">
          <div className="tweak-label">Tema</div>
          <div className="tweak-chips">
            {["dark", "light"].map(t => (
              <button key={t} className={`tweak-chip ${settings.theme === t ? 'active' : ''}`} onClick={() => set('theme', t)}>
                {t === 'dark' ? <I.Moon size={10} /> : <I.Sun size={10} />} {t}
              </button>
            ))}
          </div>
        </div>

        <div className="tweak-row">
          <div className="tweak-label">Vista</div>
          <div className="tweak-chips">
            {views.map(([k, l]) => (
              <button key={k} className={`tweak-chip ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
        </div>

        <Chips label="Ver disponibilidad actual" opts={[[false, 'Diseño completo'], [true, 'Disponible hoy']]} value={avail} onPick={(v) => { S.set({ avail: v }); if (v && S.isSoon(view)) setView('chat'); }} />
        <Chips label="Cuenta de ejemplo (el rol viene de la cuenta)" opts={[["admin","Admin · finops-central"], ["owner","Creador · finops-central"], ["creator","Creador · people"], ["central","Usuario · finops-central"], ["user","Usuario · bu-finanzas"]]} value={role} onPick={(k) => { set('persona', k); S.set({ actorOverride: null }); }} />
        {role === 'admin' && <Chips label="Admin que revisa" opts={[[null, 'Usuario 1'], ['Usuario 6', 'Usuario 6 (otro admin)']]} value={actorOverride || null} onPick={(v) => S.set({ actorOverride: v })} />}
        <Chips label="Estado de la cuenta al entrar" opts={[['active', 'Con grupo'], ['nogroup', 'Sin grupo asignado'], ['temp', 'Contraseña temporal (creada por admin)'], ['noarea', 'Líder de área sin área'], ['twoareas', 'Líder de área con dos áreas']]} value={accountState} onPick={(v) => S.set({ accountState: v })} />
        <Chips label="Login · MFA" opts={authCfg.install === 'client' ? [['required', 'Obligatorio']] : [['required', 'Obligatorio'], ['optional', 'Opcional'], ['off', 'Desactivado']]} value={authCfg.mfa} onPick={(v) => S.set({ authCfg: { ...authCfg, mfa: v } })} />
        <Chips label="Login · MFA ya configurado" opts={[[true, 'Sí'], [false, 'Primer ingreso']]} value={!!authCfg.mfaEnrolled} onPick={(v) => S.set({ authCfg: { ...authCfg, mfaEnrolled: v } })} />
        <Chips label="Recargar la página" opts={[['app-hot', 'Con sesión · 0,4 s'], ['app-cold', 'Con sesión · en frío'], ['app-out', 'Tenía sesión · ya no'], ['app-fail', 'Con sesión · no responde'], ['out', 'Sin sesión'], ['out-cold', 'Sin sesión · en frío']]} value={null} onPick={(v) => window.dispatchEvent(new CustomEvent('mango:reload', { detail: v }))} />
        <Chips label="Login · al abrir la app" opts={[[null, 'Formulario'], ['otherTab', 'Cerró sesión en otra pestaña'], ['ssoReturn', 'Vuelve del SSO']]} value={S.get().simSessionBoot || null} onPick={(v) => { S.set({ simSessionBoot: v }); setView('login'); }} />
        <Chips label="Sesión · cómo ingresó" opts={[['password', 'Contraseña y MFA'], ['sso', 'SSO']]} value={S.get().loggedVia === 'sso' ? 'sso' : 'password'} onPick={(v) => S.set({ loggedVia: v })} />
        <Chips label="Sesión · aviso de vencimiento" opts={[[false, 'No'], [10, 'Vence en 10 min'], [4, 'Abrió con 4 min']]} value={S.get().simSessionWarn === true ? 10 : (S.get().simSessionWarn || false)} onPick={(v) => S.set({ simSessionWarn: v })} />
        <Chips label="Login · IdP de la empresa" opts={[['none', 'Sin IdP'], ['sso', 'Con IdP']]} value={authCfg.idp} onPick={(v) => S.set({ authCfg: { ...authCfg, idp: v } })} />
        <Chips label="Ajustes · Lista de restablecimientos MFA" opts={[[false, 'Carga'], [true, 'Error al cargar']]} value={!!S.get().mfaListErr} onPick={(v) => S.set({ mfaListErr: v })} />
        <Chips label="Ajustes · Aprobar/rechazar/retirar MFA" opts={[[false, 'Funciona'], ['generic', 'Falla'], ['409', '409 · cambió'], ['410', '410 · venció']]} value={S.get().mfaActErr || false} onPick={(v) => S.set({ mfaActErr: v })} />
        <Chips label="Datos de ejemplo" opts={[['running', 'En uso'], ['fresh', 'Instalación nueva · un solo admin']]} value={S.get().simInstall || 'running'} onPick={(v) => window.MangoPeople.setInstall(v)} />
        <Chips label="Personas · directorio" opts={[[null, 'Carga'], ['loading', 'Cargando'], ['error', 'Error al cargar'], ['truncated', 'Más grande de lo que se lee']]} value={S.get().simPeopleList || null} onPick={(v) => S.set({ simPeopleList: v })} />
        <Chips label="Personas · al actuar o invitar" opts={[[null, 'Funciona'], ['error', 'Falla'], ['busy', 'Otro cambio en curso'], ['forbidden', 'Ya no es admin']]} value={S.get().simPeopleAct || null} onPick={(v) => S.set({ simPeopleAct: v })} />
        <Chips label="Ajustes · datos de la instalación" opts={[[null, 'Cargan'], ['loading', 'Cargando'], ['error', 'Error']]} value={S.get().simInstallLoad || null} onPick={(v) => S.set({ simInstallLoad: v })} />
        <Chips label="Inicio · al cargar" opts={[[null, 'Carga'], ['loading', 'Cargando'], ['error', 'Error']]} value={S.get().simDash || null} onPick={(v) => S.set({ simDash: v })} />
        <Chips label="Inicio · desde cuándo hay datos" opts={[[null, 'Todo el periodo'], ['12d', 'Desde hace 12 días'], ['today', 'Desde hoy (instalación nueva)'], ['none', 'Antes del primer turno']]} value={S.get().simDashSince || null} onPick={(v) => S.set({ simDashSince: v })} />

        <Chips label="Builder · error del servidor al enviar" opts={[[null, 'Ninguno'], ['cycle', 'Supervisor en ciclo'], ['manager-missing', 'Supervisor no publicado'], ['model-required', 'Modelo obligatorio'], ['default-not-allowed', 'Por defecto fuera de permitidos'], ['model-disabled', 'Modelo no habilitado'], ['model-no-tools', 'Modelo sin tools'], ['tool-disabled', 'Tool no habilitada'], ['write-no-approval', 'Escritura sin aprobación'], ['group-missing', 'Grupo inexistente'], ['too-large', 'Definición muy grande'], ['accounts-users', 'Datos de cuentas con personas'], ['kb-missing', 'Knowledge base que ya no existe'], ['kb-forbidden', 'Knowledge base sin acceso'], ['skill-unapproved', 'Skill no aprobada'], ['skill-mcp-off', 'Skill con MCP no habilitado'], ['skill-mcp-missing', 'Skill sin tools de su MCP'], ['remote-not-usable', 'Servicio externo fuera de tus grupos'], ['conflict', 'Conflicto de versión'], ['forbidden', 'Sin permiso'], ['unavailable', 'Servicio no disponible'], ['network', 'Sin red'], ['daily', 'Límite diario']]} value={S.get().simBuilder || null} onPick={(v) => S.set({ simBuilder: v })} />
        <Chips label="Chat · «Qué puede usar» al abrirlo" opts={[[null, 'Carga'], ['error', 'Error al cargar']]} value={S.get().simChatPop || null} onPick={(v) => S.set({ simChatPop: v })} />
        <Chips label="Chat · progreso del turno" opts={[[null, 'Normal'], ['unnamed', 'Tool sin nombre'], ['parallel', 'Tools en paralelo · una falla'], ['guardrail', 'Corte por guardrail']]} value={S.get().simProgress || null} onPick={(v) => S.set({ simProgress: v })} />
        <Chips label="Aprobaciones · al ejecutar" opts={[[null, 'Se ejecuta'], ['fail', 'Falla'], ['not_started', 'No llega a iniciarse']]} value={S.get().simExec || null} onPick={(v) => S.set({ simExec: v })} />
        <Chips label="Catálogo de MCP · error al actuar" opts={[[null, 'Ninguno'], ['identity', 'Cambió modo de identidad'], ['generic', 'Genérico']]} value={S.get().simMcp || null} onPick={(v) => S.set({ simMcp: v })} />
        <Chips label="Marketplace · carga" opts={[[null, 'Normal'], ['loading', 'Cargando'], ['error', 'Error']]} value={S.get().simMarket || null} onPick={(v) => S.set({ simMarket: v })} />
        <Chips label="Chat · agente" opts={[[null, 'Normal'], ['none', 'Sin agentes'], ['unavailable', 'Ya no disponible'], ['retired', 'Retirado'], ['tools-missing', 'Le faltan tools'], ['central-denied', 'Tool solo centrales'], ['load-error', 'Error al cargar agentes']]} value={S.get().simChatAgent || null} onPick={(v) => S.set({ simChatAgent: v })} />
        <Chips label="Builder · Personas por correo" opts={[[null, 'Encuentra'], ['notfound', 'No está en el directorio'], ['rate', 'Demasiadas búsquedas'], ['error', 'Falla la búsqueda']]} value={S.get().simPeople || null} onPick={(v) => S.set({ simPeople: v })} />
        <Chips label="Agente retirado · limpieza" opts={[[null, 'Según el retiro'], ['running', 'En curso'], ['failed', 'Falló']]} value={S.get().simCleanup || null} onPick={(v) => S.set({ simCleanup: v })} />
        <Chips label="Brains" opts={[[null, 'Normal'], ['never', 'Catálogo sin consultar'], ['conflict', 'Error · conflicto'], ['forbidden', 'Error · sin acceso'], ['audit', 'Error · auditoría']]} value={S.get().simBrains || null} onPick={(v) => S.set({ simBrains: v })} />
        <Chips label="Revisión · estado" opts={[[null, 'Normal'], ['loading', 'Cargando'], ['load-error', 'Error al cargar'], ['rules-uneval', 'Reglas sin evaluar'], ['gone', 'Ya no en revisión']]} value={S.get().simReview || null} onPick={(v) => S.set({ simReview: v })} />
        <Chips label="Revisión · error al decidir" opts={[[null, 'Ninguno'], ['same-approver', 'Mismo aprobador'], ['changed', 'Versión cambió'], ['rules', 'Reglas incumplidas'], ['pub-unavailable', 'Publicación no disponible'], ['audit-unavailable', 'Auditoría no disponible'], ['rules-uneval', 'Reglas sin evaluar'], ['network', 'Sin red'], ['pub-not-started', 'Publicación no arrancó']]} value={S.get().simReviewDecide || null} onPick={(v) => S.set({ simReviewDecide: v })} />
        <Chips label="Chat · historial y conversación" opts={[[null, 'Normal'], ['loading', 'Cargando'], ['empty', 'Sin conversaciones'], ['history-error', 'Error historial'], ['conv-error', 'Error conversación']]} value={simChat || null} onPick={(v) => S.set({ simChat: v })} />
        <Chips label="Conectividad · resultado de la prueba" opts={[['none', 'Todo bien'], ['connerr', 'Chequeo con error'], ['apierr', 'Falla la API'], ['ratelimit', 'Límite por minuto'], ['member-fail', 'Cuentas miembro · falla'], ['member-none', 'Sin cuentas miembro'], ['member-many', 'Más de 50 cuentas']]} value={simConn || 'none'} onPick={(v) => S.set({ simConn: v })} />
        <Chips label="Conectividad · comprobación diaria" opts={[[null, 'Con problemas'], ['ok', 'Todas válidas'], ['noid', 'Rol intermedio sin exigir identidad'], ['loading', 'Leyendo'], ['error', 'No se pudo leer'], ['never', 'Aún no ha corrido']]} value={S.get().simDaily || null} onPick={(v) => S.set({ simDaily: v })} />
        <Chips label="Bandeja" opts={[[null, 'Normal'], ['loading', 'Cargando'], ['error', 'Error al cargar'], ['save', 'Falla al marcar o archivar'], ['more', 'Falla «Mostrar más»'], ['emptypage', 'Página vacía con cursor'], ['gone', 'Ejecución que ya no existe']]} value={S.get().simInbox || null} onPick={(v) => S.set({ simInbox: v })} />
        <Chips label="Gobernanza" opts={[[null, 'Normal'], ['loading', 'Cargando'], ['error', 'Error al cargar'], ['cap', 'Más de 5000 eventos en 24 h'], ['denied', 'Sin acceso (403)']]} value={S.get().simGov || null} onPick={(v) => S.set({ simGov: v })} />
        <Chips label="Actividad" opts={[[null, 'Normal'], ['loading', 'Cargando'], ['error', 'Error al cargar'], ['poll', 'Falla «En vivo»'], ['denied', 'Sin acceso (403)'], ['cap', 'Más de 1000 eventos en 7 días']]} value={S.get().simAct || null} onPick={(v) => S.set({ simAct: v })} />
        <Chips label="Playground" opts={[[null, 'Normal'], ['loading', 'Cargando agentes'], ['load-error', 'Error · agentes'], ['ver-loading', 'Cargando versión'], ['ver-error', 'Error · versión'], ['empty', 'Nada que probar'], ['off', 'No disponible en la instalación'], ['budget-user', 'Sin presupuesto · tuyo'], ['budget-agent', 'Sin presupuesto · agente'], ['rate', 'Límite de pruebas'], ['fail', 'Falla a mitad'], ['conflict', 'Borrador cambió en otra pestaña'], ['model-off', 'Modelo ya no habilitado'], ['no-tools-model', 'Modelo sin tools'], ['not-testable', 'Versión que no se prueba'], ['skill-off', 'Skill ya no aprobada'], ['skills-off', 'Dos skills ya no aprobadas'], ['skills-err', 'No se leen las skills'], ['retired', 'Agente retirado'], ['tool-fail', 'Una tool falla'], ['remote-consent', 'Falta conectar Azure DevOps']]} value={S.get().simPg || null} onPick={(v) => S.set({ simPg: v })} />
        <Chips label="Skills" opts={[[null, 'Normal'], ['loading', 'Cargando'], ['error', 'Error al cargar'], ['denied', 'Sin acceso (403)'], ['limit-skills', 'Tope de 200 skills'], ['limit-open', 'Tope de 20 propuestas']]} value={S.get().simSk || null} onPick={(v) => S.set({ simSk: v })} />
        <Chips label="Knowledge Bases · «Sincronizar ahora»" opts={[[null, 'Arranca'], ['busy', 'Ya hay una en curso']]} value={S.get().simKbSync || null} onPick={(v) => S.set({ simKbSync: v })} />
        <Chips label="Knowledge Bases · al guardar archivos" opts={[[null, 'Normal'], ['mismatch', 'Un PDF no es del tipo que dice']]} value={S.get().simKbUpload || null} onPick={(v) => S.set({ simKbUpload: v })} />
        <Chips label="Knowledge Bases · respuesta del servidor" opts={[[null, 'Normal'], ['check', 'No se pudo comprobar el bucket'], ['pending', 'Ya hay una propuesta pendiente'], ['notsent', 'Al crear · no se pudo enviar el bucket'], ['syncfail', 'No se pudo empezar la sincronización'], ['searchbusy', 'Búsqueda saturada'], ['searchfail', 'Búsqueda falla']]} value={S.get().simKbSrv || null} onPick={(v) => S.set({ simKbSrv: v })} />
        <Chips label="Knowledge Bases · tokens, fragmentos, páginas y consultas de 30 días" opts={[[false, 'El servidor no los da (hoy)'], [true, 'Con los datos']]} value={!!S.get().simKbMetrics} onPick={(v) => S.set({ simKbMetrics: v })} />
        <Chips label="Builder · lista de knowledge bases" opts={[[null, 'Carga'], ['error', 'No se pudo cargar']]} value={S.get().simKbBuilder || null} onPick={(v) => S.set({ simKbBuilder: v })} />
        <Chips label="Revisión · reglas de knowledge bases" opts={[[null, 'Se cumplen'], ['gone', 'Una ya no existe'], ['groups', 'Quien la editó no está en sus grupos']]} value={S.get().simReviewKb || null} onPick={(v) => S.set({ simReviewKb: v })} />
        <Chips label="Chat · búsqueda en knowledge bases (People Docs)" opts={[[null, 'Con fragmentos'], ['none', 'Sin fragmentos']]} value={S.get().simChatKb || null} onPick={(v) => S.set({ simChatKb: v })} />
        <div className="tweak-row"><div className="tweak-label">Knowledge Bases · subida abierta</div><div className="tweak-chips"><button className="tweak-chip" onClick={() => S.set({ kbDemoDrop: Date.now() })}>Agregar 5 archivos de ejemplo</button></div></div>
        <Chips label="Schedules · reporte PDF (Diseño completo)" opts={[[null, 'Normal'], ['dlfail', 'Falla la descarga'], ['genfail', 'Ejecutar ahora · falla el PDF']]} value={S.get().simReport || null} onPick={(v) => S.set({ simReport: v })} />
        <Chips label="Catálogo de MCP · EC2 Operations con tool destructiva y sin clasificar" opts={[[false, 'No'], [true, 'Sí']]} value={!!S.get().simDestructive} onPick={(v) => S.set({ simDestructive: v, mcpCatalog: (S.get().mcpCatalog || []).map(s => s.id !== 'aws-ec2-ops' ? s : { ...s, tools: [...s.tools.filter(t => !t.demo), ...(v ? [{ name: 'terminate_instances', write: true, destructive: true, desc: 'Terminar instancias', scope: 'org', demo: true }, { name: 'modify_instance_attribute', write: true, unclassified: true, desc: 'Cambiar atributos de una instancia', scope: 'org', demo: true }] : [])] }) })} />
        {!avail && <>
          <Chips label="Servicios externos · registro de Azure DevOps" opts={[['none', 'Sin registrar'], ['pending-other', 'Pendiente · pidió Usuario 6'], ['pending-mine', 'Pendiente · pediste tú'], ['creating', 'Creándose'], ['failed', 'Falló'], ['active', 'Habilitado'], ['scope-other', 'Cambio de grupos · pidió Usuario 6'], ['scope-mine', 'Cambio de grupos · pediste tú'], ['disabled', 'Deshabilitado']]} value={S.get().simRemoteReg || 'active'} onPick={(v) => S.set({ simRemoteReg: v, remoteRegs: window.RM.seedRegs(v, S.get().simRemoteSecret || 'd30') })} />
          <Chips label="Servicios externos · secreto de la app de Entra" opts={[['ok', 'Vigente'], ['d30', 'Vence en 21 días'], ['d7', 'Vence en 5 días'], ['expired', 'Vencido']]} value={S.get().simRemoteSecret || 'd30'} onPick={(v) => S.set({ simRemoteSecret: v, remoteRegs: (S.get().remoteRegs || []).map(r => ({ ...r, secretExp: new Date(Date.now() + window.RM.SECRET_DAYS[v] * 864e5).toISOString() })) })} />
          <Chips label="Servicios externos · tu cuenta" opts={[['none', 'Sin conectar'], ['server', 'Conectada en otra pestaña'], ['connected', 'Conectada']]} value={(c => c?.status === 'connected' ? 'connected' : c?.server ? 'server' : 'none')((S.get().remoteConn || {})['azure-devops'])} onPick={(v) => S.set({ remoteConn: { 'azure-devops': v === 'connected' ? { status: 'connected', at: new Date(Date.now() - 3 * 864e5).toISOString() } : v === 'server' ? { status: 'none', server: true, at: new Date(Date.now() - 2 * 36e5).toISOString() } : { status: 'none' } } })} />
          <Chips label="Servicios externos · al pulsar «Conectar»" opts={[[null, 'Abre Microsoft'], ['error', 'Error'], ['identity_unavailable', 'Identidad de AWS no responde'], ['rate_limited', 'Demasiados intentos'], ['popup_blocked', 'El navegador bloqueó la pestaña']]} value={S.get().simRemoteConnectErr || null} onPick={(v) => S.set({ simRemoteConnectErr: v })} />
          <Chips label="Servicios externos · al desconectar" opts={[[null, 'Se borra'], ['fail', 'No se confirma']]} value={S.get().simRemoteDisconnect || null} onPick={(v) => S.set({ simRemoteDisconnect: v })} />
          <Chips label="Bandeja · tarea con servicio externo" opts={[[null, 'Falta conectar'], ['gone', 'Ya no está en tus conexiones']]} value={S.get().simRemoteTask || null} onPick={(v) => S.set({ simRemoteTask: v })} />
          <Chips label="Builder · tools de un servicio fuera de tus grupos" opts={[[null, 'No'], ['stray', 'Sí']]} value={S.get().simBuilderRemote || null} onPick={(v) => S.set({ simBuilderRemote: v })} />
          <Chips label="Revisión · quien editó no está en los grupos del servicio" opts={[[false, 'No'], [true, 'Sí']]} value={!!S.get().simReviewRemote} onPick={(v) => S.set({ simReviewRemote: v })} />
          <Chips label="Compartir · el agente usa Azure DevOps" opts={[[false, 'No'], [true, 'Sí']]} value={!!S.get().simShareRemote} onPick={(v) => S.set({ simShareRemote: v })} />
          <Chips label="Servicios externos · al aprobar" opts={[[null, 'Se crea'], ['fail', 'Falla al crearse']]} value={S.get().simRemoteCreate || null} onPick={(v) => S.set({ simRemoteCreate: v })} />
          <Chips label="Servicios externos · al pedir o aprobar" opts={[[false, 'Funciona'], [true, 'El perfil ya no está en la versión']]} value={!!S.get().simRemoteGone} onPick={(v) => S.set({ simRemoteGone: v })} />
          <Chips label="Chat · servicio externo" opts={[[null, 'Nada'], ['consent', 'Falta conectar la cuenta'], ['consent-link', 'Falta conectar · el agente escribió un enlace'], ['expired', 'El enlace venció'], ['read', 'Respuesta que leyó Azure DevOps']]} value={S.get().simRemoteChat || null} onPick={(v) => { S.set({ simRemoteChat: v }); if (v) setView('chat'); }} />
          <Chips label="Servicios externos · el perfil trae datos de toolsets" opts={[[false, 'Sí'], [true, 'Todavía no']]} value={!!S.get().simRemoteNoTsFields} onPick={(v) => S.set({ simRemoteNoTsFields: v })} />
          <Chips label="Chat · servicio externo · conversación" opts={[[null, 'Normal'], ['busy', 'Otro turno responde'], ['later', 'Recargada · ya hay una pregunta después'], ['loading', 'Mis conexiones sin leer'], ['connfail', 'Mis conexiones falló']]} value={S.get().simRemoteTurn || null} onPick={(v) => S.set({ simRemoteTurn: v })} />
          <Chips label="Servicios externos · en la instalación" opts={[[null, 'Encendidos'], ['off', 'Apagados'], ['off-late', 'Apagados · el perfil no lo dijo']]} value={S.get().simRemoteInstall || null} onPick={(v) => S.set({ simRemoteInstall: v })} />
          <Chips label="Servicios externos · código del fallo" opts={[['target_timeout', 'target_timeout'], ['target_failed', 'target_failed'], ['other', 'Otro']]} value={S.get().simRemoteFail || 'target_timeout'} onPick={(v) => S.set({ simRemoteFail: v, remoteRegs: (S.get().remoteRegs || []).map(r => r.status === 'failed' ? { ...r, failCode: v } : r) })} />
          <Chips label="Servicios externos · al reintentar" opts={[[null, 'Se crea'], ['fail', 'Falla otra vez'], ['release_changed', 'La versión cambió'], ['busy', 'Ya en curso']]} value={S.get().simRemoteRetry || null} onPick={(v) => S.set({ simRemoteRetry: v })} />
          <Chips label="Vuelta desde Microsoft · y lo que ve tu pestaña al pulsar «Conectar»" opts={[['ok', 'Conectada'], ['relaying', 'Terminando'], ['orphan', 'Tu pestaña se cerró o cambió de sesión'], ['expired', 'Venció'], ['cancelled', 'Canceló en Microsoft (si se distingue)'], ['denied', 'Microsoft no autorizó'], ['conditional', 'Acceso condicional'], ['ambiguous', 'Dos conexiones a medias'], ['notyours', 'Enlace de otra persona'], ['error', 'Error inesperado']]} value={S.get().simRemoteReturn || 'ok'} onPick={(v) => { S.set({ simRemoteReturn: v, remoteReturn: S.get().remoteReturn || { pid: 'azure-devops', from: 'connections' } }); setView('connect-return'); }} />
        </>}
        <div className="tweak-row">
          <div className="tweak-label">Simular error</div>
          <div className="tweak-chips">
            {[[null,"Ninguno"],["network","Red"],["401","401"],["403","403"],["timeout","Timeout"],["crash","Crash"]].map(([k,l]) => (
              <button key={l} className={`tweak-chip ${simError === k ? 'active' : ''}`} onClick={() => window.MangoStore.set({ simError: k })}>{l}</button>
            ))}
          </div>
        </div>

        <div className="tweak-row">
          <div className="tweak-label">Densidad</div>
          <div className="tweak-chips">
            {["comfortable", "compact"].map(d => (
              <button key={d} className={`tweak-chip ${settings.density === d ? 'active' : ''}`} onClick={() => set('density', d)}>{d}</button>
            ))}
          </div>
        </div>

        <div className="tweak-row">
          <div className="tweak-label">Escenario de agente</div>
          <div className="tweak-chips">
            {[["running","Running"],["paused","Paused"],["budget80","Budget 80%"],["budget100","Auto-pause"]].map(([k,l]) => (
              <button key={k} className={`tweak-chip ${settings.scenario === k ? 'active' : ''}`} onClick={() => set('scenario', k)}>{l}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const { user, agents: initialAgents, threads, tickets, mcpServers, models: initialModels, groups, activity, skills, schedules, evals, knowledgeBases } = window.MangoData;
  const I = window.Icons;
  const [agents, setAgents] = useState(initialAgents);
  const agentsRef = React.useRef(agents); agentsRef.current = agents;
  useEffect(() => {
    const h = (e) => {
      const { agentId, snap, isNew } = e.detail;
      const servers = [...new Set((snap.tools || []).map(t => t.split('.')[0]))];
      setAgents(prev => isNew
        ? [...prev, { id: agentId, name: snap.name, desc: snap.desc, cat: snap.cat || 'Productivity', icon: snap.icon || 'Bot', iconBg: '#8b5cf622', iconColor: '#a78bfa', caps: [], mcp: servers, status: 'online', budget: 0, budgetMax: window.MangoStore.get().govBudgets?.defaults?.agent ?? snap.budget, budgetDefault: true, tickets: 0, model: snap.model, availableModels: snap.allowedModels || [snap.model], manager: snap.manager || 'platform', role: snap.role || '', groups: snap.groups, kbs: snap.kbs || [], prompt: snap.prompt, limits: snap.limits }]
        : prev.map(x => x.id === agentId ? { ...x, name: snap.name, desc: snap.desc, manager: snap.manager || x.manager, role: snap.role ?? x.role, model: snap.model, availableModels: snap.allowedModels || x.availableModels, mcp: servers, groups: snap.groups, kbs: snap.kbs || x.kbs, prompt: snap.prompt, limits: snap.limits } : x));
    };
    const hs = (e) => { const { agentId, shares } = e.detail; setAgents(prev => prev.map(x => x.id === agentId ? { ...x, shares, groups: shares.everyone ? [...shares.groups.map(g => g.id).filter(g => g !== 'all-staff')] : shares.groups.map(g => g.id) } : x)); };
    window.addEventListener('mango:agent-published', h);
    window.addEventListener('mango:share-approved', hs);
    return () => { window.removeEventListener('mango:agent-published', h); window.removeEventListener('mango:share-approved', hs); };
  }, []);
  const [models, setModels] = useState(initialModels);

  const S = window.MangoStore;
  const R = window.MangoRouter;
  const availNow = window.useMango(st => st.avail);
  const role = window.useMango(st => st.role);
  const lang = window.useMango(st => st.lang);
  const simError = window.useMango(st => st.simError);
  const initialRoute = R.parse();
  const [view, setViewRaw] = useState(() => initialRoute.view || localStorage.getItem('mango-view') || 'login');
  const [routeParam, setRouteParam] = useState(initialRoute.param);
  const setView = (v, param = null) => { setViewRaw(v); setRouteParam(param); };
  window.MangoNav = setView;
  const [loggedIn, setLoggedIn] = useState(false);
  // Recargar: un aviso local (sí o no) elige qué se pinta al instante; no decide autorización. Sin texto en ningún caso.
  const [boot, setBoot] = useState(null);
  useEffect(() => {
    const h = (e) => { const k = e.detail; const back = view; setBoot(k);
      setTimeout(() => { if (k === 'app-fail') { setBoot('fail'); return; } setBoot(null); if (k === 'app-hot' || k === 'app-cold') { setLoggedIn(true); setView(back === 'login' ? (S.get().avail ? 'chat' : 'dashboard') : back); } else { S.set({ simSessionBoot: k === 'app-out' ? 'ended' : null }); setLoggedIn(false); setView('login'); } }, k.endsWith('cold') || k === 'app-fail' ? 2800 : k === 'app-out' ? 900 : 400); };
    window.addEventListener('mango:reload', h); return () => window.removeEventListener('mango:reload', h);
  }, [view]);
  const [activeAgentId, setActiveAgentId] = useState("fin-01");
  const [activeThreadId, setActiveThreadIdRaw] = useState(initialRoute.view === 'chat' && initialRoute.param ? initialRoute.param : "t1");
  const setActiveThreadId = (id) => { setActiveThreadIdRaw(id); };
  const isNarrow = window.useMedia('(max-width: 1200px)');
  const isMobile = window.useMedia('(max-width: 900px)');
  const [mobileNav, setMobileNav] = useState(false);
  const [tour, setTour] = useState(false);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { document.documentElement.setAttribute('data-density', settings.density || 'comfortable'); });
  useEffect(() => {
    const h = () => setMobileNav(true), g = (e) => setView(e.detail), tt = () => setTour(true), lo = () => { setLoggedIn(false); setView('login'); history.replaceState(null, '', location.pathname); };
    window.addEventListener('mango:open-nav', h); window.addEventListener('mango:go', g); window.addEventListener('mango:tour', tt); window.addEventListener('mango:logout', lo);
    return () => { window.removeEventListener('mango:open-nav', h); window.removeEventListener('mango:go', g); window.removeEventListener('mango:tour', tt); window.removeEventListener('mango:logout', lo); };
  }, []);
  const [visited, setVisited] = useState(() => { try { return JSON.parse(localStorage.getItem('mango-visited') || '[]'); } catch { return []; } });
  useEffect(() => { if (view && !visited.includes(view)) { const n = [...visited, view]; setVisited(n); localStorage.setItem('mango-visited', JSON.stringify(n)); } }, [view]);
  // Deep links: state → hash
  useEffect(() => {
    if (view === 'login') return;
    const param = view === 'chat' ? activeThreadId : view === 'admin' ? routeParam : routeParam;
    R.go(view, param);
  }, [view, activeThreadId, routeParam]);
  // hash → state (back/forward, pasted URLs)
  useEffect(() => {
    const h = () => {
      const r = R.parse();
      if (!r.view) return;
      setViewRaw(r.view); setRouteParam(r.param);
      if (r.view === 'chat' && r.param) {
        const th = threads.find(x => x.id === r.param);
        if (th) setActiveAgentId(th.agentId);
        setActiveThreadIdRaw(r.param);
      }
    };
    window.addEventListener('popstate', h); window.addEventListener('hashchange', h);
    return () => { window.removeEventListener('popstate', h); window.removeEventListener('hashchange', h); };
  }, []);
  useEffect(() => {
    if (initialRoute.view === 'chat' && initialRoute.param) { const th = threads.find(x => x.id === initialRoute.param); if (th) setActiveAgentId(th.agentId); }
  }, []);
  const [sbCollapsed, setSbCollapsed] = useState(() => localStorage.getItem('mango-sb-collapsed') === '1');
  const [pinnedIds, setPinnedIds] = useState(() => {
    try { const d = window.MangoStore.get().avail ? '["fin-01"]' : '["fin-01","dev-01","sec-01"]'; return JSON.parse(localStorage.getItem('mango-pinned-agents') || d); }
    catch { return ["fin-01","dev-01","sec-01"]; }
  });
  useEffect(() => { localStorage.setItem('mango-sb-collapsed', sbCollapsed ? '1' : '0'); }, [sbCollapsed]);
  useEffect(() => { localStorage.setItem('mango-pinned-agents', JSON.stringify(pinnedIds)); }, [pinnedIds]);
  const [settings, setSettings] = useState(EDIT_DEFAULTS);
  const [tweaksVisible, setTweaksVisible] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme || 'dark');
  }, [settings.theme]);

  useEffect(() => {
    if (view !== 'login') localStorage.setItem('mango-view', view);
  }, [view]);

  // Host edit-mode integration
  useEffect(() => {
    const handler = (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === '__activate_edit_mode') setTweaksVisible(true);
      if (e.data.type === '__deactivate_edit_mode') setTweaksVisible(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    const h = () => {
      const next = settings.theme === 'dark' ? 'light' : 'dark';
      setSettings({ ...settings, theme: next });
    };
    window.addEventListener('mango:toggle-theme', h);
    return () => window.removeEventListener('mango:toggle-theme', h);
  }, [settings]);

  useEffect(() => {
    const h = (e) => {
      const id = e.detail;
      setActiveAgentId(id);
      // Jump to the agent's default seeded thread if there is one
      const defaultThread = (window.agentSeeds || {})[id] || null;
      setActiveThreadId(defaultThread);
      setView('chat');
    };
    window.addEventListener('mango:chat-agent', h);
    const hNew = () => { setActiveThreadId(null); setView('chat'); };
    window.addEventListener('mango:new-chat', hNew);
    const hPick = () => { const S = window.MangoStore; if (S.get().avail && agentsRef.current.length <= 1) { window.dispatchEvent(new CustomEvent('mango:chat-agent', { detail: 'fin-01' })); return; } setAgentPickerOpen(true); };
    window.addEventListener('mango:pick-agent', hPick);
    const hNewAgent = () => setView('admin');
    const hEdit = (e) => setView('admin', e.detail);
    window.addEventListener('mango:edit-agent', hEdit);
    window.addEventListener('mango:new-agent', hNewAgent);
    return () => {
      window.removeEventListener('mango:chat-agent', h);
      window.removeEventListener('mango:new-chat', hNew);
      window.removeEventListener('mango:pick-agent', hPick);
      window.removeEventListener('mango:new-agent', hNewAgent);
    };
  }, []);

  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdk(x => !x); }
    };
    window.addEventListener('keydown', h);
    const h2 = () => setCmdk(true);
    window.addEventListener('mango:cmdk', h2);
    return () => { window.removeEventListener('keydown', h); window.removeEventListener('mango:cmdk', h2); };
  }, []);

  const openChat = (agentId, threadId) => {
    setActiveAgentId(agentId);
    const t = threadId !== undefined ? threadId : ((window.agentSeeds || {})[agentId] || null);
    setActiveThreadId(t);
    setView('chat');
  };

  const rmRet = window.useMango(s => s.simRemoteReturn);
  if (view === 'connect-return' && !S.get().avail && window.RemoteReturn) {
    return <window.ToastProvider><window.RemoteReturn setView={setView} /><TweaksPanel visible={tweaksVisible} onClose={() => setTweaksVisible(false)} settings={settings} setSettings={setSettings} view={view} setView={setView} /></window.ToastProvider>;
  }
  if (boot) return <BootScreen had={boot.startsWith('app')} fail={boot === 'fail'} onRetry={() => window.dispatchEvent(new CustomEvent('mango:reload', { detail: 'app-hot' }))} onSignOut={() => { setBoot(null); S.set({ simSessionBoot: null }); setLoggedIn(false); setView('login'); }} />;
  if (view === 'login') {
    return <>
      <Login onLogin={() => { setLoggedIn(true); S.log('account.login', user.email, 'Inició sesión'); setView(S.get().avail ? 'chat' : 'dashboard'); }} />
      <TweaksPanel visible={tweaksVisible} onClose={() => setTweaksVisible(false)} settings={settings} setSettings={setSettings} view={view} setView={setView} />
    </>;
  }

  let content;
  switch (view) {
    case 'dashboard': content = <Dashboard agents={agents} tickets={tickets} setView={setView} openChat={openChat} />; break;
    case 'marketplace': content = <Marketplace agents={agents} setAgents={setAgents} setView={setView} openChat={openChat} pinnedIds={pinnedIds} setPinnedIds={setPinnedIds} editAgent={(id) => setView('admin', id)} />; break;
    case 'chat': content = <Chat agents={agents} activeAgentId={activeAgentId} setActiveAgentId={setActiveAgentId} threads={threads} activeThreadId={activeThreadId} setActiveThreadId={setActiveThreadId} />; break;
    case 'tickets': content = <Tickets tickets={tickets} agents={agents} initialOpenId={routeParam} onOpenChange={(id) => setRouteParam(id)} />; break;
    case 'admin': content = <AgentAdmin key={routeParam || 'new'} routeId={routeParam} editingId={routeParam && agents.some(a => a.id === routeParam) ? routeParam : null} agents={agents} setAgents={setAgents} mcpServers={mcpServers} models={models} groups={groups} setView={setView} />; break;
    case 'approvals': content = <window.ApprovalsView agents={agents} openChat={openChat} />; break;
    case 'audit': content = <window.AuditLog />; break;
    case 'budgets': content = <window.BudgetsView agents={agents} />; break;
    case 'playground': content = <window.Playground agents={agents} models={models} />; break;
    case 'search': content = <window.GlobalSearch threads={threads} agents={agents} openChat={openChat} />; break;
    case 'governance': content = <Governance tickets={tickets} agents={agents} activity={activity} />; break;
    case 'org': content = <OrgChart agents={agents} />; break;
    case 'inbox': content = <Inbox tickets={tickets} agents={agents} setView={setView} openChat={openChat} />; break;
    case 'activity': content = <window.ActivityView agents={agents} openChat={openChat} />; break;
    case 'skills': content = <window.SkillsCatalog agents={agents} />; break;
    case 'mcp': content = <window.McpCatalog agents={agents} setView={setView} />; break;
    case 'review': content = <window.AgentReview agents={agents} setView={setView} />; break;
    case 'models': content = <window.ModelsView models={models} setModels={setModels} agents={agents} />; break;
    case 'schedules': content = <window.SchedulesView agents={agents} />; break;
    case 'evals': content = <window.EvalsView agents={agents} />; break;
    case 'observability': content = <window.ObservabilityView agents={agents} openChat={openChat} />; break;
    case 'knowledge': content = <window.KnowledgeView agents={agents} />; break;
    case 'costs': content = <window.CostsView agents={agents} />; break;
    case 'connect-return': content = window.RemoteReturn ? <window.RemoteReturn setView={setView} /> : null; break;
    case 'settings': content = <Settings models={models} mcpServers={mcpServers} groups={groups} initialTab={routeParam} />; break;
    default: content = null;
  }
  const notFound = content === null;
  const home = () => { S.set({ simError: null }); setView('chat'); };
  const viewLabel = (v) => v === 'dashboard' ? 'Inicio' : window.t('nav.' + v);
  if (notFound) content = <><Topbar crumbs={[window.t('err.notfound.t')]} /><window.ErrorState kind="notfound" view={view} onHome={home} /></>;
  else if (view === 'connect-return' && !availNow) {}
  else if (S.isSoon(view)) content = <window.SoonView view={view} label={viewLabel(view)} />;
  else if (!S.canView(view) && ['audit', 'budgets', 'settings', 'governance', 'skills', 'playground'].includes(view)) content = <><Topbar crumbs={[viewLabel(view)]} /><div className="content"><window.GovKit.Denied view={view} /></div></>;
  else if (!S.canView(view)) content = <><Topbar crumbs={[viewLabel(view)]} /><window.ErrorState kind="403" view={view} onHome={home} /></>;
  else if (simError === 'crash') { const Boom = () => { throw new Error("Cannot read properties of undefined (reading 'budgetMax')"); }; content = <Boom />; }
  else if (simError) content = <><Topbar crumbs={[viewLabel(view)]} /><window.ErrorState kind={simError} view={view} onHome={home} onRetry={() => S.set({ simError: null })} onLogin={() => { S.set({ simError: null, simSessionBoot: 'ended' }); setView('login'); }} /></>;
  const sessWarn = S.get().simSessionWarn;
  const closeTour = () => { setTour(false); localStorage.setItem('mango-onboarded', '1'); };

  return (
    <window.ToastProvider>
    <div className={`app ${(sbCollapsed || isNarrow) && !isMobile ? 'app-sb-collapsed' : ''} ${isMobile ? 'app-mobile' : ''}`}>
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>{window.t('sb.skip')}</a>
      <Sidebar view={view} setView={setView} agents={agents} user={user} collapsed={sbCollapsed || isNarrow} setCollapsed={setSbCollapsed} pinnedIds={pinnedIds} setPinnedIds={setPinnedIds} openChat={openChat} threads={threads} mobile={isMobile} mobileOpen={mobileNav} setMobileOpen={setMobileNav} onTour={() => setTour(true)} />
      <main className="main" id="main" tabIndex={-1} data-screen-label={view}>
        <window.OfflineBanner />
        {sessWarn && <div className="sess-warn" role="status"><window.Icons.Clock size={14} /><span style={{ flex: 1, minWidth: 0 }}><b>{'Tu sesión vence en ' + (sessWarn === true ? 10 : sessWarn) + ' min.'}</b> Guarda lo que estés escribiendo: al vencer vuelves a ingresar{S.get().loggedVia === 'sso' ? '' : ' con tu contraseña y MFA'}.</span><button className="btn btn-sm btn-ghost" onClick={() => S.set({ simSessionWarn: false })}>Entendido</button></div>}
        <window.ErrorBoundary resetKey={view + (simError || '')} view={view} onHome={home}>{content}</window.ErrorBoundary>
      </main>
      {view === 'dashboard' && !availNow && <window.SetupGuide onOpenTour={() => setTour(true)} onGo={(v) => v === '__tour' ? setTour(true) : setView(v)} steps={[
        { label: 'Conoce Mango en 1 minuto', view: '__tour', done: !!localStorage.getItem('mango-onboarded') },
        { label: 'Fija tus agentes', view: 'marketplace', done: visited.includes('marketplace') },
        { label: 'Inicia una conversación', view: 'chat', done: visited.includes('chat') },
        { label: role === 'user' ? 'Revisa tus aprobaciones' : 'Configura un presupuesto', view: role === 'user' ? 'approvals' : 'budgets', done: visited.includes(role === 'user' ? 'approvals' : 'budgets') },
      ]} />}
      {window.MyConnections && <window.MyConnections />}
      <window.Onboarding open={tour} onClose={closeTour} setView={(v) => { closeTour(); setView(v); }} role={role} />
      <TweaksPanel visible={tweaksVisible} onClose={() => setTweaksVisible(false)} settings={settings} setSettings={setSettings} view={view} setView={setView} />
      <window.CmdK open={cmdk} onClose={() => setCmdk(false)} agents={agents} tickets={tickets} threads={threads} setView={setView} openChat={openChat} />
      <window.AgentPicker open={agentPickerOpen} onClose={() => setAgentPickerOpen(false)} agents={agents} threads={threads} openChat={(id) => { openChat(id); setActiveThreadId(null); }} />
    </div>
    </window.ToastProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
