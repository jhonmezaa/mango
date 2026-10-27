// Mis conexiones, the return from the provider, the chat card, «Leyó» and the link dialog of a
// turn that used remote tools (design remote-core.jsx and remote-views.jsx, D93, D94, D97).
export const connections = {
  menu: 'Mis conexiones',
  title: 'Mis conexiones',
  intro:
    'Servicios externos que tus grupos pueden usar. Tu cuenta se conecta una vez y los agentes leen con tus permisos, solo lectura. Mango no muestra tu token ni datos de tu cuenta.',
  loading: 'Cargando tus conexiones',
  loadError: 'No se pudieron cargar tus conexiones',
  retry: 'Reintentar',
  empty: 'Ningún servicio externo está habilitado para tus grupos.',
  connect: 'Conectar',
  disconnect: 'Desconectar',
  row: {
    already: 'Tu cuenta ya estaba conectada.',
    off: 'Un administrador deshabilitó {{service}}.',
    opening: 'Abriendo {{idp}}…',
    on: 'Conectado',
    onAt: 'Conectado · {{when}}.',
    onNow: 'Conectado.',
    blocked:
      'Por ahora no se puede conectar: un administrador tiene que renovar la configuración de {{service}}.',
    none: 'No has conectado tu cuenta.',
  },
  hint: 'Al conectar vas a iniciar sesión en {{idps}}. Si tu cuenta ya estaba conectada, Mango lo confirma sin abrir {{idp}}.',
  hintOr: ' o ',
  hintProvider: 'el proveedor',
  errors: {
    remote_disabled: 'Un administrador deshabilitó {{service}}.',
    remote_not_usable: '{{service}} no está habilitado para tus grupos.',
    gateway_unavailable: 'No se pudo conectar tu cuenta. Inténtalo de nuevo en unos minutos.',
  },
  card: {
    label: 'Aviso de Mango: conectar {{service}}',
    head: 'Mango',
    notAgent: 'No lo escribió el agente',
    askTitle: 'Conecta tu cuenta de {{service}}',
    askBody: 'El agente necesita leer {{service}} con tu cuenta. Vas a iniciar sesión en {{idp}}.',
    doneTitle: 'Conectado. Vuelve a enviar tu pregunta.',
    doneBody:
      'Tu cuenta de {{service}} quedó conectada. El agente lee con tus permisos, solo lectura.',
    expiredTitle: 'El enlace venció',
    expiredBefore: 'Vuelve a preguntar para conectar, o hazlo desde ',
    expiredAfter: '.',
    opening: 'Abriendo {{idp}}…',
    expiresIn: 'Vence en {{time}}',
  },
  read: {
    mark: 'Leyó {{service}}',
    sub: '· contenido de fuera de Mango',
    title:
      'Esta respuesta usó contenido de {{service}}. Lo escribió gente de fuera de Mango: revisa los enlaces antes de abrirlos.',
  },
  link: {
    warnBefore: 'Esta respuesta leyó contenido de ',
    warnAfter:
      '. Ese contenido lo escribió alguien de fuera de Mango y el enlace puede venir de ahí.',
    goesTo: 'Te lleva a',
    own: 'Tu organización de {{service}} ({{org}}). Mango solo comprueba la dirección, no lo que hay en la página.',
    otherOrg: 'Otra organización',
    otherOrgNamed: ' está en {{service}}, pero no es una organización registrada por tu empresa.',
    otherOrgUnnamed: 'Está en {{service}}, pero no es una organización registrada por tu empresa.',
    otherDomain: 'Otro dominio',
    otherDomainNote: 'No es un dominio de {{service}}.',
    noCredentials: 'Si te pide iniciar sesión o datos de tu cuenta, no los escribas.',
    open: 'Abrir enlace',
    openAnyway: 'Abrir de todas formas',
  },
  ret: {
    crumb: 'Mis conexiones',
    from: '· vuelta desde {{idp}}',
    working: 'Terminando la conexión',
    ok: {
      title: 'Listo, tu cuenta de {{service}} está conectada.',
      body: 'Vuelve al chat y repite tu pregunta.',
    },
    expired: { title: 'El enlace venció', body: 'Vuelve a pedir la conexión.' },
    nosession: {
      title: 'Inicia sesión en Mango para terminar',
      body: 'Este navegador no tiene tu sesión de Mango abierta. Después de ingresar vuelves aquí y la conexión se completa.',
    },
    notyours: {
      title: 'Este enlace no es tuyo',
      body: 'Pide la conexión desde tu propia sesión.',
    },
    denied: {
      title: '{{idp}} no autorizó la conexión',
      body: 'Si no fuiste tú quien canceló, consulta con el administrador de {{idp}} de tu empresa.',
    },
    conditional: {
      title: 'Una regla de acceso de tu empresa bloqueó la conexión',
      body: 'El Acceso condicional de {{idp}} no dejó iniciar sesión desde este dispositivo o esta red, o pidió un paso que no se completó. Consulta con el administrador de {{idp}} de tu empresa.',
    },
    error: {
      title: 'No se pudo conectar tu cuenta',
      body: 'Inténtalo de nuevo en unos minutos.',
    },
    providerFallback: 'el proveedor',
    signIn: 'Iniciar sesión',
    toChat: 'Volver al chat',
    goChat: 'Ir al chat',
    toConnections: 'Mis conexiones',
  },
  inbox: {
    type: 'Tarea',
    source: 'Servicios externos',
    title: 'Conecta tu cuenta de {{service}}',
    body: 'La tarea "{{task}}" no pudo leer {{service}} porque no has conectado tu cuenta.',
    action: 'Ir a Mis conexiones',
  },
  builder: {
    external: 'servicio externo · {{org}}',
    sub: 'lee con la cuenta de cada persona',
    read: 'Lectura',
    warnBefore: 'Este agente es visible para ',
    warnGroups: 'grupos que no tienen {{service}} (',
    warnGroupsAfter: ')',
    warnAnd: ' y ',
    warnUsers: 'personas sueltas',
    warnAfter:
      '. Esas personas no podrán conectar su cuenta: el agente les responderá sin estas tools.',
  },
};
