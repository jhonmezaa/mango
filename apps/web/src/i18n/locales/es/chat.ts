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
  stopLabel: 'Cancelar respuesta',
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
    code: 'Ejecutando código…',
  },
  // Knowledge searches of a turn and the sources of an answer (design kb-agent.jsx, D88 (44)).
  knowledge: {
    searched: 'Buscó en',
    anyBase: 'las knowledge bases',
    fragments_one: '{{count}} fragmento',
    fragments_other: '{{count}} fragmentos',
    noFragments: 'ningún fragmento',
    sources: 'Fuentes',
    sourcesOf: 'Fuentes · {{kb}}',
    page: '· p. {{page}}',
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
    codeRunning: 'Ejecutando código',
    codeOk: 'Ejecutó código',
    codeFailed: 'Falló el código',
    status: { running: 'En curso', ok: 'Listo', failed: 'Falló' },
  },
  // Design round 40 `CodeBlock` (D114, C4): the cells the answer ran.
  code: {
    running: 'Analizando…',
    completed: 'Analizado',
    error: 'Error',
    paused: 'Pausado',
    cells_one: '{{count}} celda',
    cells_other: '{{count}} celdas',
    show: 'Ver código',
    hide: 'Ocultar código',
    cell: 'Celda {{n}}',
    cellRunning: 'corriendo',
    unfinished: 'sin terminar',
    pausedNote: 'Quedó sin terminar porque la respuesta se detuvo.',
    truncated: 'Salida recortada: se muestran los primeros 20.000 caracteres.',
    timeout: 'La celda pasó su tope de 300 s y se detuvo.',
    timeoutLabel: 'TIEMPO',
    exceptionLabel: 'EXCEPCIÓN',
    blocked:
      'Mango no muestra el código ni la salida de esta celda: infringían una regla de seguridad.',
  },
  // Design round 40 `CrFigure`.
  figure: {
    loading: 'Cargando la figura',
    error: 'No se pudo cargar la figura.',
    retry: 'Reintentar',
    expand: 'Ampliar {{name}}',
    expandShort: 'Ampliar',
    download: 'Descargar {{name}}',
    downloadShort: 'Descargar',
  },
  // Design round 40 `ChatChart` (D118, G1). `withheld` and `error` are not drawn by the design
  // yet (reported for the next round of Claude Design).
  chart: {
    loading: 'Cargando la gráfica…',
    loadingLabel: 'Cargando la gráfica',
    invalidTitle: 'No se pudo dibujar esta gráfica.',
    invalid:
      'Los datos que mandó el agente no tienen el formato que espera Mango. Pídele que la vuelva a generar o que te los dé en una tabla.',
    withheld: 'Mango no muestra esta gráfica: infringía una regla de seguridad.',
    error: 'No se pudo cargar la gráfica.',
    retry: 'Reintentar',
    copy: 'Copiar datos',
    copied: 'Datos copiados. Pégalos en Excel o en una hoja de cálculo.',
    chart: 'Gráfica',
  },
  // Design round 40 `DataTable` (D118 (5), T1).
  table: {
    loadingLabel: 'Cargando la tabla',
    rows_one: '{{n}} fila',
    rows_other: '{{n}} filas',
    columns_one: '{{count}} columna',
    columns_other: '{{count}} columnas',
    capped: 'Se muestran {{shown}} de {{total}} filas. Descarga el CSV para verlas todas.',
    invalid: 'No se pudo mostrar esta tabla. Pídele al agente que la vuelva a generar.',
    withheld: 'Mango no muestra esta tabla: infringía una regla de seguridad.',
    error: 'No se pudo cargar la tabla.',
    retry: 'Reintentar',
  },
  // Design round 40 `FileCard` (D116): a file the agent generated.
  /** Canvas (D124, design round 41 `canvas.jsx`). */
  canvas: {
    aria: 'Canvas: {{title}}',
    kindDocument: 'Documento',
    kindCode: 'Código · {{language}}',
    subtitle: 'Canvas · {{kind}} · v{{n}} de {{m}} · {{who}}',
    byYou: 'editada por ti',
    byAgent: 'de {{agent}}',
    history: 'Historial de versiones',
    historyTitle: 'Historial',
    export: 'Exportar',
    close: 'Cerrar Canvas',
    tabCode: 'Código',
    tabPreview: 'Vista previa',
    showChanges: 'Mostrar cambios',
    firstVersion: 'Es la primera versión',
    compareWith: 'Comparar con v{{n}}',
    edit: 'Editar',
    discard: 'Descartar',
    saveVersion: 'Guardar versión',
    editLabel: 'Editar el contenido',
    saved: 'Guardado como v{{n}}.',
    oldNotice: 'Estás viendo v{{n}} · {{at}} · {{who}}.',
    oldYours: 'tuya',
    goLatest: 'Ir a la actual',
    restore: 'Restaurar esta versión',
    restored: 'v{{from}} restaurada como v{{n}}.',
    changesTitle: 'Cambios de v{{from}} a v{{to}} · {{note}}',
    comments_one: '{{count}} comentario de {{agent}}',
    comments_other: '{{count}} comentarios de {{agent}}',
    resolve: 'Resolver',
    answerInChat: 'Responder en el chat',
    answerPrefix: 'Sobre «{{quote}}» en el Canvas: ',
    versions: 'Versiones',
    firstDraft: 'Primer borrador',
    current: 'Actual',
    versionsFooter: 'Las versiones viven lo que vive la conversación.',
    you: 'ti',
    exportNow: 'Se descarga al momento',
    exportChat: 'Se genera y llega al chat como archivo',
    exportWord: 'Word (.docx)',
    exportPdf: 'PDF',
    downloading: 'Descargando {{name}}',
    generating: 'Generando {{kind}}. Aparecerá en la conversación.',
    loading: 'Cargando el Canvas…',
    loadError: 'No se pudo abrir el Canvas. Inténtalo de nuevo.',
    retry: 'Reintentar',
    conflict: 'El documento tiene una versión más nueva. Ábrelo de nuevo para ver la actual.',
    saveError: 'No se pudo guardar la versión. Inténtalo de nuevo.',
    exportError: 'No se pudo generar el archivo. Inténtalo de nuevo.',
    card: 'Abrir en el Canvas',
    cardMetaDocument: 'Documento · v{{n}}',
    cardMetaCode: '{{language}} · la vista previa corre en tu navegador · v{{n}}',
    preview: {
      origin: 'Vista previa · contenido del agente, no de Mango',
      run: 'Ejecutar de nuevo',
      frameTitle: 'Vista previa del Canvas',
      footer:
        'Corre en tu navegador, aislado de Mango, sin red y sin costo de modelo. Dentro no funcionan formularios, ventanas emergentes, diálogos, descargas ni enlaces.',
      unavailable: 'La vista previa no está disponible en esta instalación.',
      state: {
        init: 'Preparando',
        run: 'Ejecutando',
        ok: 'Lista',
        error: 'Error en el código',
        initTimeout: 'No arrancó a tiempo',
        timeout: 'Tiempo agotado',
      },
      initTitle: 'Preparando Python…',
      initBody:
        'La primera vez descarga Python, numpy, pandas y matplotlib (decenas de MB). Tiene 20 s para arrancar.',
      initTitleOther: 'Preparando la vista previa…',
      initBodyOther: 'Tiene 20 s para arrancar.',
      runTitle: 'Ejecutando…',
      runBody: 'Tope de 50 s por ejecución.',
      initTimeoutTitle: 'La vista previa no arrancó en 20 s.',
      initTimeoutBody:
        'Puede ser la red de tu equipo al descargar los paquetes. Vuelve a ejecutarla.',
      timeoutTitle: 'La ejecución pasó su tope de 50 s y se detuvo.',
      errorHint: 'Solo hay numpy, pandas y matplotlib. No se instalan paquetes.',
    },
  },
  file: {
    meta: '{{kind}} · {{size}} · de {{agent}}',
    scanning: 'Revisando el archivo…',
    blocked: 'El escaneo de malware bloqueó este archivo. No se puede descargar.',
    gone: 'Ya no está disponible. Los archivos se guardan 90 días y se borran con la conversación.',
    dlError: 'No se pudo preparar la descarga. Inténtalo de nuevo.',
    rate_one:
      'Llegaste al máximo de 60 descargas por hora. Podrás descargar de nuevo en {{count}} minuto.',
    rate_other:
      'Llegaste al máximo de 60 descargas por hora. Podrás descargar de nuevo en {{count}} minutos.',
    download: 'Descargar',
    retry: 'Reintentar',
    preparing: 'Preparando…',
    downloading: 'Descargando {{name}}',
  },
  guardrail:
    'La respuesta se cortó porque infringía una regla de seguridad de Mango. Lo que ves arriba es lo que alcanzó a escribir. Reformula la pregunta si necesitas más.',
  // Design chat.jsx round 34: the answer reached its token cap (D74). No «Continuar».
  truncated: {
    title: 'Respuesta incompleta.',
    tokens: 'El agente llegó a su largo máximo de respuesta.',
    toolBefore: 'El agente llegó a su largo máximo mientras preparaba una consulta a ',
    toolAfter: ', y la consulta no se hizo.',
    toolUnnamed:
      'El agente llegó a su largo máximo mientras preparaba una consulta, y la consulta no se hizo.',
    rest: 'Lo de arriba es lo que alcanzó a escribir. Si necesitas el resto, pídelo en un mensaje nuevo; por ejemplo, «sigue desde donde quedaste».',
  },
  live: 'LIVE',
  // Design round 40 (D121 (7)): «Cancelar» ends the turn interrupted; it is charged in full.
  stopped:
    'Respuesta detenida. El turno se cobra entero y tu próxima pregunta empieza de nuevo: el agente solo recordará lo que se ve aquí.',
  // Design round 40 `ConnLine`: the stream of the turn was cut and is read again (D120 (4)).
  connection: {
    reconnecting: 'Se cortó la conexión. Reconectando…',
    attempt: 'intento {{n}} de 12',
    resumed: 'Reconectado. La respuesta sigue donde iba.',
    failedTitle: 'No se pudo reconectar.',
    failedBody:
      'La respuesta puede seguir en Mango. «Volver a conectar» trae lo que haya, sin preguntar otra vez. También la verás al abrir de nuevo la conversación.',
    reconnect: 'Volver a conectar',
  },
  // Design round 40: Mango lost the turn halfway (D121 (7)).
  interrupted: {
    title: 'Respuesta interrumpida.',
    body: 'Mango perdió el turno a mitad. Lo de arriba es lo que alcanzó a escribir; el turno se cobra entero. Puedes volver a preguntar: el agente solo recordará lo que se ve aquí.',
  },
  // Design round 40: the session ended while the turn was read.
  away: 'La respuesta sigue en Mango. La verás completa al volver a entrar.',
  // Design round 40 «Otra pestaña»: the server refused the turn (`conversation_busy`).
  fromOtherTab: 'Desde otra pestaña',
  busy: 'Tu mensaje no se envió: hay una respuesta en curso en esta conversación, desde otra pestaña. Sigue en el cuadro de texto; envíalo cuando termine.',
  loadError: 'No se pudo cargar la conversación',
  // Design round 34: «+» while the first answer of a new conversation runs.
  newChatWait: 'Podrás empezar otra cuando termine la primera respuesta',
  // Design round 34: the person scrolled up while the agent answers.
  toEnd: {
    label: 'Ir al final de la conversación',
    newAnswer: 'Respuesta nueva',
    end: 'Ir al final',
  },
  toast: {
    doneTitle: 'Respuesta completa',
    doneBody: '{{name}} terminó de responder.',
    // Design round 34: an answer cut at its cap is not announced as complete.
    incompleteTitle: 'Respuesta incompleta',
    incompleteBody: '{{name}} no terminó de responder.',
    newChat: 'Nueva conversación iniciada.',
  },
  // Design round 35: opened from Buscar conversaciones at a message that is no longer there.
  focusGone: 'Ese mensaje ya no está en la conversación.',
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
  // Design chat.jsx ChatHeader `tools-pop` (round 23, D92 (8)).
  toolsPop: {
    title: 'Qué puede usar {{name}}',
    subtitle:
      'Lo fija la versión que te responde. Cambiarlo es una versión nueva del agente, con su aprobación.',
    skills: 'Skills · {{shown}}',
    skillsNote:
      'Son instrucciones: no ejecutan nada. El agente carga una cuando le sirve; si quieres que use alguna, pídelo en tu mensaje y puede seguirlo o no.',
    noSkills: 'Esta versión no tiene skills.',
    version: 'v{{version}}',
    mcp: 'Tools (MCP) · {{count}}',
    mcpTools_one: '{{count}} tool',
    mcpTools_other: '{{count}} tools',
    loading: 'Cargando…',
    // Design round 24: the detail could not be read.
    error: 'No se pudo cargar qué puede usar {{name}}',
    errorBody: 'Inténtalo de nuevo en unos segundos.',
    retry: 'Reintentar',
    // Design round 41 (memory.jsx `MemoryPopRow`, D122).
    memory: 'Memoria',
    memoryNone: 'Esta versión no recuerda nada entre conversaciones.',
    memoryOff:
      'Esta versión tiene memoria, pero está apagada en esta instalación: no recuerda nada.',
    memoryOn:
      'Recuerda lo que hablas con {{name}} entre conversaciones. Solo tú lo ves; lo borras en ',
    memoryLink: 'Memoria',
    memoryEnd: '.',
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
    commands: 'comandos',
    commandsLabel: 'Comandos con /',
    newLine: 'nueva línea',
  },
  // Design round 40 (chat-run.jsx, D116): the files of a message.
  attachments: {
    uploading: 'Subiendo · {{percent}} %',
    scanning: 'Revisando el archivo…',
    blocked: 'Bloqueado por el escaneo',
    unsupported: 'Tipo no permitido',
    mismatch: 'El contenido no es del tipo que dice',
    tooLarge: 'Supera 100 MB',
    failed: 'No se pudo subir',
    gone: 'Ya no disponible',
    goneTitle: 'Los adjuntos se guardan 90 días.',
    retry: 'Reintentar',
    remove: 'Quitar {{name}}',
    overflow_one: 'Puedes adjuntar hasta {{max}} archivos por mensaje. Uno se quedó fuera.',
    overflow_other:
      'Puedes adjuntar hasta {{max}} archivos por mensaje. {{count}} se quedaron fuera.',
    waitBusy: 'Enviar se activa cuando terminen de subirse y revisarse los archivos.',
    waitBad: 'Quita los archivos con problemas para enviar el mensaje.',
    attachOff: 'Adjuntar archivos (no disponible)',
    cannotTitle: '{{name}} no puede leer archivos: su versión no tiene «Ejecutar código».',
    cannot:
      '{{name}} no puede leer archivos: su versión no tiene «Ejecutar código». Quien lo administra puede activarlo en el Builder.',
    dropTitle: 'Suelta los archivos para adjuntarlos',
    dropHint:
      'Hasta 20 archivos · 100 MB c/u · PDF, CSV, TXT, JSON, Excel, Word, PowerPoint, PNG, JPG',
    dropCannot: '{{name}} no puede leer archivos',
    dropCannotHint: 'Su versión no tiene «Ejecutar código».',
    // A message that is only its files (design `(archivos adjuntos)`).
    onlyFiles: '(archivos adjuntos)',
  },
  tools: {
    listLabel: 'Herramientas del agente',
    count_one: '{{count}} herramienta',
    count_other: '{{count}} herramientas',
    seconds: '{{seconds}} s',
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
