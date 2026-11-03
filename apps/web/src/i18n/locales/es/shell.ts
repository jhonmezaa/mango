// Shell and shared texts: app frame, navigation, "Próximamente", roles and errors.
export const app = {
  name: 'Mango',
  loading: 'Cargando…',
  skipToContent: 'Saltar al contenido',
  offline: 'Sin conexión · reintentaremos cuando vuelva la conexión',
  sessionWarning: {
    title_one: 'Tu sesión vence en {{count}} min.',
    title_other: 'Tu sesión vence en {{count}} min.',
    body: 'Guarda lo que estés escribiendo: al vencer vuelves a ingresar con tu contraseña y MFA.',
    bodySso: 'Guarda lo que estés escribiendo: al vencer vuelves a ingresar.',
    dismiss: 'Entendido',
  },
} as const;

export const common = {
  close: 'Cerrar',
  cancel: 'Cancelar',
  save: 'Guardar',
  saving: 'Guardando…',
  retry: 'Reintentar',
} as const;

export const config = {
  error: 'No se pudo cargar la configuración de la aplicación.',
} as const;

export const nav = {
  label: 'Navegación principal',
  workspaceOrg: 'Empresa',
  dashboard: 'Inicio',
  chat: 'Chat',
  inbox: 'Bandeja',
  marketplace: 'Marketplace',
  tickets: 'Tickets',
  search: 'Buscar conversaciones',
  approvals: 'Aprobaciones',
  review: 'Revisión de agentes',
  governance: 'Gobernanza',
  budgets: 'Presupuestos',
  audit: 'Audit log',
  activity: 'Actividad',
  playground: 'Playground',
  models: 'Brains',
  skills: 'Skills',
  mcp: 'Catálogo de MCP',
  knowledge: 'Knowledge Bases',
  schedules: 'Schedules',
  observability: 'Observability',
  evals: 'Evals',
  costs: 'Costos',
  org: 'Org Chart',
  settings: 'Ajustes',
  agentBuilder: 'Nuevo agente',
  groups: {
    gov: 'Gobernanza',
    build: 'Construir',
    ops: 'Operación',
  },
  platform: 'Plataforma',
  pinned: 'Agentes fijados',
  chatWith: 'Chat con {{name}}',
  unpin: 'Quitar de fijados',
  unpinAgent: 'Quitar {{name}} de fijados',
  newChat: 'Nueva conversación',
  emptyHistory: 'Aún no tienes conversaciones.',
  historyError: 'No se pudo cargar el historial.',
  // Design chat.jsx round 34: the turn failed too; its «Reintentar» reloads both.
  historyOutage: 'No se pudo cargar el historial. Se vuelve a cargar cuando reintentes tu mensaje.',
  openMenu: 'Abrir menú',
  closeMenu: 'Cerrar menú',
  collapse: 'Colapsar sidebar',
  expand: 'Expandir sidebar',
  breadcrumb: 'Ruta de navegación',
  withUnread_one: '{{label}}, {{count}} sin leer',
  withUnread_other: '{{label}}, {{count}} sin leer',
  searchShort: 'Buscar',
  searchLabel: 'Buscar (⌘K)',
  accountMenu: 'Cuenta de {{user}}',
  language: 'Idioma',
  languageCurrent: 'Idioma · Español',
  toggleTheme: 'Cambiar tema',
  themeCurrentLight: 'Tema claro activo',
  themeCurrentDark: 'Tema oscuro activo',
  tour: 'Primeros pasos',
  accountSecurity: {
    title: 'Contraseña y MFA',
    hint: 'Para cambiar tu contraseña usa «Olvidé mi contraseña» al iniciar sesión. Para restablecer tu MFA, pídeselo a un admin.',
  },
  groupsLabel: 'Grupos:',
  // Collapsed rail (design shell.jsx `RailGroup` and `.sb-tip`).
  rail: {
    expand: 'Expandir',
    containsCurrent: 'contiene la vista actual',
    pending_one: '{{count}} pendiente',
    pending_other: '{{count}} pendientes',
    currentView: 'vista actual',
    morePinned: 'Más agentes fijados ({{count}})',
  },
} as const;

export const soon = {
  tag: 'Próximamente',
  title: 'Todavía no está disponible',
  item: '{{label}}, próximamente',
  itemTitle: '{{label}} · Próximamente',
  viewBody: 'Esta sección todavía no está disponible en Mango.',
  goToChat: 'Ir al chat',
} as const;

// Design store.js ROLES: the label follows the permission group of the account.
export const roles = {
  admin: 'Admin',
  creator: 'Creador de agentes',
  user: 'Usuario',
} as const;

export const errors = {
  crashTitle: 'Algo se rompió en esta vista',
  crashHint: 'Ocurrió un error inesperado. Recarga la página o vuelve al chat.',
  forbiddenTitle: 'No tienes acceso a esta sección',
  forbiddenHint: 'Tu grupo no incluye esta sección. Un admin de Mango puede darte acceso.',
  reload: 'Recargar',
  home: 'Ir al chat',
  generic: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
  budget_exceeded: 'Se agotó tu presupuesto de uso. Contacta al administrador de Mango.',
  forbidden: 'No tienes permiso para realizar esta acción.',
  invalid_message: 'El mensaje no es válido.',
  upstream_error: 'El agente no está disponible en este momento. Inténtalo más tarde.',
  agent_unavailable: 'El agente no está disponible en este momento. Inténtalo más tarde.',
  agent_retired: 'Este agente fue retirado y ya no recibe mensajes.',
  agent_mismatch: 'Esta conversación pertenece a otro agente. Inicia una nueva conversación.',
  model_not_allowed: 'El agente no permite ese modelo. Elige otro.',
  model_unavailable: 'Ese modelo está deshabilitado. Elige otro o avisa a un administrador.',
  conversation_busy: 'Todavía se está respondiendo el mensaje anterior. Inténtalo de nuevo.',
  network: 'No se pudo conectar con Mango. Revisa tu conexión.',
  streamInterrupted: 'La respuesta se interrumpió antes de terminar.',
  // Design chat.jsx round 34: a 429 of the turn (the edge or mango-api).
  rate_limited: 'Llegaron muchas solicitudes desde tu red. Tu mensaje no se envió.',
  rateLimitedTitle: 'Demasiadas solicitudes',
  retry: 'Reintentar',
} as const;

/** Design chat.jsx round 34 `RateWait`: the wait of a 429, from its `Retry-After`. */
export const rateWait = {
  minutes: 'Puedes volver a intentarlo en {{count}} minutos.',
  seconds: 'Puedes volver a intentarlo en unos segundos.',
  ready: 'Ya puedes volver a intentarlo.',
  retryIn: 'Reintentar en {{wait}}',
  hint: 'La espera la fija Mango; reintentar antes vuelve a contar',
  hours_one: 'en {{count}} hora',
  hours_other: 'en {{count}} horas',
  secondsShort: '{{count}} s',
} as const;

export const notFound = {
  title: 'Página no encontrada',
  description: 'La dirección no existe o ya no está disponible.',
  back: 'Volver al chat',
} as const;
