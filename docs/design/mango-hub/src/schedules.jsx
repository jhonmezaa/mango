// Schedules — tareas recurrentes de agentes publicados
const SC_FREQ = [['15m', 'Cada 15 min'], ['hourly', 'Cada hora'], ['6h', 'Cada 6 h'], ['daily', 'Diario'], ['weekdays', 'Lunes a viernes'], ['days', 'Días específicos'], ['weekly', 'Semanal'], ['monthly', 'Mensual']];
const SC_DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const SC_DELIVER = { inbox: 'Bandeja del creador', ticket: 'Crear ticket', slack: 'Canal de Slack' };
const SC_RUN = { ok: ['Completada', 'var(--green)'], failed: ['Fallida', 'var(--red)'], skipped: ['Omitida', 'var(--text-dim)'], approval: ['Espera aprobación', 'var(--amber)'] };
const pad2 = (n) => String(n).padStart(2, '0');

function scParse(cron) {
  const [mi, h, dom, , dow] = (cron || '0 9 * * *').split(' ');
  if (/^\*\/15$/.test(mi)) return { freq: '15m', hour: 0, min: 0 };
  if (h === '*') return { freq: 'hourly', hour: 0, min: +mi || 0 };
  if (/^\d(,\d)+$/.test(dow)) return { freq: 'days', days: dow.split(',').map(Number), hour: +h, min: +mi };
  if (h.startsWith('*/')) return { freq: '6h', hour: 0, min: +mi || 0 };
  if (dom !== '*') return { freq: 'monthly', dom: +dom, hour: +h, min: +mi };
  if (dow === '1-5') return { freq: 'weekdays', hour: +h, min: +mi };
  if (dow !== '*') return { freq: 'weekly', dow: +dow, hour: +h, min: +mi };
  return { freq: 'daily', hour: +h, min: +mi };
}
const scCron = (p) => ({ '15m': '*/15 * * * *', days: `${p.min} ${p.hour} * * ${(p.days || [1]).join(',')}`, hourly: `${p.min} * * * *`, '6h': `${p.min} */6 * * *`, daily: `${p.min} ${p.hour} * * *`, weekdays: `${p.min} ${p.hour} * * 1-5`, weekly: `${p.min} ${p.hour} * * ${p.dow}`, monthly: `${p.min} ${p.hour} ${p.dom} * *` })[p.freq];
const scLabel = (p) => { const t = pad2(p.hour) + ':' + pad2(p.min); const dl = (p.days || []).map(d => SC_DOW[d]); return ({ '15m': 'Cada 15 minutos', days: (dl.length > 1 ? dl.slice(0, -1).join(', ') + ' y ' + dl[dl.length - 1] : dl[0] || '') .replace(/^./, c => c.toUpperCase()) + ` · ${t}`, hourly: `Cada hora, al minuto ${p.min}`, '6h': 'Cada 6 horas', daily: `Todos los días · ${t}`, weekdays: `Lunes a viernes · ${t}`, weekly: `Cada ${SC_DOW[p.dow]} · ${t}`, monthly: `Día ${p.dom} de cada mes · ${t}` })[p.freq]; };
const scSafeLabel = (s) => { const l = scLabel(s.p); return /undefined|NaN/.test(l) ? (s.cronLabel || s.cron) : l; };
const scPerMonth = (p) => ({ '15m': 2880, days: (p.days || []).length * 4.3, hourly: 720, '6h': 120, daily: 30, weekdays: 22, weekly: 4.3, monthly: 1 })[p.freq];
function scNext(p, n = 3, from = new Date()) {
  const out = []; const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 40 && out.length < n; i++) {
    const ok = p.freq === '15m' ? d.getMinutes() % 15 === 0 : d.getMinutes() === p.min && (p.freq === 'hourly' || (p.freq === '6h' ? d.getHours() % 6 === 0 : d.getHours() === p.hour)) && (p.freq !== 'days' || (p.days || []).includes(d.getDay())) &&
      (p.freq !== 'weekdays' || (d.getDay() > 0 && d.getDay() < 6)) && (p.freq !== 'weekly' || d.getDay() === p.dow) && (p.freq !== 'monthly' || d.getDate() === p.dom);
    if (ok) out.push(new Date(d));
    d.setMinutes(d.getMinutes() + (p.freq === 'hourly' || p.freq === '6h' || ok ? 1 : 1));
  }
  return out;
}
const scFmt = (d) => d.toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

