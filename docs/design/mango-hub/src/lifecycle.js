// Ciclo de vida de agentes y catálogo de MCP (datos de ejemplo + acciones)
(function () {
  const S = window.MangoStore; const D = window.MangoData;
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

  const DATA_LEVEL = { public: ['Datos públicos', 'badge'], internal: ['Datos internos', 'badge-blue'], accounts: ['Datos de cuentas', 'badge-violet'], write: ['Escritura', 'badge-amber'] };
  const MCP_STATUS = { soon: ['Próximamente', 'soon'], available: ['Disponible', 'badge'], pending: ['Pendiente de aprobación', 'badge-amber'], installing: ['Instalando', 'badge-blue'], enabled: ['Habilitado', 'badge-green'], error: ['Error', 'badge-red'], disabling: ['Deshabilitando', 'badge-blue'], disabled: ['Deshabilitado', 'badge'] };
  const REV_STATUS = { draft: ['Borrador', 'badge'], review: ['En revisión', 'badge-amber'], rejected: ['Rechazado', 'badge-red'], approved: ['Aprobado · publicando', 'badge-blue'], published: ['Publicado', 'badge-green'], failed: ['Fallido', 'badge-red'], retired: ['Retirado', 'badge'] };
  const GROUP_TYPES = { central: ['Central', 'Puede usar tools de «Datos de cuentas»'], area: ['De área', 'Líderes de un área; solo ven el gasto de sus OUs'], general: ['General', 'Equipos de negocio o toda la organización; sin «Datos de cuentas»'] };
  const GROUP_SEED = { 'mango-admin': ['central', null, 'Administradores de Mango', 4, true], 'mango-agent-creator': ['general', null, 'Pueden crear y editar agentes', 7, true], 'finops-central': ['central', null, 'FinOps central', 6, true], 'bu-lead': ['general', null, 'Líderes de área (todas)', 24, true], devops: ['central', null, 'Plataforma y SRE', 11], security: ['central', null, 'Seguridad central', 5], 'bu-finanzas': ['area', 'finanzas', 'Líderes de Finanzas', 8], 'bu-retail': ['area', 'retail', 'Líderes de Retail y compras', 7], 'bu-plataforma': ['area', 'plataforma', 'Líderes de Plataforma', 9], people: ['general', null, 'Personas y Cultura', 14] };
  const groupDefsNow = () => S.get().groupDefs || [];
  const isRestricted = (g) => { const d = groupDefsNow().find(x => x.id === g); return d ? d.type !== 'central' : false; };
  Object.defineProperty(window, '__areaGroups', { get: () => groupDefsNow().filter(g => g.type !== 'central').map(g => g.id), configurable: true });
  const LIMITS = { drafts: 20, perDay: 5 };

  // ---- Catálogo ----
  const T = (name, write, desc, scope = 'org', service) => ({ name, write: !!write, desc, scope, service });
  const CONNECTOR_TOOLS = {
    'aws-cost-explorer': { level: 'accounts', perms: ['ce:GetCostAndUsage', 'ce:GetCostForecast', 'ce:GetDimensionValues', 'ce:GetTags'], tools: [T('get_cost_and_usage', 0, 'Gasto por servicio, cuenta o tag', 'user'), T('get_cost_forecast', 0, 'Pronóstico de gasto', 'user'), T('get_dimension_values', 0, 'Valores disponibles para filtrar', 'user')] },
    'compute-optimizer': { level: 'accounts', perms: ['compute-optimizer:GetEC2InstanceRecommendations', 'compute-optimizer:GetECSServiceRecommendations'], tools: [T('get_recommendations', 0, 'Recomendaciones de rightsizing'), T('get_savings_estimate', 0, 'Ahorro estimado por recomendación')] },
    'cloudwatch': { level: 'accounts', perms: ['cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms', 'logs:FilterLogEvents'], tools: [T('describe_alarms', 0, 'Alarmas y su estado'), T('get_metric_statistics', 0, 'Series de métricas'), T('filter_log_events', 0, 'Buscar en logs')] },
    'codepipeline': { level: 'write', perms: ['codepipeline:GetPipelineExecution', 'codepipeline:ListPipelineExecutions'], wperms: ['codepipeline:PutApprovalResult', 'codepipeline:StartPipelineExecution'], tools: [T('get_pipeline_execution', 0, 'Estado de una ejecución'), T('put_approval_result', 1, 'Responder un manual approval'), T('rollback', 1, 'Volver a una ejecución anterior')] },
    'ecs': { level: 'write', perms: ['ecs:DescribeServices', 'ecs:ListTasks'], wperms: ['ecs:UpdateService'], tools: [T('describe_services', 0, 'Servicios y su estado'), T('update_service', 1, 'Cambiar tareas deseadas')] },
    'guardduty': { level: 'accounts', perms: ['guardduty:ListFindings', 'guardduty:GetFindings'], tools: [T('list_findings', 0, 'Findings por severidad'), T('get_findings', 0, 'Detalle de un finding')] },
    'iam': { level: 'accounts', perms: ['iam:GetAccountAuthorizationDetails', 'access-analyzer:ListFindings'], tools: [T('get_policies', 0, 'Políticas y permisos'), T('list_access_findings', 0, 'Hallazgos de Access Analyzer')] },
    'google-drive': { level: 'internal', perms: [], tools: [T('search', 0, 'Buscar documentos'), T('get_document', 0, 'Leer un documento')] },
    'confluence': { level: 'internal', perms: [], tools: [T('search', 0, 'Buscar páginas'), T('get_page', 0, 'Leer una página')] },
    'slack': { level: 'write', perms: [], tools: [T('read_channel', 0, 'Leer mensajes de un canal'), T('post_message', 1, 'Publicar en un canal')] },
    'github': { level: 'write', perms: [], tools: [T('list_commits', 0, 'Commits entre versiones'), T('create_release', 1, 'Crear un release')] },
    'athena': { level: 'accounts', perms: ['athena:StartQueryExecution', 'athena:GetQueryResults'], tools: [T('run_query', 0, 'Ejecutar SQL de solo lectura'), T('get_query_results', 0, 'Resultados de una consulta')] },
  };
  const genericTools = (m) => [T('list', 0, 'Listar recursos'), T('get', 0, 'Leer un recurso'), T('describe', 0, 'Describir configuración')].slice(0, Math.max(1, Math.min(3, m.toolsCount || 2)));
  const connectors = (D.mcpServers || []).map(m => {
    const k = CONNECTOR_TOOLS[m.id] || {};
    const tools = k.tools || genericTools(m);
    return { id: m.id, kind: 'connector', name: m.name, desc: m.desc, provider: 'Mango', status: m.id === 'aws-cost-explorer' ? 'enabled' : 'soon', level: k.level || (m.conn === 'AWS' ? 'accounts' : 'internal'), perms: k.perms || [], wperms: k.wperms || [], tools, params: [], version: m.version || '1.0.0',
      metrics: m.latency ? { health: m.health, latency: m.latency, calls24h: m.calls24h, lastCheck: m.lastCheck } : null };
  });
  const REG = { key: 'region', label: 'Región', options: ['us-east-1', 'us-west-2', 'eu-west-1', 'sa-east-1'] };
  const packs = [
    { id: 'aws-pricing', kind: 'pack', name: 'AWS Pricing', desc: 'Precios públicos de servicios de AWS por región y configuración.', provider: 'AWS Labs', status: 'pending', request: { by: 'Usuario 6', at: ago(42), params: { region: 'us-east-1' }, reason: 'FinOps central quiere comparar precios de instancias sin salir de Mango.' }, level: 'public', version: '1.2.0',
      perms: ['pricing:GetProducts', 'pricing:DescribeServices', 'pricing:GetAttributeValues'], tools: [T('get_products', 0, 'Precios de un servicio'), T('list_services', 0, 'Servicios con precio público'), T('get_attribute_values', 0, 'Valores de atributos de precio')], params: [{ ...REG, value: 'us-east-1' }], metrics: null },
    { id: 'aws-billing', kind: 'pack', name: 'AWS Billing', desc: 'Costos, presupuestos, anomalías, reservas y Savings Plans de toda la organización.', provider: 'AWS Labs', status: 'enabled', level: 'accounts', mode: 'central', version: '1.0.0', latest: { version: '1.1.0', added: [T('get_cost_categories', 0, 'Categorías de costo')], removed: [] }, approvedBy: 'Usuario 1',
      perms: ['ce:GetCostAndUsage', 'budgets:ViewBudget', 'ce:GetAnomalies', 'ce:GetReservationUtilization', 'ce:GetReservationCoverage', 'savingsplans:DescribeSavingsPlans', 'ce:GetSavingsPlansUtilization', 'compute-optimizer:GetEC2InstanceRecommendations', 'cost-optimization-hub:ListRecommendations'],
      tools: [T('get_org_costs', 0, 'Gasto de toda la organización'), T('get_budgets', 0, 'Presupuestos de AWS y su consumo'), T('get_anomalies', 0, 'Anomalías de gasto'), T('get_reservation_utilization', 0, 'Uso de reservas'), T('get_reservation_coverage', 0, 'Cobertura de reservas'), T('get_savings_plans', 0, 'Savings Plans vigentes'), T('get_savings_plans_utilization', 0, 'Uso de Savings Plans'), T('get_compute_optimizer_recommendations', 0, 'Recomendaciones de Compute Optimizer', 'org', 'Compute Optimizer'), T('get_cost_optimization_hub_recommendations', 0, 'Recomendaciones de Cost Optimization Hub', 'org', 'Cost Optimization Hub')], params: [{ ...REG, value: 'us-east-1' }], metrics: null },
    { id: 'aws-cloudwatch-logs', kind: 'pack', name: 'CloudWatch Logs Insights', desc: 'Consultas de Logs Insights sobre grupos de logs de la organización.', provider: 'AWS Labs', status: 'installing', level: 'accounts', version: '1.0.1',
      perms: ['logs:StartQuery', 'logs:GetQueryResults', 'logs:DescribeLogGroups'], tools: [T('start_query', 0, 'Lanzar una consulta'), T('get_query_results', 0, 'Resultados de la consulta')], params: [{ ...REG, value: 'us-east-1' }], metrics: null,
      request: { by: 'Usuario 2', at: ago(95), params: { region: 'us-east-1' }, reason: 'DevOps quiere consultar logs de incidentes.' }, approvedBy: 'Usuario 1', installStarted: ago(3) },
    { id: 'aws-cost-anomaly', kind: 'pack', name: 'Cost Anomaly Detection', desc: 'Anomalías de gasto detectadas por AWS y su causa raíz.', provider: 'AWS Labs', status: 'error', level: 'accounts', version: '0.4.0',
      perms: ['ce:GetAnomalies', 'ce:GetAnomalyMonitors'], tools: [T('get_anomalies', 0, 'Anomalías recientes'), T('get_monitors', 0, 'Monitores configurados')], params: [{ ...REG, value: 'us-east-1' }], metrics: null,
      request: { by: 'Usuario 6', at: ago(300), params: { region: 'us-east-1' }, reason: 'Detectar picos antes del cierre.' }, approvedBy: 'Usuario 1', error: 'Paso «Crear rol de lectura»: AccessDenied al asumir mango-mcp-reader en la cuenta de administración.' },
    { id: 'aws-ec2-ops', kind: 'pack', name: 'EC2 Operations', desc: 'Consultar instancias y detenerlas o iniciarlas con aprobación.', provider: 'AWS Labs', status: 'enabled', level: 'write', version: '1.2.0',
      perms: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus'], wperms: ['ec2:StopInstances', 'ec2:StartInstances'], tools: [T('describe_instances', 0, 'Instancias y su estado'), T('stop_instances', 1, 'Detener instancias'), T('start_instances', 1, 'Iniciar instancias')], params: [{ ...REG, value: 'us-east-1' }], metrics: null,
      approvedBy: 'Usuario 1', update: { version: '1.3.0', by: 'Usuario 6', at: ago(180), added: [T('reboot_instances', 1, 'Reiniciar instancias')], removed: [], addedWperms: ['ec2:RebootInstances'] } },
    { id: 'aws-support', kind: 'pack', name: 'AWS Support', desc: 'Casos de soporte y recomendaciones de Trusted Advisor.', provider: 'AWS Labs', status: 'disabled', level: 'accounts', version: '1.0.0',
      perms: ['support:DescribeCases', 'support:DescribeTrustedAdvisorChecks'], tools: [T('describe_cases', 0, 'Casos abiertos'), T('trusted_advisor_checks', 0, 'Recomendaciones de Trusted Advisor')], params: [{ ...REG, value: 'us-east-1' }], metrics: null, disabledBy: 'Usuario 1', disabledAt: ago(4000) },
  ];

  // Algunos agentes publicados usan packs
  const ops2 = (D.agents || []).find(a => a.id === 'ops-02'); if (ops2 && !ops2.mcp.includes('aws-ec2-ops')) ops2.mcp.push('aws-ec2-ops');
  const fin1 = (D.agents || []).find(a => a.id === 'fin-01'); if (fin1 && !fin1.limits) fin1.limits = { tokens: 8000, iterations: 8, seconds: 120 };
  const sec2 = (D.agents || []).find(a => a.id === 'sec-02'); if (sec2 && !sec2.mcp.includes('aws-support')) sec2.mcp.push('aws-support');

  const catalogNow = () => S.get().mcpCatalog || [];
  const serverOf = (id) => catalogNow().find(s => s.id === id);
  const toolId = (s, t) => s.id + '.' + t.name;
  const toolInfo = (tid) => { const i = tid.indexOf('.'); const s = serverOf(tid.slice(0, i)); const t = s?.tools.find(x => x.name === tid.slice(i + 1)); return s && t ? { server: s, tool: t, id: tid } : { server: s || null, tool: { name: tid.slice(i + 1), write: false }, id: tid, missing: true }; };

  const snapOf = (a) => ({
    name: a.name, desc: a.desc, cat: a.cat, icon: a.icon, manager: a.manager || 'platform', role: a.role || '', model: a.model, allowedModels: a.availableModels || [a.model],
    prompt: a.prompt || `# Instrucciones\n\nEres ${a.name}. ${a.desc}\nResponde en español, con tablas cuando compares cifras.\nNo inventes números: cita la herramienta que usaste.`,
    tools: a.mcp.flatMap(id => { const s = (connectors.concat(packs)).find(x => x.id === id); return s ? s.tools.map(t => id + '.' + t.name) : []; }),
    groups: a.groups || ['mango-admin', ({ finops: 'finops-central', devops: 'devops', security: 'security', data: 'bu-plataforma', productivity: 'people' })[(a.cat || '').toLowerCase()]].filter(g => (D.groups || []).includes(g)),
    limits: a.limits || { tokens: 4096, iterations: 8, seconds: 120 },
    budget: a.budgetMax,
    color: a.colorIdx || 0, perCall: 4096, temperature: 0.2, users: [], approval: [],
  });
  const agentById = (id) => (D.agents || []).find(a => a.id === id);
  const managerName = (id) => !id ? '—' : id === 'platform' ? 'Platform Admin' : agentById(id)?.name || id;
  const pub = (id, patch) => { const s = snapOf(agentById(id)); return { ...s, ...patch }; };
  const baseFin = snapOf(agentById('fin-01')); const baseDev = snapOf(agentById('dev-01'));

  const revs = [
    { id: 'REV-41', ver: 4, agentId: 'fin-01', kind: 'change', status: 'review', by: 'Usuario 2', createdAt: ago(210), submittedAt: ago(95), base: baseFin,
      snap: { ...baseFin, temperature: 0.3, approval: ['aws-cost-explorer.get_cost_forecast'], users: ['usuario8@empresa.com'], memory: 'session', prompt: baseFin.prompt + '\nAntes de recomendar Savings Plans, revisa la cobertura actual.\nIncluye siempre el ahorro anualizado.', tools: [...baseFin.tools.filter(t => t !== 'cloudwatch.filter_log_events')], groups: [...baseFin.groups, 'bu-finanzas'], budget: 3500, limits: { ...baseFin.limits, iterations: 12 } } },
    { id: 'REV-40', agentId: null, kind: 'new', status: 'review', by: 'Usuario 3', createdAt: ago(400), submittedAt: ago(160), base: null,
      snap: { manager: 'hr-01', role: 'Onboarding', name: 'Onboarding Buddy', desc: 'Guía a personas nuevas en sus primeras semanas: accesos, herramientas y políticas.', cat: 'Productivity', icon: 'BookOpen', model: 'Haiku 4.5', prompt: '# Instrucciones\n\nAyuda a personas nuevas de la empresa.\nResponde con pasos numerados y enlaza la política de origen.\nSi algo requiere un ticket, dilo y ofrece crearlo.', tools: ['google-drive.search', 'google-drive.get_document', 'confluence.search', 'confluence.get_page'], groups: ['people'], limits: { tokens: 2048, iterations: 6, seconds: 60 }, budget: 400 } },
    { id: 'REV-39', ver: 8, agentId: 'dev-01', kind: 'change', status: 'review', by: 'Usuario 1', createdAt: ago(80), submittedAt: ago(30), base: baseDev,
      snap: { ...baseDev, tools: [...baseDev.tools, 'ecs.update_service'], limits: { ...baseDev.limits, seconds: 180 } } },
    { id: 'REV-38', agentId: null, kind: 'new', status: 'rejected', by: 'Usuario 2', createdAt: ago(3000), submittedAt: ago(2800), reviewer: 'Usuario 1', decidedAt: ago(2600), reason: 'Usa tools de Datos de cuentas y está visible para bu-finanzas. Quita bu-finanzas o esas tools.', base: null,
      snap: { name: 'Cost Anomaly Watch', desc: 'Avisa de picos de gasto por cuenta.', cat: 'FinOps', icon: 'Money', model: 'Sonnet 4.6', prompt: '# Instrucciones\n\nRevisa el gasto diario y avisa de picos mayores al 20%.', tools: ['aws-cost-explorer.get_cost_and_usage'], groups: ['finops-central', 'bu-finanzas'], limits: { tokens: 4096, iterations: 8, seconds: 120 }, budget: 800 } },
    { id: 'REV-37', agentId: null, kind: 'new', status: 'draft', by: 'Usuario 1', createdAt: ago(60), base: null,
      snap: { name: 'Billing Reconciler', desc: 'Concilia facturas de AWS con órdenes de compra de SAP.', cat: 'FinOps', icon: 'Database', model: 'Sonnet 4.6', prompt: '# Instrucciones\n\nCruza cada factura con su PO.\nSi falta la PO, pide el número al usuario.', tools: ['aws-billing.get_org_costs', 'sap-s4-hana.get'], groups: ['finops-central'], limits: { tokens: 4096, iterations: 10, seconds: 180 }, budget: 600 } },
    { id: 'REV-36', agentId: null, kind: 'new', status: 'failed', by: 'Usuario 3', createdAt: ago(5000), submittedAt: ago(4800), reviewer: 'Usuario 1', decidedAt: ago(4700), failedStep: 'Crear alias de producción del agente', failedCode: 'publication_expired', base: null,
      snap: { name: 'Release Notes Writer', desc: 'Redacta notas de release desde los commits.', cat: 'Productivity', icon: 'Zap', model: 'Haiku 4.5', prompt: '# Instrucciones\n\nResume los commits en lenguaje de negocio.', tools: ['github.list_commits'], groups: ['devops'], limits: { tokens: 2048, iterations: 4, seconds: 60 }, budget: 200 } },
    { id: 'REV-35', ver: 3, agentId: 'fin-01', kind: 'change', status: 'published', by: 'Usuario 2', createdAt: ago(9000), submittedAt: ago(8900), reviewer: 'Usuario 1', decidedAt: ago(8800), base: { ...baseFin, budget: 2500 }, snap: baseFin },
    { id: 'REV-33', ver: 7, legacy: true, agentId: 'dev-01', kind: 'change', status: 'published', by: 'Usuario 3', createdAt: ago(12000), submittedAt: ago(11900), reviewer: 'Usuario 6', decidedAt: ago(11800), base: { ...baseDev, limits: { ...baseDev.limits, iterations: 6 } }, snap: baseDev },
    { id: 'REV-30', ver: 2, legacy: true, agentId: null, kind: 'new', status: 'retired', by: 'Usuario 4', createdAt: ago(40000), submittedAt: ago(39900), reviewer: 'Usuario 6', decidedAt: ago(39800), reason: 'Reemplazado por FinOps Navigator.', base: null,
      snap: { name: 'Legacy Cost Reporter', desc: 'Reportes semanales de costo.', cat: 'FinOps', icon: 'Document', model: 'Sonnet 4.5', prompt: '', tools: ['aws-cost-explorer.get_cost_and_usage'], groups: ['finops-central'], limits: { tokens: 2048, iterations: 4, seconds: 60 }, budget: 300 } },
    ...[0, 1, 2].map(i => ({ id: 'REV-4' + (2 + i), agentId: null, kind: 'new', status: 'rejected', by: 'Usuario 1', createdAt: ago(300 + i * 40), submittedAt: ago(200 + i * 30), reviewer: 'Usuario 6', decidedAt: ago(150 + i * 20), reason: 'Duplica un agente existente.', base: null, hidden: true,
      snap: { name: 'Prueba ' + (i + 1), desc: 'Borrador de prueba.', cat: 'Data', icon: 'Bot', model: 'Haiku 4.5', prompt: '# Prueba', tools: [], groups: ['bu-plataforma'], limits: { tokens: 1024, iterations: 2, seconds: 30 }, budget: 50 } })),
  ];
  S.set({ mcpCatalog: [...connectors, ...packs], agentRevs: revs, groupDefs: (D.groups || []).map(id => { const s = GROUP_SEED[id] || ['general', null, '', 0]; return { id, type: s[0], area: s[1], desc: s[2], members: s[3], system: !!s[4], createdBy: 'Sistema' }; }) });

  // ---- Reglas ----
  const SECRET_RES = [[/AKIA[0-9A-Z]{16}/, 'clave de acceso de AWS'], [/aws_secret_access_key\s*[:=]/i, 'clave secreta de AWS'], [/\bsk-[A-Za-z0-9]{20,}/, 'token'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clave privada'], [/\b(password|contraseña|passwd)\s*[:=]\s*\S+/i, 'contraseña'], [/xox[bpa]-[A-Za-z0-9-]{10,}/, 'token de Slack']];
  // Devuelve solo el tipo de secreto; nunca el valor.
  const findSecret = (txt) => { for (const [re, type] of SECRET_RES) { if (re.test(String(txt || ''))) return type; } return null; };
  const SECRET_FIELDS = [['prompt', 'las instrucciones', 'brain'], ['desc', 'la descripción', 'identity'], ['name', 'el nombre', 'identity'], ['role', 'el rol', 'org']];
  const secretIn = (snap) => { for (const [k, label, sec] of SECRET_FIELDS) { const t = findSecret(snap[k]); if (t) return { type: t, field: label, key: k, sec }; } return null; };
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const counts = (who = S.actor()) => {
    const r = S.get().agentRevs || [];
    return { drafts: r.filter(x => x.by === who && x.status === 'draft').length, today: r.filter(x => x.by === who && x.submittedAt && new Date(x.submittedAt).getTime() >= today()).length };
  };
  const validate = (snap, opts = {}) => {
    const errs = [];
    if (!snap.name?.trim()) errs.push({ sec: 'identity', code: 'name', msg: 'Falta el nombre del agente.' });
    if (opts.submitting && !snap.manager) errs.push({ sec: 'org', code: 'manager', msg: 'Elige a quién reporta el agente.' });
    if (opts.submitting && !snap.role?.trim()) errs.push({ sec: 'org', code: 'role', msg: 'Escribe el rol del agente.' });
    if (!snap.prompt?.trim()) errs.push({ sec: 'brain', code: 'prompt', msg: 'Faltan las instrucciones.' });
    const mdl = (D.models || []).find(m => (m.short || m.name) === snap.model);
    if (snap.allowedModels && !snap.allowedModels.includes(snap.model)) errs.push({ sec: 'brain', code: 'allowed', msg: 'El modelo por defecto tiene que estar entre los permitidos.' });
    if (mdl && mdl.status !== 'enabled') errs.push({ sec: 'brain', code: 'model', msg: `El modelo ${snap.model} no está habilitado en Brains. Elige otro.` });
    if (mdl && mdl.caps && !mdl.caps.tools && (snap.tools || []).length) errs.push({ sec: 'brain', code: 'model-tools', msg: `${snap.model} no admite uso de tools y el agente tiene tools.` });
    const info = (snap.tools || []).map(toolInfo);
    const off = info.filter(i => !i.server || i.server.status !== 'enabled');
    if (off.length) errs.push({ sec: 'tools', code: 'tools-off', msg: `${off.length === 1 ? 'Una tool no está habilitada' : off.length + ' tools no están habilitadas'}: ${off.slice(0, 3).map(i => i.id).join(', ')}. Quítalas o pide habilitar su MCP.` });
    const acct = info.filter(i => i.server?.level === 'accounts');
    const areas = (snap.groups || []).filter(isRestricted);
    if (S.get().avail) {
      const org = info.filter(i => i.server?.level === 'accounts' && i.tool.scope === 'org');
      if (org.length && areas.length) errs.push({ sec: 'tools', code: 'accounts-area', msg: `Tiene tools solo para grupos centrales (${org.slice(0, 2).map(i => i.id).join(', ')}${org.length > 2 ? '…' : ''}) y es visible para grupos que no son centrales (${areas.join(', ')}). Quita esos grupos o esas tools.` });
      if (org.length && (snap.users || []).length) errs.push({ sec: 'access', code: 'accounts-users', msg: 'Tiene tools solo para grupos centrales y está compartido con personas sueltas. Compártelo solo con grupos centrales o quita esas tools.' });
    } else if (acct.length && areas.length) errs.push({ sec: 'tools', code: 'accounts-area', msg: `Usa tools de «Datos de cuentas» y es visible para roles de área (${areas.join(', ')}). Quita esos grupos o esas tools.` });
    if (!(snap.groups || []).length) errs.push({ sec: 'access', code: 'groups', msg: 'Elige al menos un grupo que pueda usarlo.' });
    const sec = secretIn(snap);
    if (sec) errs.push({ sec: sec.sec, code: 'secret', msg: `Se detectó un posible secreto (${sec.type}) en ${sec.field}. Quítalo; usa una conexión segura en su lugar.` });
    if (opts.submitting && counts().today >= LIMITS.perDay) errs.push({ sec: null, code: 'daily', msg: `Alcanzaste el límite de ${LIMITS.perDay} envíos a revisión por día. Podrás enviar de nuevo mañana.` });
    return errs;
  };
  const KNOWN = ['name', 'desc', 'cat', 'icon', 'color', 'manager', 'role', 'model', 'allowedModels', 'prompt', 'tools', 'approval', 'groups', 'users', 'limits', 'perCall', 'temperature', 'budget'];
  const diff = (base, snap) => {
    const b = base || { name: '', desc: '', model: '', prompt: '', tools: [], groups: [], limits: {}, budget: 0 };
    const set = (a, x) => ({ add: x.filter(v => !a.includes(v)), rem: a.filter(v => !x.includes(v)) });
    const ch = (k) => base && JSON.stringify(b[k] ?? null) !== JSON.stringify(snap[k] ?? null) ? [b[k] ?? null, snap[k] ?? null] : null;
    const extra = base ? [...new Set([...Object.keys(b), ...Object.keys(snap)])].filter(k => !KNOWN.includes(k) && JSON.stringify(b[k] ?? null) !== JSON.stringify(snap[k] ?? null)).map(k => [k, b[k] ?? null, snap[k] ?? null]) : [];
    return {
      cat: ch('cat'), icon: ch('icon'), color: ch('color'), perCall: ch('perCall'), temperature: ch('temperature'), extra,
      approval: set(b.approval || [], snap.approval || []), users: set(b.users || [], snap.users || []),
      name: b.name !== snap.name ? [b.name, snap.name] : null,
      desc: b.desc !== snap.desc ? [b.desc, snap.desc] : null,
      manager: (b.manager || null) !== (snap.manager || null) ? [b.manager || null, snap.manager || null] : null,
      role: (b.role || '') !== (snap.role || '') ? [b.role || '', snap.role || ''] : null,
      model: b.model !== snap.model ? [b.model, snap.model] : null,
      allowed: set(b.allowedModels || [], snap.allowedModels || []),
      prompt: b.prompt !== snap.prompt,
      tools: set(b.tools || [], snap.tools || []),
      groups: set(b.groups || [], snap.groups || []),
      limits: ['tokens', 'iterations', 'seconds'].filter(k => (b.limits || {})[k] !== (snap.limits || {})[k]).map(k => [k, (b.limits || {})[k], snap.limits[k]]),
      budget: b.budget !== snap.budget ? [b.budget, snap.budget] : null,
    };
  };
  const diffCount = (d) => { const S2 = window.MangoStore.get().avail; return (d.name ? 1 : 0) + (d.desc ? 1 : 0) + (d.manager ? 1 : 0) + (d.role ? 1 : 0) + (d.model ? 1 : 0) + (d.allowed ? d.allowed.add.length + d.allowed.rem.length : 0) + (d.prompt ? 1 : 0) + d.tools.add.length + d.tools.rem.length + d.groups.add.length + d.groups.rem.length + d.limits.length + (S2 ? ((d.cat ? 1 : 0) + (d.icon ? 1 : 0) + (d.color ? 1 : 0) + (d.perCall ? 1 : 0) + (d.temperature ? 1 : 0) + (d.approval ? d.approval.add.length + d.approval.rem.length : 0) + (d.users ? d.users.add.length + d.users.rem.length : 0) + (d.extra || []).length) : (d.budget ? 1 : 0)); };
  const uidOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return 'agt_' + (h >>> 0).toString(36).padStart(7, '0').slice(0, 7); };
  const revLabel = (r) => !S.get().avail ? r.id : uidOf(r.agentId || r.id) + ' · v' + (r.ver || 1);
  const reviewerLabel = (r) => !r.reviewer ? '—' : !S.get().avail ? r.reviewer : r.legacy ? uidOf('sub' + r.reviewer).replace('agt_', 'sub_') + '…' : 'usuario' + (r.reviewer.match(/\d+/) || ['1'])[0] + '@empresa.com';
  const modelLabel = (short) => { if (!S.get().avail) return short; const m = (D.models || []).find(x => x.short === short || x.name === short); return m ? m.modelId : short; };
  const levelOf = (level) => S.get().avail && level === 'internal' ? DATA_LEVEL.public : DATA_LEVEL[level];

  // ---- Acciones ----
  const setCat = (fn) => S.set({ mcpCatalog: catalogNow().map(s => fn(s) || s) });
  const setRevs = (fn) => S.set({ agentRevs: (S.get().agentRevs || []).map(r => fn(r) || r) });
  const install = (id) => {
    setTimeout(() => {
      const s = serverOf(id); if (!s || s.status !== 'installing') return;
      const fail = id === 'aws-support-fail';
      setCat(x => x.id === id ? { ...x, status: fail ? 'error' : 'enabled', error: fail ? 'Paso «Registrar tools»: tiempo de espera agotado.' : null, installStarted: null } : null);
      S.log(fail ? 'mcp.install_error' : 'mcp.enable', id, fail ? `Falló la instalación de ${s.name}` : `${s.name} quedó habilitado`);
    }, 3500);
  };
  setTimeout(() => catalogNow().filter(s => s.status === 'installing').forEach(s => { setCat(x => x.id === s.id ? { ...x, installStarted: new Date().toISOString() } : null); install(s.id); }), 0);
  const Lifecycle = {
    DATA_LEVEL, MCP_STATUS, REV_STATUS, LIMITS, GROUP_TYPES, isRestricted,
    get AREA_GROUPS() { return window.__areaGroups; },
    groupNames: () => groupDefsNow().map(g => g.id),
    groupDef: (id) => groupDefsNow().find(g => g.id === id),
    agentsWithGroup: (id) => (D.agents || []).filter(a => (a.groups || []).includes(id) || (window.sharesOf?.(a).groups || []).some(g => g.id === id)),
    saveGroup: (g, isNew) => {
      const all = groupDefsNow();
      S.set({ groupDefs: isNew ? [...all, { ...g, members: 0, createdBy: S.actor() }] : all.map(x => x.id === g.id ? { ...x, ...g } : x) });
      S.log(isNew ? 'group.create' : 'group.update', g.id, `${isNew ? 'Creó' : 'Editó'} el grupo ${g.id} (${GROUP_TYPES[g.type][0].toLowerCase()}${g.area ? ' · área ' + g.area : ''})`);
    },
    deleteGroup: (id) => { S.set({ groupDefs: groupDefsNow().filter(x => x.id !== id) }); S.log('group.delete', id, 'Eliminó el grupo ' + id); },
    serverOf, toolInfo, toolId, snapOf, managerName, validate, diff, diffCount, counts, findSecret, secretIn, revLabel, reviewerLabel, modelLabel, levelOf, uidOf,
    usedBy: (id) => (D.agents || []).filter(a => a.mcp.includes(id)),
    requestPack: (id, params, reason) => { setCat(s => s.id === id ? { ...s, status: 'pending', request: { by: S.actor(), at: new Date().toISOString(), params, reason }, error: null } : null); S.log('mcp.request', id, `Pidió habilitar ${serverOf(id).name}${reason ? ': ' + reason : ''}`); },
    decidePack: (id, decision, reason) => {
      const s = serverOf(id);
      if (decision === 'approved') { setCat(x => x.id === id ? { ...x, status: 'installing', approvedBy: S.actor(), installStarted: new Date().toISOString(), params: x.params.map(p => ({ ...p, value: x.request?.params?.[p.key] ?? p.value })) } : null); install(id); }
      else setCat(x => x.id === id ? { ...x, status: x.prevStatus || 'available', rejected: { by: S.actor(), at: new Date().toISOString(), reason }, request: null } : null);
      S.log(decision === 'approved' ? 'mcp.approve' : 'mcp.reject', id, `${decision === 'approved' ? 'Aprobó' : 'Rechazó'} habilitar ${s.name}${reason ? ': ' + reason : ''}`);
    },
    requestParams: (id, params) => { setCat(x => x.id === id ? { ...x, paramReq: { by: S.actor(), at: new Date().toISOString(), params } } : null); S.log('mcp.params_request', id, `Pidió cambiar parámetros de ${serverOf(id).name}: ${Object.entries(params).map(([k, v]) => k + '=' + v).join(', ')}`); },
    decideParams: (id, decision) => { const s = serverOf(id); setCat(x => x.id === id ? { ...x, params: decision === 'approved' ? x.params.map(p => ({ ...p, value: x.paramReq.params[p.key] ?? p.value })) : x.params, paramReq: null } : null); S.log(decision === 'approved' ? 'mcp.params_approve' : 'mcp.params_reject', id, `${decision === 'approved' ? 'Aprobó' : 'Rechazó'} el cambio de parámetros de ${s.name}`); },
    retryPack: (id) => { setCat(x => x.id === id ? { ...x, status: 'installing', error: null, installStarted: new Date().toISOString() } : null); install(id); S.log('mcp.retry', id, 'Reintentó la instalación'); },
    disablePack: (id, reason) => {
      const final = { status: 'disabled', disabledBy: S.actor(), disabledAt: new Date().toISOString(), prevStatus: 'disabled' };
      const nm = serverOf(id).name;
      if (S.get().avail) { setCat(x => x.id === id ? { ...x, status: 'disabling', disabledBy: S.actor() } : null); S.log('mcp.disable_request', id, `Pidió deshabilitar ${nm}${reason ? ': ' + reason : ''}`, { outcome: 'requested' }); setTimeout(() => { setCat(x => x.id === id && x.status === 'disabling' ? { ...x, ...final } : null); S.log('mcp.disable', id, `La plataforma deshabilitó ${nm}`, { outcome: 'applied', actor: 'Sistema', role: 'system' }); }, 2500); }
      else { setCat(x => x.id === id ? { ...x, ...final } : null); S.log('mcp.disable', id, `Deshabilitó ${nm}${reason ? ': ' + reason : ''}`); }
    },
    withdrawPack: (id, what) => { const s = serverOf(id); setCat(x => x.id !== id ? null : what === 'request' ? { ...x, status: x.prevStatus || 'available', request: null } : what === 'params' ? { ...x, paramReq: null } : { ...x, update: null }); S.log('mcp.withdraw', id, `Retiró su solicitud (${what === 'request' ? 'habilitar' : what === 'params' ? 'cambio de parámetros' : 'actualización'}) de ${s.name}`); },
    requestUpdate: (id) => { const s = serverOf(id); if (!s.latest) return; setCat(x => x.id === id ? { ...x, update: { version: s.latest.version, by: S.actor(), at: new Date().toISOString(), added: s.latest.added, removed: s.latest.removed, addedWperms: [] } } : null); S.log('mcp.update_request', id, `Pidió actualizar ${s.name} a ${s.latest.version}`); },
    decideUpdate: (id, decision, reason) => {
      const s = serverOf(id); const u = s.update;
      setCat(x => x.id === id ? (decision === 'approved' ? { ...x, latest: x.latest?.version === u.version ? null : x.latest, version: u.version, tools: [...x.tools.filter(t => !u.removed.some(r => r.name === t.name)), ...u.added], wperms: [...(x.wperms || []), ...(u.addedWperms || [])], update: null } : { ...x, update: null }) : null);
      S.log(decision === 'approved' ? 'mcp.update_approve' : 'mcp.update_reject', id, `${decision === 'approved' ? 'Aprobó' : 'Rechazó'} la actualización ${u.version} de ${s.name}${reason ? ': ' + reason : ''}`);
    },
    saveDraft: (rev) => {
      const all = S.get().agentRevs || [];
      const exists = all.some(r => r.id === rev.id);
      const next = { ...rev, status: 'draft', by: rev.by || S.actor(), createdAt: rev.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), reason: null };
      S.set({ agentRevs: exists ? all.map(r => r.id === rev.id ? next : r) : [next, ...all] });
      S.log('agent.draft', rev.agentId || rev.id, `Guardó borrador de ${rev.snap.name}`);
      return next;
    },
    submit: (rev) => {
      const all = S.get().agentRevs || [];
      const next = { ...rev, status: 'review', by: rev.by || S.actor(), createdAt: rev.createdAt || new Date().toISOString(), submittedAt: new Date().toISOString(), reason: null };
      S.set({ agentRevs: all.some(r => r.id === rev.id) ? all.map(r => r.id === rev.id ? next : r) : [next, ...all] });
      S.log('agent.submit', rev.agentId || rev.id, `Envió a aprobación ${rev.snap.name}`);
      return next;
    },
    newRevId: () => 'REV-' + (Math.max(0, ...(S.get().agentRevs || []).map(r => parseInt(r.id.slice(4)) || 0)) + 1),
    decideRev: (id, decision, reason) => {
      const r = (S.get().agentRevs || []).find(x => x.id === id);
      if (decision === 'rejected') {
        setRevs(x => x.id === id ? { ...x, status: 'rejected', reviewer: S.actor(), decidedAt: new Date().toISOString(), reason } : null);
        S.log('agent.reject', r.agentId || id, `Rechazó ${r.snap.name}: ${reason}`);
        return;
      }
      setRevs(x => x.id === id ? { ...x, status: 'approved', reviewer: S.actor(), decidedAt: new Date().toISOString() } : null);
      S.log('agent.approve', r.agentId || id, `Aprobó ${r.kind === 'new' ? 'el agente nuevo' : 'el cambio de'} ${r.snap.name}`);
      S.log('agent.publish_start', r.agentId || id, `Inició la publicación de ${r.snap.name}`);
      setTimeout(() => {
        const agentId = r.agentId || (r.snap.cat || 'agt').toLowerCase().slice(0, 3) + '-' + String(20 + parseInt(id.slice(4))).padStart(2, '0');
        setRevs(x => x.id === id ? { ...x, status: 'published', agentId, publishedAt: new Date().toISOString() } : null);
        window.dispatchEvent(new CustomEvent('mango:agent-published', { detail: { agentId, snap: r.snap, isNew: !r.agentId } }));
        S.log('agent.publish', agentId, `Publicó ${r.snap.name}`);
      }, 1800);
    },
    retryPublish: (id) => { const r = (S.get().agentRevs || []).find(x => x.id === id); S.log('agent.retry', r?.agentId || id, `Reintentó publicar ${r?.snap.name}`); setRevs(x => x.id === id ? { ...x, status: 'review', failedStep: null, failedCode: null } : null); Lifecycle.decideRev(id, 'approved'); },
  };
  window.Lifecycle = Lifecycle;
})();
