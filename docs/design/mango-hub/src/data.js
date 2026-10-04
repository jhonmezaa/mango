// Mock data for Mango
window.MangoData = {
  user: {
    name: "Usuario 1",
    role: "FinOps central",
    email: "usuario1@empresa.com",
    initials: "U1",
  },

  categories: ["FinOps", "DevOps", "ERP", "Productivity", "Security", "Data"],

  agents: [
    { id: "fin-01", name: "FinOps", cat: "FinOps", icon: "Money", iconBg: "#16a34a22", iconColor: "#4ade80", manager: "platform", role: "FinOps lead",
      desc: "Consulta el gasto de AWS de tu organización: costos y uso por cuenta y área, pronósticos, anomalías y Savings Plans. Solo lectura.",
      caps: ["Costos y uso", "Áreas y OUs", "Pronósticos", "Anomalías", "Savings Plans"],
      mcp: ["aws-cost-explorer"],
      status: "online", budget: 2400, budgetMax: 3000, tickets: 47, model: "Sonnet 4.6", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "dev-01", name: "DevOps Sentinel", cat: "DevOps", icon: "Terminal", iconBg: "#2563eb22", iconColor: "#60a5fa", manager: "platform", role: "DevOps lead",
      desc: "Revisión de pipelines CI/CD, logs de CloudWatch, deploys y rollbacks guiados.",
      caps: ["Pipeline Status", "Log Query", "Deploy Ops", "Rollback"],
      mcp: ["cloudwatch", "codepipeline", "ecs"],
      status: "online", budget: 1120, budgetMax: 2000, tickets: 31, model: "Sonnet 4.6", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "sap-01", name: "SAP Procure", cat: "ERP", icon: "Database", iconBg: "#f59e0b22", iconColor: "#fbbf24", manager: "platform", role: "ERP procurement",
      desc: "Consulta de órdenes de compra, vendors y aprobaciones de SAP S/4HANA.",
      caps: ["Purchase Orders", "Vendor Lookup", "Three-way Match"],
      mcp: ["sap-s4-hana", "google-drive"],
      status: "online", budget: 480, budgetMax: 1500, tickets: 22, model: "Sonnet 4.5", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "ops-01", name: "CloudWatch Ops", cat: "DevOps", icon: "Activity", iconBg: "#2563eb22", iconColor: "#60a5fa", manager: "dev-01", role: "Ops monitoring",
      desc: "Agregación de métricas operacionales, alarmas activas y runbooks.",
      caps: ["Metrics", "Alarms", "Runbooks", "Incident Response"],
      mcp: ["cloudwatch", "x-ray"],
      status: "warmup", budget: 820, budgetMax: 1500, tickets: 14, model: "Haiku 4.5", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "hr-01", name: "People Docs", cat: "Productivity", icon: "BookOpen", iconBg: "#8b5cf622", iconColor: "#a78bfa", manager: "platform", role: "Productivity lead",
      desc: "Búsqueda semántica sobre políticas internas, onboarding y handbook.",
      caps: ["Doc Search", "Policy Q&A", "Onboarding"],
      mcp: ["google-drive", "confluence"],
      status: "online", budget: 340, budgetMax: 800, tickets: 89, model: "Haiku 4.5", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "sec-01", name: "Security Pulse", cat: "Security", icon: "Shield", iconBg: "#dc262622", iconColor: "#f87171", manager: "platform", role: "Security lead",
      desc: "Monitoreo de GuardDuty, Security Hub y recomendaciones de IAM.",
      caps: ["Threat Detection", "IAM Review", "Compliance"],
      mcp: ["guardduty", "security-hub", "iam"],
      status: "online", budget: 1580, budgetMax: 2000, tickets: 18, model: "Sonnet 4.6", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "data-01", name: "Athena Analyst", cat: "Data", icon: "Database", iconBg: "#f59e0b22", iconColor: "#fbbf24", manager: "fin-01", role: "Data analyst",
      desc: "Genera SQL sobre el data lake, valida schemas y construye dashboards rápidos.",
      caps: ["SQL Generation", "Schema Intro", "Quicksight Link"],
      mcp: ["athena", "glue-catalog", "quicksight"],
      status: "online", budget: 940, budgetMax: 2500, tickets: 26, model: "Sonnet 4.6", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "fin-02", name: "Reservation Scout", cat: "FinOps", icon: "Money", iconBg: "#16a34a22", iconColor: "#4ade80", manager: "fin-01", role: "Reservation analyst",
      desc: "Recomienda compras de Savings Plans y Reserved Instances por cuenta.",
      caps: ["SP Recommendations", "RI Analysis", "Coverage Report"],
      mcp: ["aws-cost-explorer", "compute-optimizer"],
      status: "degraded", budget: 2950, budgetMax: 3000, tickets: 9, model: "Sonnet 4.6", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "pm-01", name: "Release Herald", cat: "Productivity", icon: "Zap", iconBg: "#8b5cf622", iconColor: "#a78bfa", manager: "hr-01", role: "Release communications",
      desc: "Redacta changelogs, notas de release y notifica stakeholders.",
      caps: ["Changelog", "Release Notes", "Slack Post"],
      mcp: ["github", "slack"],
      status: "online", budget: 210, budgetMax: 500, tickets: 55, model: "Haiku 4.5", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "sap-02", groups: ["bu-retail"], name: "SAP Invoicer", cat: "ERP", icon: "Database", iconBg: "#f59e0b22", iconColor: "#fbbf24", manager: "sap-01", role: "Invoicing analyst",
      desc: "Estado de facturación, aging reports y pagos pendientes.",
      caps: ["Invoice Status", "Aging", "Payment Runs"],
      mcp: ["sap-s4-hana"],
      status: "offline", budget: 0, budgetMax: 1200, tickets: 3, model: "Sonnet 4.5", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "ops-02", name: "Incident Captain", cat: "DevOps", icon: "Zap", iconBg: "#2563eb22", iconColor: "#60a5fa", manager: "dev-01", role: "Incident orchestrator",
      desc: "Orquesta respuesta a incidentes, crea canales de guerra, timeline post-mortem.",
      caps: ["Incident Triage", "War Room", "Post-mortem"],
      mcp: ["pagerduty", "slack", "cloudwatch"],
      status: "online", budget: 1340, budgetMax: 2000, tickets: 12, model: "Opus 4", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
    { id: "sec-02", name: "Access Reviewer", cat: "Security", icon: "Lock", iconBg: "#dc262622", iconColor: "#f87171", manager: "sec-01", role: "Access reviewer",
      desc: "Revisa permisos IAM, detecta least-privilege drift y genera SCPs.",
      caps: ["IAM Audit", "SCP Draft", "Access Review"],
      mcp: ["iam", "organizations"],
      status: "warmup", budget: 690, budgetMax: 1500, tickets: 8, model: "Sonnet 4.6", availableModels: ["Sonnet 4.6", "Sonnet 4.5", "Haiku 4.5", "Opus 4"] },
  ],

  threads: [
    { id: "t1", agentId: "fin-01", title: "Drivers de costo Octubre", last: "EC2-Other subió 18%…", time: "12:04", pinned: true, unread: 0 },
    { id: "t2", agentId: "fin-01", title: "Optimización S3 IA tier", last: "Movamos 4 buckets a IT…", time: "Ayer", pinned: false, unread: 2 },
    { id: "t3", agentId: "dev-01", title: "Pipeline prod-web falla", last: "Deploy 341 está stuck…", time: "Ayer", pinned: false, unread: 0 },
    { id: "t4", agentId: "ops-01", title: "Alarmas región eu-west-1", last: "3 alarmas en WARN…", time: "Lun", pinned: false, unread: 0 },
    { id: "t5", agentId: "hr-01", title: "Política de vacaciones 2026", last: "Se actualizó en marzo…", time: "Lun", pinned: false, unread: 0 },
    { id: "t6", agentId: "sec-01", title: "Hallazgos GuardDuty", last: "2 findings HIGH…", time: "Lun", pinned: false, unread: 1 },
    { id: "t7", agentId: "sap-01", title: "PO #47721 Proveedor 1", last: "Aprobada, esperando GR…", time: "Sáb", pinned: false, unread: 0 },
    { id: "t8", agentId: "data-01", title: "Retención activaciones Q3", last: "Cohort 2025-07 = 34%…", time: "Sáb", pinned: false, unread: 0 },
  ],

  tickets: [
    { id: "MNG-412", title: "Identificar top 5 drivers de costo de Octubre", agent: "fin-01", status: "in_progress", prio: "high", age: "2h", assignee: "U1",
      desc: "El equipo de FinOps pidió un breakdown de los principales drivers de crecimiento de costo en AWS para Octubre 2026, con recomendaciones accionables.",
      trace: [
        { t: "12:03:41", tool: "aws-cost-explorer.get_cost_and_usage", status: "ok", ms: 820, params: { granularity: "MONTHLY", filter: "linked_account=prod" } },
        { t: "12:03:43", tool: "aws-cost-explorer.get_cost_forecast", status: "ok", ms: 410, params: { metric: "AMORTIZED_COST" } },
        { t: "12:03:44", tool: "compute-optimizer.get_recommendations", status: "ok", ms: 1120 },
        { t: "12:03:46", tool: "cloudwatch.get_metric_statistics", status: "error", ms: 3000, params: { namespace: "AWS/EC2" } },
      ] },
    { id: "MNG-411", title: "Rightsizing fleet ECS staging", agent: "fin-01", status: "open", prio: "medium", age: "3h", assignee: null },
    { id: "MNG-410", title: "Pipeline prod-web deploy 341 stuck en CodeDeploy", agent: "dev-01", status: "in_progress", prio: "high", age: "4h", assignee: "U1" },
    { id: "MNG-409", title: "Override de budget para Reservation Scout", agent: "fin-02", status: "needs_approval", prio: "high", age: "5h", assignee: "U1" },
    { id: "MNG-408", title: "Alarma CPUUtilization api-gateway-prod en WARN", agent: "ops-01", status: "open", prio: "medium", age: "5h", assignee: null },
    { id: "MNG-407", title: "PO #47721 — requiere three-way match manual", agent: "sap-01", status: "done", prio: "low", age: "1d", assignee: "U2" },
    { id: "MNG-406", title: "Actualizar política de vacaciones en Google Drive", agent: "hr-01", status: "done", prio: "low", age: "1d", assignee: "U3" },
    { id: "MNG-405", title: "Finding GuardDuty UnauthorizedAccess:EC2", agent: "sec-01", status: "needs_approval", prio: "high", age: "1d", assignee: "U1" },
    { id: "MNG-404", title: "Query Athena — retention cohorts Q3", agent: "data-01", status: "done", prio: "medium", age: "2d", assignee: "U1" },
    { id: "MNG-403", title: "Changelog release v2.14 — notificar a #announce", agent: "pm-01", status: "done", prio: "low", age: "2d", assignee: "U4" },
    { id: "MNG-402", title: "IAM drift en cuenta marketing-prod", agent: "sec-02", status: "open", prio: "medium", age: "2d", assignee: null },
    { id: "MNG-401", title: "Incident INC-9812 — latencia checkout", agent: "ops-02", status: "in_progress", prio: "high", age: "3d", assignee: "U1" },
  ],

  mcpServers: [
    { id: "aws-cost-explorer", name: "AWS Cost Explorer", desc: "Costos, forecasts y utilización", conn: "AWS", health: "ok", toolsCount: 8, latency: 380, calls24h: 412, version: "1.4.2", lastCheck: "hace 30s" },
    { id: "compute-optimizer", name: "Compute Optimizer", desc: "Recomendaciones de rightsizing", conn: "AWS", health: "ok", toolsCount: 4, latency: 620, calls24h: 87, version: "1.2.0", lastCheck: "hace 30s" },
    { id: "cloudwatch", name: "CloudWatch", desc: "Métricas, logs y alarmas", conn: "AWS", health: "ok", toolsCount: 12, latency: 210, calls24h: 1290, version: "2.1.0", lastCheck: "hace 30s" },
    { id: "x-ray", name: "AWS X-Ray", desc: "Traces distribuidas", conn: "AWS", health: "ok", toolsCount: 5, latency: 290, calls24h: 142, version: "1.1.8", lastCheck: "hace 31s" },
    { id: "codepipeline", name: "CodePipeline", desc: "Estado de pipelines CI/CD", conn: "AWS", health: "warn", toolsCount: 7, latency: 840, calls24h: 94, version: "1.3.0", lastCheck: "hace 2m", note: "Elevated latency en us-east-1" },
    { id: "ecs", name: "ECS", desc: "Servicios, tasks y escalado", conn: "AWS", health: "ok", toolsCount: 9, latency: 320, calls24h: 188, version: "1.5.1", lastCheck: "hace 30s" },
    { id: "iam", name: "IAM", desc: "Identidades, roles y policies", conn: "AWS", health: "ok", toolsCount: 11, latency: 180, calls24h: 74, version: "2.0.3", lastCheck: "hace 30s" },
    { id: "guardduty", name: "GuardDuty", desc: "Threat detection", conn: "AWS", health: "ok", toolsCount: 6, latency: 410, calls24h: 52, version: "1.2.4", lastCheck: "hace 31s" },
    { id: "security-hub", name: "Security Hub", desc: "Postura de seguridad agregada", conn: "AWS", health: "ok", toolsCount: 4, latency: 520, calls24h: 38, version: "1.1.0", lastCheck: "hace 32s" },
    { id: "athena", name: "Athena", desc: "SQL sobre S3", conn: "AWS", health: "ok", toolsCount: 5, latency: 1200, calls24h: 156, version: "1.4.0", lastCheck: "hace 30s" },
    { id: "glue-catalog", name: "Glue Catalog", desc: "Metadata y schemas", conn: "AWS", health: "ok", toolsCount: 6, latency: 240, calls24h: 89, version: "1.2.1", lastCheck: "hace 30s" },
    { id: "quicksight", name: "QuickSight", desc: "Dashboards embebibles", conn: "AWS", health: "ok", toolsCount: 3, latency: 680, calls24h: 24, version: "1.0.8", lastCheck: "hace 33s" },
    { id: "organizations", name: "Organizations", desc: "Cuentas y SCPs", conn: "AWS", health: "ok", toolsCount: 4, latency: 220, calls24h: 18, version: "1.1.0", lastCheck: "hace 30s" },
    { id: "sap-s4-hana", name: "SAP S/4HANA", desc: "ERP corporativo", conn: "SAP", health: "ok", toolsCount: 18, latency: 920, calls24h: 207, version: "2.3.0", lastCheck: "hace 30s" },
    { id: "google-drive", name: "Google Drive", desc: "Documentos corporativos", conn: "Google", health: "ok", toolsCount: 7, latency: 340, calls24h: 524, version: "1.6.2", lastCheck: "hace 30s" },
    { id: "confluence", name: "Confluence", desc: "Wiki interno", conn: "Atlassian", health: "warn", toolsCount: 5, latency: 1540, calls24h: 112, version: "1.2.0", lastCheck: "hace 4m", note: "P95 latency >1s — posible degradación" },
    { id: "github", name: "GitHub", desc: "Repos y releases", conn: "GitHub", health: "ok", toolsCount: 14, latency: 380, calls24h: 298, version: "1.8.1", lastCheck: "hace 30s" },
    { id: "slack", name: "Slack", desc: "Mensajería corporativa", conn: "Slack", health: "ok", toolsCount: 9, latency: 220, calls24h: 687, version: "1.4.0", lastCheck: "hace 30s" },
    { id: "pagerduty", name: "PagerDuty", desc: "On-call y incidentes", conn: "PagerDuty", health: "ok", toolsCount: 6, latency: 290, calls24h: 41, version: "1.1.3", lastCheck: "hace 30s" },
  ],

  skills: [
    { id: "cost-analysis", name: "Cost Analysis", cat: "FinOps", icon: "Money", desc: "Descompone gasto AWS por cuenta, servicio y tag; identifica drivers de variación mes a mes.",
      tools: ["aws-cost-explorer", "compute-optimizer"],
      instructions: `Eres un analista FinOps. Para las cuentas {{cuentas}} en el período {{período}} con granularidad {{granularidad}}:
1. Consulta AWS Cost Explorer agrupando por servicio y tag.
2. Identifica drivers con variación >15% mes a mes.
3. Entrega breakdown detallado, top 5 drivers de variación y forecast a 30 días.
4. Presenta en tablas markdown y resalta anomalías en bold.`, inputs: ["período", "granularidad", "cuentas"], outputs: ["breakdown", "drivers", "forecast"],
      usedBy: ["fin-01", "fin-02"], runs30d: 127, owner: "FinOps team" },
    { id: "budget-monitoring", name: "Budget Monitoring", cat: "FinOps", icon: "Activity", desc: "Alertas cuando un proyecto se acerca al cap mensual; calcula proyección lineal y recomienda pausas.",
      tools: ["aws-cost-explorer", "slack"],
      instructions: `Monitorea el budget {{budget_id}}.
1. Calcula consumo actual vs cap mensual.
2. Proyecta linealmente el cierre de mes.
3. Si proyección >90% del cap, emite alerta con severity y recomienda pausas de recursos no críticos.
4. Notifica en Slack al owner del budget.`, inputs: ["budget_id"], outputs: ["alerta", "proyección"],
      usedBy: ["fin-01"], runs30d: 84, owner: "FinOps team" },
    { id: "rightsizing", name: "Rightsizing", cat: "FinOps", icon: "Sliders", desc: "Recomienda cambios de instance type basado en utilización observada en 14d.",
      tools: ["compute-optimizer", "cloudwatch"],
      instructions: `Para las cuentas {{account_ids}}:
1. Consulta Compute Optimizer por recomendaciones de instance type.
2. Valida con utilización observada en CloudWatch (14 días).
3. Genera tabla de recomendaciones con instance actual, sugerido, ahorro estimado/mes y confianza.
4. Ordena por ahorro descendente.`, inputs: ["account_ids"], outputs: ["recomendaciones", "ahorro_estimado"],
      usedBy: ["fin-01"], runs30d: 42, owner: "FinOps team" },
    { id: "sp-recommendations", name: "Savings Plans Recommendations", cat: "FinOps", icon: "Money", desc: "Sugiere compras de Savings Plans por cuenta con payback y coverage target.",
      tools: ["aws-cost-explorer"],
      instructions: `Sugiere compras de Savings Plans con commitment {{commitment_term}} y cobertura objetivo {{target_coverage}}.
1. Analiza uso estable de los últimos 60 días.
2. Calcula payback period y break-even.
3. Entrega recomendación por cuenta con monto, tipo de SP, cobertura resultante y ahorro estimado.`, inputs: ["commitment_term", "target_coverage"], outputs: ["recomendaciones"],
      usedBy: ["fin-02"], runs30d: 18, owner: "FinOps team" },
    { id: "pipeline-status", name: "Pipeline Status", cat: "DevOps", icon: "Terminal", desc: "Obtiene el estado actual, stage y duración de pipelines CI/CD.",
      tools: ["codepipeline"],
      instructions: `Para el pipeline {{pipeline_name}}:
1. Consulta CodePipeline por estado actual, stage en ejecución y duración.
2. Lista artefactos generados y últimos 5 runs.
3. Si hay stage fallido, resume el error y linkea a los logs.`, inputs: ["pipeline_name"], outputs: ["estado", "stage", "artefactos"],
      usedBy: ["dev-01"], runs30d: 312, owner: "Platform team" },
    { id: "log-query", name: "Log Query", cat: "DevOps", icon: "Search", desc: "Ejecuta queries CloudWatch Insights y resume patrones o errores recurrentes.",
      tools: ["cloudwatch"],
      instructions: `Ejecuta la query {{query}} sobre {{log_group}}:
1. Lanza CloudWatch Insights con el rango solicitado.
2. Resume patrones recurrentes y outliers.
3. Si detectas errores, agrúpalos por signature y muestra frecuencia.`, inputs: ["log_group", "query"], outputs: ["resultados", "patrones"],
      usedBy: ["dev-01", "ops-01"], runs30d: 198, owner: "Platform team" },
    { id: "deploy-ops", name: "Deploy Ops", cat: "DevOps", icon: "Zap", desc: "Ejecuta rollouts o rollbacks validando healthchecks antes de cada stage.",
      tools: ["codepipeline", "cloudwatch"],
      instructions: `Write-action. Despliega {{service}} versión {{version}}:
1. Verifica healthchecks de la versión actual antes de iniciar.
2. Ejecuta rollout progresivo por stage.
3. Después de cada stage, valida healthchecks; si fallan, inicia rollback automático.
4. Reporta deploy_id y estado final.`, inputs: ["service", "version"], outputs: ["deploy_id"],
      usedBy: ["dev-01"], runs30d: 47, owner: "Platform team", writeAction: true },
    { id: "incident-triage", name: "Incident Triage", cat: "DevOps", icon: "Warn", desc: "Clasifica alertas, identifica servicio afectado y sugiere runbook.",
      tools: ["pagerduty", "cloudwatch", "slack"],
      instructions: `Para el incident {{incident_id}}:
1. Consulta PagerDuty por metadata y alertas relacionadas.
2. Cross-referencia con CloudWatch para identificar servicio afectado.
3. Clasifica severity (SEV1-4) según impacto.
4. Sugiere runbook relevante y notifica en Slack al on-call.`, inputs: ["incident_id"], outputs: ["severity", "runbook"],
      usedBy: ["ops-01", "ops-02"], runs30d: 29, owner: "Platform team" },
    { id: "threat-detection", name: "Threat Detection", cat: "Security", icon: "Shield", desc: "Revisa findings de GuardDuty y Security Hub y prioriza por impacto.",
      tools: ["guardduty", "security-hub"],
      instructions: `Revisa findings con severity >= {{severity_min}}:
1. Consulta GuardDuty y Security Hub.
2. Prioriza por impacto y exposición (public-facing primero).
3. Para cada finding, sugiere acción concreta (aislar, rotar credencial, aplicar policy).
4. Entrega tabla con finding, severity, recurso afectado y acción recomendada.`, inputs: ["severity_min"], outputs: ["findings", "acciones"],
      usedBy: ["sec-01"], runs30d: 73, owner: "Security team" },
    { id: "iam-audit", name: "IAM Audit", cat: "Security", icon: "Lock", desc: "Detecta drift de least-privilege y recomienda revocar permisos no usados.",
      tools: ["iam", "organizations"],
      instructions: `Audita least-privilege en la cuenta {{account_id}}:
1. Consulta IAM por roles y policies.
2. Identifica permisos no usados en los últimos 90 días.
3. Detecta drift vs baseline de Organizations.
4. Entrega hallazgos con role, permiso, último uso y recomendación (revocar/mantener).`, inputs: ["account_id"], outputs: ["hallazgos"],
      usedBy: ["sec-02"], runs30d: 21, owner: "Security team" },
    { id: "doc-search", name: "Doc Search", cat: "Productivity", icon: "BookOpen", desc: "Búsqueda semántica sobre Google Drive y Confluence con citas al documento fuente.",
      tools: ["google-drive", "confluence"],
      instructions: `Búsqueda semántica para "{{query}}":
1. Consulta Google Drive y Confluence con embeddings.
2. Rankea resultados por relevancia y recencia.
3. Entrega top 5 con extracto, link al documento y fecha de última modificación.
4. Cita siempre la fuente original.`, inputs: ["query"], outputs: ["resultados", "citas"],
      usedBy: ["hr-01"], runs30d: 412, owner: "People team" },
    { id: "purchase-orders", name: "Purchase Orders", cat: "ERP", icon: "Database", desc: "Consulta y resume estado de órdenes de compra en SAP.",
      tools: ["sap-s4-hana"],
      instructions: `Consulta la orden {{po_number}} (o del vendor {{vendor}}):
1. Busca en SAP S/4HANA el estado actual y historia.
2. Valida three-way match (PO vs goods receipt vs invoice).
3. Reporta discrepancias si existen.
4. Resume en una tabla: PO#, vendor, monto, estado, pending actions.`, inputs: ["po_number | vendor"], outputs: ["estado", "three_way_match"],
      usedBy: ["sap-01"], runs30d: 94, owner: "Procurement" },
    { id: "sql-generation", name: "SQL Generation", cat: "Data", icon: "Database", desc: "Genera queries Athena usando el Glue Catalog y valida el schema antes de ejecutar.",
      tools: ["athena", "glue-catalog"],
      instructions: `Genera SQL Athena para "{{intent}}" sobre las tablas {{tables}}:
1. Consulta Glue Catalog para validar schemas y tipos.
2. Construye query optimizada (partitions, limits).
3. Ejecuta en modo preview (LIMIT 10) y muestra resultado.
4. Explica el SQL línea por línea antes de entregarlo.`, inputs: ["intent", "tables"], outputs: ["sql", "preview"],
      usedBy: ["data-01"], runs30d: 156, owner: "Data Platform" },
    { id: "changelog", name: "Changelog", cat: "Productivity", icon: "Zap", desc: "Redacta changelogs a partir de PRs mergeados y notifica stakeholders en Slack.",
      tools: ["github", "slack"],
      instructions: `Para el repo {{repo}}, rango {{version_range}}:
1. Consulta GitHub por PRs mergeados en el rango.
2. Agrupa por tipo (feat, fix, chore, breaking).
3. Redacta changelog en markdown siguiendo Keep a Changelog.
4. Publica en Slack al canal del equipo dueño del repo.`, inputs: ["repo", "version_range"], outputs: ["changelog_md"],
      usedBy: ["pm-01"], runs30d: 38, owner: "Platform team" },
  ],

  groups: ["mango-admin", "mango-agent-creator", "finops-central", "bu-lead", "devops", "security", "bu-plataforma", "bu-finanzas", "bu-retail", "people"],

  models: [
    {"id":"claude-sonnet-46","name":"Claude Sonnet 4.6","short":"Sonnet 4.6","provider":"Anthropic","modelId":"us.anthropic.claude-sonnet-4-6-v1:0","region":"us-east-1","status":"enabled","contextWindow":200000,"caps":{"tools":true,"vision":true},"inputPrice":3,"outputPrice":15,"listInput":3,"listOutput":15,"default":true,"confirmed":{"by":"Usuario 1","at":20},"metrics":{"calls":18420,"tokens":412000000,"cost":2890.4}},
    {"id":"claude-sonnet-45","name":"Claude Sonnet 4.5","short":"Sonnet 4.5","provider":"Anthropic","modelId":"us.anthropic.claude-sonnet-4-5-v1:0","region":"us-east-1","status":"enabled","contextWindow":200000,"caps":{"tools":true,"vision":true},"inputPrice":3,"outputPrice":15,"listInput":3,"listOutput":15,"confirmed":{"by":"Usuario 6","at":60},"metrics":{"calls":2310,"tokens":41000000,"cost":318.2}},
    {"id":"claude-haiku-45","name":"Claude Haiku 4.5","short":"Haiku 4.5","provider":"Anthropic","modelId":"us.anthropic.claude-haiku-4-5-v1:0","region":"us-east-1","status":"enabled","contextWindow":200000,"caps":{"tools":true,"vision":true},"inputPrice":1,"outputPrice":5,"listInput":1,"listOutput":5,"confirmed":{"by":"Usuario 1","at":20},"metrics":{"calls":9870,"tokens":96000000,"cost":212.6}},
    {"id":"claude-opus-4","name":"Claude Opus 4","short":"Opus 4","provider":"Anthropic","modelId":"us.anthropic.claude-opus-4-v1:0","region":"us-east-1","status":"enabled","contextWindow":200000,"caps":{"tools":true,"vision":true},"inputPrice":15,"outputPrice":75,"listInput":15,"listOutput":75,"confirmed":{"by":"Usuario 6","at":90},"metrics":{"calls":640,"tokens":14000000,"cost":488.9}},
    {"id":"claude-opus-41","name":"Claude Opus 4.1","short":"Opus 4.1","provider":"Anthropic","modelId":"us.anthropic.claude-opus-4-1-v1:0","region":"us-east-1","status":"available","contextWindow":200000,"caps":{"tools":true,"vision":true},"inputPrice":15,"outputPrice":75,"listInput":15,"listOutput":75},
    {"id":"nova-pro","name":"Amazon Nova Pro","short":"Nova Pro","provider":"Amazon","modelId":"us.amazon.nova-pro-v1:0","region":"us-east-1","status":"enabled","contextWindow":300000,"caps":{"tools":true,"vision":true},"inputPrice":0.8,"outputPrice":3.2,"listInput":0.8,"listOutput":3.2,"confirmed":{"by":"Usuario 1","at":45},"metrics":null},
    {"id":"nova-lite","name":"Amazon Nova Lite","short":"Nova Lite","provider":"Amazon","modelId":"us.amazon.nova-lite-v1:0","region":"us-east-1","status":"available","contextWindow":300000,"caps":{"tools":true,"vision":true},"inputPrice":0.06,"outputPrice":0.24,"listInput":0.06,"listOutput":0.24},
    {"id":"nova-micro","name":"Amazon Nova Micro","short":"Nova Micro","provider":"Amazon","modelId":"us.amazon.nova-micro-v1:0","region":"us-east-1","status":"available","contextWindow":128000,"caps":{"tools":true,"vision":false},"inputPrice":0.035,"outputPrice":0.14,"listInput":0.035,"listOutput":0.14},
    {"id":"nova-premier","name":"Amazon Nova Premier","short":"Nova Premier","provider":"Amazon","modelId":"us.amazon.nova-premier-v1:0","region":"us-east-1","status":"noaccess","contextWindow":1000000,"caps":{"tools":true,"vision":true},"inputPrice":2.5,"outputPrice":12.5,"listInput":2.5,"listOutput":12.5},
    {"id":"llama-33-70b","name":"Llama 3.3 70B Instruct","short":"Llama 3.3 70B","provider":"Meta","modelId":"us.meta.llama3-3-70b-instruct-v1:0","region":"us-east-1","status":"available","contextWindow":128000,"caps":{"tools":true,"vision":false},"inputPrice":0.72,"outputPrice":0.72,"listInput":0.72,"listOutput":0.72},
    {"id":"llama-4-maverick","name":"Llama 4 Maverick 17B","short":"Llama 4 Maverick","provider":"Meta","modelId":"us.meta.llama4-maverick-17b-instruct-v1:0","region":"us-east-1","status":"noaccess","contextWindow":1000000,"caps":{"tools":true,"vision":true},"inputPrice":0.24,"outputPrice":0.97,"listInput":0.24,"listOutput":0.97},
    {"id":"mistral-large-2","name":"Mistral Large 2","short":"Mistral Large 2","provider":"Mistral","modelId":"mistral.mistral-large-2407-v1:0","region":"us-east-1","status":"disabled","contextWindow":128000,"caps":{"tools":true,"vision":false},"inputPrice":2,"outputPrice":6,"listInput":2,"listOutput":6,"confirmed":{"by":"Usuario 6","at":400},"disabledBy":"Usuario 1","disabledReason":"Sin uso en 60 días"},
    {"id":"pixtral-large","name":"Pixtral Large","short":"Pixtral Large","provider":"Mistral","modelId":"us.mistral.pixtral-large-2502-v1:0","region":"us-east-1","status":"available","contextWindow":128000,"caps":{"tools":true,"vision":true},"inputPrice":2,"outputPrice":6,"listInput":2,"listOutput":6},
    {"id":"command-r-plus","name":"Command R+","short":"Command R+","provider":"Cohere","modelId":"cohere.command-r-plus-v1:0","region":"us-east-1","status":"available","contextWindow":128000,"caps":{"tools":true,"vision":false},"inputPrice":2.5,"outputPrice":10,"listInput":2.5,"listOutput":10},
    {"id":"deepseek-r1","name":"DeepSeek-R1","short":"DeepSeek-R1","provider":"DeepSeek","modelId":"us.deepseek.r1-v1:0","region":"us-east-1","status":"available","contextWindow":128000,"caps":{"tools":false,"vision":false},"inputPrice":1.35,"outputPrice":5.4,"listInput":1.35,"listOutput":5.4}
  ],

  schedules: [
    { id: "sch-01", name: "Budget check diario", agent: "fin-01", cron: "0 9 * * *", cronLabel: "Todos los días · 09:00", tz: "America/Mexico_City", desc: "Revisa cap mensual y emite alerta en Slack si >80%.", lastRun: "hace 3h", nextRun: "en 21h", status: "active", runs30d: 30, successRate: 100, skill: "budget-monitoring" },
    { id: "sch-02", name: "Rightsizing semanal", agent: "fin-01", cron: "0 8 * * 1", cronLabel: "Lunes · 08:00", tz: "America/Mexico_City", desc: "Analiza 14d de utilización y emite recomendaciones de instance type.", lastRun: "hace 2d", nextRun: "en 5d", status: "active", runs30d: 4, successRate: 100, skill: "rightsizing" },
    { id: "sch-03", name: "GuardDuty sweep", agent: "sec-01", cron: "0 */6 * * *", cronLabel: "Cada 6 horas", tz: "UTC", desc: "Lista findings HIGH de las últimas 6h y escala a #sec-ops.", lastRun: "hace 1h", nextRun: "en 5h", status: "active", runs30d: 120, successRate: 99, skill: "threat-detection" },
    { id: "sch-04", name: "IAM audit mensual", agent: "sec-02", cron: "0 9 1 * *", cronLabel: "Día 1 · 09:00", tz: "America/Mexico_City", desc: "Detecta drift de least-privilege y genera tickets para revocar permisos no usados.", lastRun: "hace 19d", nextRun: "en 11d", status: "active", runs30d: 1, successRate: 100, skill: "iam-audit" },
    { id: "sch-05", name: "Release digest viernes", agent: "pm-01", cron: "0 17 * * 5", cronLabel: "Viernes · 17:00", tz: "America/Mexico_City", desc: "Consolida PRs mergeados de la semana y postea resumen en #announce.", lastRun: "hace 4d", nextRun: "en 3d", status: "active", runs30d: 4, successRate: 100, skill: "changelog" },
    { id: "sch-06", name: "Cohort retention Q3", agent: "data-01", cron: "0 6 * * 1,4", cronLabel: "Lunes y jueves · 06:00", tz: "UTC", desc: "Recalcula cohort retention y publica en QuickSight.", lastRun: "hace 16h", nextRun: "en 3d", status: "paused", runs30d: 6, successRate: 83, skill: "sql-generation" },
    { id: "sch-07", name: "Pipeline health check", agent: "dev-01", cron: "*/15 * * * *", cronLabel: "Cada 15 minutos", tz: "UTC", desc: "Revisa estado de pipelines críticos y alerta si stuck >10min.", lastRun: "hace 4m", nextRun: "en 11m", status: "active", runs30d: 2880, successRate: 99.8, skill: "pipeline-status" },
    { id: "sch-08", name: "Reservation analysis", agent: "fin-02", cron: "0 7 * * 3", cronLabel: "Miércoles · 07:00", tz: "America/Mexico_City", desc: "Evalúa coverage de Savings Plans y recomienda compras.", lastRun: "hace 6d", nextRun: "en 1d", status: "error", runs30d: 4, successRate: 75, skill: "sp-recommendations", lastError: "Budget excedido — requiere aprobación" },
    { id: "sch-09", name: "SAP PO aging check", agent: "sap-01", cron: "0 10 * * *", cronLabel: "Todos los días · 10:00", tz: "America/Mexico_City", desc: "Identifica POs sin movimiento >7 días y notifica al owner.", lastRun: "hace 2h", nextRun: "en 22h", status: "active", runs30d: 30, successRate: 100, skill: "purchase-orders" },
  ],

  evals: [
    { id: "ev-01", name: "FinOps Cost Analysis — Golden Set", agent: "fin-01", skill: "cost-analysis", type: "golden", cases: 24,
      lastRun: "hace 6h", lastScore: 0.94, prevScore: 0.91, status: "pass", threshold: 0.85, runs: 12,
      desc: "24 queries reales de FinOps con respuestas validadas por el equipo. Mide accuracy, completeness y tool usage correcto." },
    { id: "ev-02", name: "DevOps Pipeline Triage", agent: "dev-01", skill: "pipeline-status", type: "regression", cases: 18,
      lastRun: "hace 1d", lastScore: 0.88, prevScore: 0.90, status: "pass", threshold: 0.80, runs: 8,
      desc: "Casos sintéticos de pipelines failing con causa conocida. Evalúa si el agente identifica el stage correcto." },
    { id: "ev-03", name: "Security — Finding Classification", agent: "sec-01", skill: "threat-detection", type: "golden", cases: 42,
      lastRun: "hace 12h", lastScore: 0.97, prevScore: 0.96, status: "pass", threshold: 0.90, runs: 15,
      desc: "Findings de GuardDuty con severity validada manualmente. Mide precision y recall de triage." },
    { id: "ev-04", name: "SQL Generation Accuracy", agent: "data-01", skill: "sql-generation", type: "golden", cases: 36,
      lastRun: "hace 3h", lastScore: 0.81, prevScore: 0.85, status: "fail", threshold: 0.85, runs: 9,
      desc: "Preguntas de negocio con SQL esperado validado en Athena. Mide exact match, execution success y row count." },
    { id: "ev-05", name: "Doc Search Citation Quality", agent: "hr-01", skill: "doc-search", type: "human_eval", cases: 50,
      lastRun: "hace 2d", lastScore: 0.89, prevScore: 0.87, status: "pass", threshold: 0.80, runs: 6,
      desc: "50 queries de empleados evaluadas por 3 reviewers. Mide relevancia, precisión de citas y alucinaciones." },
    { id: "ev-06", name: "IAM Audit — Least Privilege", agent: "sec-02", skill: "iam-audit", type: "regression", cases: 12,
      lastRun: "hace 5d", lastScore: 0.92, prevScore: 0.92, status: "pass", threshold: 0.85, runs: 3,
      desc: "Cuentas con drift conocido. Evalúa si detecta los permisos excedidos sin falsos positivos." },
    { id: "ev-07", name: "Changelog Quality — Human", agent: "pm-01", skill: "changelog", type: "human_eval", cases: 20,
      lastRun: "hace 4d", lastScore: 0.86, prevScore: 0.84, status: "pass", threshold: 0.75, runs: 5,
      desc: "Changelogs generados vs el equipo de producto. Mide claridad, completeness y tone." },
    { id: "ev-08", name: "Purchase Order Lookup", agent: "sap-01", skill: "purchase-orders", type: "golden", cases: 28,
      lastRun: "hace 1d", lastScore: 0.95, prevScore: 0.94, status: "pass", threshold: 0.90, runs: 10,
      desc: "POs reales con estado y vendor verificados. Mide exactitud de la consulta SAP." },
    { id: "ev-09", name: "Incident Triage Speed", agent: "ops-02", skill: "incident-triage", type: "regression", cases: 16,
      lastRun: "hace 8h", lastScore: 0.78, prevScore: 0.82, status: "fail", threshold: 0.80, runs: 7,
      desc: "Incidentes pasados con severity y runbook. Mide tiempo a clasificación y selección correcta de runbook." },
  ],

  knowledgeBases: [
    { id: "kb-01", name: "AWS Runbooks", owner: "Platform team", source: "Confluence", icon: "BookOpen",
      desc: "Runbooks operativos para incidentes comunes, rollbacks y procedimientos de DR.",
      docs: 142, chunks: 3420, tokens: 1.8e6, embedding: "titan-v2", lastSync: "hace 2h", syncStatus: "ok",
      usedBy: ["dev-01", "ops-01", "ops-02"], bucket: "s3://mango-kb-runbooks/" },
    { id: "kb-02", name: "Políticas de RH", owner: "People team", source: "Google Drive", icon: "People",
      desc: "Handbook, políticas de vacaciones, onboarding y beneficios.",
      docs: 38, chunks: 612, tokens: 284000, embedding: "titan-v2", lastSync: "hace 12h", syncStatus: "ok",
      usedBy: ["hr-01"], bucket: "s3://mango-kb-rh/" },
    { id: "kb-03", name: "FinOps Playbooks", owner: "FinOps team", source: "Confluence", icon: "Money",
      desc: "Procesos de optimización de costos, Savings Plans, Reserved Instances y cost allocation.",
      docs: 24, chunks: 489, tokens: 215000, embedding: "titan-v2", lastSync: "hace 1d", syncStatus: "ok",
      usedBy: ["fin-01", "fin-02"], bucket: "s3://mango-kb-finops/" },
    { id: "kb-04", name: "Security Baseline", owner: "Security team", source: "Confluence", icon: "Shield",
      desc: "Standards de seguridad, compliance SOC2, runbooks de respuesta y políticas IAM.",
      docs: 87, chunks: 1820, tokens: 920000, embedding: "titan-v2", lastSync: "hace 6h", syncStatus: "ok",
      usedBy: ["sec-01", "sec-02"], bucket: "s3://mango-kb-sec/" },
    { id: "kb-05", name: "SAP Procurement", owner: "Procurement", source: "Google Drive", icon: "Database",
      desc: "Procesos de compras, vendors aprobados, three-way match y workflows.",
      docs: 56, chunks: 892, tokens: 412000, embedding: "titan-v2", lastSync: "hace 3h", syncStatus: "warn",
      usedBy: ["sap-01", "sap-02"], bucket: "s3://mango-kb-sap/", note: "5 documentos con errores de OCR" },
    { id: "kb-06", name: "Data Dictionary", owner: "Data Platform", source: "Custom S3", icon: "Database",
      desc: "Definiciones de tablas, métricas de negocio y data contracts del lakehouse.",
      docs: 203, chunks: 5120, tokens: 2.4e6, embedding: "titan-v2", lastSync: "hace 4h", syncStatus: "ok",
      usedBy: ["data-01"], bucket: "s3://mango-kb-data/" },
    { id: "kb-07", name: "Release Archive", owner: "Platform team", source: "GitHub", icon: "Zap",
      desc: "Changelogs históricos, release notes y RFCs archivados.",
      docs: 412, chunks: 2180, tokens: 1.1e6, embedding: "titan-v2", lastSync: "hace 30m", syncStatus: "ok",
      usedBy: ["pm-01"], bucket: "s3://mango-kb-releases/" },
    { id: "kb-08", name: "Customer Docs (draft)", owner: "Platform team", source: "Confluence", icon: "BookOpen",
      desc: "Documentación externa de clientes — en proceso de aprobación legal.",
      docs: 18, chunks: 245, tokens: 118000, embedding: "titan-v2", lastSync: "nunca", syncStatus: "pending",
      usedBy: [], bucket: "s3://mango-kb-customer/" },
  ],

  activity: [
    { t: "12:04", who: "FinOps", what: "creó ticket", target: "MNG-412", tone: "blue" },
    { t: "12:02", who: "Usuario 1", what: "aprobó override de budget para", target: "Reservation Scout", tone: "green" },
    { t: "11:58", who: "Security Pulse", what: "escaló finding", target: "UnauthorizedAccess:EC2", tone: "red" },
    { t: "11:47", who: "Reservation Scout", what: "alcanzó 98% de budget mensual", target: "", tone: "amber" },
    { t: "11:33", who: "DevOps Sentinel", what: "ejecutó rollback en", target: "prod-web", tone: "blue" },
    { t: "11:18", who: "SAP Procure", what: "cerró ticket", target: "MNG-407", tone: "green" },
    { t: "10:55", who: "Athena Analyst", what: "ejecutó query", target: "retention_q3_cohorts", tone: "blue" },
    { t: "10:41", who: "Usuario 1", what: "creó nuevo agente", target: "Access Reviewer", tone: "violet" },
  ],
};