function scInit() {
  const S = window.MangoStore; if (S.get().schedules) return;
  const tasks = { 'sch-01': 'Revisa el consumo del presupuesto mensual y avisa si pasa del 80%.', 'sch-02': 'Analiza 14 días de utilización y recomienda cambios de tipo de instancia.', 'sch-03': 'Lista findings HIGH de las últimas 6 horas y escala los nuevos.' };
  const list = (window.MangoData.schedules || []).map((s, i) => {
    const runs = Array.from({ length: Math.min(12, s.runs30d || 0) }, (_, j) => {
      const failed = (s.successRate || 100) < 100 && j % Math.max(2, Math.round(100 / (100 - s.successRate))) === 1;
      const st = s.status === 'error' && j < 2 ? 'failed' : failed ? 'failed' : (s.id === 'sch-02' && j === 0) ? 'approval' : 'ok';
      return { at: new Date(Date.now() - (j + 1) * (s.cron.includes('*/6') ? 6 : s.cron.split(' ')[4] !== '*' ? 168 : 24) * 36e5).toISOString(), status: st, ms: 4000 + ((j * 1337 + i * 911) % 18000), cost: 0.02 + ((j * 7 + i * 3) % 30) / 100, err: st === 'failed' ? 'Timeout al consultar ' + (i % 2 ? 'Security Hub' : 'Cost Explorer') : null };
    });
    const owner = ['Usuario 1', 'Usuario 2', 'Usuario 6', 'Usuario 3'][i % 4];
    const lost = i === 3;
    return { ...s, task: tasks[s.id] || s.desc, deliver: i % 2 === 0 ? 'inbox' : 'ticket', channel: '', owner, ownerLost: lost, ...(lost ? { status: 'paused', autoPaused: { at: new Date(Date.now() - 5 * 36e5).toISOString(), reason: owner + ' perdió el acceso al agente' } } : {}), p: scParse(s.cron), runs };
  });
  S.set({ schedules: list });
}

