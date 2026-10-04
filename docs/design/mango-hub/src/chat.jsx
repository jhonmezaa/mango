// Chat view — Claude Desktop style with Hero, Artifacts, Slash commands
const { useEffect, useRef, useMemo } = React;

const seedMessages = {
  "t1": [
    { type: "user_message", text: "¿Cuáles son mis principales drivers de costo en AWS este mes y qué podemos optimizar?", time: "12:03" },
    { type: "tool_call", tool: "aws-cost-explorer.get_cost_and_usage", params: { granularity: "MONTHLY", metrics: ["AmortizedCost"], groupBy: "SERVICE" }, ms: 820, status: "ok", expanded: false },
    { type: "tool_call", tool: "compute-optimizer.get_recommendations", params: { accountIds: ["prod-main", "prod-data"] }, ms: 1120, status: "ok", expanded: false },
    { type: "agent_response", text: `Aquí está el breakdown de costos para **Octubre 2026** (mes a la fecha), con los drivers de crecimiento ordenados por impacto:

| Servicio | MTD | Δ vs Sept | % cuenta |
|---|---:|---:|---:|
| **EC2-Other** | $48,210 | **+18.4%** | 22% |
| **S3 Standard** | $31,890 | +11.2% | 15% |
| **Bedrock** | $18,440 | **+240%** | 9% |
| **RDS** | $14,120 | -2.1% | 7% |
| **Data Transfer** | $9,870 | +4.8% | 5% |

**Drivers principales:**

1. **EC2-Other (+$7.5k)** — crecimiento casi todo en NAT Gateway y EBS snapshots huérfanos en \`us-east-1\`.
2. **Bedrock (+$13k)** — coincide con el rollout de Mango. Esperado y dentro de proyección.
3. **S3 Standard (+$3.2k)** — el bucket \`events-ingest\` creció 8 TB; ningún lifecycle policy activo.

Generé un reporte completo con las 12 recomendaciones accionables y el ahorro estimado. ¿Quieres que abra tickets para ejecutarlas?`,
      artifact: { id: "art-cost-oct", kind: "report", title: "Análisis de costos Octubre 2026", preview: "Reporte con 12 acciones, ahorro total estimado $3,840/mes" }
    },
    { type: "ticket_created", id: "MNG-412", title: "Identificar top 5 drivers de costo de Octubre", prio: "high", status: "in_progress" },
    { type: "system_notice", tone: "amber", text: "Budget de FinOps alcanzó 80% ($2,400 / $3,000). Nuevas invocaciones continúan pero recibirás otra alerta al 100%.", icon: "Warn" },
  ],
  "t2": [
    { type: "user_message", text: "Revisa los 4 buckets de S3 candidatos para mover a Intelligent-Tiering y dame el ahorro estimado", time: "Ayer 14:12" },
    { type: "tool_call", tool: "s3.list_buckets", params: { filter: "size>1TB" }, ms: 410, status: "ok" },
    { type: "tool_call", tool: "aws-cost-explorer.get_cost_and_usage", params: { service: "AmazonS3", groupBy: "USAGE_TYPE" }, ms: 680, status: "ok" },
    { type: "agent_response", text: `Encontré los **4 buckets** con mejor perfil de ahorro:

| Bucket | Tamaño | Acceso últimos 90d | Ahorro/mes |
|---|---:|:--:|---:|
| \`events-ingest\` | 8.2 TB | Baja | **$1,100** |
| \`analytics-archive\` | 3.1 TB | Muy baja | **$620** |
| \`logs-prod-backup\` | 2.4 TB | Baja | **$480** |
| \`ml-features-v2\` | 1.8 TB | Media | **$290** |

Total: **$2,490/mes** ($29,880 anualizado). ¿Aplico el lifecycle policy en staging primero?` },
  ],
  "t3": [
    { type: "user_message", text: "El deploy 341 de prod-web está stuck desde hace 45min", time: "Ayer 11:20" },
    { type: "tool_call", tool: "codepipeline.get_pipeline_execution", params: { pipelineName: "prod-web", executionId: "341" }, ms: 320, status: "ok" },
    { type: "agent_response", text: "El pipeline está esperando una **manual approval** en el stage **Deploy-Prod**. Fue solicitada a las 10:35 pero nadie ha respondido. El aprobador asignado es `@usuario9` (fuera de oficina según PagerDuty).\n\n¿Quieres que reasigne la aprobación a otro miembro de tu grupo o que ejecute un rollback al deploy 340?" },
    { type: "error", text: "No se pudo enviar notificación a Slack: channel #deploys is archived. Retry?", retry: true },
  ],
  "t4": [
    { type: "user_message", text: "Dame el estado de las alarmas en eu-west-1", time: "Lun 09:30" },
    { type: "tool_call", tool: "cloudwatch.describe_alarms", params: { stateValue: "ALARM", region: "eu-west-1" }, ms: 280, status: "ok" },
    { type: "agent_response", text: "Hay **3 alarmas en WARN** en eu-west-1:\n\n1. `api-gateway-4xx` — tasa 8.2% (umbral 5%)\n2. `rds-connections-staging` — 340/400\n3. `ecs-cpu-checkout` — sostenido 82% en últimos 10min\n\nNinguna es crítica pero `ecs-cpu-checkout` puede escalar. ¿Reviso el runbook?" },
  ],
  "t5": [
    { type: "user_message", text: "¿Cuál es la política de vacaciones para 2026?", time: "Lun 10:15" },
    { type: "tool_call", tool: "google-drive.search", params: { query: "política vacaciones 2026" }, ms: 540, status: "ok" },
    { type: "agent_response", text: "Encontré el documento **Política de Vacaciones 2026** actualizado el 14 de marzo. Los cambios principales respecto al año anterior son:\n\n- Los días de vacaciones se acumulan desde el primer mes (antes eran 6 meses)\n- Se añadieron 2 días de **\"bienestar mental\"** por año\n- La venta de vacaciones no acumuladas se paga al 150% (antes 125%)\n\n¿Quieres que te comparta el link del documento?" },
  ],
  "t6": [
    { type: "user_message", text: "Revísame los findings de GuardDuty de las últimas 24h", time: "Lun 08:45" },
    { type: "tool_call", tool: "guardduty.list_findings", params: { severity: ">= 7" }, ms: 620, status: "ok" },
    { type: "agent_response", text: "Detecté **2 findings HIGH**:\n\n1. **UnauthorizedAccess:EC2/SSHBruteForce** en `i-0a8b9f...` (staging) — 47 intentos fallidos desde una IP externa (nodo de salida Tor). Bloqueé esa IP en el SG automáticamente.\n\n2. **Recon:EC2/Portscan** hacia `10.0.12.x` — tráfico interno inusual. Requiere revisión manual.\n\nTe creé ticket MNG-405 para el segundo caso." },
    { type: "ticket_created", id: "MNG-405", title: "Finding GuardDuty UnauthorizedAccess:EC2", prio: "high", status: "needs_approval" },
  ],
  "t7": [
    { type: "user_message", text: "Estado de la PO #47721 con Proveedor 1", time: "Sáb" },
    { type: "tool_call", tool: "sap-s4-hana.get_purchase_order", params: { poNumber: "47721" }, ms: 890, status: "ok" },
    { type: "agent_response", text: "La **PO #47721** está **aprobada y liberada**, esperando Goods Receipt. El vendor ya confirmó envío para el 15-Nov. Cuando llegue la mercancía, el three-way match corre automáticamente.\n\nMonto: **$42,800 USD**. Cerré el ticket MNG-407." },
  ],
  "t8": [
    { type: "user_message", text: "Dame la retención de la cohort de activaciones de Q3", time: "Sáb" },
    { type: "tool_call", tool: "athena.run_query", params: { query: "SELECT cohort, retention_30, retention_60, retention_90 FROM user_cohorts WHERE quarter='Q3-2025'" }, ms: 2140, status: "ok" },
    { type: "agent_response", text: "Retención de cohorts Q3 2025:\n\n| Cohort | 30d | 60d | 90d |\n|---|---:|---:|---:|\n| 2025-07 | 61% | 42% | **34%** |\n| 2025-08 | 58% | 39% | 31% |\n| 2025-09 | 64% | 45% | — |\n\nLa cohort **2025-09** está performando mejor. Hipótesis: el nuevo onboarding rolled out el 28-Ago. ¿Quieres que te genere un dashboard en QuickSight?" },
  ],
};

// Fallback por agente cuando no hay thread seleccionado específico
const agentSeeds = {
  "fin-01": "t1", "dev-01": "t3", "ops-01": "t4", "hr-01": "t5",
  "sec-01": "t6", "sap-01": "t7", "data-01": "t8",
};

const suggestedPrompts = {
  "fin-01": [
    { icon: "Money", title: "Gasto del mes", sub: "Cuánto llevamos y contra el mes pasado", q: "¿Cuánto llevamos gastado este mes?" },
    { icon: "List", title: "Top 5 servicios", sub: "Los servicios con más gasto", q: "¿Cuáles son los 5 servicios con más gasto este mes?" },
    { icon: "Activity", title: "Pronóstico de fin de mes", sub: "Cómo cerraría el mes a este ritmo", q: "¿Cuál es el pronóstico de gasto para fin de mes?" },
    { icon: "Zap", title: "Anomalías de la semana", sub: "Gastos fuera de lo normal", q: "¿Hubo anomalías de gasto esta semana?" },
  ],
  "dev-01": [
    { icon: "Terminal", title: "Estado de pipelines", sub: "Qué está corriendo ahora" },
    { icon: "Zap", title: "Logs del último deploy", sub: "Errores y warnings" },
    { icon: "Activity", title: "Rollback guiado", sub: "Regresar a versión estable" },
    { icon: "Shield", title: "Deploy readiness check", sub: "Antes de ir a prod" },
  ],
  _default: [
    { icon: "Chat", title: "Preguntar algo general", sub: "Conversación abierta" },
    { icon: "Command", title: "Ver tools disponibles", sub: "Escribe / en el input" },
    { icon: "BookOpen", title: "Revisar documentación", sub: "Qué puede hacer este agente" },
    { icon: "Activity", title: "Últimas actividades", sub: "Historial de la semana" },
  ],
};

