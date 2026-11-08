// Memoria (D122): pantalla de la persona, indicador del turno, fila del popover, capacidades en la Revisión. También: iconos nuevos, skills de Mango y la figura de matplotlib del prototipo.
(function () {
const S = window.MangoStore;
const Ic = ({ children, size = 14, ...rest }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>;
Object.assign(window.Icons, {
  Memory: (p) => <Ic {...p}><path d="M12 4a4 4 0 0 0-4 4v.2A3.5 3.5 0 0 0 6 14.5 3.5 3.5 0 0 0 9.5 18H12V4z" /><path d="M12 4a4 4 0 0 1 4 4v.2a3.5 3.5 0 0 1 2 6.3A3.5 3.5 0 0 1 14.5 18H12" /><path d="M12 9h-2M12 13h2" /></Ic>,
  Pip: (p) => <Ic {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="6" rx="1" /></Ic>,
  Canvas: (p) => <Ic {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M17 8h1M17 11h1" /></Ic>,
  History: (p) => <Ic {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 8v4l3 2" /></Ic>,
  Diff: (p) => <Ic {...p}><path d="M8 4v10M3 9h10M15 15h6" /><rect x="3" y="3" width="18" height="18" rx="2" opacity=".35" /></Ic>,
  Comment: (p) => <Ic {...p}><path d="M4 5h16v11H9l-5 4z" /></Ic>,
});

// ---------- Skills de Mango (las reciben los agentes con «Ejecutar código») ----------
const CODE_AGENTS = ['fin-01', 'data-01', 'ops-01'];
const mk = (id, name, icon, desc, lib) => ({ id, name, cat: 'De Mango', icon, desc, instructions: '# ' + name + '\n\nInstrucciones que trae Mango para generar archivos ' + name + ' con ' + lib + ' dentro del entorno de «Ejecutar código». No se editan.', tools: [], outputs: [], usedBy: CODE_AGENTS, version: 1, mango: true, runs30d: 0 });
window.MANGO_SKILLS = [mk('pdf', 'PDF', 'Document', 'Genera informes en PDF con tablas y figuras.', 'ReportLab'), mk('word', 'Word', 'Document', 'Genera documentos .docx con títulos, tablas e imágenes.', 'python-docx'), mk('excel', 'Excel', 'Database', 'Genera libros .xlsx con hojas, fórmulas y formato.', 'openpyxl'), mk('powerpoint', 'PowerPoint', 'Dashboard', 'Genera presentaciones .pptx con diapositivas y gráficas.', 'python-pptx')];

// ---------- Datos de ejemplo ----------
const KIND = { preference: ['Preferencia', 'badge-blue'], fact: ['Hecho', 'badge'], summary: ['Resumen', 'badge-violet'] };
const d = (days) => new Date(Date.now() - days * 864e5).toISOString();
const SEED = [
  { id: 'mem_01', agent: 'fin-01', kind: 'preference', text: 'Prefiere las cifras en USD sin decimales y las tablas ordenadas de mayor a menor costo.', at: d(1) },
  { id: 'mem_02', agent: 'fin-01', kind: 'fact', text: 'Es responsable del costo de las cuentas 111111111112 y 111111111115 (plataforma de datos).', at: d(2) },
  { id: 'mem_03', agent: 'fin-01', kind: 'summary', text: 'Revisó el aumento de EC2 de agosto a octubre de 2026. Quedó pendiente pedir al equipo de plataforma que limpie los snapshots EBS huérfanos de us-east-1 y que evalúe consolidar los NAT Gateways. Pidió volver a revisarlo a fin de mes con el pronóstico de los próximos tres meses y comparar contra el presupuesto del trimestre, que ya va al 80 %. También preguntó por Savings Plans de cómputo a un año para la carga estable de', trunc: true, at: d(3) },
  { id: 'mem_04', agent: 'fin-01', kind: 'preference', text: 'Quiere que las recomendaciones lleven el ahorro mensual estimado y quién es el equipo responsable.', at: d(9) },
  { id: 'mem_05', agent: 'data-01', kind: 'fact', text: 'Las cohortes se cuentan por mes de activación, no por mes de registro.', at: d(5) },
  { id: 'mem_06', agent: 'data-01', kind: 'summary', text: 'Comparó la retención a 90 días de las cohortes de Q3 2025. La de 2025-09 rindió mejor; la hipótesis es el onboarding nuevo del 28 de agosto.', at: d(12) },
  { id: 'mem_07', agent: 'ops-01', kind: 'preference', text: 'Responde primero con las alarmas críticas y después con las de aviso.', at: d(20) },
];
const agentName = (id) => ((window.MangoData?.agents || []).find(a => a.id === id) || {}).name || id;
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
// Encendida en la instalación: en «Disponible hoy» está apagada (D122) salvo que la demo la encienda.
const memOn = () => { const st = S.get(); return st.simMemory ? st.simMemory !== 'off' : !st.avail; };
window.memOn = memOn;

function MemoryView() {
  const I = window.Icons; const K = window.GovKit; const toast = window.useToast?.();
  const sim = window.useMango(s => s.simMemory) || null; window.useMango(s => s.avail);
  const on = memOn();
  const [items, setItems] = React.useState(SEED);
  const [loading, setLoading] = React.useState(true);
  const [agent, setAgent] = React.useState('all');
  const [kind, setKind] = React.useState('all');
  const [ask, setAsk] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [allOpen, setAllOpen] = React.useState(false);
  const [rate, setRate] = React.useState(null);
  React.useEffect(() => { setLoading(true); setItems(sim === 'empty' ? [] : SEED); setRate(sim === 'rate' ? Date.now() + 42000 : null); const t = setTimeout(() => setLoading(false), 600); return () => clearTimeout(t); }, [sim]);
  const over = sim === 'over';
  const total = over ? 412 : items.length;
  const agents = [...new Set(items.map(m => m.agent))];
  const list = items.filter(m => (agent === 'all' || m.agent === agent) && (kind === 'all' || m.kind === kind));
  const del = (id) => { setBusy(id); setTimeout(() => { setBusy(null); setAsk(null); setItems(x => x.filter(m => m.id !== id)); S.log('memory.delete', id, 'Borró un recuerdo'); toast?.({ tone: 'success', msg: 'Recuerdo borrado.' }); }, 600); };
  const delAll = () => { setBusy('all'); setTimeout(() => { const n = total; setBusy(null); setAllOpen(false); setItems([]); S.log('memory.delete_all', S.actorEmail(), 'Borró toda su memoria'); toast?.({ tone: 'success', msg: 'Se borraron ' + n + ' recuerdos y ' + (n * 6 + 3) + ' eventos.' }); }, 900); };
  let body;
  if (!on) body = <div className="mm-empty"><span className="mm-empty-ic"><I.Memory size={20} /></span><div className="mm-empty-t">La memoria está apagada en esta instalación</div><p>Mientras esté apagada, los agentes no recuerdan nada entre conversaciones y no hay nada guardado de ti.</p></div>;
  else if (sim === 'loading' || loading) body = <div className="card" aria-busy="true" aria-label="Cargando tu memoria">{[0, 1, 2, 3].map(i => <div key={i} className="mm-row" style={{ cursor: 'default' }}><div style={{ display: 'grid', gap: 8, flex: 1 }}><K.Skel w={70} h={16} /><K.Skel w={(90 - i * 12) + '%'} /><K.Skel w="30%" h={10} /></div></div>)}</div>;
  else if (sim === 'unavailable') body = <K.ErrorState title="La memoria no está disponible ahora" body="No se pudieron cargar tus recuerdos. Inténtalo de nuevo en unos minutos." onRetry={() => S.set({ simMemory: null })} />;
  else if (rate) body = <div className="mc-alert amber" role="alert"><I.Warn size={14} /><div style={{ flex: 1 }}><b>Demasiadas solicitudes.</b> Puedes pedir tu memoria hasta 30 veces por minuto.<window.RateWait at={rate} inline /></div><window.RateWait at={rate} onRetry={() => { setRate(null); S.set({ simMemory: null }); }} /></div>;
  else if (!items.length) body = <div className="mm-empty"><span className="mm-empty-ic"><I.Memory size={20} /></span><div className="mm-empty-t">Ningún agente recuerda nada de ti</div><p>Los agentes con memoria guardan preferencias, hechos y resúmenes de lo que hablas con ellos. Aparecerán aquí.</p></div>;
  else body = <>
    {over && <div className="mc-alert" role="status" style={{ marginBottom: 12 }}><I.Info size={14} /><div>Se muestran tus 300 recuerdos más recientes de {total.toLocaleString()}. «Borrar todo» también borra los que no se ven.</div></div>}
    <div className="mm-bar">
      <select className="input mk-sel" value={agent} onChange={e => setAgent(e.target.value)} aria-label="Agente"><option value="all">Todos los agentes</option>{agents.map(a => <option key={a} value={a}>{agentName(a)}</option>)}</select>
      <div className="tk-quick" role="group" aria-label="Tipo">{[['all', 'Todos'], ['preference', 'Preferencias'], ['fact', 'Hechos'], ['summary', 'Resúmenes']].map(([k, l]) => <button key={k} className={kind === k ? 'is-on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}</div>
      <span className="mk-meta" style={{ marginLeft: 'auto' }}>{list.length === items.length ? total.toLocaleString() + ' recuerdos' : list.length + ' de ' + total.toLocaleString()}</span>
      <button className="btn btn-sm mk-danger" onClick={() => setAllOpen(true)}><I.Trash size={11} /> Borrar todo…</button>
    </div>
    {!list.length ? <div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600 }}>Ningún recuerdo coincide</div><div className="mk-meta">Prueba con otro agente o tipo.</div></div> :
    <div className="card mm-list">{list.map(m => <div key={m.id} className={'mm-row' + (ask === m.id ? ' is-ask' : '')}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row gap-2" style={{ marginBottom: 6, flexWrap: 'wrap' }}><span className={'badge ' + KIND[m.kind][1]}>{KIND[m.kind][0]}</span><span className="mk-meta">{agentName(m.agent)} · {fmtDate(m.at)}</span></div>
        <div className="mm-text">{m.text}{m.trunc ? '…' : ''}</div>
        {m.trunc && <div className="mk-meta" style={{ marginTop: 4 }}>Texto recortado: el recuerdo completo es más largo.</div>}
        {ask === m.id && <div className="row gap-2 mm-ask" role="group" aria-label="Confirmar borrado"><span className="mk-meta" style={{ flex: 1 }}>{agentName(m.agent)} dejará de recordarlo. No se puede deshacer.</span><button className="btn btn-sm" onClick={() => setAsk(null)} disabled={busy === m.id}>Cancelar</button><button className="btn btn-sm mk-danger" onClick={() => del(m.id)} disabled={busy === m.id}>{busy === m.id ? <><span className="mango-spinner" aria-hidden="true" /> Borrando…</> : 'Borrar'}</button></div>}
      </div>
      {ask !== m.id && <button className="btn btn-ghost btn-icon" aria-label="Borrar este recuerdo" title="Borrar" onClick={() => setAsk(m.id)}><I.Trash size={12} /></button>}
    </div>)}</div>}
  </>;
  return (
    <>
      <window.Topbar crumbs={['Memoria']} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Memoria</h1>
          <p className="page-subtitle">Lo que los agentes recuerdan de ti entre conversaciones. Cada agente recuerda solo lo suyo, y nadie más lo ve: ni otros agentes, ni otras personas, ni quien creó el agente, ni los administradores.</p>
        </div>
        <div className="mm-wrap">
          {body}
          <div className="mm-foot"><I.Info size={12} /><span>Los recuerdos los saca el servicio de AWS de tus conversaciones; tú no los escribes. Solo se usan en el chat: las tareas programadas, las evals y el Playground no tienen memoria.</span></div>
        </div>
      </div>
      <window.Modal open={allOpen} onClose={() => busy !== 'all' && setAllOpen(false)} title="Borrar toda tu memoria" width={440}>
        <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>Todos los agentes dejarán de recordar lo que saben de ti: {total.toLocaleString()} recuerdos{over ? ', también los que no se ven en la lista' : ''}, y lo que guardaron tus tareas. No se puede deshacer.</p>
        <div className="row gap-2" style={{ justifyContent: 'flex-end' }}><button className="btn btn-sm" data-autofocus onClick={() => setAllOpen(false)} disabled={busy === 'all'}>Cancelar</button><button className="btn btn-sm mk-danger" onClick={delAll} disabled={busy === 'all'}>{busy === 'all' ? <><span className="mango-spinner" aria-hidden="true" /> Borrando…</> : 'Borrar todo'}</button></div>
      </window.Modal>
    </>
  );
}

// Indicador del turno: si la versión tiene memoria y el turno recuperó recuerdos (lo confirma la prueba en AWS).
function MemoryUsed() {
  const I = window.Icons;
  return <div className="mm-used"><I.Memory size={12} /><span>Usó lo que recuerda de ti</span><button className="sr-link" onClick={() => window.MangoNav?.('memory')}>Ver memoria</button></div>;
}
// Fila del popover «Qué puede usar».
function MemoryPopRow({ agent }) {
  const has = window.agentMemory?.(agent); const on = memOn();
  return <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>Memoria</div>
    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>{!has ? 'Esta versión no recuerda nada entre conversaciones.' : !on ? 'Esta versión tiene memoria, pero está apagada en esta instalación: no recuerda nada.' : <>Recuerda lo que hablas con {agent.name} entre conversaciones. Solo tú lo ves; lo borras en <button className="sr-link" onClick={() => window.MangoNav?.('memory')}>Memoria</button>.</>}</div>
  </div>;
}
window.agentMemory = (a) => { const sim = S.get().simChatMemory; return sim ? sim !== 'none' : !!a?.memory; };

// Revisión: «Ejecutar código» y «Memoria» como el resto de lo que puede usar (TM-ME6).
function RvCaps({ r, d, isNew }) {
  const rows = [['code', 'Ejecutar código', 'Python aislado; lee adjuntos y genera archivos'], ['memory', 'Memoria', 'Recuerda a cada persona entre conversaciones']];
  const changed = rows.filter(([k]) => d[k]);
  return <div>
    <div className="mk-sec-t">capacidades {isNew ? '' : changed.length ? '· ' + changed.length + (changed.length === 1 ? ' cambio' : ' cambios') : '· sin cambios'}</div>
    <div className="rv-tools">
      {(isNew ? rows : changed).map(([k, l, sub]) => { const now = !!r.snap[k]; const sign = isNew ? (now ? '+' : '·') : now ? '+' : '−'; return <div key={k} className={'rv-tool ' + (isNew ? (now ? 'add' : '') : now ? 'add' : 'rem')}><span className="rv-sign">{sign}</span><span style={{ flex: 1, minWidth: 0 }}><span style={{ fontSize: 12.5, fontWeight: 500 }}>{l}</span><span className="mk-meta" style={{ display: 'block' }}>{sub}</span></span><span className={'badge ' + (now ? 'badge-amber' : '')}>{isNew ? (now ? 'Encendida' : 'Apagada') : now ? 'Se enciende' : 'Se apaga'}</span></div>; })}
      {!isNew && !changed.length && <div className="mk-meta" style={{ padding: '6px 0' }}>Ejecutar código: {r.snap.code ? 'sí' : 'no'} · Memoria: {r.snap.memory ? 'sí' : 'no'}.</div>}
    </div>
    {r.snap.memory && (isNew || d.memory) && !memOn() && <div className="mk-meta" style={{ marginTop: 6 }}>La memoria está apagada en esta instalación: aunque se apruebe, el agente no recordará nada hasta que se encienda.</div>}
  </div>;
}

// Figura de matplotlib del prototipo: lo que devolvería plt.savefig (fondo blanco, estilo por defecto).
function MplFigure({ kind = 'bar' }) {
  const M = [['2026-05', 41200, 9800, 12800], ['2026-06', 42900, 9650, 13100], ['2026-07', 44100, 9900, 12950], ['2026-08', 51800, 10100, 13300], ['2026-09', 55600, 10050, 13400], ['2026-10', 58300, 10200, 13600]];
  const C = ['#1f77b4', '#ff7f0e', '#2ca02c']; const W = 600, H = 300, L = 62, R = 14, T = 16, B = 58, pw = W - L - R, ph = H - T - B, max = 60000; const y = (v) => T + ph - v / max * ph; const bw = pw / M.length;
  return <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Costo por servicio, may–oct 2026" style={{ display: 'block', background: '#fff', fontFamily: 'DejaVu Sans, Verdana, sans-serif' }}>
    <rect x={L} y={T} width={pw} height={ph} fill="none" stroke="#000" strokeWidth=".8" />
    {[0, 10000, 20000, 30000, 40000, 50000, 60000].map(v => <g key={v}><line x1={L - 4} x2={L} y1={y(v)} y2={y(v)} stroke="#000" strokeWidth=".8" /><text x={L - 7} y={y(v) + 3.5} fontSize="10" textAnchor="end" fill="#000">{v}</text></g>)}
    {kind === 'line' ? [1, 2, 3].map(s => <polyline key={s} fill="none" stroke={C[s - 1]} strokeWidth="1.6" points={M.map((r, i) => (L + bw * i + bw / 2) + ',' + y(r[s])).join(' ')} />) : M.map((r, i) => [1, 2, 3].map(s => { const gw = bw * .5, w = gw / 3; return <rect key={i + '-' + s} x={L + bw * i + bw / 2 - gw / 2 + w * (s - 1)} y={y(r[s])} width={w} height={T + ph - y(r[s])} fill={C[s - 1]} />; }))}
    {M.map((r, i) => <g key={i} transform={`translate(${L + bw * i + bw / 2},${T + ph + 8}) rotate(-90)`}><text fontSize="10" textAnchor="end" dy="3.5" fill="#000">{r[0]}</text></g>)}
    <text x="14" y={T + ph / 2} fontSize="11" fill="#000" transform={`rotate(-90 14 ${T + ph / 2})`} textAnchor="middle">USD</text>
    <g transform={`translate(${L + 10},${T + 8})`}><rect width="62" height="54" fill="#fff" stroke="#ccc" rx="2" />{['EC2', 'RDS', 'S3'].map((n, i) => <g key={n} transform={`translate(8,${12 + i * 15})`}><rect width="14" height="7" y="-6" fill={C[i]} /><text x="20" fontSize="10" fill="#000">{n}</text></g>)}</g>
  </svg>;
}

Object.assign(window, { MemoryView, MemoryUsed, MemoryPopRow, RvCaps, MplFigure });
})();
