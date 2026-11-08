// MCP Apps (D125): la interfaz de una tool de un MCP remoto de solo lectura, dentro del chat, en un marco aislado.
(function () {
const ITEMS = [[4821, 'Bug', 'Timeout al exportar el CUR de octubre', 'Activo', 'Usuario 4'], [4817, 'Tarea', 'Etiquetar recursos de la cuenta 111111111115', 'Activo', 'Usuario 2'], [4809, 'Historia', 'Alertas de presupuesto por área', 'Nuevo', '—'], [4802, 'Bug', 'El dashboard de S3 no muestra us-west-2', 'En revisión', 'Usuario 7'], [4795, 'Tarea', 'Limpiar snapshots EBS huérfanos', 'Activo', 'Usuario 4']];
const CALL_ERR = { denied: 'permiso denegado: tus grupos no pueden usar esa tool', budget: 'sin presupuesto: tu presupuesto del mes se agotó', limit: 'llegó al tope de 20 llamadas de esta app en este turno', down: 'Azure DevOps no responde ahora' };

function AppFrame({ onBig, st }) {
  const [sel, setSel] = React.useState(null);
  if (st === 'loading') return <div className="ap-fr-msg"><span className="mango-spinner" /> Cargando la app…</div>;
  return <div className="ap-fr">
    <div className="ap-fr-h"><b>Sprint 46 · trabajo abierto</b><span>5 elementos</span><button onClick={onBig}>Ver en grande</button></div>
    <div className="ap-fr-l">{ITEMS.map(([id, t, title, state, who]) => <button key={id} className={sel === id ? 'is-on' : ''} onClick={() => setSel(id)}><span className={'ap-fr-t t-' + t.toLowerCase()}>{t}</span><span className="ap-fr-n">#{id} {title}</span><span className="ap-fr-s">{state}</span><span className="ap-fr-w">{who}</span></button>)}</div>
    {sel && <div className="ap-fr-d">#{sel} · Pedido a get_work_item…</div>}
  </div>;
}

function McpApp({ app }) {
  const I = window.Icons;
  const sim = window.useMango(s => s.simApp) || null;
  const [mode, setMode] = React.useState('inline');
  const [st, setSt] = React.useState('loading');
  const [closed, setClosed] = React.useState(false);
  const [n, setN] = React.useState(0);
  React.useEffect(() => { setClosed(sim === 'closed'); if (['connect', 'timeout'].includes(sim)) { setSt(sim); return; } setSt('loading'); const t = setTimeout(() => setSt('ready'), sim === 'loading' ? 1e9 : 900); return () => clearTimeout(t); }, [sim, n]);
  React.useEffect(() => { if (mode !== 'full') return; const h = e => e.key === 'Escape' && setMode('inline'); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [mode]);
  const callErr = CALL_ERR[sim];
  const label = <span className="cv-origin"><I.Lock size={11} /> app de {app.mcp}</span>;
  const head = (inMode) => <div className="ap-h">{label}<span className="mono ap-tool">{app.tool}</span><span style={{ flex: 1 }} />
    {inMode !== 'full' && <button className="btn btn-ghost btn-icon" title="Pantalla completa" aria-label="Pantalla completa" onClick={() => setMode('full')}><I.Expand size={12} /></button>}
    {inMode !== 'pip' && <button className="btn btn-ghost btn-icon" title="Ventana flotante" aria-label="Ventana flotante" onClick={() => setMode('pip')}><I.Pip size={13} /></button>}
    {inMode !== 'inline' && <button className="btn btn-ghost btn-sm" onClick={() => setMode('inline')}>Volver a la respuesta</button>}
    <button className="btn btn-ghost btn-icon" title="Cerrar la app" aria-label="Cerrar la app" onClick={() => { setClosed(true); setMode('inline'); }}><I.Close size={12} /></button></div>;
  const foot = <div className="ap-f">{callErr ? <span className="ap-f-err" role="alert"><I.Warn size={11} /> La app pidió <span className="mono">get_work_item</span> y Mango no la hizo: {callErr}.</span> : <span>{st === 'ready' ? '2 de 20 llamadas en este turno · ' : ''}Solo lectura. Cada llamada pasa por Mango con tus permisos y tu presupuesto, y queda en Auditoría.</span>}</div>;
  const body = <div className="ap-frame"><AppFrame st={st} onBig={() => setMode('full')} /></div>;
  if (closed) return <div className="ap-closed">{label}<span className="mk-meta" style={{ flex: 1 }}>Cerraste la app.</span><button className="btn btn-sm" onClick={() => { window.MangoStore.set({ simApp: null }); setClosed(false); setN(x => x + 1); }}>Abrir de nuevo</button></div>;
  if (st === 'connect') return <div className="ap-card">{head('inline')}<div className="ap-connect"><I.Lock size={16} /><div style={{ flex: 1 }}><b>Conecta tu cuenta de Azure DevOps para usar esta app</b><div className="mk-meta">La app lee con tu cuenta. Mango no guarda tu contraseña.</div></div><button className="btn btn-sm btn-primary" onClick={() => window.MangoStore.set({ simApp: null })}>Conectar</button></div></div>;
  if (st === 'timeout') return <div className="ap-card">{head('inline')}<div className="ap-fr-msg is-err" role="alert"><I.Warn size={14} /><span style={{ flex: 1 }}>La app no arrancó a tiempo.</span><button className="btn btn-sm" onClick={() => { window.MangoStore.set({ simApp: null }); setN(x => x + 1); }}><I.Refresh size={11} /> Reintentar</button></div></div>;
  return <>
    {mode === 'inline' ? <div className="ap-card">{head('inline')}{body}{foot}</div>
      : <div className="ap-away"><I.Pip size={13} /><span style={{ flex: 1 }}>La app está {mode === 'full' ? 'en pantalla completa' : 'en una ventana flotante'}.</span><button className="btn btn-sm" onClick={() => setMode('inline')}>Traer aquí</button></div>}
    {mode === 'full' && <div className="ap-full" role="dialog" aria-modal="true" aria-label={'app de ' + app.mcp}><div className="ap-card is-full">{head('full')}{body}{foot}</div></div>}
    {mode === 'pip' && <div className="ap-pip" role="dialog" aria-label={'app de ' + app.mcp}><div className="ap-card is-pip">{head('pip')}{body}</div></div>}
  </>;
}
window.McpApp = McpApp;
})();
