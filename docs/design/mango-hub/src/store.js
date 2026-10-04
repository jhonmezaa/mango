// Global store (pub/sub) for cross-cutting governance state: role, lang, audit, approvals, versions, budgets.
(function () {
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const now = () => new Date();
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ('00000000' + (h >>> 0).toString(16)).slice(-8); };

  // label: según el grupo (mango-admin → Admin; mango-agent-creator → Creador de agentes; resto → Usuario). groups: grupos reales de Cognito.
  const ROLES = {
    admin: { label: 'Admin', admin: true, creator: true, central: true, groups: ['mango-admin', 'finops-central'] },
    owner: { label: 'Creador de agentes', creator: true, central: true, groups: ['mango-agent-creator', 'finops-central'] },
    central: { label: 'Usuario', central: true, groups: ['finops-central'] },
    user: { label: 'Usuario', area: 'finanzas', groups: ['bu-lead', 'bu-finanzas'] },
    creator: { label: 'Creador de agentes', creator: true, groups: ['mango-agent-creator', 'people'] },
  };
  const USER_VIEWS = ['chat', 'inbox', 'dashboard', 'marketplace', 'tickets', 'activity', 'search', 'approvals', 'org'];
  const OWNER_VIEWS = [...USER_VIEWS, 'governance', 'playground', 'admin', 'budgets', 'evals', 'observability', 'costs', 'skills', 'knowledge', 'schedules', 'mcp'];
  const CREATOR_VIEWS = [...USER_VIEWS, 'admin', 'mcp'];
  const PERMS = {
    admin: { views: '*', actions: '*' },
    owner: { views: OWNER_VIEWS, actions: ['agent.edit', 'agent.create', 'agent.clone', 'approval.decide', 'budget.view', 'playground.publish', 'version.rollback'] },
    user: { views: USER_VIEWS, actions: [] },
    central: { views: USER_VIEWS, actions: [] },
    creator: { views: CREATOR_VIEWS, actions: ['agent.edit', 'agent.create', 'agent.clone'] },
  };

  const seedAudit = [
    { actor: 'Usuario 1', role: 'admin', action: 'agent.update', target: 'fin-01', detail: 'Cambió el presupuesto de USD 2.500,00 a USD 3.000,00', before: { budgetMax: 2500 }, after: { budgetMax: 3000 }, outcome: 'applied', at: ago(18) },
    { actor: 'Usuario 4', role: 'user', action: 'chat.query', target: 'fin-01', perm: 'agent.invoke', turn: 'TRN-5102', detail: 'Preguntó a FinOps · consultó Cost Explorer (3 llamadas) · costo USD 0,04', after: { llamadas: 3, costo: 'USD 0,04' }, agentVersion: 3, model: 'us.anthropic.claude-sonnet-4-6-v1:0', at: ago(22) },
    { actor: 'Usuario 4', role: 'user', action: 'access.view', target: 'agent.invoke', turn: 'TRN-5102', detail: 'Usar agente fin-01 · permitido', at: ago(22.1) },
    { actor: 'Usuario 4', role: 'user', action: 'agent.invoke', target: 'fin-01', turn: 'TRN-5102', detail: 'Inició un turno con FinOps', at: ago(22.2) },
    { actor: 'Usuario 1', role: 'admin', action: 'access.view', target: 'admin.view', detail: 'Ver administración · permitido', read: true, at: ago(26) },
    { actor: 'Usuario 7', role: 'user', action: 'access.denied', target: 'agent.invoke', turn: 'TRN-5099', detail: 'Usar agente fin-01 · denegado (403) · sin grupo con acceso', at: ago(40) },
    { actor: 'Usuario 7', role: 'user', action: 'agent.invoke', target: 'fin-01', turn: 'TRN-5099', detail: 'Inició un turno con FinOps', at: ago(40.1) },
    { actor: 'FinOps', role: 'agent', action: 'approval.request', target: 'APR-208', detail: 'Solicitó aplicar lifecycle policy en events-ingest', outcome: 'requested', at: ago(34) },
    { actor: 'Usuario 4', role: 'user', action: 'access.denied', target: 'audit.view', detail: 'Ver auditoría · denegado (403)', at: ago(52) },
    { actor: 'Usuario 3', role: 'owner', action: 'access.view', target: 'groups.view', detail: 'Ver grupos · permitido', read: true, at: ago(58) },
    { actor: 'Usuario 1', role: 'admin', action: 'agent.publish_failed', target: 'agt_release', detail: 'La publicación de Release Notes Writer venció (publication_expired)', outcome: 'rejected', error: 'publication_expired', at: ago(70) },
    { actor: 'Usuario 1', role: 'admin', action: 'model.catalog_sync', target: 'bedrock', detail: 'Consultó el catálogo de Bedrock · sin modelos nuevos', outcome: 'applied', at: ago(42) },
    { actor: 'Usuario 6', role: 'lead_admin', action: 'access.view', target: 'audit.view', detail: 'Ver auditoría · permitido', read: true, at: ago(64) },
    { actor: 'Usuario 6', role: 'lead_admin', action: 'approval.approve', target: 'APR-205', detail: 'Aprobó rollback de prod-web a deploy 340 (pedido por Usuario 2)', outcome: 'applied', at: ago(95) },
    { actor: 'Usuario 1', role: 'admin', action: 'mcp.connect', target: 'guardduty', detail: 'Conectó MCP server con AWS IAM role', outcome: 'applied', at: ago(160) },
    { actor: 'Usuario 3', role: 'owner', action: 'agent.update', target: 'dev-01', detail: 'Cambió el límite de tokens por turno de 8.000 a 16.000', before: { maxTokens: 8000 }, after: { maxTokens: 16000 }, outcome: 'rejected', error: 'VERSION_CONFLICT', at: ago(300) },
    { actor: 'Usuario 5', role: 'user', action: 'access.view', target: 'agent.invoke', turn: 'TRN-5094', detail: 'Usar agente fin-01 · permitido · el turno no terminó (tiempo de espera de Cost Explorer)', at: ago(120) },
    { actor: 'Usuario 5', role: 'user', action: 'agent.invoke', target: 'fin-01', turn: 'TRN-5094', detail: 'Inició un turno con FinOps', at: ago(120.1) },
    { actor: 'Usuario 6', role: 'lead_admin', action: 'chat.query', target: 'fin-01', perm: 'agent.invoke', turn: 'TRN-5090', detail: 'Preguntó a FinOps · consultó Cost Explorer (5 llamadas) · costo USD 0,07', after: { llamadas: 5, costo: 'USD 0,07' }, agentVersion: 3, model: 'us.anthropic.claude-sonnet-4-6-v1:0', at: ago(190) },
    { actor: 'Usuario 6', role: 'lead_admin', action: 'access.view', target: 'agent.invoke', turn: 'TRN-5090', detail: 'Usar agente fin-01 · permitido', at: ago(190.1) },
    { actor: 'Usuario 6', role: 'lead_admin', action: 'agent.invoke', target: 'fin-01', turn: 'TRN-5090', detail: 'Inició un turno con FinOps', at: ago(190.2) },
    { actor: 'Sistema', role: 'system', action: 'budget.alert', target: 'fin-01', detail: 'FinOps llegó al 80% del límite por defecto (USD 24,00 de USD 30,00)', at: ago(220) },
    { actor: 'Usuario 3', role: 'owner', action: 'agent.rollback', target: 'dev-01', detail: 'Restauró versión v6 del system prompt', before: { version: 7 }, after: { version: 6 }, outcome: 'applied', at: ago(410) },
    { actor: 'usuario1@empresa.com', role: 'admin', action: 'directory.group_add', target: 'usuario4@empresa.com', detail: 'Agregó a usuario4@empresa.com al grupo bu-finanzas', outcome: 'applied', at: ago(640) },
    { actor: 'usuario1@empresa.com', role: 'admin', action: 'policy.decision', target: 'ManagePeople', detail: 'Gestionar personas · permitido', at: ago(640.01) },
    { actor: 'usuario1@empresa.com', role: 'admin', action: 'directory.group_add', target: 'usuario4@empresa.com', detail: 'Pidió agregar a usuario4@empresa.com al grupo bu-finanzas', outcome: 'requested', at: ago(640.02) },
    { actor: 'usuario6@empresa.com', role: 'lead_admin', action: 'directory.member_reject', target: 'usuario12@empresa.com', detail: 'Rechazó 18106de3 — "ya no está en el equipo"', outcome: 'applied', at: ago(700) },
    { actor: 'Sec Guardian', role: 'agent', action: 'tool.execute', target: 'ec2.modify_security_group', detail: 'Bloqueó una IP externa tras la aprobación de Usuario 1', outcome: 'applied', at: ago(900) },
    { actor: 'Usuario 2', role: 'owner', action: 'approval.reject', target: 'APR-201', detail: 'Rechazó terminar instancias i-0a8b* — "falta ventana de mantenimiento"', at: ago(1300) },
    { actor: 'Usuario 1', role: 'admin', action: 'settings.update', target: 'auth', detail: 'Activó MFA obligatorio para admins', outcome: 'applied', at: ago(2100) },
    { actor: 'Sistema', role: 'system', action: 'budget.pause', target: 'data-01', detail: 'Auto-pausa al 100% del presupuesto', outcome: 'applied', at: ago(2900) },
    { actor: 'Usuario 3', role: 'owner', action: 'skill.create', target: 'rightsizing-ecs', detail: 'Creó skill "Rightsizing ECS"', outcome: 'applied', at: ago(3600) },
  ];
  let prev = 'genesis';
  const audit = seedAudit.slice().reverse().map((e, i) => { const id = 'AUD-' + (4100 + i); const h = hash(prev + id + e.action + e.at); prev = h; return { id, hash: h, ...e }; }).reverse();

  const approvals = [
    { id: 'APR-208', agent: 'fin-01', action: 'Aplicar lifecycle policy a Intelligent-Tiering', tool: 's3.put_bucket_lifecycle_configuration', params: { bucket: 'events-ingest', env: 'staging', transitionDays: 30, storageClass: 'INTELLIGENT_TIERING' }, risk: 'medium', policy: 'Escritura sobre recursos S3 > 1 TB', impact: 'Ahorro estimado $1,100/mes · reversible', requestedBy: 'Usuario 1', threadId: 't2', at: ago(34), expiresMin: 1406, status: 'pending' },
    { id: 'APR-207', agent: 'dev-01', action: 'Reasignar manual approval de Deploy-Prod', tool: 'codepipeline.put_approval_result', params: { pipeline: 'prod-web', execution: '341', approver: 'usuario3' }, risk: 'high', policy: 'Cambios en pipelines de producción', impact: 'Desbloquea deploy 341 · afecta prod-web', requestedBy: 'Usuario 2', threadId: 't3', at: ago(52), expiresMin: 188, status: 'pending' },
    { id: 'APR-206', agent: 'sec-01', action: 'Aislar instancia con finding Recon:EC2/Portscan', tool: 'ec2.modify_instance_attribute', params: { instanceId: 'i-0f31c9e2', securityGroups: ['sg-quarantine'] }, risk: 'high', policy: 'Acciones de contención en EC2', impact: 'La instancia deja de recibir tráfico', requestedBy: 'Sec Guardian (autónomo)', threadId: 't6', at: ago(70), expiresMin: 50, status: 'pending' },
    { id: 'APR-204', agent: 'sap-01', action: 'Liberar pago a Proveedor 1', tool: 'sap-s4-hana.release_payment', params: { po: '47721', amount: 42800, currency: 'USD' }, risk: 'high', policy: 'Pagos mayores a USD 10.000 requieren doble aprobación', impact: '$42,800 USD · irreversible', requestedBy: 'Usuario 4', threadId: 't7', at: ago(140), expiresMin: 2740, status: 'pending', approvalsNeeded: 2, approvalsGiven: ['Usuario 2'] },
    { id: 'APR-205', agent: 'dev-01', action: 'Rollback prod-web a deploy 340', tool: 'codepipeline.rollback', params: { pipeline: 'prod-web', to: '340' }, risk: 'high', policy: 'Cambios en pipelines de producción', impact: 'Revierte 3 commits', requestedBy: 'Usuario 2', at: ago(120), expiresMin: 1440, status: 'approved', decidedBy: 'Usuario 6', approvalsGiven: ['Usuario 6'], decidedAt: ago(95) },
    { id: 'APR-203', agent: 'fin-01', action: 'Eliminar 14 snapshots EBS huérfanos', tool: 'ec2.delete_snapshots', params: { count: 14, env: 'staging' }, risk: 'medium', policy: 'Escritura sobre recursos de staging', impact: 'Ahorro estimado $310/mes · irreversible', requestedBy: 'Usuario 1', threadId: 't2', at: ago(220), expiresMin: 1440, status: 'approved', decidedBy: 'Usuario 6', approvalsGiven: ['Usuario 6'], decidedAt: ago(180) },
    { id: 'APR-202', agent: 'fin-01', action: 'Detener 3 instancias de desarrollo fuera de horario', tool: 'ec2.stop_instances', params: { ids: ['i-0c41a1', 'i-0c41a2', 'i-0c41a3'], env: 'dev' }, risk: 'low', policy: 'Escritura sobre recursos de desarrollo', requestedBy: 'Usuario 3', at: ago(900), expiresMin: 1440, status: 'executed', decidedBy: 'Usuario 1', approvalsGiven: ['Usuario 1'], decidedAt: ago(860), executedAt: ago(840) },
    { id: 'APR-200', agent: 'fin-01', action: 'Cambiar clase de almacenamiento de logs-archive', tool: 's3.put_bucket_lifecycle_configuration', params: { bucket: 'logs-archive', storageClass: 'GLACIER_IR' }, risk: 'medium', policy: 'Escritura sobre recursos S3 > 1 TB', requestedBy: 'Usuario 2', at: ago(3200), expiresMin: 1440, status: 'expired', decidedAt: ago(3200 - 1440) },
    { id: 'APR-201', agent: 'ops-01', action: 'Terminar 6 instancias idle', tool: 'ec2.terminate_instances', params: { ids: ['i-0a8b01', 'i-0a8b02', '…'] }, risk: 'high', policy: 'Acciones destructivas en EC2', impact: 'Irreversible', requestedBy: 'Ops Pilot (schedule)', at: ago(1400), status: 'rejected', decidedBy: 'Usuario 2', decidedAt: ago(1300), note: 'Falta ventana de mantenimiento' },
  ];

  const basePrompt = '# Instrucciones\n\nEres FinOps. Analiza costos AWS con Cost Explorer y Compute Optimizer.\nUsa siempre formato tabular para comparativos.\nNo inventes números.';
  const versions = {
    'fin-01': [
      { v: 3, at: ago(18), author: 'Usuario 1', note: 'Sube budget y añade regla de executive summary', snapshot: { manager: 'platform', role: 'FinOps lead', model: 'Sonnet 4.6', budgetMax: 3000, mcp: ['aws-cost-explorer', 'compute-optimizer'], caps: ['Cost Analysis', 'Budget Monitoring', 'Rightsizing'], prompt: basePrompt + '\nCuando pidan reportes de fin de Q, formatea como executive summary.' } },
      { v: 2, at: ago(4300), author: 'Usuario 3', note: 'Agrega Compute Optimizer', snapshot: { manager: 'platform', role: 'FinOps lead', model: 'Sonnet 4.6', budgetMax: 2500, mcp: ['aws-cost-explorer', 'compute-optimizer'], caps: ['Cost Analysis', 'Budget Monitoring'], prompt: basePrompt } },
      { v: 1, at: ago(14000), author: 'Usuario 1', note: 'Versión inicial', snapshot: { manager: 'platform', role: 'Análisis de costos', model: 'Haiku 4.5', budgetMax: 2000, mcp: ['aws-cost-explorer'], caps: ['Cost Analysis'], prompt: '# Instrucciones\n\nEres FinOps. Analiza costos AWS con Cost Explorer.\nNo inventes números.' } },
    ],
  };

  const budgets = [
    { id: 'B-01', scope: 'agent', target: 'fin-01', limit: 3000, spent: 2400, warn: 80, action: 'alert', channel: '#finops-alerts' },
    { id: 'B-02', scope: 'agent', target: 'dev-01', limit: 2000, spent: 1180, warn: 80, action: 'pause', channel: '#dev-alerts' },
    { id: 'B-03', scope: 'agent', target: 'data-01', limit: 1500, spent: 1500, warn: 75, action: 'pause', channel: '#data' },
    { id: 'B-04', scope: 'agent', target: 'sec-01', limit: 2500, spent: 940, warn: 80, action: 'approval', channel: '#security' },
    { id: 'B-05', scope: 'team', target: 'FinOps', limit: 6000, spent: 4120, warn: 80, action: 'alert', channel: '#finops-alerts' },
    { id: 'B-06', scope: 'team', target: 'DevOps', limit: 5000, spent: 4310, warn: 85, action: 'approval', channel: '#dev-alerts' },
    { id: 'B-07', scope: 'team', target: 'Security', limit: 4000, spent: 1900, warn: 80, action: 'alert', channel: '#security' },
  ];

  const changes = [
    { id: 'CHG-15', kind: 'mfa_reset', key: 'mfa_reset', target: 'usuario3@empresa.com', from: null, to: null, title: 'Restablecer MFA de usuario3@empresa.com', summary: 'Borra su MFA y cierra todas sus sesiones', by: 'Usuario 6', at: ago(15), reason: 'Cambió de teléfono y perdió la app autenticadora.', verified: true, status: 'pending' },
    { id: 'CHG-09', kind: 'mfa_reset', key: 'mfa_reset', target: 'usuario5@empresa.com', from: null, to: null, title: 'Restablecer MFA de usuario5@empresa.com', summary: 'Borra su MFA y cierra todas sus sesiones · identidad verificada por otro canal', by: 'Usuario 1', at: ago(1400), reason: 'Reportó que no recibe códigos.', verified: true, status: 'withdrawn' },
    { id: 'CHG-08', kind: 'mfa_reset', key: 'mfa_reset', target: 'usuario7@empresa.com', from: null, to: null, title: 'Restablecer MFA de usuario7@empresa.com', summary: 'Borra su MFA y cierra todas sus sesiones · identidad verificada por otro canal', by: 'Usuario 6', at: ago(6200), reason: 'Perdió el acceso a la app autenticadora.', verified: true, status: 'expired' },
    { id: 'CHG-14', kind: 'group', key: 'create', target: 'retail-lideres', from: null, to: { id: 'retail-lideres', type: 'area', area: 'retail', desc: 'Líderes de Retail' }, title: 'Crear grupo retail-lideres', summary: 'Nuevo grupo de área · área retail', by: 'Usuario 6', at: ago(25), reason: 'Los líderes de Retail necesitan ver el gasto de sus OUs.', status: 'pending' },
    { id: 'CHG-13', kind: 'share', target: 'dev-01', key: 'shares', from: null, to: { everyone: null, groups: [{ id: 'mango-admin', role: 'use' }, { id: 'devops', role: 'use' }], users: [{ email: 'usuario5@empresa.com', role: 'use' }] }, summary: 'Agrega a usuario5@empresa.com', by: 'Usuario 6', at: ago(40), reason: 'Necesita revisar pipelines de su equipo.', status: 'pending' },
    { id: 'CHG-12', kind: 'auth', key: 'session', from: 8, to: 12, by: 'Usuario 6', at: ago(90), reason: 'Los turnos de soporte duran 12 horas.', status: 'pending' },
    { id: 'CHG-11', kind: 'auth', key: 'mfa', from: 'optional', to: 'required', by: 'Usuario 6', at: ago(2200), reason: 'Requisito de la política de seguridad.', status: 'approved', decidedBy: 'Usuario 1', decidedAt: ago(2100) },
    { id: 'CHG-10', kind: 'auth', key: 'idp', from: 'none', to: 'sso', by: 'Usuario 1', at: ago(5000), reason: 'Entrar con la cuenta corporativa.', status: 'rejected', decidedBy: 'Usuario 6', decidedAt: ago(4900), note: 'Falta el metadata del IdP.' },
  ];
  const CHG_PREFIX = { member: 'directory.member_', mfa_reset: 'account.mfa_reset_', share: 'agent.share_', group: 'group.', skill: 'skill.', policy: 'policy.', auth: 'settings.' };
  const AVAILABLE = ['chat', 'approvals', 'budgets', 'audit', 'settings', 'login', 'marketplace', 'admin', 'review', 'org', 'models', 'mcp'];

  let state = {
    avail: ls('mango-avail2', true),
    accountState: 'active',
    authCfg: { aiPolicyUrl: 'https://intranet.empresa.com/politica-uso-ia', mfa: 'required', mfaEnrolled: true, session: 8, idp: 'none', idpName: 'Okta (empresa.okta.com)', convAccess: false, install: 'client', domains: ['empresa.com', 'empresa.mx'], dirPlan: 'Essentials', installName: 'mango-empresa', version: 'v0.1.0', release: 'v0.1.0-g1a2b3c4', awsOrg: 'o-xxxxxxxxxx', mgmtAccount: '111111111111', alertEmail: 'alertas@empresa.com', firstAdmins: ['usuario1@empresa.com', 'usuario6@empresa.com'], pool: 'us-east-1_XXXXXXXXX', region: 'us-east-1', client: 'xxxxxxxxxxxxxxxxxxxxxxxxxx' },
    changes, retired: {},
    toolPolicies: {
      'aws-budgets.create_budget': { cond: 'amount', amount: 1000, approvers: 1, expiresH: 24 },
      'sap-s4-hana.release_payment': { cond: 'amount', amount: 10000, approvers: 2, expiresH: 48 },
      'codepipeline.rollback': { cond: 'env', env: 'prod', approvers: 1, expiresH: 4 },
      'codepipeline.put_approval_result': { cond: 'env', env: 'prod', approvers: 1, expiresH: 4 },
      'aws-ec2-ops.stop_instances': { cond: 'count', count: 3, approvers: 1, expiresH: 24 },
      'aws-ec2-ops.start_instances': { cond: 'always', approvers: 1, expiresH: 24 },
    },
    role: ls('mango-role', 'admin'),
    lang: ls('mango-lang', 'es'),
    audit, approvals, versions, budgets,
    simError: null,
    inboxUnread: (() => { const r = ls('mango-inbox', {}); return Math.max(0, 8 - Object.values(r).filter(x => x && (x.read || x.archived)).length); })(),
    comments: ls('mango-comments', {
      'MNG-410': [{ author: 'Usuario 9', initials: 'U9', text: '@Usuario 1 ¿puedes confirmar si el rollback de prod-web se puede hacer hoy antes de las 18:00?', at: 'hace 4 h' }],
      'MNG-412': [{ author: 'FinOps', initials: 'FO', agent: true, text: 'Encontré 3 drivers principales. Adjunto el reporte en el hilo de chat.', at: 'hace 6 h' }],
    }),
  };
  const subs = new Set();
  const emit = () => subs.forEach(f => f());
  const set = (patch) => {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    if ('role' in p) localStorage.setItem('mango-role', JSON.stringify(state.role));
    if ('lang' in p) localStorage.setItem('mango-lang', JSON.stringify(state.lang));
    if ('avail' in p) localStorage.setItem('mango-avail2', JSON.stringify(state.avail));
    emit();
  };

  const store = {
    ROLES, PERMS,
    get: () => state,
    set,
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    AVAILABLE, onDecide: {},
    isSoon: (view) => state.avail && !AVAILABLE.includes(view),
    propose: (c) => {
      const n = Math.max(0, ...state.changes.map(x => /^CHG-/.test(x.id) ? parseInt(x.id.slice(4), 10) || 0 : 0)) + 1;
      if (c.kind === 'mfa_reset' && c.target === store.actorEmail()) return null;
      const rid = () => Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const item = { id: c.kind === 'member' ? rid() : 'CHG-' + n, status: 'pending', by: store.actor(), at: now().toISOString(), ...c };
      set({ changes: [item, ...state.changes] });
      const pfx = CHG_PREFIX[c.kind] || 'settings.';
      store.log(pfx + 'propose', c.target || c.key, (c.kind === 'auth' ? 'Propuso cambiar ' + c.key + ': ' + JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to) : 'Propuso: ' + (c.summary || c.title || '')) + (c.reason ? ' — "' + c.reason + '"' : ''));
      return item;
    },
    decideChange: (id, decision, note) => {
      const c = state.changes.find(x => x.id === id);
      if (!c || c.status !== 'pending' || c.by === store.actor()) return;
      if (c.kind === 'mfa_reset' && (c.target === store.actorEmail() || Date.now() - new Date(c.at).getTime() > 72 * 36e5)) return;
      if (c.kind === 'member' && (c.target === store.actorEmail() || Date.now() - new Date(c.at).getTime() > 72 * 36e5)) return;
      if (c.kind === 'group' && state.avail && Date.now() - new Date(c.at).getTime() > 72 * 36e5) return;
      if (decision === 'approved' && c.kind === 'auth' && c.key === 'mfa' && state.authCfg.install === 'client' && c.to !== 'required') {
        const why = 'Instalación de cliente: MFA solo puede ser obligatorio';
        set({ changes: state.changes.map(x => x.id === id ? { ...x, status: 'rejected', decidedBy: 'Sistema', decidedAt: now().toISOString(), note: why } : x) });
        store.log('settings.reject', 'mfa', 'Rechazó automáticamente ' + c.id + ' al intentar aprobarlo ' + store.actor() + ' — "' + why + '"');
        return 'blocked';
      }
      set({ changes: state.changes.map(x => x.id === id ? { ...x, status: decision, decidedBy: store.actor(), decidedAt: now().toISOString(), note } : x) });
      if (decision === 'approved' && c.kind === 'auth') set({ authCfg: { ...state.authCfg, [c.key]: c.to } });
      if (decision === 'approved' && c.kind === 'mfa_reset') {
        set({ mfaResets: { ...(state.mfaResets || {}), [c.target]: now().toISOString() } });
        store.log('account.mfa_reset', c.target, 'Se borró el MFA de ' + c.target + ' y se cerraron todas sus sesiones; debe configurarlo en su próximo ingreso');
      }
      if (decision === 'approved' && c.kind === 'share') window.dispatchEvent(new CustomEvent('mango:share-approved', { detail: { agentId: c.target, shares: c.to } }));
      if (store.onDecide[c.kind]) store.onDecide[c.kind](c, decision);
      const pre = CHG_PREFIX[c.kind] || 'settings.';
      store.log(pre + (decision === 'approved' ? 'approve' : 'reject'), c.target || c.key, (decision === 'approved' ? 'Aprobó ' : 'Rechazó ') + c.id + (note ? ' — "' + note + '"' : ''));
    },
    withdrawChange: (id) => {
      const c = state.changes.find(x => x.id === id);
      if (!c || c.by !== store.actor()) return;
      set({ changes: c.kind === 'mfa_reset' ? state.changes.map(x => x.id === id ? { ...x, status: 'withdrawn' } : x) : state.changes.filter(x => x.id !== id) });
      if (store.onDecide[c.kind]) store.onDecide[c.kind](c, 'withdrawn');
      store.log((CHG_PREFIX[c.kind] || 'settings.') + 'withdraw', c.target || c.key, 'Retiró la propuesta ' + c.id);
    },
    canView: (view, role = state.role) => { if (state.avail && view === 'budgets' && role !== 'admin') return false; const p = PERMS[role]; return p.views === '*' || p.views.includes(view); },
    can: (action, role = state.role) => { const p = PERMS[role]; return p.actions === '*' || p.actions.includes(action); },
    actorEmail: () => 'usuario' + (store.actor().match(/\d+/) || ['1'])[0] + '@empresa.com',
    actor: () => (state.actorOverride || ({ admin: 'Usuario 1', owner: 'Usuario 2', user: 'Usuario 4', creator: 'Usuario 3' })[state.role]),
    log: (action, target, detail, extra = {}) => {
      const last = state.audit[0];
      const id = 'AUD-' + (parseInt(last ? last.id.slice(4) : '4100', 10) + 1);
      const at = now().toISOString();
      const entry = { id, hash: hash((last ? last.hash : 'genesis') + id + action + at), actor: store.actor(), role: state.role, action, target, detail, at, ...extra };
      set({ audit: [entry, ...state.audit] });
      return entry;
    },
    requestApproval: (a) => {
      const n = Math.max(...state.approvals.map(x => parseInt(x.id.slice(4), 10))) + 1;
      const pol = (state.toolPolicies || {})[a.tool] || { approvers: 1, expiresH: 24 };
      const item = { id: 'APR-' + n, at: now().toISOString(), status: 'pending', expiresMin: pol.expiresH * 60, approvalsNeeded: pol.approvers, requestedBy: store.actor(), ...a };
      set({ approvals: [item, ...state.approvals] });
      store.log('approval.request', item.id, a.action);
      return item;
    },
    decide: (id, decision, note) => {
      const ap = state.approvals.find(a => a.id === id);
      if (!ap) return;
      if (decision === 'approved' && ap.requestedBy === store.actor()) return;
      const given = [...(ap.approvalsGiven || []), store.actor()];
      const done = decision === 'rejected' || given.length >= (ap.approvalsNeeded || 1);
      const next = done
        ? { ...ap, status: decision, decidedBy: store.actor(), decidedAt: now().toISOString(), note, approvalsGiven: given }
        : { ...ap, approvalsGiven: given };
      set({ approvals: state.approvals.map(a => a.id === id ? next : a) });
      store.log(decision === 'approved' ? 'approval.approve' : 'approval.reject', id, `${decision === 'approved' ? 'Aprobó' : 'Rechazó'} "${ap.action}"${note ? ' — "' + note + '"' : ''}`);
      return next;
    },
    execute: (id) => {
      const ap = state.approvals.find(a => a.id === id);
      if (!ap || ap.status !== 'approved' || ap.requestedBy !== store.actor()) return;
      const upd = (p) => set({ approvals: state.approvals.map(a => a.id === id ? { ...a, ...p } : a) });
      upd({ status: 'executing', error: null });
      const sim = state.simExec;
      setTimeout(() => {
        if (sim === 'not_started') { upd({ status: 'approved', notStarted: true }); store.log('approval.execute_failed', id, 'La acción no llegó a iniciarse: "' + ap.action + '"', { outcome: 'rejected' }); return; }
        if (sim === 'fail') { upd({ status: 'failed', executedAt: now().toISOString(), error: 'AccessDenied' }); store.log('approval.execute_failed', id, 'Falló: "' + ap.action + '"', { outcome: 'rejected' }); return; }
        upd({ status: 'executed', executedAt: now().toISOString(), notStarted: false });
        store.log('approval.execute', id, 'Ejecutó "' + ap.action + '"', { outcome: 'applied' });
      }, 1800);
    },
    cancelApproval: (id) => {
      const ap = state.approvals.find(a => a.id === id);
      if (!ap || ap.requestedBy !== store.actor() || !['pending', 'approved'].includes(ap.status)) return;
      set({ approvals: state.approvals.map(a => a.id === id ? { ...a, status: 'cancelled', decidedBy: store.actor(), decidedAt: now().toISOString() } : a) });
      store.log('approval.cancel', id, 'Canceló "' + ap.action + '"');
    },
    addComment: (ticketId, text) => {
      const at = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      const c = { author: store.actor(), initials: store.actor().split(' ').map(w => w[0]).slice(0, 2).join(''), text, at, mine: true };
      const comments = { ...state.comments, [ticketId]: [...(state.comments[ticketId] || []), c] };
      set({ comments });
      localStorage.setItem('mango-comments', JSON.stringify(comments));
      store.log('ticket.comment', ticketId, 'Comentó: "' + (text.length > 60 ? text.slice(0, 60) + '…' : text) + '"');
      return c;
    },
    pushVersion: (agentId, snapshot, note) => {
      const list = state.versions[agentId] || [];
      const v = (list[0]?.v || 0) + 1;
      const entry = { v, at: now().toISOString(), author: store.actor(), note: note || 'Actualización', snapshot };
      set({ versions: { ...state.versions, [agentId]: [entry, ...list] } });
      return entry;
    },
    ensureVersions: (agent) => {
      if (state.versions[agent.id]) return;
      set({ versions: { ...state.versions, [agent.id]: [{ v: 1, at: ago(9000), author: 'Usuario 1', note: 'Versión inicial', snapshot: { manager: agent.manager || 'platform', role: agent.role || '', model: agent.model, budgetMax: agent.budgetMax, mcp: agent.mcp, caps: agent.caps, prompt: agent.prompt || ('# Instrucciones\n\nEres ' + agent.name + '. ' + agent.desc) } }] } });
    },
  };
  window.MangoStore = store;
  // Selectors must return primitives or references that already live in state (no .filter/.map/|| [] inside).
  window.useMango = (sel) => React.useSyncExternalStore(store.subscribe, () => sel(store.get()));
})();
