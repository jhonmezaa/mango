// Buscar conversaciones (design search.jsx `GlobalSearch`, D103).
export const search = {
  title: 'Buscar conversaciones',
  inputLabel: 'Buscar en conversaciones',
  placeholder: 'Busca en títulos, mensajes, respuestas y herramientas',
  clear: 'Borrar búsqueda',
  agentLabel: 'Agente',
  allAgents: 'Todos los agentes',
  whenLabel: 'Fecha',
  when: { all: 'Cualquier fecha', today: 'Hoy', yesterday: 'Desde ayer' },
  kindLabel: 'Buscar en',
  kindFilter: {
    all: 'Todo',
    title: 'Títulos',
    user: 'Mis mensajes',
    agent: 'Respuestas',
    tool: 'Herramientas',
  },
  kind: { title: 'Título', user: 'Tú', agent: 'Agente', tool: 'Herramienta' },
  clearFilters: 'Limpiar',
  removeFilters: 'Quitar filtros',
  recent: 'búsquedas recientes',
  clearRecent: 'Borrar',
  recentConversations: 'conversaciones recientes',
  noResults: 'Sin resultados para “{{query}}”',
  noResultsFiltered: 'Prueba quitando algún filtro.',
  noResultsHint:
    'Revisa la ortografía o usa menos palabras. Todas las palabras deben aparecer en el mismo mensaje.',
  // «<b>N</b> coincidencias en <b>M</b> conversaciones»: the numbers are rendered in bold.
  hitsWord_one: 'coincidencia',
  hitsWord_other: 'coincidencias',
  in: 'en',
  conversationsWord_one: 'conversación',
  conversationsWord_other: 'conversaciones',
  sortLabel: 'Ordenar',
  sort: { relevance: 'Más relevantes', recent: 'Más recientes' },
  open: 'Abrir',
  more: 'Ver {{count}} más',
  less: 'Ver menos',
  hintMove: 'para moverte',
  hintOpen: 'abre en la coincidencia',
  hintClear: 'borra',
  // Design round 35 `.sr-cap`: the read stopped at its cap, or more conversations matched than
  // the answer carries.
  capped_one: 'Buscamos en tu conversación más reciente; las más antiguas no se revisaron.',
  capped_other:
    'Buscamos en tus {{count}} conversaciones más recientes; las más antiguas no se revisaron.',
  truncated:
    'Se muestran las {{count}} conversaciones con más coincidencias; afina la búsqueda para ver otras.',
  error: 'No se pudo buscar en tus conversaciones.',
  // Design round 35: a 429 here; the wait line is the common one (`rateWait`).
  rateTitle: 'Demasiadas solicitudes',
  rateBody: 'Hiciste muchas búsquedas seguidas.',
  searching: 'Buscando…',
  // The hidden status (design round 35).
  liveCount: '{{hits}} {{hitsWord}} en {{conversations}} {{conversationsWord}}',
  liveNone: 'Sin resultados',
};
