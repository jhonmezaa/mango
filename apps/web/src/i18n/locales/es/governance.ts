// Texts shared by the governance screens (Presupuestos, Ajustes, Audit log).
export const admin = {
  // Design round 34: when a request refused with a 429 may be sent again.
  rateWhen: {
    unknown: 'en unos minutos',
    seconds: 'en unos segundos',
    minutes_one: 'en {{count}} minuto',
    minutes_other: 'en {{count}} minutos',
    today: 'a las {{time}}',
    tomorrow: 'mañana a las {{time}}',
  },
  errors: {
    self_edit: 'No puedes cambiar algo que te afecta (tu presupuesto o el mapeo de tu área).',
    same_approver:
      'Quien propone un cambio no puede aprobarlo: lo debe aprobar otro administrador.',
    version_conflict:
      'Otro administrador hizo un cambio mientras tanto. Recargamos los datos: revísalos y vuelve a intentarlo.',
    expired: 'La propuesta venció (7 días). Pide una propuesta nueva.',
    unknown_ou: 'Alguna OU no existe en la organización. Revisa la propuesta.',
    too_many_pending:
      'Hay demasiadas propuestas pendientes. Aprueba, rechaza o retira alguna para proponer otra.',
    audit_unavailable:
      'No se pudo registrar la auditoría; el cambio no se aplicó. Intenta de nuevo en unos minutos.',
    // Design round 34: the wait comes from `Retry-After` (`rateWhen`); which limit it is and
    // its window are not in the answer, so the design's «Llegaste al límite de {acción}…» is not.
    rate_limited: 'Hiciste demasiadas solicitudes. Puedes volver a intentarlo {{when}}.',
    unavailable:
      'El servicio no está disponible en este momento; no se aplicó ningún cambio. Intenta de nuevo en unos minutos.',
    forbidden: 'No tienes permiso para realizar esta acción.',
    invalid: 'Los datos enviados no son válidos. Revisa el formulario.',
    network: 'No se pudo conectar con Mango. Revisa tu conexión.',
    generic: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
  },
} as const;

export const gov = {
  preview: 'Con este límite quedaría en',
  status: {
    ok: 'OK',
    warn: 'En alerta',
    out: 'Agotado',
  },
  money: {
    empty: 'Escribe un monto',
    format: 'Usa solo números, por ejemplo 150,00',
    decimals: 'Máximo 2 decimales',
    positive: 'Debe ser mayor que 0',
    max: 'El máximo es USD 1.000.000,00',
    rule: 'Mayor que 0 y hasta 1.000.000, con hasta 2 decimales.',
  },
  denied: {
    title: 'No tienes acceso a esta sección',
    body: 'Presupuestos, Ajustes y el Audit log son solo para admins. Un admin de Mango puede darte acceso.',
    // Design round 20 (`DENIED`): each of these views with its own notice.
    governance: {
      title: 'No tienes acceso a Gobernanza',
      body: 'Gobernanza es para administradores y para FinOps central. Un admin de Mango puede darte acceso.',
    },
    activity: {
      title: 'No tienes acceso a Actividad',
      body: 'Tu cuenta no tiene permiso para ver la actividad. Un admin de Mango puede darte acceso.',
    },
    playground: {
      title: 'No tienes acceso al Playground',
      body: 'El Playground es para quien edita agentes: creadores de agentes y administradores. Un admin de Mango puede darte acceso.',
    },
    // Design round 21.
    skills: {
      title: 'No tienes acceso a Skills',
      body: 'Skills es para administradores y creadores de agentes. Un admin de Mango puede darte acceso.',
    },
  },
  rel: {
    now: 'ahora',
    minutes: 'hace {{n}} min',
    hours: 'hace {{n}} h',
    yesterday: 'ayer',
    days: 'hace {{n}} días',
  },
} as const;
