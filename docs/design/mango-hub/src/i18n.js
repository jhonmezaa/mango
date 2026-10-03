// Minimal i18n: window.t(key) → string in current lang. Missing keys fall back to es, then key.
(function () {
  const dict = {
    es: {
      'nav.chat': 'Chat', 'nav.inbox': 'Bandeja', 'nav.dashboard': 'Dashboard', 'nav.search': 'Buscar conversaciones',
      'nav.marketplace': 'Marketplace', 'nav.tickets': 'Tickets', 'nav.activity': 'Actividad', 'nav.governance': 'Gobernanza',
      'nav.approvals': 'Aprobaciones', 'nav.audit': 'Audit log', 'nav.budgets': 'Presupuestos', 'nav.playground': 'Playground',
      'nav.models': 'Brains', 'nav.skills': 'Skills', 'nav.mcp': 'Catálogo de MCP', 'nav.review': 'Revisión de agentes', 'nav.knowledge': 'Knowledge Bases',
      'nav.schedules': 'Schedules', 'nav.evals': 'Evals', 'nav.observability': 'Observability', 'nav.org': 'Org Chart', 'nav.costs': 'Costos',
      'nav.settings': 'Ajustes',
      'sb.pinned': 'AGENTES FIJADOS', 'sb.recent': 'RECIENTES', 'sb.work': 'TRABAJO', 'sb.gov': 'GOBERNANZA', 'sb.admin': 'ADMIN',
      'sb.new': 'Nueva conversación', 'sb.pinEmpty': 'Fija agentes desde el marketplace para acceso rápido', 'sb.skip': 'Saltar al contenido',
      'sb.lang': 'Idioma', 'sb.tour': 'Primeros pasos',
      'err.network.t': 'Sin conexión con Mango', 'err.network.d': 'No pudimos contactar al backend. Revisa tu conexión o la VPN corporativa.',
      'err.401.t': 'Tu sesión expiró', 'err.401.d': 'Por seguridad cerramos la sesión después de 8 h. Vuelve a entrar con Cognito.',
      'err.403.t': 'No tienes acceso a esta sección', 'err.403.d': 'Tu grupo no incluye esta sección. Un admin de Mango puede darte acceso.',
      'err.timeout.t': 'El agente tardó demasiado', 'err.timeout.d': 'La invocación superó el límite de 60 s. Puede que un MCP server esté degradado.',
      'err.notfound.t': 'Página no encontrada', 'err.notfound.d': 'La dirección no existe o ya no está disponible.', 'err.back': 'Volver al chat', 'err.crash.t': 'Algo se rompió en esta vista', 'err.crash.d': 'Ocurrió un error inesperado. Recarga la página o vuelve al chat.',
      'err.retry': 'Reintentar', 'err.reload': 'Recargar', 'err.home': 'Ir al chat', 'err.login': 'Iniciar sesión',
      'offline': 'Sin conexión · reintentaremos cuando vuelva la conexión',
      'nav.admin': 'Nuevo agente',
    },
    en: {
      'nav.chat': 'Chat', 'nav.inbox': 'Inbox', 'nav.dashboard': 'Dashboard', 'nav.search': 'Search conversations',
      'nav.marketplace': 'Marketplace', 'nav.tickets': 'Tickets', 'nav.activity': 'Activity', 'nav.governance': 'Gobernanza',
      'nav.approvals': 'Approvals', 'nav.audit': 'Audit log', 'nav.budgets': 'Budgets', 'nav.playground': 'Playground',
      'nav.models': 'Brains', 'nav.skills': 'Skills', 'nav.mcp': 'MCP catalog', 'nav.review': 'Agent review', 'nav.knowledge': 'Knowledge Bases',
      'nav.schedules': 'Schedules', 'nav.evals': 'Evals', 'nav.observability': 'Observability', 'nav.org': 'Org Chart', 'nav.costs': 'Costs',
      'nav.settings': 'Settings',
      'sb.pinned': 'PINNED AGENTS', 'sb.recent': 'RECENT', 'sb.work': 'WORK', 'sb.gov': 'GOVERNANCE', 'sb.admin': 'ADMIN',
      'sb.new': 'New conversation', 'sb.pinEmpty': 'Pin agents from the marketplace for quick access', 'sb.skip': 'Skip to content',
      'sb.lang': 'Language', 'sb.tour': 'Getting started',
      'err.network.t': 'Can\u2019t reach Mango', 'err.network.d': 'We couldn\u2019t contact the backend. Check your connection or corporate VPN.',
      'err.401.t': 'Your session expired', 'err.401.d': 'For security we sign you out after 8 h. Sign in again with Cognito.',
      'err.403.t': 'You don\u2019t have access here', 'err.403.d': 'Your group doesn\u2019t include this section. A Mango admin can give you access.',
      'err.timeout.t': 'The agent took too long', 'err.timeout.d': 'The invocation exceeded the 60 s limit. An MCP server may be degraded.',
      'err.notfound.t': 'Page not found', 'err.notfound.d': 'This address doesn\u2019t exist or is no longer available.', 'err.back': 'Back to chat', 'err.crash.t': 'Something broke in this view', 'err.crash.d': 'An unexpected error occurred. Reload the page or go back to chat.',
      'err.retry': 'Retry', 'err.reload': 'Reload', 'err.home': 'Go to chat', 'err.login': 'Sign in',
      'offline': 'Offline · we\u2019ll retry when the connection is back',
      'nav.admin': 'New agent',
    },
  };
  window.MangoStrings = dict;
  window.t = (key) => {
    const lang = window.MangoStore ? window.MangoStore.get().lang : 'es';
    return (dict[lang] && dict[lang][key]) || dict.es[key] || key;
  };
})();
