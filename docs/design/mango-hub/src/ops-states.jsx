// Estados de carga, error, vacío y 403 para Costos, Observabilidad, Evals y Tickets (demo: panel › «Costos, Observabilidad, Evals y Tickets · respuesta del servidor»).
const OPS_LABEL = { costs: 'Costos', observability: 'Observabilidad', evals: 'Evals', tickets: 'Tickets' };
const OPS_DENIED = {
  costs: 'Costos es para administradores y para FinOps central. Un admin de Mango puede darte acceso.',
  observability: 'Observabilidad es solo para administradores de Mango.',
  evals: 'Evals es para administradores, para FinOps central y para quien edita un agente.',
  tickets: 'Ves los tickets que creaste, los que tienes asignados y los de los agentes que puedes usar.',
};
const OPS_EMPTY = {
  costs: ['Todavía no hay gasto este mes', 'El gasto aparece cuando un agente responde, corre una tarea o una eval, o se prueba en Playground.'],
  observability: ['No hay trazas en este rango', 'Cada respuesta de un agente, en el chat o en una tarea, deja una traza.'],
  evals: ['Todavía no hay suites', 'Una suite prueba un agente con casos y un umbral. La crea quien edita el agente.'],
  tickets: ['No hay tickets', 'Los agentes los crean dentro de una conversación o de una tarea. También puedes crear uno.'],
};
function useOpsSim() { return window.useMango(s => s.simOps || null); }
function OpsState({ view, kind, onRetry, action }) {
  const I = window.Icons; const S = window.MangoStore;
  const retry = onRetry || (() => S.set({ simOps: null }));
  if (kind === 'loading') return <div className="mk-empty" role="status" aria-live="polite"><span className="mango-spinner" aria-hidden="true" /><span className="mk-meta">Cargando {OPS_LABEL[view].toLowerCase()}…</span></div>;
  if (kind === 'error') return <div className="mk-empty" role="alert"><I.Warn size={18} style={{ color: 'var(--amber)' }} /><div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>No se pudo cargar {OPS_LABEL[view]}.</div><div className="mk-meta">Inténtalo de nuevo en unos segundos.</div><button className="btn btn-sm" onClick={retry}><I.Refresh size={12} /> Reintentar</button></div>;
  if (kind === '403') return <div className="mk-empty"><I.Lock size={18} style={{ color: 'var(--text-muted)' }} /><div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>No tienes acceso a {OPS_LABEL[view]}</div><div className="mk-meta" style={{ maxWidth: 440 }}>{OPS_DENIED[view]}</div><button className="btn btn-sm" onClick={() => { S.set({ simOps: null }); window.MangoNav?.('chat'); }}>Ir al chat</button></div>;
  if (kind === 'empty') return <div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>{OPS_EMPTY[view][0]}</div><div className="mk-meta" style={{ maxWidth: 440 }}>{OPS_EMPTY[view][1]}</div>{action}</div>;
  return null;
}
Object.assign(window, { OpsState, useOpsSim, OPS_LABEL });
