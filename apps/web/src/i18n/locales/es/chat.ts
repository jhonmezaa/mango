// Chat with an agent and its Markdown rendering. Name, description and category of an agent
// come from the API (its published version); only what the API does not carry is here.
export const agent = {
  /** Name of the release agent where only its id is known (budgets of the admin screens). */
  name: 'FinOps',
  /** Line under the name of the release agent in the chat hero (design chat.jsx). */
  releaseTagline: 'Agente de costos de AWS',
  capabilitiesLabel: 'Capacidades del agente',
  capabilities: {
    costs: 'Costos y uso',
    forecast: 'Pronósticos',
    anomalies: 'Anomalías',
    savingsPlans: 'Savings Plans',
    areas: 'Áreas y OUs',
  },
  mcpServers_one: '{{count}} MCP server',
  mcpServers_other: '{{count}} MCP servers',
} as const;

export const chat = {
  conversations: 'Conversaciones',
  history: 'Historial',
  historyLoading: 'Cargando historial',
  conversationLoading: 'Cargando conversación',
  searchConversations: 'Buscar conversaciones',
  searchPlaceholder: 'Buscar en todas las conversaciones...',
  noMatches: 'Sin resultados para “{{query}}”',
  groups: {
    today: 'Hoy',
    yesterday: 'Ayer',
    week: 'Esta semana',
    older: 'Anteriores',
  },
  suggestions: 'Sugerencias',
  prompts: {
    monthSpend: {
      title: 'Gasto del mes',
      sub: 'Cuánto llevamos y contra el mes pasado',
      prompt: '¿Cuánto llevamos gastado este mes?',
    },
    topServices: {
      title: 'Top 5 servicios',
      sub: 'Los servicios con más gasto',
      prompt: '¿Cuáles son los 5 servicios con más gasto este mes?',
    },
    forecast: {
      title: 'Pronóstico de fin de mes',
      sub: 'Cómo cerraría el mes a este ritmo',
      prompt: '¿Cuál es el pronóstico de gasto para fin de mes?',
    },
    anomalies: {
      title: 'Anomalías de la semana',
      sub: 'Gastos fuera de lo normal',
      prompt: '¿Hubo anomalías de gasto esta semana?',
    },
  },
  placeholder: 'Mensaje a {{name}}…',
  inputLabel: 'Mensaje a {{name}}',
  agentUnknown: 'Agente',
  agentRetired: 'Retirado',
  // Design chat.jsx `ChatBlocked` and the box that replaces the composer.
  noAgent: {
    marketplace: 'Ir al Marketplace',
    loadError: 'No se pudieron cargar tus agentes',
    loadErrorBody: 'No se pudo completar la acción. Inténtalo de nuevo.',
    none: {
      title: 'Todavía no tienes agentes disponibles',
      body: 'Los agentes que puedes usar dependen de tus grupos. Revisa el Marketplace o pide acceso a un administrador.',
      composer: 'Necesitas un agente para conversar.',
    },
    unavailable: {
      title: 'Este agente ya no está disponible para ti',
      body: 'Puede que hayas perdido el acceso o que lo hayan quitado. Busca otro agente en el Marketplace.',
      composer: 'No puedes enviar mensajes a este agente.',
    },
    retired: {
      title: 'Este agente fue retirado',
      body: 'Sus conversaciones se conservan, pero no se pueden empezar nuevas. Busca otro agente en el Marketplace.',
      composer: 'No se pueden enviar mensajes a un agente retirado.',
    },
  },
  toolsMissing:
    'Algunas tools de {{name}} no están disponibles ahora porque se deshabilitó su MCP. Responderá sin ellas hasta que se vuelva a habilitar.',
  send: 'Enviar',
  stop: 'Cancelar',
  retry: 'Reintentar',
  you: 'Tú',
  assistant: 'Agente',
  tooLong: 'El mensaje supera el máximo de 4.000 caracteres. Acórtalo para enviarlo.',
  // Design chat.jsx `PHASE_TXT` and `STEP_TXT`: the four phases of a turn and its list of steps.
  progress: {
    thinking: 'Pensando…',
    tool: 'Consultando {{tool}}…',
    toolUnnamed: 'Consultando una tool…',
    toolCount: 'Consultando {{count}} tools…',
    tool_result: 'Procesando resultados…',
    writing: 'Escribiendo…',
  },
  steps: {
    count_one: '{{count}} paso',
    count_other: '{{count}} pasos',
    failed: ' · {{count}} con error',
    thinking: 'Pensó',
    tool_result: 'Procesó resultados',
    writing: 'Escribió',
    toolRunning: 'Consultando {{tool}}',
    toolOk: 'Consultó {{tool}}',
    toolFailed: 'Falló {{tool}}',
    toolUnnamed: 'una tool',
    status: { running: 'En curso', ok: 'Listo', failed: 'Falló' },
  },
  guardrail:
    'La respuesta se cortó porque infringía una regla de seguridad de Mango. Lo que ves arriba es lo que alcanzó a escribir. Reformula la pregunta si necesitas más.',
  live: 'LIVE',
  stopped: 'Respuesta detenida.',
  loadError: 'No se pudo cargar la conversación',
  toast: {
    doneTitle: 'Respuesta completa',
    doneBody: '{{name}} terminó de responder.',
    newChat: 'Nueva conversación iniciada.',
  },
  systemNotice: 'Aviso del sistema',
  viewBudget: 'Ver presupuesto',
  header: {
    model: 'Modelo',
    modelOf: 'Modelo: {{model}}',
    allowedModels: 'Modelos permitidos',
    allowedModelsNote: 'Solo los modelos permitidos en la versión aprobada del agente',
    cost: 'Costo de la conversación',
    costEmpty: 'USD —',
    observe: 'Observar herramientas',
    observeOn: 'Observar herramientas en vivo',
    observeOff: 'Dejar de observar herramientas',
    tools: 'Skills y tools disponibles',
    more: 'Más opciones',
  },
  actions: {
    copy: 'Copiar',
    copied: 'Copiado',
    copyMessage: 'Copiar mensaje',
    copyAnswer: 'Copiar respuesta',
    edit: 'Editar mensaje',
    feedback: 'Útil / Mejorable',
    resend: 'Reintentar',
  },
  composer: {
    attach: 'Adjuntar archivos',
    skill: 'Skill',
    commands: 'comandos',
    commandsLabel: 'Comandos con /',
    newLine: 'nueva línea',
  },
  tools: {
    listLabel: 'Herramientas del agente',
    count_one: '{{count}} herramienta',
    count_other: '{{count}} herramientas',
    seconds: '{{seconds}} s',
    ms: '{{ms}} ms',
    params: 'Parámetros de la tool',
    failed: 'Falló',
    status: {
      started: 'En curso',
      completed: 'Completada',
      error: 'Falló',
      interrupted: 'Interrumpida',
    },
  },
} as const;

// «Nueva conversación» (design ui.jsx `AgentPicker`).
export const agentPicker = {
  title: 'Nueva conversación',
  subtitle: 'Elige el agente con el que quieres conversar',
  search: 'Buscar agentes',
  searchPlaceholder: 'Buscar por nombre, capability o categoría...',
  everyone: 'Todos',
  recent: 'Recientes',
  all: 'Todos los agentes',
  results: 'Resultados ({{count}})',
  noMatches: 'Sin agentes que coincidan con "{{query}}"',
  none: 'Todavía no tienes agentes disponibles.',
  missing: '¿No encuentras el agente correcto?',
  create: 'Crear nuevo agente',
  marketplace: 'Ver Marketplace',
} as const;

export const markdown = {
  blockedImage: 'Imagen bloqueada',
  blockedImageTitle: 'Las imágenes del agente no se cargan',
  externalLinkTitle: 'Abrir enlace externo',
  externalLinkBody:
    'Este enlace lo escribió el agente y te lleva fuera de Mango. Revisa la dirección completa antes de abrirla.',
  externalLinkConfirm: 'Abrir enlace',
  cancel: 'Cancelar',
} as const;