function SchedulesView({ agents }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const list0 = window.useMango(s => s.schedules) || [];
  window.useMango(s => s.role); window.useMango(s => s.budgets);
  const canEdit = S.can('agent.create');
  window.useMango(s => s.actorOverride);
  const me = S.actor(); const isAdmin = S.get().role === 'admin';
  const isOwner = (s) => s.owner === me;
  const canControl = (s) => isOwner(s) || isAdmin;
  const [q, setQ] = useState(''); const [st, setSt] = useState('all'); const [ag, setAg] = useState('all');
  const [sel, setSel] = useState(null); const [edit, setEdit] = useState(null);
  const health = (s) => {
    const a = agents.find(x => x.id === s.agent);
    if (!a) return { tone: 'red', msg: 'El agente ya no existe' };
    if (s.status === 'retired') return null;
    if (s.ownerLost) return { tone: 'red', msg: s.owner + ' perdió el acceso al agente: la tarea se pausó sola y no se puede reanudar' };
    const off = (a.mcp || []).filter(id => { const x = L.serverOf(id); return !x || x.status !== 'enabled'; });
    const b = (S.get().budgets || []).find(x => x.scope === 'agent' && x.target === a.id);
    if (b && b.spent >= b.limit) return { tone: 'amber', msg: 'Presupuesto del agente agotado: las próximas ejecuciones se omitirán' };
    if (off.length) return { tone: 'amber', msg: `${off.length === 1 ? 'Una tool no está disponible' : off.length + ' tools no están disponibles'} (${off.join(', ')})` };
    const fails = s.runs.slice(0, 3).filter(r => r.status === 'failed').length;
    if (fails >= 2) return { tone: 'red', msg: `${fails} de las últimas 3 ejecuciones fallaron` };
    return null;
  };
  const Q = q.trim().toLowerCase();
  const base = list0.filter(s => (ag === 'all' || s.agent === ag) && (!Q || (s.name + ' ' + s.task).toLowerCase().includes(Q)));
  const list = base.filter(s => st === 'all' ? s.status !== 'retired' : st === 'attention' ? s.status !== 'retired' && (s.status === 'error' || health(s)) : s.status === st);
  const monthly = list0.filter(s => s.status === 'active').reduce((sum, s) => { const avg = s.runs.length ? s.runs.reduce((x, r) => x + r.cost, 0) / s.runs.length : 0; return sum + avg * scPerMonth(s.p); }, 0);
  const nextAll = list0.filter(s => s.status === 'active').map(s => ({ s, d: scNext(s.p, 1)[0] })).filter(x => x.d).sort((a, b) => a.d - b.d);
  const set = (id, patch, action, msg) => { S.set({ schedules: S.get().schedules.map(x => x.id === id ? { ...x, ...patch } : x) }); S.log(action, id, msg); };
  const runNow = (s) => {
    set(s.id, { running: true }, 'schedule.run', 'Ejecutó ahora ' + s.name);
    setTimeout(() => { const cur = S.get().schedules.find(x => x.id === s.id); if (!cur) return; S.set({ schedules: S.get().schedules.map(x => x.id === s.id ? { ...x, running: false, status: x.status === 'error' ? 'active' : x.status, runs: [{ at: new Date().toISOString(), status: 'ok', ms: 6200, cost: 0.08, manual: true }, ...x.runs] } : x) }); toast?.({ tone: 'success', msg: s.name + ' completada · entregada en ' + SC_DELIVER[s.deliver].toLowerCase() }); }, 2200);
  };
  const retire = (s, reason) => { set(s.id, { status: 'retired', retired: { by: S.actor(), at: new Date().toISOString(), reason } }, 'schedule.retire', 'Retiró ' + s.name + ': ' + reason); toast?.({ tone: 'info', msg: s.name + ' retirada · el historial se conserva' }); };
  const toggle = (s) => { if (s.status === 'paused' && (s.ownerLost || !isOwner(s))) return; const on = s.status === 'paused'; set(s.id, { status: on ? 'active' : 'paused' }, on ? 'schedule.resume' : 'schedule.pause', (on ? 'Reanudó ' : 'Pausó ') + s.name); toast?.({ tone: 'info', msg: s.name + (on ? ' reanudada' : ' pausada') }); };
  const selected = sel && list0.find(x => x.id === sel);
  const STATUS = { active: ['Activa', 'badge-green'], paused: ['Pausada', 'badge'], error: ['Con errores', 'badge-red'], retired: ['Retirada', 'badge'] };

  return (
    <>
      <Topbar crumbs={['Construir', 'Schedules']} actions={canEdit && <button className="btn btn-sm btn-primary" onClick={() => setEdit({ isNew: true, name: '', agent: agents[0].id, task: '', p: { freq: 'daily', hour: 9, min: 0, dow: 1, dom: 1 }, tz: 'America/Mexico_City', deliver: 'inbox', channel: '' })}><I.Plus size={12} /> Nuevo schedule</button>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Schedules</h1>
          <p className="page-subtitle">Tareas que un agente publicado ejecuta solo, cada cierto tiempo. Cada tarea corre con la identidad y los permisos de quien la creó, no del agente; si esa persona pierde el acceso al agente, se pausa sola. Si necesitan escribir, dejan una aprobación pendiente.</p>
        </div>
        <div className="bg-kpis">
          <div className="card bg-kpi"><span className="bg-kpi-l">Activas</span><span className="bg-kpi-v">{list0.filter(s => s.status === 'active').length}</span><span className="bg-kpi-s">{(n => n + (n === 1 ? ' pausada' : ' pausadas'))(list0.filter(s => s.status === 'paused').length)}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Próxima ejecución</span><span className="bg-kpi-v" style={{ fontSize: 17 }}>{nextAll[0] ? nextAll[0].d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</span><span className="bg-kpi-s">{nextAll[0] ? nextAll[0].s.name : 'Ninguna programada'}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Necesitan atención</span><span className="bg-kpi-v" style={list0.some(s => s.status === 'error' || health(s)) ? { color: 'var(--amber)' } : null}>{list0.filter(s => s.status === 'error' || health(s)).length}</span><span className="bg-kpi-s">Errores, tools o presupuesto</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Costo estimado · mes</span><span className="bg-kpi-v">{window.GovKit ? window.GovKit.usd(monthly) : monthly.toFixed(2)}</span><span className="bg-kpi-s">Según el costo medio por ejecución</span></div>
        </div>
        <div className="bg-toolbar">
          <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar schedule o tarea" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar" /></div>
          <div className="tk-quick" role="group">{[['all', 'Todas'], ['active', 'Activas'], ['paused', 'Pausadas'], ['attention', 'Necesitan atención'], ['retired', 'Retiradas']].map(([k, l]) => <button key={k} className={st === k ? 'is-on' : ''} onClick={() => setSt(k)}>{l}<span className="mk-count">{k === 'all' ? base.filter(s => s.status !== 'retired').length : base.filter(s => k === 'attention' ? s.status !== 'retired' && (s.status === 'error' || health(s)) : s.status === k).length}</span></button>)}</div>
          <select className="input mk-sel" value={ag} onChange={e => setAg(e.target.value)} aria-label="Agente"><option value="all">Todos los agentes</option>{agents.filter(a => list0.some(s => s.agent === a.id)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </div>
        <div className="mc-body" style={{ paddingTop: 0 }}>
          <div className="card mc-table">
            <div className="sc-tr mc-th"><span>schedule</span><span>frecuencia</span><span>próxima</span><span>últimas ejecuciones</span><span>estado</span><span /></div>
            {list.map(s => { const a = agents.find(x => x.id === s.agent); const h = health(s); const nx = s.status === 'active' ? scNext(s.p, 1)[0] : null; return (
              <div key={s.id} className="sc-tr" onClick={() => setSel(s.id)} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && setSel(s.id)}>
                <span style={{ minWidth: 0 }}><span className="mk-name" style={{ display: 'block' }}>{s.name}</span><span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a?.name || s.agent} · como {s.owner} · {SC_DELIVER[s.deliver]}</span></span>
                <span style={{ fontSize: 13 }}>{scSafeLabel(s)}<span className="mk-meta" style={{ display: 'block' }}>{s.tz}</span></span>
                <span className="mk-meta">{s.running ? <span className="row gap-2"><span className="g-spin" /> Ejecutando…</span> : nx ? scFmt(nx) : '—'}</span>
                <span className="sc-dots" aria-label="Últimas ejecuciones">{s.runs.slice(0, 10).reverse().map((r, i) => <i key={i} title={SC_RUN[r.status][0] + ' · ' + new Date(r.at).toLocaleString('es-MX')} style={{ background: SC_RUN[r.status][1] }} />)}{!s.runs.length && <span className="mk-meta">Sin ejecuciones</span>}</span>
                <span className="row gap-1" style={{ flexWrap: 'wrap' }}><span className={'badge ' + STATUS[s.status][1]}>{STATUS[s.status][0]}</span>{h && <span className={'badge ' + (h.tone === 'red' ? 'badge-red' : 'badge-amber')} title={h.msg}><I.Warn size={10} /></span>}</span>
                <span className="row gap-1" style={{ justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>{s.status !== 'retired' && !s.ownerLost && <>{isOwner(s) && <button className="btn btn-sm btn-ghost btn-icon" title="Ejecutar ahora" aria-label={'Ejecutar ahora ' + s.name} disabled={s.running} onClick={() => runNow(s)}><I.Play size={12} /></button>}{canControl(s) && (s.status !== 'paused' || isOwner(s)) && <button className="btn btn-sm btn-ghost btn-icon" title={s.status === 'paused' ? 'Reanudar' : 'Pausar'} aria-label={(s.status === 'paused' ? 'Reanudar ' : 'Pausar ') + s.name} onClick={() => toggle(s)}>{s.status === 'paused' ? <I.Play size={12} /> : <I.Pause size={12} />}</button>}</>}</span>
              </div>
            ); })}
            {!list.length && <div className="mk-meta" style={{ padding: 16 }}>Ningún schedule coincide.</div>}
          </div>
        </div>
      </div>
      {selected && <ScheduleDetail s={selected} agent={agents.find(a => a.id === selected.agent)} health={health(selected)} isOwner={isOwner(selected)} canControl={canControl(selected)} onClose={() => setSel(null)} onEdit={() => setEdit({ ...selected })} onRun={() => runNow(selected)} onToggle={() => toggle(selected)} onRetire={(r) => retire(selected, r)} />}
      {edit && <ScheduleEditor s={edit} agents={agents} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); setSel(id); }} />}
    </>
  );
}

function ScheduleDetail({ s, agent, health, isOwner, canControl, onClose, onEdit, onRun, onToggle, onRetire }) {
  const I = window.Icons; const S = window.MangoStore;
  const toast = window.useToast?.();
  const [del, setDel] = useState(false);
  const [why, setWhy] = useState('');
  const soon = window.useSoon?.();
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const ok = s.runs.filter(r => r.status === 'ok').length;
  const nx = s.status === 'active' ? scNext(s.p, 3) : [];
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" style={{ width: 520 }} role="dialog" aria-modal="true" aria-label={s.name}>
        <div className="mk-drawer-h">
          <span className="mc-ic lg"><I.Clock size={20} /></span>
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{s.name}</div><div className="mk-meta" style={{ marginTop: 3 }}>{agent?.name} · {scSafeLabel(s)}</div></div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="mk-drawer-b">
          {health && <div className={'mc-alert ' + (health.tone === 'red' ? 'red' : 'amber')}><I.Warn size={14} /><div>{health.msg}.</div></div>}
          {s.status === 'paused' && !s.autoPaused && <div className="mc-alert"><I.Pause size={14} /><div>Pausada: no se ejecutará hasta que la reanudes.</div></div>}
          {s.autoPaused && s.status === 'paused' && <div className="mc-alert red"><I.Lock size={14} /><div><b>Pausada automáticamente {window.fmtAgo(s.autoPaused.at)}.</b> {s.autoPaused.reason}. Solo se reanuda si recupera el acceso; si no, retírala.</div></div>}
          {s.status === 'retired' && <div className="mc-alert"><I.Archive size={14} /><div>Retirada por {s.retired?.by}{s.retired?.reason ? ' · ' + s.retired.reason : ''}. No vuelve a ejecutarse; el historial se conserva.</div></div>}
          <MkSec title="Tarea"><div style={{ fontSize: 13.5, lineHeight: 1.55, padding: '10px 12px', borderRadius: 10, background: 'var(--input-bg)' }}>{s.task}</div></MkSec>
          <MkSec title="Programación">
            <div className="mk-kv"><span>Frecuencia</span><span>{scSafeLabel(s)}</span></div>
            <div className="mk-kv"><span>Zona horaria</span><span className="mono" style={{ fontSize: 12 }}>{s.tz}</span></div>
            <div className="mk-kv"><span>Cron</span><span className="mono" style={{ fontSize: 12 }}>{scCron(s.p)}</span></div>
            {nx.length > 0 && <div className="mk-kv"><span>Próximas</span><span style={{ textAlign: 'right' }}>{nx.map(d => <div key={+d}>{scFmt(d)}</div>)}</span></div>}
          </MkSec>
          <MkSec title="Entrega y control">
            <div className="mk-kv"><span>Resultado</span><span>{SC_DELIVER[s.deliver]}</span></div>
            <div className="mk-kv"><span>Se ejecuta como</span><span>{s.owner} · con su identidad y sus permisos</span></div>
            <div className="mk-kv"><span>Agente</span><span>{agent?.name} · usa su presupuesto</span></div>
            <div className="mk-kv"><span>Si {s.owner} pierde el acceso</span><span>La tarea se pausa sola</span></div>
            <div className="mk-kv"><span>Acciones de escritura</span><span>Quedan como aprobación pendiente</span></div>
          </MkSec>
          <MkSec title={`Ejecuciones recientes · ${ok} de ${s.runs.length} completadas`}>
            {s.runs.length ? s.runs.slice(0, 10).map((r, i) => (
              <div key={i} className="mk-line row between" style={{ alignItems: 'flex-start' }}>
                <span className="row gap-2" style={{ minWidth: 0 }}><span className="tk-dot" style={{ background: SC_RUN[r.status][1], marginTop: 6 }} /><span style={{ minWidth: 0 }}><span style={{ display: 'block' }}>{SC_RUN[r.status][0]}{r.manual ? ' · manual' : ''}</span>{r.err && <span className="mk-meta" style={{ display: 'block', color: 'var(--red)' }}>{r.err}</span>}{r.status === 'approval' && <button className="sr-link" onClick={() => { onClose(); window.MangoNav?.('approvals'); }}>Ver aprobación</button>}</span></span>
                <span className="mk-meta mono" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{window.fmtAgo(r.at)}<br />{(r.ms / 1000).toFixed(1)} s · USD {r.cost.toFixed(2).replace('.', ',')}</span>
              </div>
            )) : <div className="mk-meta">Aún no se ha ejecutado.</div>}
          </MkSec>
        </div>
        {canControl && s.status !== 'retired' && <div className="mc-foot row gap-2" style={{ flexWrap: 'wrap' }}>
          {del ? <>
            <input className="input" style={{ flex: '1 1 200px' }} value={why} onChange={e => setWhy(e.target.value)} placeholder="Motivo del retiro (obligatorio)" aria-label="Motivo del retiro" autoFocus />
            <button className="btn btn-sm" onClick={() => setDel(false)}>Cancelar</button>
            <button className="btn btn-sm btn-primary" disabled={!why.trim()} onClick={() => { onRetire(why.trim()); setDel(false); }}><I.Archive size={12} /> Retirar</button>
          </> : <>
            {isOwner && <button className="btn btn-sm btn-primary" disabled={s.running || s.ownerLost} onClick={onRun}><I.Play size={12} /> {s.running ? 'Ejecutando…' : 'Ejecutar ahora'}</button>}
            {(s.status !== 'paused' || isOwner) && <button className="btn btn-sm" disabled={s.ownerLost && s.status === 'paused'} title={s.ownerLost ? 'El creador perdió el acceso al agente' : undefined} onClick={onToggle}>{s.status === 'paused' ? 'Reanudar' : 'Pausar'}</button>}
            {isOwner && <button className="btn btn-sm" disabled={s.ownerLost} onClick={onEdit}><I.Edit size={12} /> Editar</button>}
            {!isOwner && <span className="ap-reason" style={{ flexBasis: '100%', order: 9 }}><I.Lock size={12} /> Solo {s.owner} puede editarla, ejecutarla ahora o reanudarla (corre con su identidad). Como admin puedes pausarla o retirarla.</span>}
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm btn-ghost" onClick={() => setDel(true)}><I.Archive size={12} /> Retirar</button>
          </>}
        </div>}
      </aside>
    </div>
  );
}

