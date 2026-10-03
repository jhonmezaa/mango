// Texts shared by the governance screens (Presupuestos, Ajustes, Audit log).
export const admin = {
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
    rate_limited: 'Hiciste demasiadas solicitudes. Espera un minuto y vuelve a intentarlo.',
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
  },
  rel: {
    now: 'ahora',
    minutes: 'hace {{n}} min',
    hours: 'hace {{n}} h',
    yesterday: 'ayer',
    days: 'hace {{n}} días',
  },
} as const;
