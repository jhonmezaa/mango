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
  // Design round 25: `RemoteMcpEnabled` off, the list is not shown and the parameter is not named.
  off: {
    title: 'Los servicios externos están apagados en esta instalación',
    body: 'Cuando un administrador los encienda, aquí vas a poder conectar tu cuenta.',
  },
  connect: 'Conectar',
  // D100: the provider opens in another tab; this one waits (design round 24).
  reopen: 'Abrir de nuevo',
  reopenTitle: 'Si cerraste la pestaña de {{idp}}',
  disconnect: 'Desconectar',
  row: {
    already: 'Tu cuenta ya estaba conectada.',
    off: 'Un administrador deshabilitó {{service}}.',
    opening: 'Abriendo {{idp}}…',
    waiting:
      'Inicia sesión en {{idp}} en la otra pestaña. Al terminar, la conexión se completa aquí.',
    finishing: 'Terminando la conexión…',
    on: 'Conectado',
    onAt: 'Conectado · {{when}}.',
    onNow: 'Conectado.',
    blocked:
      'Por ahora no se puede conectar: un administrador tiene que renovar la configuración de {{service}}.',
    onBlocked:
      'Tu cuenta sigue conectada, pero los agentes no pueden leer {{service}} hasta que un administrador renueve su configuración.',
    expiredTitle: 'El enlace venció',
    expiredBody: 'Vuelve a pulsar «Conectar».',
    none: 'No has conectado tu cuenta.',
  },
  hint: 'Al conectar vas a iniciar sesión en {{idps}}. Si tu cuenta ya estaba conectada, Mango lo confirma sin abrir {{idp}}.',
  hintOr: ' o ',
  hintProvider: 'el proveedor',
  // Design `CONNECT_ERR` (round 24): the card of the chat and the Playground, and a row here.
  connectErrors: {
    error: {
      title: 'No se pudo iniciar la conexión',
      body: 'Inténtalo de nuevo en unos segundos.',
    },
    identity_unavailable: {
      title: 'El servicio de identidad no responde',
      body: 'Mango no pudo pedir el inicio de sesión en {{idp}}. Inténtalo de nuevo en unos minutos.',
    },
    rate_limited: {
      title: 'Demasiados intentos seguidos',
      body: 'Espera un minuto y vuelve a pulsar «Conectar».',
    },
    popup_blocked: {
      title: 'El navegador bloqueó la pestaña de {{idp}}',
      body: 'Permite las ventanas emergentes de Mango en este navegador y vuelve a pulsar «Conectar».',
    },
  },
  // Design `DisconnectModal` (D97): Mango deletes the connection; it never says the provider did.
  disconnectDialog: {
    title: 'Desconectar {{service}}',
    body: 'Mango borra tu conexión ahora y deja de leer {{service}} con tu cuenta en el chat, en tus tareas y en el Playground.',
    chat: 'Si un agente lo necesita, el chat te ofrece «Conectar» otra vez.',
    tasks: 'Tus tareas que lo usan van a fallar, y la Bandeja te avisa.',
    again: 'Para volver a conectar, inicias sesión en {{idp}} otra vez.',
    provider: 'Mango no cambia nada en tu cuenta de {{idp}}.',
    failedTitle: 'No se pudo confirmar que se desconectó',
    failedBody: 'Tu conexión puede seguir activa. Inténtalo de nuevo.',
    busy: 'Desconectando…',
    cancel: 'Cancelar',
    done: 'Desconectaste tu cuenta de {{service}}',
  },
  // Design `FINISH_ERR` (round 24, D100): the tab that pressed «Conectar» could not finish.
  finishErrors: {
    session_changed: {
      title: 'No se pudo terminar la conexión',
      body: 'Tu sesión de Mango cambió mientras iniciabas sesión en {{idp}}. Vuelve a pulsar «Conectar».',
    },
    denied: {
      title: '{{idp}} no autorizó la conexión',
      body: 'Tu cuenta no quedó conectada. Si no fuiste tú quien canceló, consulta con el administrador de {{idp}} de tu empresa.',
    },
    conditional: {
      title: 'Una regla de acceso de tu empresa bloqueó la conexión',
      body: 'Consulta con el administrador de {{idp}} de tu empresa.',
    },
    error: {
      title: 'No se pudo conectar tu cuenta',
      body: 'Inténtalo de nuevo en unos minutos.',
    },
  },
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
    // Design round 25: the turn ended when the connection was missing; «Enviar de nuevo» sends the
    // same question as a new turn.
    doneTitle: 'Conectado',
    doneBody:
      'Tu cuenta de {{service}} quedó conectada. Envía tu pregunta otra vez para que el agente lea {{service}}.',
    doneResent: 'Tu cuenta de {{service}} quedó conectada. Enviaste tu pregunta otra vez.',
    resend: 'Enviar de nuevo',
    offTitle: 'Los servicios externos están apagados',
    offBody:
      'Esta instalación de Mango tiene apagados los servicios externos, así que el agente no puede leer {{service}}. Si lo necesitas, avisa a un administrador de Mango.',
    waitingTitle: 'Inicia sesión en {{idp}} en la otra pestaña',
    waitingBody: 'Al terminar, la conexión se completa aquí. No cierres esta pestaña.',
    finishingTitle: 'Terminando la conexión…',
    finishingBody: 'Mango está guardando tu conexión con {{service}}.',
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
  // Design round 25: in a turn with the «Conectar» card, the agent's links that are not of an
  // organization the person may use cannot be opened (the agent never gets the real URL).
  stripped: {
    title: 'Enlace quitado por Mango · {{host}}',
    note_one:
      'Mango desactivó un enlace del agente. Para conectar tu cuenta usa solo «Conectar», en el aviso de Mango.',
    note_other:
      'Mango desactivó {{count}} enlaces del agente. Para conectar tu cuenta usa solo «Conectar», en el aviso de Mango.',
  },
  link: {
    warnBefore: 'Esta respuesta leyó contenido de ',
    warnAfter:
      '. Ese contenido lo escribió alguien de fuera de Mango y el enlace puede venir de ahí.',
    goesTo: 'Te lleva a',
    own: 'Tu organización de {{service}} ({{org}}). Mango solo comprueba la dirección, no lo que hay en la página.',
    otherOrg: 'Otra organización',
    otherOrgNamed: ' está en {{service}}, pero no es una organización que puedas usar en Mango.',
    otherOrgUnnamed: 'Está en {{service}}, pero no es una organización que puedas usar en Mango.',
    otherDomain: 'Otro dominio',
    otherDomainNote: 'No es un dominio de {{service}}.',
    noCredentials: 'Si te pide iniciar sesión o datos de tu cuenta, no los escribas.',
    open: 'Abrir enlace',
    openAnyway: 'Abrir de todas formas',
  },
  // The return page (design `RemoteReturn`, round 24, D100): a tab of its own, full screen.
  ret: {
    from: '· vuelta desde {{idp}}',
    brand: 'Mango',
    relaying: {
      title: 'Terminando la conexión…',
      body: 'Mango la termina en la pestaña donde pulsaste «Conectar». No cierres esta página.',
    },
    ok: {
      title: 'Listo, vuelve a tu pestaña de Mango',
      body: 'Tu cuenta de {{service}} quedó conectada. En la pestaña donde pulsaste «Conectar», envía tu pregunta otra vez. Esta ya no hace falta.',
      bodyUnnamed:
        'Tu cuenta quedó conectada. En la pestaña donde pulsaste «Conectar», envía tu pregunta otra vez. Esta ya no hace falta.',
    },
    orphan: {
      title: 'Pídelo de nuevo desde Mango',
      body: 'La conexión solo se termina en la pestaña de Mango donde pulsaste «Conectar», y esa pestaña se cerró o cambió de sesión. Tu cuenta no quedó conectada.',
    },
    expired: {
      title: 'El enlace venció',
      body: 'Pasaron más de 10 minutos desde que pulsaste «Conectar». Vuelve a pulsarlo en Mango.',
    },
    denied: {
      title: '{{idp}} no autorizó la conexión',
      body: 'Tu cuenta no quedó conectada. Si no fuiste tú quien canceló, consulta con el administrador de {{idp}} de tu empresa.',
    },
    conditional: {
      title: 'Una regla de acceso de tu empresa bloqueó la conexión',
      body: 'El Acceso condicional de {{idp}} no dejó iniciar sesión desde este dispositivo o esta red, o pidió un paso que no se completó. Consulta con el administrador de {{idp}} de tu empresa.',
    },
    ambiguous: {
      title: 'No se pudo saber qué conexión terminar',
      body: 'Tienes más de una conexión a medias en Mango. Vuelve a pulsar «Conectar» en la que quieras terminar.',
    },
    notyours: {
      title: 'Este enlace no es tuyo',
      body: 'Pide la conexión desde tu propia sesión de Mango.',
    },
    error: {
      title: 'No se pudo conectar tu cuenta',
      body: 'Inténtalo de nuevo en unos minutos.',
    },
    providerFallback: 'el proveedor',
    closeTab: 'Cerrar esta pestaña',
    // Design round 25: without `window.opener` the browser decides; the page never opens Mango again.
    cannotClose:
      'El navegador no deja que Mango cierre esta pestaña. Ciérrala tú: tu pestaña de Mango ya está al día.',
    openMango: 'Abrir Mango',
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
