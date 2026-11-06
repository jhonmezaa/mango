// Shared states of the Operación views and Tickets (design round 37, ops-states.jsx).
export const ops = {
  label: {
    costs: 'Costos',
    observability: 'Observabilidad',
    evals: 'Evals',
    tickets: 'Tickets',
  },
  loading: {
    costs: 'Cargando costos…',
    observability: 'Cargando observabilidad…',
    evals: 'Cargando evals…',
    tickets: 'Cargando tickets…',
  },
  error: {
    title: 'No se pudo cargar {{view}}.',
    body: 'Inténtalo de nuevo en unos segundos.',
  },
  // Design round 38: the 429 of the four views; Observabilidad says its own limit.
  rate: {
    title: 'Demasiadas solicitudes',
    body: 'Hiciste muchas solicitudes seguidas.',
    observability:
      'Observabilidad admite 30 lecturas por minuto: cada filtro, búsqueda o página cuenta.',
  },
  denied: {
    title: 'No tienes acceso a {{view}}',
    toChat: 'Ir al chat',
    costs:
      'Costos es para administradores y para FinOps central. Un admin de Mango puede darte acceso.',
    observability: 'Observabilidad es solo para administradores de Mango.',
    evals: 'Evals es para administradores, para FinOps central y para quien edita un agente.',
    tickets:
      'Ves los tickets que creaste, los que tienes asignados y los de los agentes que puedes usar.',
  },
  empty: {
    costs: {
      title: 'Todavía no hay gasto este mes',
      body: 'El gasto aparece cuando un agente responde, corre una tarea o una eval, o se prueba en Playground.',
    },
    observability: {
      title: 'No hay trazas en este rango',
      body: 'Cada respuesta de un agente, en el chat o en una tarea, deja una traza.',
    },
    evals: {
      title: 'Todavía no hay suites',
      body: 'Una suite prueba un agente con casos y un umbral. La crea quien edita el agente.',
    },
    tickets: {
      title: 'No hay tickets',
      body: 'Los agentes los crean dentro de una conversación o de una tarea. También puedes crear uno.',
    },
  },
} as const;
