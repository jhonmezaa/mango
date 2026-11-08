// MCP Apps in the chat (design round 41, mcp-apps.jsx, D125): the texts of the frame Mango draws
// around an app. Nothing inside the frame is Mango's.
export const mcpApps = {
  // «app de {MCP}»: the label of origin, outside the frame (TM-UI10).
  origin: 'app de {{service}}',
  loading: 'Cargando la app…',
  fullscreen: 'Pantalla completa',
  pip: 'Ventana flotante',
  back: 'Volver a la respuesta',
  close: 'Cerrar la app',
  closed: 'Cerraste la app.',
  reopen: 'Abrir de nuevo',
  timeout: 'La app no arrancó a tiempo.',
  retry: 'Reintentar',
  connectTitle: 'Conecta tu cuenta de {{service}} para usar esta app',
  connectBody: 'La app lee con tu cuenta. Mango no guarda tu contraseña.',
  connect: 'Conectar',
  awayFull: 'La app está en pantalla completa.',
  awayPip: 'La app está en una ventana flotante.',
  bringBack: 'Traer aquí',
  calls: '{{used}} de {{limit}} llamadas en este turno · ',
  footer:
    'Solo lectura. Cada llamada pasa por Mango con tus permisos y tu presupuesto, y queda en Auditoría.',
  // «La app pidió {tool} y Mango no la hizo: {motivo}.»
  callFailedBefore: 'La app pidió ',
  callFailedAfter: ' y Mango no la hizo: {{reason}}.',
  reasons: {
    denied: 'permiso denegado: tus grupos no pueden usar esa tool',
    budget: 'sin presupuesto: tu presupuesto del mes se agotó',
    limit: 'llegó al tope de {{limit}} llamadas de esta app en este turno',
    down: '{{service}} no responde ahora',
    // Not in the design (round 41 only has the limit of the turn): pending for Claude Design.
    minute: 'demasiadas solicitudes',
  },
} as const;