const slashCommands = [
  { cmd: "/tool", desc: "Invocar un tool específico", icon: "Command" },
  { cmd: "/handoff", desc: "Pasar contexto a otro agente", icon: "ArrowRight" },
  { cmd: "/ticket", desc: "Crear un ticket desde esta conversación", icon: "Tickets" },
  { cmd: "/reset", desc: "Nuevo chat manteniendo el agente", icon: "Refresh" },
  { cmd: "/export", desc: "Exportar conversación a Markdown", icon: "Download" },
  { cmd: "/observe", desc: "Ver tool calls en vivo mientras responde", icon: "Activity" },
];

function Chat({ agents, activeAgentId, setActiveAgentId, threads: allThreads, activeThreadId, setActiveThreadId }) {
  const I = window.Icons;
  const soon = window.useSoon();
  const agent = agents.find(a => a.id === activeAgentId) || agents[0];
  const threads = soon ? allThreads.filter(t => t.agentId === 'fin-01') : allThreads;
  const simAgent = window.useMango(s => s.simChatAgent) || null;
  const blocked = soon && simAgent && simAgent !== 'tools-missing' && simAgent !== 'central-denied' ? simAgent : null;
  const [input, setInput] = useState("");
  const initial = activeThreadId ? seedMessages[activeThreadId] : [];
  const [messages, setMessages] = useState(initial || []);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamPhase, setStreamPhase] = useState(null);
  const [streamSteps, setStreamSteps] = useState([]);
  const streamTimers = useRef([]);
  const [artifact, setArtifact] = useState(null);
  const [observe, setObserve] = useState(false);
  const streamRef = useRef(null);
  const scrollRef = useRef(null);
  const toast = window.useToast?.();
  const [attachments, setAttachments] = useState([]);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [extUrl, setExtUrl] = useState(null);
  const simChat = window.useMango(s => s.simChat);
  useEffect(() => {
    const h = (e) => { const a = e.target.closest && e.target.closest('a[data-ext-url]'); if (!a) return; e.preventDefault(); setExtUrl(a.getAttribute('data-ext-url')); };
    document.addEventListener('click', h); return () => document.removeEventListener('click', h);
  }, []);
  const approvals = window.useMango(s => s.approvals);
  const handledRef = useRef(new Set());
  useEffect(() => {
    messages.forEach(m => {
      if (m.type !== 'approval_request' || handledRef.current.has(m.approvalId)) return;
      const ap = approvals.find(a => a.id === m.approvalId);
      if (!ap || ap.status === 'pending') return;
      handledRef.current.add(m.approvalId);
      setMessages(ms => [...ms, ap.status === 'approved'
        ? { type: 'tool_call', tool: ap.tool, params: ap.params, ms: 740, measured: true, status: 'ok' }
        : { type: 'system_notice', tone: 'amber', icon: 'Warn', text: `${ap.id} rechazada por ${ap.decidedBy}: “${ap.note}”. No se ejecutó ninguna acción.` },
        ...(ap.status === 'approved' ? [{ type: 'agent_response', text: `Listo. ${ap.decidedBy} aprobó **${ap.id}** y ejecuté \`${ap.tool}\`. El cambio quedó registrado en el audit log.` }] : [])]);
    });
  }, [approvals, messages]);
  const addFiles = (files) => {
    const list = [...files].slice(0, 5).map(f => ({ name: f.name, size: f.size, type: f.type }));
    const tooBig = list.filter(f => f.size > 25 * 1024 * 1024);
    if (tooBig.length) toast?.({ tone: 'error', msg: `${tooBig[0].name} supera 25 MB` });
    setAttachments(a => [...a, ...list.filter(f => f.size <= 25 * 1024 * 1024)].slice(0, 5));
  };

  useEffect(() => {
    if (activeThreadId && seedMessages[activeThreadId]) {
      setMessages(seedMessages[activeThreadId]);
    } else {
      setMessages([]);
    }
    setStreaming(false); setStreamText(""); setArtifact(null);
  }, [activeThreadId, activeAgentId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamText, streaming]);

  const sendMessage = (textOverride) => {
    const text = (textOverride ?? input).trim();
    if ((!text && !attachments.length) || streaming) return;
    setInput("");
    const att = attachments;
    setAttachments([]);
    if (att.length) window.MangoStore.log('chat.attach', agent.id, att.map(f => f.name).join(', '));
    setMessages(m => [...m, { type: "user_message", text: text || '(archivos adjuntos)', time: "ahora", attachments: att }]);
    setStreaming(true);
    const isWrite = /\b(elimina|borra|apaga|termina|detén|deten|rollback|aplica|ejecuta|libera|reasigna|delete|terminate)|\bcrea(r)?\s+(un\s+)?presupuesto/i.test(text);
    if (isWrite) {
      setStreamPhase({ k: 'think' }); setTimeout(() => setStreamPhase({ k: 'tool', name: 'políticas de aprobación' }), 400);
      setTimeout(() => {
        const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')) : null; };
        const env = /\bprod/i.test(text) ? 'prod' : /\bstaging\b/i.test(text) ? 'staging' : null;
        const call = /presupuesto/i.test(text) ? { tool: 'aws-budgets.create_budget', params: { amount: num(/(\d[\d.,]*)/), currency: 'USD' } }
          : /pago|libera/i.test(text) ? { tool: 'sap-s4-hana.release_payment', params: { amount: num(/(\d[\d.,]*)/), currency: 'USD' } }
          : /rollback/i.test(text) ? { tool: 'codepipeline.rollback', params: { env } }
          : /det[eé]n|apaga|stop/i.test(text) ? { tool: 'aws-ec2-ops.stop_instances', params: { count: num(/(\d+)\s*instanc/i), env } }
          : { tool: agent.mcp[0] + '.execute_change', params: { env } };
        Object.keys(call.params).forEach(k => { if (call.params[k] === null || call.params[k] === undefined) delete call.params[k]; });
        const tier = window.approvalTier ? window.approvalTier(call.tool, call.params) : { tier: 'approvers', rule: 'Aprobación requerida' };
        const action = text.length > 70 ? text.slice(0, 70) + '…' : text;
        setStreaming(false); setStreamPhase(null);
        if (tier.tier === 'self') {
          setMessages(m => [...m, { type: 'agent_response', text: 'Esta acción modifica recursos. Según la política, basta con **tu confirmación** antes de ejecutarla.' }, { type: 'self_confirm', status: 'pending', action, rule: tier.rule, ...call }]);
          return;
        }
        const ap = window.MangoStore.requestApproval({ agent: agent.id, action, tool: call.tool, params: call.params, risk: /prod|elimina|borra|termina|delete|terminate/i.test(text) ? 'high' : 'medium', policy: tier.rule, impact: 'Cambio sobre recursos gestionados por ' + agent.name, threadId: activeThreadId });
        setMessages(m => [...m, { type: 'agent_response', text: 'Puedo hacerlo, pero la política exige **aprobación de ' + (ap.approvalsNeeded > 1 ? ap.approvalsNeeded + ' personas' : 'otra persona') + '** distinta de ti. Aprobar no la ejecuta: cuando esté aprobada, la ejecutas tú con **Ejecutar** en esta tarjeta o en Aprobaciones, antes de que venza.' }, { type: 'approval_request', approvalId: ap.id }]);
      }, 1400);
      return;
    }
    runTurn(text);
  };

  const runTurn = (text) => {
    const S = window.MangoStore; const avail = S.get().avail; const sim = S.get().simProgress || null;
    const srvName = (id) => window.Lifecycle?.serverOf?.(id)?.name || id;
    const toolA = avail ? { id: 'aws-cost-explorer.get_cost_and_usage', srv: 'aws-cost-explorer', params: { granularity: 'MONTHLY', groupBy: 'SERVICE' } } : { id: (agent.mcp[0] || 'tools') + '.query', srv: agent.mcp[0], params: {} };
    const toolB = avail ? { id: 'aws-billing.get_rightsizing_recommendations', srv: 'aws-billing', params: { service: 'EC2' } } : { id: (agent.mcp[1] || agent.mcp[0] || 'tools') + '.query', srv: agent.mcp[1] || agent.mcp[0], params: {} };
    const toolC = avail ? { id: 'aws-cost-explorer.get_cost_forecast', srv: 'aws-cost-explorer', params: { months: 3 } } : toolA;
    const part1 = avail ? "Revisé el gasto del mes con Cost Explorer. Los tres cambios con más impacto son: mover **events-ingest** a Intelligent-Tiering, limpiar snapshots EBS huérfanos y consolidar NAT Gateways en us-east-1." : "Voy a abrir 3 tickets de optimización y los voy a encolar con la prioridad correspondiente al impacto de ahorro.";
    const part2 = avail ? "\n\nCon el pronóstico de los próximos tres meses, el ahorro combinado ronda **USD 2.300/mes**. Te dejo el detalle por servicio para que el equipo responsable lo evalúe." : " El lifecycle de **events-ingest** lo puedo aplicar en staging si confirmas.";
    const parallel = sim === 'parallel';
    const named = sim !== 'unnamed';
    const label = (t) => named ? srvName(t.srv) : null;
    let steps = []; let txt = ''; const tools = []; let t = 0; const timers = [];
    const at = (ms, fn) => { t += ms; timers.push(setTimeout(fn, t)); };
    const push = (s) => { steps = [...steps, s]; setStreamSteps(steps); };
    const done = (id, st, extra) => { steps = steps.map(s => s.id === id ? { ...s, status: st, ...extra } : s); setStreamSteps(steps); };
    const write = (chunk, then) => { let i = 0; const base = txt; streamRef.current = setInterval(() => { i += 3; txt = base + chunk.slice(0, i); setStreamText(txt); if (i >= chunk.length) { clearInterval(streamRef.current); then(); } }, 22); };
    streamTimers.current = timers;
    setStreamSteps([]); setStreamText('');
    setStreamPhase({ k: 'think' }); push({ id: 's0', k: 'think', status: 'run' });
    at(700, () => { done('s0', 'ok'); const run = parallel ? [toolA, toolB] : [toolA]; run.forEach((x, n) => push({ id: 'tA' + n, k: 'tool', name: label(x), tool: x.id, status: 'run', t0: performance.now() })); setStreamPhase(parallel ? { k: 'tool', count: 2 } : { k: 'tool', name: label(toolA) }); });
    if (parallel) at(700, () => { done('tA1', 'fail'); tools.push({ type: 'tool_call', tool: toolB.id, params: toolB.params, ms: 700, measured: true, status: 'error' }); setStreamPhase({ k: 'tool', name: label(toolA) }); });
    at(parallel ? 400 : 1000, () => { done('tA0', 'ok'); tools.unshift({ type: 'tool_call', tool: toolA.id, params: toolA.params, ms: parallel ? 1100 : 1000, measured: true, status: 'ok' }); push({ id: 'p1', k: 'process', status: 'run' }); setStreamPhase({ k: 'process' }); });
    at(600, () => { done('p1', 'ok'); push({ id: 'w1', k: 'write', status: 'run' }); setStreamPhase({ k: 'write' });
      write(part1, () => { done('w1', 'ok');
        const finish = (cut) => { setStreaming(false); setStreamText(''); setStreamPhase(null); setStreamSteps([]);
          setMessages(m => [...m, ...tools, { type: 'agent_response', text: txt, ...(cut ? { guardrail: true } : {}) }]);
          if (cut) S.log('chat.guardrail', agent.id, 'Respuesta cortada por guardrail');
          else toast?.({ tone: 'success', title: 'Respuesta completa', msg: agent.name + ' terminó de responder.' }); };
        push({ id: 'tC', k: 'tool', name: label(toolC), tool: toolC.id, status: 'run' }); setStreamPhase({ k: 'tool', name: label(toolC) });
        timers.push(setTimeout(() => { done('tC', 'ok'); tools.push({ type: 'tool_call', tool: toolC.id, params: toolC.params, ms: 900, measured: true, status: 'ok' }); push({ id: 'p2', k: 'process', status: 'run' }); setStreamPhase({ k: 'process' });
          timers.push(setTimeout(() => { done('p2', 'ok'); push({ id: 'w2', k: 'write', status: 'run' }); setStreamPhase({ k: 'write' });
            if (sim === 'guardrail') { const half = part2.slice(0, Math.round(part2.length * 0.45)); write(half, () => finish(true)); }
            else write(part2, () => { done('w2', 'ok'); timers.push(setTimeout(() => finish(false), 200)); });
          }, 600));
        }, 900));
      });
    });
  };

  const confirmSelf = (idx, ok) => {
    const S = window.MangoStore; const m0 = messages[idx]; if (!m0 || m0.status !== 'pending') return;
    S.log(ok ? 'approval.self_confirm' : 'approval.self_cancel', m0.tool, (ok ? 'Confirmó en el chat: "' : 'Canceló en el chat: "') + m0.action + '" · ' + m0.rule);
    setMessages(ms => { const n = ms.map((x, i) => i === idx ? { ...x, status: ok ? 'confirmed' : 'cancelled', by: S.actor() } : x); return ok ? [...n, { type: 'tool_call', tool: m0.tool, params: m0.params, ms: 720, measured: true, status: 'ok' }] : n; });
  };

  const cancelStream = () => {
    if (streamRef.current) clearInterval(streamRef.current);
    streamTimers.current.forEach(clearTimeout); streamTimers.current = [];
    setStreaming(false);
    setMessages(m => [...m, ...(streamText ? [{ type: "agent_response", text: streamText, stopped: true }] : []), { type: "stopped_note" }]);
    setStreamText(""); setStreamPhase(null); setStreamSteps([]);
  };

  const retryError = (idx) => {
    setMessages(m => m.map((msg, i) => i === idx ? { ...msg, retrying: true } : msg));
    setTimeout(() => {
      setMessages(m => m.filter((_, i) => i !== idx).concat([{ type: "agent_response", text: "Reintenté enviar a Slack usando el canal alternativo **#deploys-v2**. Enviado correctamente." }]));
      toast?.({ tone: 'success', msg: 'Slack reintentado con éxito.' });
    }, 800);
  };

  const newChat = () => {
    setActiveThreadId?.(null);
    setMessages([]); setStreamText(""); setStreamPhase(null); setStreamSteps([]); setStreaming(false); setArtifact(null);
    toast?.({ tone: 'info', msg: 'Nueva conversación iniciada.' });
  };

  const soonOffers = [[/\s*¿Quieres que abra tickets para ejecutarlas\?/, ''], [/Generé un reporte completo con las 12 recomendaciones accionables y el ahorro estimado\./, 'Estas son las 12 recomendaciones con su ahorro estimado.'], [/\s*¿Aplico el lifecycle policy en staging primero\?/, ' Para aplicarlo, lo debe hacer el equipo responsable del bucket.']];
  const shown = soon ? messages.map(m => m.type === 'ticket_created' ? null : m.type === 'agent_response' ? { ...m, text: soonOffers.reduce((x, [re, r]) => x.replace(re, r), m.text) } : m) : messages;
  const convError = simChat === 'conv-error' && activeThreadId;
  const convLoading = simChat === 'loading' && activeThreadId;
  const isEmpty = messages.length === 0 && !convError && !convLoading;
  const listState = simChat === 'loading' ? 'loading' : simChat === 'history-error' ? 'error' : null;
  const listThreads = simChat === 'empty' ? [] : threads;
  const items = [];
  shown.forEach((m, i) => {
    if (!m) return;
    const last = items[items.length - 1];
    if (m.type === 'tool_call' && last?.type === 'tool_group') last.calls.push(m);
    else if (m.type === 'tool_call') items.push({ type: 'tool_group', calls: [m], idx: i });
    else items.push({ ...m, idx: i });
  });

  return (
    <div className={`chat-grid ${artifact ? 'has-artifact' : ''}`} style={{display:'grid', gridTemplateColumns: `300px 1fr ${artifact ? '520px' : '0px'}`, height:'100%', overflow:'hidden', transition:'grid-template-columns 0.25s'}}>
      <ThreadList state={listState} threads={listThreads} agents={agents} activeAgentId={activeAgentId} activeThreadId={activeThreadId} onSelect={(t) => { setActiveAgentId(t.agentId); setActiveThreadId?.(t.id); }} onNew={newChat} />
      <div style={{display:'flex', flexDirection:'column', overflow:'hidden', borderLeft:'1px solid var(--border)', position:'relative'}}
        onDragOver={e => { if (!soon && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={e => { e.preventDefault(); setDragOver(false); if (!soon) addFiles(e.dataTransfer.files); }}>
        {dragOver && <div aria-hidden="true" style={{position:'absolute', inset: 12, zIndex: 30, border:'2px dashed var(--accent)', borderRadius: 12, background:'color-mix(in oklab, var(--bg) 85%, transparent)', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap: 8, pointerEvents:'none'}}><I.Upload size={22} style={{color:'var(--accent-ink)'}} /><div style={{fontSize: 14}}>Suelta los archivos para adjuntarlos</div><div style={{fontSize: 12, color:'var(--text-muted)'}}>Hasta 5 archivos · 25 MB c/u · PDF, CSV, XLSX, imágenes</div></div>}
        <ChatHeader agent={agent} onNewChat={newChat} observe={observe} setObserve={setObserve} messages={messages} onOpenThreads={() => setThreadsOpen(true)} />
        <div ref={scrollRef} style={{flex: 1, overflowY:'auto', padding: isEmpty ? 0 : '28px 0'}}>
          {convLoading ? <ChatSkeleton /> : convError ? (
            <div role="alert" style={{maxWidth: 760, margin:'0 auto', padding:'64px 32px', display:'flex', flexDirection:'column', alignItems:'center', gap: 10, textAlign:'center'}}>
              <span style={{width: 40, height: 40, borderRadius: 10, background:'var(--row-hover)', color:'var(--amber)', display:'flex', alignItems:'center', justifyContent:'center'}}><I.Warn size={18} /></span>
              <div style={{fontSize: 15, fontWeight: 600, color:'var(--text-strong)'}}>No se pudo cargar la conversación</div>
              <div className="row gap-2" style={{marginTop: 4}}>
                <button className="btn btn-sm btn-primary" onClick={() => window.MangoStore.set({ simChat: null })}><I.Refresh size={11} /> Reintentar</button>
                <button className="btn btn-sm" onClick={() => { window.MangoStore.set({ simChat: null }); newChat(); }}>Nueva conversación</button>
              </div>
            </div>
          ) : blocked === 'load-error' ? <div role="alert" style={{ maxWidth: 520, margin: '0 auto', padding: '80px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}><span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--row-hover)', color: 'var(--amber)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><I.Warn size={19} /></span><div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>No se pudieron cargar tus agentes</div><p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>No se pudo completar la acción. Inténtalo de nuevo.</p><button className="btn btn-sm" onClick={() => window.MangoStore.set({ simChatAgent: null })}><I.Refresh size={11} /> Reintentar</button></div>
          : blocked === 'none' ? <ChatBlocked icon="Store" title="Todavía no tienes agentes disponibles" body="Los agentes que puedes usar dependen de tus grupos. Revisa el Marketplace o pide acceso a un administrador." />
          : isEmpty && blocked ? <ChatBlocked icon="Lock" title={blocked === 'retired' ? 'Este agente fue retirado' : 'Este agente ya no está disponible para ti'} body={blocked === 'retired' ? 'Sus conversaciones se conservan, pero no se pueden empezar nuevas. Busca otro agente en el Marketplace.' : 'Puede que hayas perdido el acceso o que lo hayan quitado. Busca otro agente en el Marketplace.'} />
          : isEmpty ? (
            <AgentHero agent={agent} onPrompt={(p) => sendMessage(p)} />
          ) : (
            <div style={{maxWidth: 760, margin:'0 auto', padding:'0 32px'}}>
              {soon && simAgent === 'tools-missing' && <div className="mc-alert amber" role="status" style={{ marginBottom: 18 }}><window.Icons.Warn size={14} /><div>Algunas tools de {agent.name} no están disponibles ahora porque se deshabilitó su MCP. Responderá sin ellas hasta que se vuelva a habilitar.</div></div>}
              {soon && simAgent === 'central-denied' && <div className="mc-alert amber" role="status" style={{ marginBottom: 18 }}><window.Icons.Lock size={14} /><div>Las tools de AWS Billing son solo para usuarios centrales. {agent.name} respondió sin esos datos.</div></div>}
              {items.map(m => m.type === 'self_confirm' ? <window.SelfConfirmCard key={m.idx} msg={m} onConfirm={() => confirmSelf(m.idx, true)} onCancel={() => confirmSelf(m.idx, false)} /> : m.type === 'approval_request' ? <window.ApprovalCard key={m.idx} id={m.approvalId} /> : m.type === 'tool_group' ? <ToolGroup key={m.idx} calls={m.calls} /> : <Message key={m.idx} msg={m} idx={m.idx} onRetry={() => retryError(m.idx)} onEdit={() => setInput(m.text)} agent={agent} onOpenArtifact={setArtifact} />)}
              {streaming && <StreamingMessage phase={streamPhase} steps={streamSteps} text={streamText} agent={agent} observe={observe} />}
            </div>
          )}
        </div>
        <div style={{maxWidth: 760, margin:'0 auto', width:'100%'}}>
          {blocked === 'load-error' ? null : blocked ? <div style={{ padding: '0 32px 20px' }}><div className="row gap-2" style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', fontSize: 13, color: 'var(--text-muted)', background: 'var(--input-bg)', flexWrap: 'wrap' }}><window.Icons.Lock size={13} />{blocked === 'none' ? 'Necesitas un agente para conversar.' : blocked === 'retired' ? 'No se pueden enviar mensajes a un agente retirado.' : 'No puedes enviar mensajes a este agente.'}<button className="sr-link" style={{ marginLeft: 'auto' }} onClick={() => window.MangoNav?.('marketplace')}>Ir al Marketplace</button></div></div>
            : <ChatInput value={input} setValue={setInput} onSend={sendMessage} onCancel={cancelStream} streaming={streaming} agent={agent} attachments={attachments} setAttachments={setAttachments} addFiles={addFiles} />}
        </div>
      </div>
      {artifact && <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} agent={agent} />}
      <window.Modal open={!!extUrl} onClose={() => setExtUrl(null)} title="Abrir enlace externo" width={440}>
        <p style={{margin:'0 0 10px', fontSize: 13.5, color:'var(--text-muted)', lineHeight: 1.55}}>Este enlace lo escribió el agente y te lleva fuera de Mango. Revisa la dirección completa antes de abrirla.</p>
        <div style={{fontSize: 14, fontWeight: 600, color:'var(--text-strong)', wordBreak:'break-all', marginBottom: 6}}>{(() => { try { return new URL(extUrl).host; } catch (e) { return ''; } })()}</div>
        <div className="mono" style={{fontSize: 12, padding:'8px 10px', border:'1px solid var(--border)', borderRadius: 6, background:'var(--input-bg)', wordBreak:'break-all', marginBottom: 16}}>{extUrl}</div>
        <div className="row gap-2" style={{justifyContent:'flex-end'}}>
          <button className="btn btn-sm" data-autofocus onClick={() => setExtUrl(null)}>Cancelar</button>
          <button className="btn btn-sm btn-primary" onClick={() => { window.open(extUrl, '_blank', 'noopener,noreferrer'); setExtUrl(null); }}>Abrir enlace</button>
        </div>
      </window.Modal>
      {threadsOpen && <window.Drawer open onClose={() => setThreadsOpen(false)} title="Historial" width={340}>
        <div className="chat-threads-drawer"><ThreadList state={listState} threads={listThreads} agents={agents} activeAgentId={activeAgentId} activeThreadId={activeThreadId} onSelect={(t) => { setActiveAgentId(t.agentId); setActiveThreadId?.(t.id); setThreadsOpen(false); }} onNew={() => { newChat(); setThreadsOpen(false); }} /></div>
      </window.Drawer>}
    </div>
  );
}

function ChatBlocked({ icon, title, body }) {
  const I = window.Icons; const Ic = I[icon] || I.Lock;
  return (
    <div role="status" style={{ maxWidth: 520, margin: '0 auto', padding: '80px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
      <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--row-hover)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={19} /></span>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>{title}</div>
      <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.55, textWrap: 'pretty' }}>{body}</p>
      <button className="btn btn-sm" onClick={() => window.MangoNav?.('marketplace')}>Ir al Marketplace</button>
    </div>
  );
}

function AgentHero({ agent, onPrompt }) {
  const I = window.Icons;
  const Ag = I[agent.icon] || I.Bot;
  const av = window.MangoStore.get().avail;
  const prompts = suggestedPrompts[agent.id] || (av ? [] : suggestedPrompts._default);
  return (
    <div style={{display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'100%', padding:'60px 32px'}}>
      <div style={{maxWidth: 680, width:'100%'}}>
        <div style={{display:'flex', alignItems:'center', gap: 16, marginBottom: 18}}>
          <span style={{width: 54, height: 54, borderRadius: 14, background: agent.iconBg, color: agent.iconColor, display:'flex', alignItems:'center', justifyContent:'center'}}>
            <Ag size={26} />
          </span>
          <div style={{minWidth: 0, flex: 1}}>
            <div style={{fontSize: 30, fontWeight: 500, letterSpacing:'-0.015em', color:'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{agent.name}</div>
            <div style={{fontSize: 12.5, color:'var(--text-muted)', marginTop: 2}}>
              <span className="row gap-2" style={{display:'inline-flex'}}>
                {!av && <><span className="row gap-1"><span className="dot dot-green pulse" />En línea</span>
                <span>·</span></>}
                {av ? <span>{agent.id === 'fin-01' ? 'Agente de costos de AWS' : agent.cat}</span> : <><span className="mono">{agent.model}</span><span>·</span><span>{agent.cat}</span></>}
              </span>
            </div>
          </div>
        </div>
        <div style={{fontSize: 16, lineHeight: 1.6, color:'var(--text)', marginBottom: 22, maxWidth: 600}}>
          {agent.desc}
        </div>
        <div style={{display:'flex', flexWrap:'wrap', gap: 6, marginBottom: 28}}>
          {(!av || agent.id === 'fin-01') && agent.caps.map(c => <span key={c} className="badge" style={{fontSize: 11}}>{c}</span>)}
          <span className="badge" style={{fontSize: 11, color:'var(--text-dim)'}}>
            <I.Command size={10} style={{marginRight: 4, display:'inline'}} />{agent.mcp.length} {agent.mcp.length === 1 ? 'MCP server' : 'MCP servers'}
          </span>
        </div>
        {prompts.length > 0 && <div style={{fontSize: 11, color:'var(--text-muted)', fontWeight: 500, marginBottom: 10}}>Sugerencias</div>}
        <div style={{display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 8}}>
          {prompts.map((p, i) => {
            const Ic = I[p.icon] || I.Chat;
            return (
              <button key={i} onClick={() => onPrompt(p.q || p.title + "?")} className="card" style={{padding: 14, textAlign:'left', display:'flex', gap: 10, alignItems:'flex-start', cursor:'pointer'}}>
                <Ic size={14} style={{color:'var(--accent-ink)', marginTop: 2, flexShrink: 0}} />
                <div style={{flex: 1, minWidth: 0}}>
                  <div style={{fontSize: 13, fontWeight: 500, marginBottom: 2}}>{p.title}</div>
                  <div style={{fontSize: 11.5, color:'var(--text-muted)', lineHeight: 1.45}}>{p.sub}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ArtifactPanel({ artifact, onClose, agent }) {
  const I = window.Icons;
  return (
    <div style={{borderLeft:'1px solid var(--border)', background:'var(--panel)', display:'flex', flexDirection:'column', overflow:'hidden', animation:'slideIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)'}}>
      <div style={{padding:'10px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap: 10}}>
        <I.Document size={14} style={{color:'var(--accent-ink)'}} />
        <div style={{flex: 1, minWidth: 0}}>
          <div style={{fontSize: 12.5, fontWeight: 600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{artifact.title}</div>
          <div style={{fontSize: 10.5, color:'var(--text-dim)'}}>Generado por {agent.name} · artifact</div>
        </div>
        <button className="btn btn-ghost btn-sm"><I.Download size={11} /></button>
        <button className="btn btn-ghost btn-sm"><I.Copy size={11} /></button>
        <button className="btn btn-ghost btn-icon" onClick={onClose}><I.Close size={13} /></button>
      </div>
      <div style={{flex: 1, overflowY:'auto', padding: '24px 26px'}}>
        <div className="md" style={{fontSize: 14.5, lineHeight: 1.7}}>
          <h2>Análisis de costos — Octubre 2026</h2>
          <p><em>Generado por FinOps · {new Date().toLocaleDateString('es-MX', {day:'numeric', month:'long'})}</em></p>
          <h3>Resumen ejecutivo</h3>
          <p>Gasto MTD <strong>$124,530</strong>, +14% vs septiembre. Dentro de proyección anual pero con tres drivers de crecimiento atípico que requieren atención.</p>
          <h3>Top drivers</h3>
          <table>
            <thead><tr><th>Servicio</th><th>MTD</th><th>Δ</th><th>Acción</th></tr></thead>
            <tbody>
              <tr><td>EC2-Other</td><td>$48,210</td><td>+18%</td><td>Limpiar snapshots</td></tr>
              <tr><td>S3 Standard</td><td>$31,890</td><td>+11%</td><td>Lifecycle policy</td></tr>
              <tr><td>Bedrock</td><td>$18,440</td><td>+240%</td><td>Esperado (rollout)</td></tr>
            </tbody>
          </table>
          <h3>Recomendaciones priorizadas</h3>
          <ol>
            <li><strong>Migrar <code>events-ingest</code> a Intelligent-Tiering</strong> — $1,100/mes</li>
            <li><strong>Eliminar 287 snapshots EBS huérfanos</strong> — $540/mes</li>
            <li><strong>Consolidar NAT Gateways us-east-1</strong> — $320/mes</li>
            <li><strong>Reducir retention de CloudWatch logs</strong> — $280/mes</li>
            <li><strong>Rightsizing 14 instancias ECS staging</strong> — $420/mes</li>
          </ol>
          <p><strong>Ahorro total estimado: $3,840/mes</strong> ($46k anualizado)</p>
        </div>
      </div>
      <div style={{padding: 12, borderTop:'1px solid var(--border)', display:'flex', gap: 8}}>
        <button className="btn btn-sm" style={{flex: 1}}><I.Tickets size={11} /> Crear tickets (5)</button>
        <button className="btn btn-sm btn-primary"><I.Share size={11} /> Compartir</button>
      </div>
    </div>
  );
}

function ToolGroup({ calls }) {
  const I = window.Icons;
  const [open, setOpen] = useState(false);
  const timed = calls.filter(c => c.measured && c.ms != null);
  const total = timed.reduce((s, c) => s + c.ms, 0);
  const failed = calls.some(c => c.status !== 'ok');
  return (
    <div style={{marginBottom: 14, maxWidth: 760}}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} style={{display:'inline-flex', alignItems:'center', gap: 6, padding:'4px 8px', fontSize: 12, color:'var(--text-muted)', border:'1px solid var(--border)', borderRadius: 6}}>
        <I.ChevronRight size={10} style={{transform: open ? 'rotate(90deg)' : 'none', transition:'transform 0.15s'}} />
        <I.Terminal size={11} style={{color: failed ? 'var(--red)' : 'var(--green)'}} />
        <span>{calls.length} {calls.length === 1 ? 'herramienta' : 'herramientas'}</span>
        {timed.length === calls.length && <span className="mono" style={{fontSize: 11, color:'var(--text-dim)'}}>· {(total / 1000).toFixed(1)} s</span>}
      </button>
      {open && <div style={{marginTop: 6, border:'1px solid var(--border)', borderRadius: 8, overflow:'hidden'}}>
        {calls.map((c, i) => <ToolCallRow key={i} call={c} first={i === 0} />)}
      </div>}
    </div>
  );
}

function ToolCallRow({ call, first }) {
  const I = window.Icons;
  const soon = window.useSoon();
  const [open, setOpen] = useState(false);
  return (
    <div style={{borderTop: first ? 'none' : '1px solid var(--border)'}}>
      <button onClick={() => setOpen(!open)} style={{width:'100%', display:'flex', alignItems:'center', gap: 8, padding:'8px 12px', textAlign:'left'}}>
        <span className={`dot dot-${call.status === 'ok' ? 'green' : 'red'}`} />
        <span className="mono" style={{fontSize: 11.5, flex: 1, minWidth: 0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{call.tool}</span>
        {call.status === 'error' && <span className="badge badge-red">Falló</span>}
        {call.measured && call.ms != null && <span className="mono" style={{fontSize: 11, color:'var(--text-dim)'}}>{call.ms} ms</span>}
        <I.ChevronDown size={10} style={{color:'var(--text-dim)', transform: open ? 'rotate(180deg)' : 'none'}} />
      </button>
      {call.error && <div style={{margin: '-2px 12px 8px 26px', fontSize: 12, color: 'var(--text-muted)'}}>{call.error}</div>}
      {open && soon && <div style={{margin: '0 12px 10px'}}><window.Soon on><span style={{fontSize: 11.5}}>Parámetros de la tool</span></window.Soon></div>}
      {open && !soon && <pre className="mono" style={{margin: '0 12px 10px', fontSize: 11, background:'var(--input-bg)', border:'1px solid var(--border)', borderRadius: 5, padding:'8px 10px', overflow:'auto'}}>{JSON.stringify(call.params, null, 2)}</pre>}
    </div>
  );
}

function threadGroup(t) {
  if (t.pinned) return 'Fijadas';
  if (/^\d{1,2}:\d{2}$/.test(t.time) || /hoy|ahora|min/i.test(t.time)) return 'Hoy';
  if (/ayer/i.test(t.time)) return 'Ayer';
  if (/^(lun|mar|mi[eé]|jue|vie|s[aá]b|dom)/i.test(t.time)) return 'Esta semana';
  return 'Anteriores';
}

function ChatSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando conversación" style={{maxWidth: 760, margin:'0 auto', padding:'0 32px', display:'grid', gap: 22}}>
      <div className="skeleton" style={{height: 38, width:'46%', borderRadius: 12, marginLeft:'auto'}} />
      <div style={{display:'grid', gap: 8}}>{['92%', '86%', '64%'].map(w => <div key={w} className="skeleton" style={{height: 12, width: w, borderRadius: 4}} />)}</div>
      <div className="skeleton" style={{height: 38, width:'38%', borderRadius: 12, marginLeft:'auto'}} />
      <div style={{display:'grid', gap: 8}}>{['88%', '72%'].map(w => <div key={w} className="skeleton" style={{height: 12, width: w, borderRadius: 4}} />)}</div>
    </div>
  );
}

function ThreadList({ threads, agents, activeAgentId, activeThreadId, onSelect, onNew, state }) {
  const I = window.Icons;
  const [q, setQ] = useState("");
  const groupOrder = ['Fijadas', 'Hoy', 'Ayer', 'Esta semana', 'Anteriores'];
  const soonTL = window.useSoon();
  const visible = threads.filter(t => !q || t.title.toLowerCase().includes(q.toLowerCase()));
  const grouped = groupOrder.map(g => [g, visible.filter(t => threadGroup(t) === g)]).filter(([, l]) => l.length);
  return (
    <div style={{display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--panel)'}}>
      <div style={{padding:'10px 12px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap: 6}}>
        <div style={{flex:1, fontSize: 13, fontWeight: 600, color:'var(--text-strong)'}}>Conversaciones</div>
        <button className="btn btn-ghost btn-icon" title="Nueva conversación" onClick={onNew}><I.Plus size={13} /></button>
      </div>
      <div style={{padding:'8px 12px'}}>
        <div className="search-wrap">
          <I.Search size={12} />
          <input className="input" placeholder="Buscar en todas las conversaciones..." style={{fontSize: 12, padding:'6px 10px 6px 28px'}} value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      <div style={{flex:1, overflowY:'auto'}}>
        {state === 'loading' && <div role="status" aria-busy="true" aria-label="Cargando historial" style={{padding: '12px', display:'grid', gap: 14}}>{[0, 1, 2, 3, 4].map(i => <div key={i} className="row gap-2"><div className="skeleton" style={{width: 26, height: 26, borderRadius: 6, flexShrink: 0}} /><div style={{flex: 1, display:'grid', gap: 6}}><div className="skeleton" style={{height: 10, width: (80 - i * 8) + '%', borderRadius: 3}} /><div className="skeleton" style={{height: 8, width: '40%', borderRadius: 3}} /></div></div>)}</div>}
        {state === 'error' && <div role="alert" style={{padding: '24px 12px', fontSize: 12.5, color:'var(--text-muted)', textAlign:'center', display:'grid', gap: 10, justifyItems:'center'}}>No se pudo cargar el historial.<button className="btn btn-sm" onClick={() => window.MangoStore.set({ simChat: null })}><I.Refresh size={11} /> Reintentar</button></div>}
        {!state && threads.length === 0 && <div style={{padding: '24px 12px', fontSize: 12.5, color:'var(--text-muted)', textAlign:'center'}}>Aún no tienes conversaciones.</div>}
        {!state && threads.length > 0 && grouped.length === 0 && <div style={{padding: '24px 12px', fontSize: 12, color:'var(--text-muted)', textAlign:'center'}}>Sin resultados para “{q}”</div>}
        {!state && grouped.map(([g, list]) => <div key={g}>
        <div style={{padding:'12px 12px 4px', fontSize: 11, fontWeight: 500, color:'var(--text-muted)'}}>{g.toLowerCase()}</div>
        {list.map(t => {
          const a = agents.find(x => x.id === t.agentId);
          if (!a) return null;
          const Ag = I[a.icon];
          const active = activeThreadId === t.id;
          return (
            <button key={t.id} onClick={() => onSelect(t)}
              style={{
                width:'100%', padding:'10px 12px', textAlign:'left', display:'flex', gap: 10,
                background: active ? 'var(--row-hover)' : 'transparent',
                borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent'}}>
              <span style={{width: 26, height: 26, borderRadius: 6, background: a.iconBg, color: a.iconColor, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
                <Ag size={13} />
              </span>
              <div style={{flex:1, minWidth:0}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', gap: 6}}>
                  <span style={{fontSize: 12.5, fontWeight: 500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{t.title}</span>
                  <span style={{fontSize: 10.5, color:'var(--text-dim)', flexShrink: 0}}>{t.time}</span>
                </div>
                <div style={{display:'flex', alignItems:'center', gap: 6, marginTop: 2}}>
                  <span style={{fontSize: 11, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex: 1}}>{soonTL ? a.name : a.name + ' · ' + t.last}</span>
                  {!soonTL && t.unread > 0 && <span aria-label={t.unread + ' sin leer'} style={{fontSize: 10.5, background:'var(--accent-soft)', color:'var(--accent-ink)', fontWeight:600, padding:'1px 6px', borderRadius:999, minWidth: 18, textAlign:'center', lineHeight: 1.4, fontVariantNumeric:'tabular-nums'}}>{t.unread}</span>}
                </div>
              </div>
            </button>
          );
        })}
        </div>)}
      </div>
    </div>
  );
}

function ChatHeader({ agent, onNewChat, observe, setObserve, messages, onOpenThreads }) {
  const I = window.Icons;
  const Ag = I[agent.icon];
  const pct = Math.round(agent.budget / agent.budgetMax * 100);
  const tokens = messages.length * 340 + 1200;
  const cost = (tokens / 1000 * 0.015).toFixed(3);
  const [model, setModel] = useState(agent.model);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef(null);
  useEffect(() => { setModel(agent.model); }, [agent.id, agent.model]);
  useEffect(() => {
    if (!toolsOpen) return;
    const h = (e) => { if (toolsRef.current && !toolsRef.current.contains(e.target)) setToolsOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [toolsOpen]);
  const mcpServers = window.MangoData?.mcpServers || [];
  const allSkills = window.MangoData?.skills || [];
  const agentSkills = allSkills.filter(s => s.usedBy?.includes(agent.id));
  const agentMcp = agent.mcp.map(id => mcpServers.find(m => m.id === id)).filter(Boolean);
  const soon = window.useSoon();
  return (
    <div className="topbar">
      <div className="row gap-3" style={{minWidth: 0, flex: '1 1 auto'}}>
        <button className="btn btn-ghost btn-icon topbar-menu chat-menu" aria-label="Abrir menú" onClick={() => window.dispatchEvent(new CustomEvent('mango:open-nav'))}><I.List size={16} /></button>
        <button className="btn btn-sm chat-threads-btn" aria-label="Conversaciones" title="Conversaciones" onClick={onOpenThreads}><I.Chat size={13} /><span className="chat-threads-l">Conversaciones</span></button>
        <span style={{width: 26, height: 26, borderRadius: 6, background: agent.iconBg, color: agent.iconColor, display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0}}>
          <Ag size={13} />
        </span>
        <div style={{minWidth: 0, overflow: 'hidden'}}>
          <div style={{fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{agent.name}</div>
          <div className="row gap-2" style={{fontSize: 11, color:'var(--text-muted)', whiteSpace: 'nowrap'}}>
            {!soon && <><span className="row gap-1"><span className="dot dot-green pulse" />En línea</span>
            <span>·</span></>}
            {soon ? <window.Soon on className="ch-model-soon"><span className="mono" style={{ fontSize: 11 }}>Modelo ▾</span></window.Soon> : <window.ModelSwitcher agent={agent} value={model} onChange={setModel} />}
          </div>
        </div>
      </div>
      <div className="topbar-actions chat-actions" style={{flexShrink: 1, minWidth: 0}}>
        <window.Soon on={soon} className="ch-soon ch-soon-3"><span className="mono" title={`${(tokens/1000).toFixed(1)}k tokens en contexto · ${pct}% del presupuesto mensual`} style={{fontSize: 11, color: pct >= 80 ? 'var(--amber)' : 'var(--text-dim)', marginRight: 6}}>USD {String(cost).replace('.', ',')}</span></window.Soon>
        <button className={`btn btn-sm btn-icon ${observe ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setObserve(!observe)} title={observe ? 'Dejar de observar herramientas' : 'Observar herramientas en vivo'} aria-pressed={observe}>
          <I.Activity size={12} />
        </button>
        <div style={{position:'relative'}} ref={toolsRef} className={soon ? 'ch-soon-wrap ch-soon-2' : ''}>
          <window.Soon on={soon}><button className={`btn btn-sm ${toolsOpen ? 'btn-primary' : ''}`} onClick={() => setToolsOpen(x => !x)} title="Skills y tools disponibles">
            <I.Skill size={11} /> {agentSkills.length} · <I.Cloud size={11} /> {agentMcp.length}
          </button></window.Soon>
          {toolsOpen && (
            <div className="tools-pop">
              <div style={{padding:'12px 14px', borderBottom:'1px solid var(--border)'}}>
                <div style={{fontSize: 12.5, fontWeight: 600}}>Qué puede hacer {agent.name}</div>
                <div style={{fontSize: 11, color:'var(--text-dim)', marginTop: 2}}>Skills y tools configuradas por el admin</div>
              </div>

              <div style={{padding:'12px 14px 8px'}}>
                <div style={{fontSize: 10.5, color:'var(--text-muted)', fontWeight: 500, marginBottom: 8}}>Skills · {agentSkills.length}</div>
                {agentSkills.length === 0 && <div style={{fontSize: 11.5, color:'var(--text-dim)'}}>Sin skills asignadas.</div>}
                {agentSkills.map(s => {
                  const Ic = I[s.icon] || I.Skill;
                  return (
                    <div key={s.id} style={{display:'flex', gap: 10, padding:'7px 0', borderTop:'1px solid var(--border)', alignItems:'flex-start'}}>
                      <span style={{width: 22, height: 22, borderRadius: 5, background:'var(--row-hover)', color:'var(--text-muted)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0}}>
                        <Ic size={11} />
                      </span>
                      <div style={{flex: 1, minWidth: 0}}>
                        <div style={{fontSize: 12, fontWeight: 600}}>{s.name}{s.writeAction && <span className="badge badge-amber" style={{marginLeft: 6, fontSize: 9}}>write</span>}</div>
                        <div style={{fontSize: 11, color:'var(--text-muted)', marginTop: 2, lineHeight: 1.4, textWrap:'pretty'}}>{s.desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{padding:'12px 14px 12px', borderTop:'1px solid var(--border)'}}>
                <div style={{fontSize: 10.5, color:'var(--text-muted)', fontWeight: 500, marginBottom: 8}}>Tools (MCP) · {agentMcp.length}</div>
                {agentMcp.map(m => (
                  <div key={m.id} className="row between" style={{padding:'6px 0', borderTop:'1px solid var(--border)'}}>
                    <div style={{minWidth: 0}}>
                      <div className="mono" style={{fontSize: 11.5, fontWeight: 600}}>⌘ {m.id}</div>
                      <div style={{fontSize: 10.5, color:'var(--text-muted)'}}>{m.toolsCount} tools · {m.latency}ms</div>
                    </div>
                    <span className={`dot dot-${m.health === 'ok' ? 'green' : m.health === 'warn' ? 'amber' : 'red'}`} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {soon ? <window.Soon on className="ch-soon ch-soon-1"><button className="btn btn-sm btn-ghost btn-icon" aria-label="Más opciones"><I.More size={13} /></button></window.Soon> : <button className="btn btn-sm btn-ghost btn-icon" aria-label="Más opciones"><I.More size={13} /></button>}
        <span className="topbar-sep" aria-hidden="true" />
        {window.MangoStore.get().role === 'admin' && <button className="topbar-icon" aria-label="Ajustes" title="Ajustes" onClick={() => window.MangoNav?.('settings')}><I.Settings size={17} /></button>}
        <button className="topbar-create" aria-label="Nueva conversación" title="Nueva conversación" onClick={onNewChat}><I.Plus size={16} /></button>
      </div>
    </div>
  );
}

function Message({ msg, idx, onRetry, onEdit, agent, onOpenArtifact }) {
  const I = window.Icons;
  const soon = window.useSoon();
  const [expanded, setExpanded] = useState(msg.expanded === true);
  if (msg.type === "user_message") {
    return (
      <div className="msg-hover" style={{display:'flex', justifyContent:'flex-end', marginBottom: 22}}>
        <div style={{maxWidth: '78%', display:'flex', flexDirection:'column', alignItems:'flex-end', gap: 6}}>
          {msg.attachments?.length > 0 && <AttachmentChips files={msg.attachments} />}
          <div style={{padding:'10px 16px', background:'var(--card)', color:'var(--text)', border:'1px solid var(--border)', borderRadius: 14, fontSize: 14.5, lineHeight: 1.55}}>{msg.text}</div>
          <div className="msg-actions row gap-1" style={{fontSize: 11, color:'var(--text-dim)'}}>
            {msg.time && <span style={{marginRight: 4}}>{msg.time}</span>}
            {soon ? <window.Soon on><button className="btn btn-ghost btn-icon" aria-label="Editar mensaje"><I.Edit size={11} /></button></window.Soon> : <button className="btn btn-ghost btn-icon" title="Editar y reenviar" aria-label="Editar mensaje" onClick={onEdit}><I.Edit size={11} /></button>}
            <button className="btn btn-ghost btn-icon" title="Copiar" aria-label="Copiar mensaje" onClick={() => navigator.clipboard?.writeText(msg.text)}><I.Copy size={11} /></button>
          </div>
        </div>
      </div>
    );
  }
  if (msg.type === "agent_response") {
    return (
      <div className="msg-hover" style={{marginBottom: 24, maxWidth: 760}}>
        <div className="md" style={{fontSize: 15.5, lineHeight: 1.7, color:'var(--text)'}}
             dangerouslySetInnerHTML={{__html: window.renderMarkdown(msg.text)}} />
        {msg.guardrail && <div className="mc-alert amber" role="status" style={{ marginTop: 10 }}><I.Lock size={14} /><div>La respuesta se cortó porque infringía una regla de seguridad de Mango. Lo que ves arriba es lo que alcanzó a escribir. Reformula la pregunta si necesitas más.</div></div>}
        {msg.artifact && (
          <window.Soon on={soon} block style={{marginTop: 14}}><button onClick={() => onOpenArtifact(msg.artifact)} className="card" style={{marginTop: 14, padding: 12, display:'flex', gap: 10, alignItems:'center', width:'100%', textAlign:'left', cursor:'pointer'}}>
            <div style={{width: 36, height: 36, borderRadius: 7, background:'var(--accent-soft)', color:'var(--accent-ink)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0}}>
              <I.Document size={16} />
            </div>
            <div style={{flex: 1, minWidth: 0}}>
              <div style={{fontSize: 13, fontWeight: 500, marginBottom: 2}}>{msg.artifact.title}</div>
              <div style={{fontSize: 11.5, color:'var(--text-muted)'}}>{msg.artifact.preview}</div>
            </div>
            <I.ArrowRight size={12} style={{color:'var(--text-dim)'}} />
          </button></window.Soon>
        )}
        <div className="msg-actions" style={{display:'flex', gap: 2, marginTop: 10}}>
          <button className="btn btn-ghost btn-icon" title="Copiar" onClick={() => navigator.clipboard?.writeText(msg.text)}><I.Copy size={11} /></button>
          <window.Soon on={soon}><span className="row gap-1"><button className="btn btn-ghost btn-icon" title="Útil" aria-label="Útil"><I.ThumbsUp size={11} /></button>
          <button className="btn btn-ghost btn-icon" title="Mejorable" aria-label="Mejorable"><I.ThumbsDown size={11} /></button></span></window.Soon>
          <button className="btn btn-ghost btn-icon" title="Reintentar"><I.Refresh size={11} /></button>
        </div>
      </div>
    );
  }
  if (msg.type === "tool_call") {
    return (
      <div style={{marginBottom: 10, maxWidth: 760}}>
        <button onClick={() => setExpanded(!expanded)} style={{display:'flex', alignItems:'center', gap: 6, padding:'4px 8px', fontSize: 11.5, color:'var(--text-muted)', background:'transparent', border:'1px solid var(--border)', borderRadius: 6, cursor:'pointer', maxWidth:'100%', whiteSpace:'nowrap'}}>
          <I.ChevronRight size={10} style={{transform: expanded ? 'rotate(90deg)':'rotate(0)', transition:'transform 0.15s', color:'var(--text-dim)'}} />
          <I.Terminal size={11} style={{color: msg.status === 'ok' ? 'var(--green)' : 'var(--red)'}} />
          <span className="mono" style={{fontSize: 11, minWidth: 0, overflow:'hidden', textOverflow:'ellipsis'}}>{msg.tool}</span>
          {msg.measured && msg.ms != null && <span className="mono" style={{fontSize: 10.5, color:'var(--text-dim)', flexShrink: 0}}>· {msg.ms} ms</span>}
        </button>
        {expanded && soon && <div style={{marginTop: 4}}><window.Soon on><span style={{fontSize: 11.5}}>Parámetros de la tool</span></window.Soon></div>}
        {expanded && !soon && (
          <div style={{marginTop: 4, padding:'10px 12px', fontSize: 11.5, color:'var(--text-muted)', background:'var(--input-bg)', border:'1px solid var(--border)', borderRadius: 6}}>
            <div style={{color:'var(--text-muted)', fontSize: 10.5, marginBottom: 4}}>Params</div>
            <pre className="mono" style={{margin: 0, fontSize: 11, background:'var(--panel)', border:'1px solid var(--border)', borderRadius: 5, padding:'8px 10px', overflow:'auto'}}>{JSON.stringify(msg.params, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }
  if (msg.type === "ticket_created") {
    return (
      <div style={{marginBottom: 16, maxWidth: 760}}>
        <div className="card" style={{padding: 12, display:'flex', alignItems:'center', gap: 10, borderColor:'var(--accent-border)', background:'var(--accent-soft)'}}>
          <I.Tickets size={15} style={{color:'var(--accent-ink)'}} />
          <div style={{flex:1}}>
            <div style={{fontSize: 12.5}}>
              <span className="mono" style={{fontSize: 11, color:'var(--accent-ink)', fontWeight: 600}}>{msg.id}</span>
              <span style={{margin:'0 8px', color:'var(--text-dim)'}}>·</span>
              <span>{msg.title}</span>
            </div>
            <div className="row gap-2" style={{marginTop: 4}}>
              <span className={`badge badge-${msg.prio === 'high' ? 'red' : msg.prio === 'medium' ? 'amber' : 'green'}`}>{msg.prio}</span>
              <StatusPill status={msg.status} />
            </div>
          </div>
          <window.Soon on={soon}><button className="btn btn-sm">Ver ticket <I.ArrowRight size={11} /></button></window.Soon>
        </div>
      </div>
    );
  }
  if (msg.type === "stopped_note") {
    return <div className="row gap-2" style={{ margin: '-14px 0 22px', fontSize: 12.5, color: 'var(--text-muted)' }}><I.Stop size={11} /> Respuesta detenida.</div>;
  }
  if (msg.type === "system_notice") {
    return (
      <div style={{margin:'12px 0 14px', padding:'10px 14px', background: msg.tone === 'amber' ? 'var(--amber-soft)' : 'var(--blue-soft)', border:`1px solid ${msg.tone === 'amber' ? 'color-mix(in oklab, var(--amber) 25%, transparent)' : 'color-mix(in oklab, var(--blue) 25%, transparent)'}`, borderRadius: 8, display:'flex', gap: 10, alignItems:'flex-start', fontSize: 12}}>
        <I.Warn size={14} style={{color: msg.tone === 'amber' ? 'var(--amber)' : 'var(--blue)', marginTop: 2, flexShrink: 0}} />
        <div style={{flex: 1}}>
          <div style={{color: msg.tone === 'amber' ? 'var(--amber)' : 'var(--blue)', fontWeight: 500, marginBottom: 2, fontSize: 11}}>Aviso del sistema</div>
          <div style={{color:'var(--text)'}}>{msg.text}</div>
        </div>
        {/budget|presupuesto/i.test(msg.text) && <button className="btn btn-sm btn-ghost" onClick={() => window.MangoNav?.('budgets')}>Ver presupuesto</button>}
      </div>
    );
  }
  if (msg.type === "error") {
    return (
      <div style={{marginBottom: 14, maxWidth: 760}}>
        <div style={{padding:'10px 14px', background:'var(--red-soft)', border:'1px solid color-mix(in oklab, var(--red) 30%, transparent)', borderRadius: 8, fontSize: 12.5, color:'var(--text)', display:'flex', alignItems:'center', gap: 10}}>
          <I.X2 size={14} style={{color:'var(--red)', flexShrink: 0}} />
          <span style={{flex: 1}}>{msg.text}</span>
          {msg.retry && !msg.retrying && <button className="btn btn-sm" onClick={onRetry}><I.Refresh size={11} /> Reintentar</button>}
          {msg.retrying && <span className="muted">Reintentando...</span>}
        </div>
      </div>
    );
  }
  return null;
}

const PHASE_TXT = (p) => !p ? '' : p.k === 'think' ? 'Pensando' : p.k === 'process' ? 'Procesando resultados' : p.k === 'write' ? 'Escribiendo' : p.count ? 'Consultando ' + p.count + ' tools' : p.name ? 'Consultando ' + p.name : 'Consultando una tool';
const STEP_TXT = (s) => s.k === 'think' ? 'Pensó' : s.k === 'process' ? 'Procesó resultados' : s.k === 'write' ? 'Escribió' : (s.status === 'fail' ? 'Falló ' : s.status === 'run' ? 'Consultando ' : 'Consultó ') + (s.name || 'una tool');
function StreamingMessage({ phase, steps = [], text, agent, observe }) {
  const I = window.Icons;
  const [open, setOpen] = useState(false);
  const fails = steps.filter(s => s.status === 'fail').length;
  return (
    <div className="ch-stream" aria-busy="true" style={{marginBottom: 24, maxWidth: 760}}>
      {steps.length > 1 && (
        <div className="ch-steps">
          <button className="ch-steps-t" aria-expanded={open} onClick={() => setOpen(o => !o)}><I.ChevronRight size={11} style={{transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s'}} /> {steps.length} pasos{fails ? ' · ' + fails + ' con error' : ''}</button>
          {open && <ol className="ch-steps-l">{steps.map(s => <li key={s.id} className={'is-' + s.status}>{s.status === 'run' ? <span className="mango-spinner sm" /> : s.status === 'fail' ? <I.X2 size={12} /> : <I.Check size={12} />}<span>{STEP_TXT(s)}</span>{s.tool && <span className="mono">{s.tool}</span>}{s.err && <span className="ch-step-err">{s.err}</span>}</li>)}</ol>}
        </div>
      )}
      {text && (
        <div className="md" style={{fontSize: 15.5, lineHeight: 1.7, color:'var(--text)'}}>
          <span dangerouslySetInnerHTML={{__html: window.renderMarkdown(text)}} />
          {phase?.k === 'write' && <span className="md-cursor" />}
        </div>
      )}
      {phase && !(phase.k === 'write' && text) && (
        <div className="ch-phase" role="status" aria-live="polite">
          <span className="ch-orb" data-k={phase.k} aria-hidden="true"><i><b /></i><i><b /></i><i><b /></i></span>
          <span className="ch-phase-t">{PHASE_TXT(phase)}…</span>
          {observe && <span className="ch-live mono"><span className="dot" style={{background:'var(--blue)'}} /> LIVE</span>}
        </div>
      )}
      {phase?.k === 'write' && text && <span className="sr-only" role="status">Escribiendo…</span>}
    </div>
  );
}

function AttachmentChips({ files, onRemove }) {
  const I = window.Icons;
  const fmt = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  return (
    <div style={{display:'flex', flexWrap:'wrap', gap: 6}}>
      {files.map((f, i) => (
        <span key={i} className="row gap-2" style={{padding:'5px 8px', border:'1px solid var(--border)', borderRadius: 8, background:'var(--card)', fontSize: 12}}>
          <I.Document size={12} style={{color:'var(--accent-ink)'}} />
          <span style={{maxWidth: 180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{f.name}</span>
          <span className="mono" style={{fontSize: 10.5, color:'var(--text-muted)'}}>{fmt(f.size)}</span>
          {onRemove && <button aria-label={'Quitar ' + f.name} onClick={() => onRemove(i)} style={{display:'flex', color:'var(--text-muted)'}}><I.Close size={11} /></button>}
        </span>
      ))}
    </div>
  );
}

function ChatInput({ value, setValue, onSend, onCancel, streaming, agent, attachments = [], setAttachments, addFiles }) {
  const I = window.Icons;
  const fileRef = useRef(null);
  const soon = window.useSoon();
  const MAX = 4000;
  const over = value.length > MAX;
  const send = () => { if (over) return; onSend(); };
  const showSlash = !soon && value.startsWith('/') && !value.includes(' ');
  const filtered = showSlash ? slashCommands.filter(c => c.cmd.startsWith(value.toLowerCase())) : [];
  return (
    <div style={{borderTop:'1px solid var(--border)', padding: 16, position:'relative'}}>
      {showSlash && filtered.length > 0 && (
        <div style={{position:'absolute', bottom:'calc(100% - 4px)', left: 16, right: 16, maxWidth: 760, margin:'0 auto', background:'var(--panel)', border:'1px solid var(--border-strong)', borderRadius: 10, boxShadow:'0 12px 32px rgba(0,0,0,0.3)', padding: 6, zIndex: 10}}>
          <div style={{padding:'6px 10px 4px', fontSize: 10.5, color:'var(--text-muted)', fontWeight: 500}}>Slash commands</div>
          {filtered.map(c => {
            const Ic = I[c.icon] || I.Command;
            return (
              <button key={c.cmd} onClick={() => { setValue(c.cmd + ' '); }} style={{width:'100%', padding:'7px 10px', display:'flex', gap: 10, alignItems:'center', textAlign:'left', borderRadius: 5}}>
                <Ic size={12} style={{color:'var(--accent-ink)'}} />
                <span className="mono" style={{fontSize: 12, fontWeight: 500}}>{c.cmd}</span>
                <span style={{fontSize: 11.5, color:'var(--text-muted)'}}>{c.desc}</span>
              </button>
            );
          })}
        </div>
      )}
      <div style={{border:'1px solid var(--border)', borderRadius: 10, background:'var(--input-bg)', padding: 10}}>
        {attachments.length > 0 && <div style={{marginBottom: 8}}><AttachmentChips files={attachments} onRemove={(i) => setAttachments(a => a.filter((_, j) => j !== i))} /></div>}
        <input ref={fileRef} type="file" multiple hidden onChange={e => { addFiles?.(e.target.files); e.target.value = ''; }} />
        <textarea
          aria-label={`Mensaje a ${agent.name}`}
          placeholder={`Mensaje a ${agent.name}…`}
          value={value} onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          aria-invalid={over} aria-describedby={over ? 'ci-err' : undefined}
          style={{width:'100%', border:'none', background:'transparent', resize:'none', outline:'none', color:'var(--text)', fontSize: 14, fontFamily:'inherit', minHeight: 44, lineHeight: 1.55}}
          rows={2}
        />
        <div className="row between">
          <div className="row gap-1">
            <window.Soon on={soon}><button className="btn btn-ghost btn-icon" title="Adjuntar archivos" aria-label="Adjuntar archivos" onClick={() => fileRef.current?.click()}><I.Paperclip size={14} /></button></window.Soon>
            <window.Soon on={soon}><button className="btn btn-ghost btn-sm"><I.Skill size={12} /> Skill</button></window.Soon>

          </div>
          <div className="row gap-2">
            <span className="row gap-1" style={{fontSize: 11, color:'var(--text-dim)'}}><window.Soon on={soon}><span><span className="mono">/</span> comandos</span></window.Soon> · <span className="mono">⇧↵</span> nueva línea</span>
            {streaming
              ? <button className="btn btn-sm" onClick={onCancel}><I.Stop size={11} /> Cancelar</button>
              : <button className="btn btn-sm btn-primary" disabled={over} onClick={send}>Enviar <I.Send size={11} /></button>}
          </div>
        </div>
        {over && <div id="ci-err" role="alert" style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>El mensaje supera el máximo de 4.000 caracteres. Acórtalo para enviarlo.</div>}
      </div>
    </div>
  );
}

Object.assign(window, { Chat, agentSeeds, ModelSwitcher, seedMessages });

function ModelSwitcher({ agent, value, onChange }) {
  const I = window.Icons;
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const approved = [...(window.MangoStore.get().agentRevs || [])].filter(r => r.agentId === agent.id && r.status === 'published').sort((x, y) => new Date(y.decidedAt || 0) - new Date(x.decidedAt || 0))[0];
  const available = approved?.snap?.allowedModels || agent.availableModels || [agent.model];
  return (
    <span ref={ref} style={{position:'relative'}}>
      <button className="mono" onClick={() => setOpen(o => !o)} style={{
        background: open ? 'var(--input-bg)' : 'transparent',
        border: `1px solid ${open ? 'var(--border-strong)' : 'transparent'}`,
        color: 'var(--text-muted)', fontSize: 11, padding:'2px 6px', borderRadius: 4,
        display:'inline-flex', alignItems:'center', gap: 4, cursor:'pointer', fontFamily:'var(--font-mono)'
      }} onMouseEnter={e => !open && (e.currentTarget.style.background='var(--input-bg)')}
         onMouseLeave={e => !open && (e.currentTarget.style.background='transparent')}>
        {value}
        <I.ChevronDown size={10} />
      </button>
      {open && (
        <div className="popover" style={{position:'absolute', top:'calc(100% + 4px)', left: 0, zIndex: 50, minWidth: 220, padding: 4, background:'var(--card)', border:'1px solid var(--border-strong)', borderRadius: 8, boxShadow:'0 12px 32px rgba(0,0,0,0.4)'}}>
          <div style={{fontSize: 10.5, color:'var(--text-muted)', padding:'6px 10px 4px'}}>Modelos permitidos</div>
          {available.map(m => {
            const active = m === value;
            return (
              <button key={m} onClick={() => { onChange(m); setOpen(false); }} style={{
                display:'flex', alignItems:'center', justifyContent:'space-between', gap: 8,
                width:'100%', padding:'7px 10px', background: active ? 'var(--row-hover)' : 'transparent',
                border:'none', borderRadius: 4, cursor:'pointer', color:'var(--text)', fontSize: 12, textAlign:'left'
              }} onMouseEnter={e => e.currentTarget.style.background='var(--row-hover)'}
                 onMouseLeave={e => e.currentTarget.style.background = active ? 'var(--row-hover)' : 'transparent'}>
                <span className="mono" style={{fontSize: 11.5, fontWeight: active ? 600 : 400}}>{m}</span>
                {active && <I.Check size={12} style={{color:'var(--accent-ink)'}} />}
              </button>
            );
          })}
          <div style={{fontSize: 10, color:'var(--text-dim)', padding:'6px 10px 4px', borderTop:'1px solid var(--border)', marginTop: 4}}>
            Solo los modelos permitidos en la versión aprobada del agente
          </div>
        </div>
      )}
    </span>
  );
}