function ScheduleEditor({ s, agents, onClose, onSaved }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const [f, setF] = useState({ ...s, p: { dow: 1, dom: 1, days: [1, 4], ...s.p } });
  const [tried, setTried] = useState(false);
  const setP = (patch) => setF(x => ({ ...x, p: { ...x.p, ...patch } }));
  const a = agents.find(x => x.id === f.agent);
  const nx = scNext(f.p, 3);
  const heavy = f.p.freq === 'hourly' || f.p.freq === '15m';
  const errs = [!f.name.trim() && 'Escribe un nombre', !f.task.trim() && 'Describe la tarea', L.findSecret(f.task) && 'Hay un posible secreto en la tarea', f.p.freq === 'days' && !(f.p.days || []).length && 'Elige al menos un día'].filter(Boolean);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const save = () => {
    setTried(true); if (errs.length) return;
    const rec = { ...f, cron: scCron(f.p), cronLabel: scLabel(f.p) }; delete rec.isNew;
    if (s.isNew) { const id = 'sch-' + Date.now().toString(36).slice(-4); S.set({ schedules: [...S.get().schedules, { ...rec, id, status: 'active', runs: [], owner: S.actor() }] }); S.log('schedule.create', id, `Creó ${f.name} · ${scLabel(f.p)}`); toast?.({ tone: 'success', msg: 'Schedule creado' }); onSaved(id); }
    else { S.set({ schedules: S.get().schedules.map(x => x.id === s.id ? { ...x, ...rec } : x) }); S.log('schedule.update', s.id, `Editó ${f.name} · ${scLabel(f.p)}`, { before: { frecuencia: scSafeLabel(s) }, after: { frecuencia: scLabel(f.p) } }); toast?.({ tone: 'success', msg: 'Cambios guardados' }); onSaved(s.id); }
  };
  const Lb = ({ children, htmlFor }) => <label htmlFor={htmlFor} style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 6 }}>{children}</label>;
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div className="card" role="dialog" aria-modal="true" aria-label={s.isNew ? 'Nuevo schedule' : 'Editar schedule'} onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '94vw', padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}>
        <div className="row between" style={{ padding: '18px 20px 4px' }}><div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>{s.isNew ? 'Nuevo schedule' : 'Editar ' + s.name}</div><button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button></div>
        <div style={{ padding: '14px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
            <div><Lb htmlFor="sc-n">Nombre</Lb><input id="sc-n" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus maxLength={48} /></div>
            <div><Lb htmlFor="sc-a">Agente</Lb><select id="sc-a" className="input" value={f.agent} onChange={e => setF({ ...f, agent: e.target.value })}>{agents.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
          </div>
          <div><Lb htmlFor="sc-t">Tarea</Lb><textarea id="sc-t" className="input" rows={3} value={f.task} onChange={e => setF({ ...f, task: e.target.value })} placeholder="Qué debe hacer el agente en cada ejecución" /></div>
          <div><Lb>Frecuencia</Lb>
            <div className="ab-seg">{SC_FREQ.map(([k, l]) => <button key={k} type="button" className={f.p.freq === k ? 'is-on' : ''} onClick={() => setP({ freq: k })}>{l}</button>)}</div>
            <div className="row gap-2" style={{ marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              {f.p.freq === 'days' && <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{SC_DOW.map((d, i) => { const on = (f.p.days || []).includes(i); return <button key={i} type="button" className={'tweak-chip ab-chip' + (on ? ' is-on' : '')} onClick={() => setP({ days: on ? f.p.days.filter(x => x !== i) : [...(f.p.days || []), i].sort() })}>{d.slice(0, 3)}</button>; })}</div>}
              {f.p.freq === 'weekly' && <select className="input" style={{ width: 'auto' }} value={f.p.dow} onChange={e => setP({ dow: +e.target.value })} aria-label="Día">{SC_DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}</select>}
              {f.p.freq === 'monthly' && <select className="input" style={{ width: 'auto' }} value={f.p.dom} onChange={e => setP({ dom: +e.target.value })} aria-label="Día del mes">{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>Día {i + 1}</option>)}</select>}
              {!['15m', 'hourly', '6h'].includes(f.p.freq) && <input type="time" className="input" style={{ width: 'auto' }} value={pad2(f.p.hour) + ':' + pad2(f.p.min)} onChange={e => { const [h, m] = e.target.value.split(':'); setP({ hour: +h, min: +m }); }} aria-label="Hora" />}
              <select className="input" style={{ width: 'auto' }} value={f.tz} onChange={e => setF({ ...f, tz: e.target.value })} aria-label="Zona horaria">{['America/Mexico_City', 'America/Bogota', 'America/Sao_Paulo', 'UTC'].map(t => <option key={t}>{t}</option>)}</select>
            </div>
            <div className="mk-meta" style={{ marginTop: 8 }}>{scLabel(f.p)} · <span className="mono">{scCron(f.p)}</span>{nx.length ? ' · próximas: ' + nx.map(scFmt).join(', ') : ''}</div>
            {heavy && <div className="mc-alert amber" style={{ marginTop: 8, fontSize: 12.5 }}><I.Warn size={13} /><div>{f.p.freq === '15m' ? 'Cada 15 minutos son ~2.880' : 'Cada hora son ~720'} ejecuciones al mes con el presupuesto de {a?.name}. Revisa que te alcance.</div></div>}
            {f.p.freq === 'days' && !(f.p.days || []).length && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>Elige al menos un día</div>}
          </div>
          <div><Lb>Entregar resultado en</Lb>
            <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><div className="ab-seg">{Object.entries(SC_DELIVER).filter(([k]) => k !== 'slack').map(([k, l]) => <button key={k} type="button" className={f.deliver === k ? 'is-on' : ''} onClick={() => setF({ ...f, deliver: k })}>{l}</button>)}</div>
            <window.Soon on><div className="ab-seg"><button type="button">{SC_DELIVER.slack}</button></div></window.Soon></div>
          </div>
          <div className="mc-alert" style={{ fontSize: 12.5 }}><I.User size={13} /><div>Se ejecuta con {s.isNew ? 'tu identidad y tus permisos' : 'la identidad y los permisos de ' + s.owner} (no con los del agente) y usa el presupuesto de {a?.name}. Si {s.isNew ? 'pierdes' : 'pierde'} el acceso al agente, la tarea se pausa sola. Si necesita escribir, se crea una aprobación pendiente.</div></div>
        </div>
        {tried && errs.length > 0 && <div style={{ padding: '0 20px 10px', fontSize: 12.5, color: 'var(--red)' }}>{errs.join(' · ')}</div>}
        <div className="row gap-2" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" onClick={save}>{s.isNew ? 'Crear schedule' : 'Guardar'}</button></div>
      </div>
    </div>
  );
}

scInit();
Object.assign(window, { SchedulesView });
