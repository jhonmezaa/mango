// Schedules — tareas de agentes publicados: por horario o al detectar una anomalía de costo (helpers en schedules-run.jsx)
function SchedulesView({ agents }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const all = window.useMango(s => s.schedules) || [];
  const role = window.useMango(s => s.role); window.useMango(s => s.budgets); window.useMango(s => s.actorOverride); const avail = window.useMango(s => s.avail);
  const scOpen = window.useMango(s => s.scOpen);
  const me = S.actor(); const isAdmin = role === 'admin';
  const inboxOn = !S.isSoon('inbox');
  const repOn = !avail;
  const usable = agents.filter(scCanUse);
  const list0 = isAdmin ? all : all.filter(s => s.owner === me);
  const [q, setQ] = useState(''); const [st, setSt] = useState('all'); const [ag, setAg] = useState('all');
  const [sel, setSel] = useState(null); const [run, setRun] = useState(null); const [ask, setAsk] = useState(null); const [edit, setEdit] = useState(null);
  const open = (id, a = null) => { setSel(id); setRun(null); setAsk(a); };
  // Desde la Bandeja: si la ejecución ya no existe (se guardan 90 días), se abre la tarea y se avisa.
  useEffect(() => { if (!scOpen) return; const t = list0.find(x => x.id === scOpen.id); const ref = scOpen.ref || scOpen.run; const gone = !t || (ref && !t.runs.some(r => r.id === ref)); setSel(t ? t.id : null); setRun(t && !gone ? scOpen.run || null : null); setAsk(null); S.set({ scOpen: null }); if (gone && ref) toast?.({ tone: 'info', title: 'Esa ejecución ya no está disponible', msg: 'Los resultados se guardan 90 días.' }); }, [scOpen]);
  const health = (s) => {
    const a = agents.find(x => x.id === s.agent);
    if (!a) return { tone: 'red', msg: 'El agente ya no existe' };
    if (s.status === 'retired') return null;
    if (s.autoPaused) return { tone: 'red', msg: s.autoPaused.reason + ': la tarea se pausó sola y no se puede reanudar' };
    const off = (a.mcp || []).filter(id => { const x = L.serverOf(id); return !x || x.status !== 'enabled'; });
    const b = (S.get().budgets || []).find(x => x.scope === 'agent' && x.target === a.id);
    if (b && b.spent >= b.limit) return { tone: 'amber', msg: 'Presupuesto del agente agotado: las próximas ejecuciones se omitirán' };
    if (s.runs[0]?.status === 'skipped' && s.runs[0].reason === 'budget') return { tone: 'amber', msg: 'La última ejecución se omitió: presupuesto agotado' };
    if (off.length) return { tone: 'amber', msg: `${off.length === 1 ? 'Una tool no está disponible' : off.length + ' tools no están disponibles'} (${off.join(', ')})` };
    const fails = s.runs.slice(0, 3).filter(r => r.status === 'failed').length;
    if (fails >= 2) return { tone: 'red', msg: `${fails} de las últimas 3 ejecuciones fallaron` };
    return null;
  };
  const attn = (s) => s.status !== 'retired' && (s.status === 'error' || !!health(s));
  const Q = q.trim().toLowerCase();
  const base = list0.filter(s => (ag === 'all' || s.agent === ag) && (!Q || (s.name + ' ' + (s.owner === me ? s.task : '')).toLowerCase().includes(Q)));
  const list = base.filter(s => st === 'all' ? s.status !== 'retired' : st === 'attention' ? attn(s) : s.status === st);
  const act = list0.filter(s => s.status === 'active');
  const avgCost = (s) => { const c = s.runs.filter(r => r.cost != null); return c.length ? c.reduce((x, r) => x + r.cost, 0) / c.length : 0; };
  const anomT = act.filter(s => s.trigger === 'anomaly');
  const monthly = act.filter(s => s.trigger !== 'anomaly').reduce((sum, s) => sum + avgCost(s) * scPerMonth(s.p), 0) + anomT.reduce((sum, s) => sum + s.runs.filter(r => r.cost != null && Date.now() - new Date(r.at).getTime() < 30 * 864e5).reduce((x, r) => x + r.cost, 0), 0);
  const nextOf = (s) => s.status === 'active' && s.trigger !== 'anomaly' ? scNextTz(s.p, s.tz, 1)[0] : null;
  const nextAll = act.map(s => ({ s, d: nextOf(s) })).filter(x => x.d).sort((a, b) => a.d - b.d);
  const setSc = (id, fn) => S.set({ schedules: S.get().schedules.map(x => x.id === id ? fn(x) : x) });
  const set = (id, patch, action, msg) => { setSc(id, x => ({ ...x, ...patch })); S.log(action, id, msg); };
  const patchRun = (sid, rid, patch) => setSc(sid, x => ({ ...x, runs: x.runs.map(r => r.id === rid ? { ...r, ...patch } : r) }));
  const openResult = (sid, rid) => { S.set({ scOpen: { id: sid, run: rid } }); window.MangoNav?.('schedules'); };
  const finishReport = (sid, rid, ms) => setTimeout(() => { const x = S.get().schedules.find(y => y.id === sid); const r = x?.runs.find(y => y.id === rid); if (!r?.report || r.report.status !== 'generating') return; patchRun(sid, rid, { report: S.get().simReport === 'genfail' ? { status: 'failed', reason: 'render', period: r.report.period } : { status: 'ready', pages: 2, kb: 405, period: r.report.period } }); }, ms);
  const retryReport = (sid, rid) => { const r = S.get().schedules.find(y => y.id === sid)?.runs.find(y => y.id === rid); patchRun(sid, rid, { report: { status: 'generating', period: r?.report?.period } }); finishReport(sid, rid, 2500); };
  const runNow = (s) => {
    const rid = s.id + '-m' + Date.now().toString(36);
    setSc(s.id, x => ({ ...x, runs: [{ id: rid, at: new Date().toISOString(), status: 'queued', manual: true }, ...x.runs] }));
    S.log('schedule.run', s.id, 'Ejecutó ahora ' + s.name);
    toast?.({ tone: 'info', msg: s.name + ' en cola' });
    const cur = () => (S.get().schedules.find(x => x.id === s.id)?.runs || []).find(x => x.id === rid);
    setTimeout(() => { if (cur()?.status === 'queued') patchRun(s.id, rid, { status: 'running' }); }, 1200);
    setTimeout(() => {
      if (cur()?.status !== 'running') { if (cur()?.status === 'skipped') toast?.({ tone: 'info', title: s.name + ' no se completó', msg: scReason(cur()) }); return; }
      const withRep = repOn && !!s.report;
      patchRun(s.id, rid, { status: 'ok', ms: 6200, cost: 0.08, result: scResultFor(s, 0), ...(withRep ? { report: { status: 'generating', period: s.id === 'sch-11' ? SC_MES[(new Date().getUTCMonth() + 11) % 12] + ' ' + new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)).getUTCFullYear() : '' } } : {}) });
      if (withRep) finishReport(s.id, rid, 3500);
      setSc(s.id, x => x.status === 'error' ? { ...x, status: 'active' } : x);
      toast?.({ tone: 'success', title: s.name + ' completada', msg: (inboxOn ? 'El resultado está en el detalle de la tarea y en tu Bandeja.' : 'El resultado está en el detalle de la tarea.') + (withRep ? ' El PDF tarda un poco más.' : ''), duration: 8000, action: { label: 'Ver resultado', fn: () => openResult(s.id, rid) } });
    }, 4200);
  };
  const dropQueued = (x, reason) => x.runs.map(r => r.status === 'queued' ? { ...r, status: 'skipped', reason } : r);
  const retire = (s, reason) => { setSc(s.id, x => ({ ...x, status: 'retired', retired: { by: me, at: new Date().toISOString(), reason }, runs: dropQueued(x, 'retired') })); S.log('schedule.retire', s.id, 'Retiró ' + s.name + ': ' + reason); toast?.({ tone: 'info', msg: s.name + ' retirada · el historial se conserva' }); };
  const pause = (s, reason) => { const byAdmin = s.owner !== me; setSc(s.id, x => ({ ...x, status: 'paused', paused: { by: byAdmin ? 'admin' : 'owner', actor: S.actorEmail(), at: new Date().toISOString(), reason: reason || null }, runs: dropQueued(x, byAdmin ? 'admin_paused' : 'paused') })); S.log('schedule.pause', s.id, 'Pausó ' + s.name + (reason ? ': ' + reason : '')); toast?.({ tone: 'info', msg: s.name + ' pausada' + (byAdmin ? ' · solo un administrador la reanuda' : '') }); };
  const resume = (s) => { set(s.id, { status: 'active', paused: null }, 'schedule.resume', 'Reanudó ' + s.name); toast?.({ tone: 'info', msg: s.name + ' reanudada' }); };
  const selected = sel && list0.find(x => x.id === sel);
  const STATUS = { active: ['Activa', 'badge-green'], paused: ['Pausada', 'badge'], error: ['Con errores', 'badge-red'], retired: ['Retirada', 'badge'] };
  const badgeOf = (s) => s.status === 'paused' && s.paused?.by === 'admin' ? ['Pausada por un admin', 'badge-amber'] : STATUS[s.status] || STATUS.active;
  const newSched = () => setEdit({ isNew: true, name: '', agent: usable[0]?.id || '', task: '', trigger: 'schedule', p: { freq: 'daily', hour: 9, min: 0, dow: 1, dom: 1 }, tz: 'America/Mexico_City', deliver: 'inbox' });

  return (
    <>
      <Topbar crumbs={['Construir', 'Schedules']} actions={<button className="btn btn-sm btn-primary" disabled={!usable.length} title={usable.length ? undefined : 'No tienes agentes publicados que puedas usar'} onClick={newSched}><I.Plus size={12} /> Nuevo schedule</button>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Schedules</h1>
          <p className="page-subtitle">Tareas que un agente publicado ejecuta solo: cada cierto tiempo o cuando AWS detecta una anomalía de costo. Cada tarea corre con la identidad y los permisos de quien la creó, no del agente; si esa persona pierde el acceso al agente, se pausa sola. Si necesitan escribir, dejan una aprobación pendiente.{isAdmin ? ' Ves las de todas las personas; la instrucción y los resultados solo los ve quien la creó.' : ''}</p>
        </div>
        <div className="bg-kpis">
          <div className="card bg-kpi"><span className="bg-kpi-l">Activas</span><span className="bg-kpi-v">{act.length}</span><span className="bg-kpi-s">{(n => n + (n === 1 ? ' pausada' : ' pausadas'))(list0.filter(s => s.status === 'paused').length)}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Próxima ejecución</span><span className="bg-kpi-v" style={{ fontSize: 17 }}>{nextAll[0] ? nextAll[0].d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</span><span className="bg-kpi-s">{nextAll[0] ? nextAll[0].s.name : 'Ninguna programada'}</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Necesitan atención</span><span className="bg-kpi-v" style={list0.some(attn) ? { color: 'var(--amber)' } : null}>{list0.filter(attn).length}</span><span className="bg-kpi-s">Errores, tools o presupuesto</span></div>
          <div className="card bg-kpi"><span className="bg-kpi-l">Costo estimado · mes</span><span className="bg-kpi-v">{window.GovKit ? window.GovKit.usd(monthly) : scUsd(monthly)}</span><span className="bg-kpi-s">{anomT.length ? 'Horario: costo medio · anomalías: últimos 30 días' : 'Según el costo medio por ejecución'}</span></div>
        </div>
        <div className="bg-toolbar">
          <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar schedule o tarea" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar" /></div>
          <div className="tk-quick" role="group">{[['all', 'Todas'], ['active', 'Activas'], ['paused', 'Pausadas'], ['attention', 'Necesitan atención'], ['retired', 'Retiradas']].map(([k, l]) => <button key={k} className={st === k ? 'is-on' : ''} onClick={() => setSt(k)}>{l}<span className="mk-count">{k === 'all' ? base.filter(s => s.status !== 'retired').length : base.filter(s => k === 'attention' ? attn(s) : s.status === k).length}</span></button>)}</div>
          <select className="input mk-sel" value={ag} onChange={e => setAg(e.target.value)} aria-label="Agente"><option value="all">Todos los agentes</option>{agents.filter(a => list0.some(s => s.agent === a.id)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </div>
        <div className="mc-body" style={{ paddingTop: 0 }}>
          <div className="card mc-table">
            <div className="sc-tr mc-th"><span>schedule</span><span>cuándo corre</span><span>próxima</span><span>últimas ejecuciones</span><span>estado</span><span></span></div>
            {list.map(s => { const a = agents.find(x => x.id === s.agent); const h = health(s); const P = scPerms(s, me, isAdmin); const nx = nextOf(s); const capHit = P.anomaly && s.status === 'active' && scToday(s) >= SC_CAP; const [bl, bc] = badgeOf(s); return (
              <div key={s.id} className="sc-tr" onClick={() => open(s.id)} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && open(s.id)}>
                <span style={{ minWidth: 0 }}><span className="mk-name" style={{ display: 'block' }}>{s.name}</span><span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a?.name || s.agent} · como {P.own ? 'tú' : s.owner}</span></span>
                <span style={{ fontSize: 13, minWidth: 0 }}>{P.anomaly ? <><span className="sc-trg"><I.Zap size={12} /> {SC_ANOMALY}</span><span className="mk-meta" style={{ display: 'block' }}>Hasta {SC_CAP} por día</span></> : <>{scSafeLabel(s)}<span className="mk-meta" style={{ display: 'block' }}>{s.tz}</span></>}</span>
                <span className="mk-meta">{P.busy ? <span className="row gap-2">{P.busy.status === 'running' ? <><span className="g-spin"></span> Ejecutando…</> : 'En cola'}</span> : capHit ? 'Tope de hoy alcanzado' : nx ? scFmt(nx) : '—'}</span>
                <span className="sc-dots" aria-label="Últimas ejecuciones">{s.runs.slice(0, 10).reverse().map(r => <i key={r.id} title={SC_RUN[r.status][0] + (scReason(r) ? ' · ' + scReason(r) : '') + ' · ' + new Date(r.at).toLocaleString('es-MX')} style={{ background: SC_RUN[r.status][1] }}></i>)}{!s.runs.length && <span className="mk-meta">Sin ejecuciones</span>}</span>
                <span className="row gap-1" style={{ flexWrap: 'wrap' }}><span className={'badge ' + bc}>{bl}</span>{h && <span className={'badge ' + (h.tone === 'red' ? 'badge-red' : 'badge-amber')} title={h.msg}><I.Warn size={10} /></span>}</span>
                <span className="row gap-1" style={{ justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                  {P.canRun && s.status !== 'paused' && <button className="btn btn-sm btn-ghost btn-icon" title="Ejecutar ahora" aria-label={'Ejecutar ahora ' + s.name} disabled={!!P.busy} onClick={() => runNow(s)}><I.Play size={12} /></button>}
                  {P.canResume ? <button className="btn btn-sm btn-ghost btn-icon" title="Reanudar" aria-label={'Reanudar ' + s.name} onClick={() => resume(s)}><I.Play size={12} /></button>
                    : P.canPause && <button className="btn btn-sm btn-ghost btn-icon" title="Pausar" aria-label={'Pausar ' + s.name} onClick={() => P.own ? pause(s, null) : open(s.id, 'pause')}><I.Pause size={12} /></button>}
                </span>
              </div>
            ); })}
            {!list.length && <div className="mk-meta" style={{ padding: 16 }}>{list0.length ? 'Ningún schedule coincide.' : usable.length ? 'Aún no tienes tareas. Crea una con «Nuevo schedule».' : 'Aún no tienes tareas. Para crear una necesitas un agente publicado que puedas usar.'}</div>}
          </div>
        </div>
      </div>
      {selected && <ScheduleDetail s={selected} agent={agents.find(a => a.id === selected.agent)} health={health(selected)} me={me} isAdmin={isAdmin} inboxOn={inboxOn} repOn={repOn} onRetryReport={(rid) => retryReport(selected.id, rid)} run={run} setRun={setRun} ask0={ask} onClose={() => { setSel(null); setRun(null); setAsk(null); }} onEdit={() => setEdit({ ...selected })} onRun={() => runNow(selected)} onPause={(r) => pause(selected, r)} onResume={() => resume(selected)} onRetire={(r) => retire(selected, r)} />}
      {edit && <ScheduleEditor s={edit} agents={agents} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); open(id); }} />}
    </>
  );
}

function ScheduleDetail({ s, agent, health, me, isAdmin, inboxOn, repOn, onRetryReport, run, setRun, ask0, onClose, onEdit, onRun, onPause, onResume, onRetire }) {
  const I = window.Icons;
  const P = scPerms(s, me, isAdmin);
  const [ask, setAsk] = useState(ask0 || null); const [why, setWhy] = useState('');
  useEffect(() => { setAsk(ask0 || null); setWhy(''); }, [s.id, ask0]);
  useEffect(() => { const h = e => { if (e.key !== 'Escape') return; if (run) setRun(null); else onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [run]);
  const ok = s.runs.filter(r => r.status === 'ok').length;
  const nx = s.status === 'active' && !P.anomaly ? scNextTz(s.p, s.tz, 3) : [];
  const openRun = run && P.own ? s.runs.find(r => r.id === run && r.result) : null;
  const today = P.anomaly ? scToday(s) : 0;
  const dest = inboxOn ? (P.own ? 'En el detalle y en tu Bandeja' : 'En el detalle y en la Bandeja de ' + s.owner) : 'En el detalle de la tarea';
  const pausedBy = s.paused?.actor === window.MangoStore.actorEmail() ? 'ti' : s.paused?.actor || 'un administrador';
  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" style={{ width: openRun ? 640 : 520 }} role="dialog" aria-modal="true" aria-label={s.name}>
        <div className="mk-drawer-h">
          <span className="mc-ic lg">{P.anomaly ? <I.Zap size={20} /> : <I.Clock size={20} />}</span>
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{s.name}</div><div className="mk-meta" style={{ marginTop: 3 }}>{agent?.name} · {scSafeLabel(s)}</div></div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="mk-drawer-b" key={openRun ? openRun.id : 'detail'}>
          {openRun ? <ScResult s={s} r={openRun} agent={agent} rep={repOn && !!s.report} onRetry={() => onRetryReport(openRun.id)} onBack={() => setRun(null)} /> : <>
            {health && !s.autoPaused && <div className={'mc-alert ' + (health.tone === 'red' ? 'red' : 'amber')}><I.Warn size={14} /><div>{health.msg}.</div></div>}
            {s.status === 'paused' && !s.autoPaused && (P.adminPaused
              ? <div className="mc-alert amber"><I.Pause size={14} /><div><b>Pausada por {isAdmin ? pausedBy : 'un administrador'}:</b> no se ejecutará, ni a pedido, hasta que un administrador la reanude.{s.paused.reason && <div style={{ marginTop: 4 }}>Motivo: {s.paused.reason}</div>}</div></div>
              : <div className="mc-alert"><I.Pause size={14} /><div>{P.own ? 'Pausada: no se ejecutará hasta que la reanudes.' : 'Pausada por ' + s.owner + ': no se ejecutará hasta que la reanude.'}</div></div>)}
            {s.autoPaused && s.status === 'paused' && <div className="mc-alert red"><I.Lock size={14} /><div><b>Pausada automáticamente {window.fmtAgo(s.autoPaused.at)}.</b> {s.autoPaused.reason}. {s.autoPaused.kind === 'central' ? 'Solo se reanuda si vuelve a ser persona central; si no, retírala.' : 'Solo se reanuda si recupera el acceso; si no, retírala.'}</div></div>}
            {s.status === 'retired' && <div className="mc-alert"><I.Archive size={14} /><div>Retirada por {s.retired?.by}{s.retired?.reason ? ' · ' + s.retired.reason : ''}. No vuelve a ejecutarse; el historial se conserva.</div></div>}
            <MkSec title="Tarea">{P.own ? <div className="sc-task">{s.task}</div> : <div className="ap-reason sc-note"><I.Lock size={12} /><span>{'Solo ' + s.owner + ' ve la instrucción y los resultados: se obtienen con su acceso, como sus conversaciones.'}</span></div>}</MkSec>
            {P.anomaly ? <MkSec title="Disparador">
              <div className="mk-kv"><span>Arranca</span><span>{SC_ANOMALY}</span></div>
              <div className="mk-kv"><span>Tope</span><span>Hasta {SC_CAP} investigaciones por día</span></div>
              <div className="mk-kv"><span>Hoy</span><span style={{ textAlign: 'right', ...(today >= SC_CAP ? { color: 'var(--amber)' } : {}) }}>{today} de {SC_CAP} · se reinicia a las <span style={{ whiteSpace: 'nowrap' }}>{scResetAt()} (tu hora)</span></span></div>
              <div className="mk-kv"><span>Si llegan varias</span><span style={{ textAlign: 'right' }}>Una a la vez; la siguiente espera en cola</span></div>
            </MkSec> : <MkSec title="Programación">
              <div className="mk-kv"><span>Frecuencia</span><span>{scSafeLabel(s)}</span></div>
              <div className="mk-kv"><span>Zona horaria</span><span className="mono" style={{ fontSize: 12 }}>{s.tz}</span></div>
              <div className="mk-kv"><span>Cron</span><span className="mono" style={{ fontSize: 12 }}>{scCron(s.p)}</span></div>
              {nx.length > 0 && <div className="mk-kv"><span>Próximas · tu hora</span><span style={{ textAlign: 'right' }}>{nx.map(d => <div key={+d}>{scFmt(d)}</div>)}</span></div>}
            </MkSec>}
            <MkSec title="Entrega y control">
              <div className="mk-kv"><span>Resultado</span><span style={{ textAlign: 'right' }}>{dest} · solo {P.own ? 'tú lo ves' : s.owner + ' lo ve'}</span></div>
              {repOn && s.report && <div className="mk-kv"><span>Reporte</span><span style={{ textAlign: 'right' }}>PDF · {(SC_REPORT[s.report] || [''])[0]} · solo {P.own ? 'tú lo descargas' : s.owner + ' lo descarga'}</span></div>}
              <div className="mk-kv"><span>Se ejecuta como</span><span>{s.owner} · con su identidad y sus permisos</span></div>
              <div className="mk-kv"><span>Agente</span><span>{agent?.name} · usa su presupuesto</span></div>
              <div className="mk-kv"><span>Si {s.owner} pierde el acceso{P.anomaly ? ' o deja de ser central' : ''}</span><span>La tarea se pausa sola</span></div>
              <div className="mk-kv"><span>Acciones de escritura</span><span>Quedan como aprobación pendiente</span></div>
            </MkSec>
            <MkSec title={`Ejecuciones recientes · ${ok} de ${s.runs.length} completadas`}>
              {!P.own && s.runs.length > 0 && <p className="mk-meta" style={{ margin: '0 0 4px' }}>Los resultados solo los ve {s.owner}.</p>}
              {s.runs.length ? s.runs.slice(0, 12).map(r => <ScRunRow key={r.id} r={r} s={s} canSee={P.own} rep={repOn && !!s.report} onOpen={() => setRun(r.id)} onApproval={() => { onClose(); window.MangoNav?.('approvals'); }} />) : <div className="mk-meta">Aún no se ha ejecutado.</div>}
            </MkSec>
          </>}
        </div>
        {!openRun && (P.own || isAdmin) && s.status !== 'retired' && <div className="mc-foot row gap-2" style={{ flexWrap: 'wrap' }}>
          {ask ? <>
            {ask === 'pause' && <span className="ap-reason sc-note" style={{ flexBasis: '100%' }}><I.Info size={12} /><span>También frena a su dueño: solo un administrador la reanuda.</span></span>}
            <input className="input" style={{ flex: '1 1 200px' }} value={why} onChange={e => setWhy(e.target.value)} placeholder={ask === 'retire' ? 'Motivo del retiro (obligatorio)' : 'Motivo de la pausa (obligatorio)'} aria-label={ask === 'retire' ? 'Motivo del retiro' : 'Motivo de la pausa'} autoFocus />
            <button className="btn btn-sm" onClick={() => setAsk(null)}>Cancelar</button>
            <button className="btn btn-sm btn-primary" disabled={!why.trim()} onClick={() => { const w = why.trim(); const k = ask; setAsk(null); setWhy(''); if (k === 'retire') onRetire(w); else onPause(w); }}>{ask === 'retire' ? <><I.Archive size={12} /> Retirar</> : <><I.Pause size={12} /> Pausar</>}</button>
          </> : <>
            {P.own && !P.anomaly && <button className="btn btn-sm btn-primary" disabled={!!P.busy || !P.canRun} onClick={onRun}><I.Play size={12} /> {P.busy ? (P.busy.status === 'running' ? 'Ejecutando…' : 'En cola…') : 'Ejecutar ahora'}</button>}
            {P.canResume ? <button className="btn btn-sm" onClick={onResume}>Reanudar</button> : P.own && s.status === 'paused' && <button className="btn btn-sm" disabled>Reanudar</button>}
            {P.canPause && <button className="btn btn-sm" title={P.own ? undefined : 'También frena a su dueño: solo un administrador la reanuda'} onClick={() => P.own ? onPause(null) : setAsk('pause')}><I.Pause size={12} /> Pausar</button>}
            {P.own && <button className="btn btn-sm" disabled={!!s.autoPaused} onClick={onEdit}><I.Edit size={12} /> Editar</button>}
            <div style={{ flex: 1 }}></div>
            <button className="btn btn-sm btn-ghost" onClick={() => setAsk('retire')}><I.Archive size={12} /> Retirar</button>
            {P.own && P.adminPaused && <span className="ap-reason sc-note" style={{ flexBasis: '100%', order: 9 }}><I.Lock size={12} /><span>Un administrador la pausó: solo un administrador la reanuda.</span></span>}
            {!P.own && <span className="ap-reason sc-note" style={{ flexBasis: '100%', order: 9 }}><I.Lock size={12} /><span>{'Solo ' + s.owner + ' puede editarla' + (P.anomaly ? '' : ' o ejecutarla ahora') + ' (corre con su identidad). Como admin puedes pausarla, reanudar la pausa de un administrador o retirarla.'}</span></span>}
          </>}
        </div>}
      </aside>
    </div>
  );
}

function ScheduleEditor({ s, agents, onClose, onSaved }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const central = !!(S.ROLES[S.get().role] || {}).central;
  const inboxOn = !S.isSoon('inbox');
  const repSoon = !!S.get().avail;
  const usable = agents.filter(scCanUse);
  const opts = !s.agent || usable.some(x => x.id === s.agent) ? usable : [agents.find(x => x.id === s.agent), ...usable].filter(Boolean);
  const [f, setF] = useState({ trigger: 'schedule', ...s, report: !!s.report, tz: s.tz || 'America/Mexico_City', p: { freq: 'daily', hour: 9, min: 0, dow: 1, dom: 1, days: [1, 4], ...s.p } });
  const [tried, setTried] = useState(false);
  const setP = (patch) => setF(x => ({ ...x, p: { ...x.p, ...patch } }));
  const anomaly = f.trigger === 'anomaly';
  const a = agents.find(x => x.id === f.agent);
  const canRep = scReportable(a); const repT = scReportType(f.trigger);
  const nx = anomaly ? [] : scNextTz(f.p, f.tz, 3);
  const otherTz = !anomaly && scTzOff(f.tz) !== -new Date().getTimezoneOffset();
  const heavy = !anomaly && (f.p.freq === 'hourly' || f.p.freq === '15m');
  const noDays = !anomaly && f.p.freq === 'days' && !(f.p.days || []).length;
  const errs = [!f.name.trim() && 'Escribe un nombre', !f.agent && 'Elige un agente', !f.task.trim() && 'Describe la tarea', L.findSecret(f.task) && 'Hay un posible secreto en la tarea', noDays && 'Elige al menos un día'].filter(Boolean);
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const save = () => {
    setTried(true); if (errs.length) return;
    const rec = { name: f.name.trim(), agent: f.agent, task: f.task, trigger: f.trigger, p: f.p, deliver: 'inbox', report: repSoon ? (s.report || null) : (f.report && canRep ? repT : null), ...(anomaly ? { tz: null, cron: null, cronLabel: SC_ANOMALY } : { tz: f.tz, cron: scCron(f.p), cronLabel: scLabel(f.p) }) };
    const what = anomaly ? 'al detectar una anomalía de costo' : scLabel(f.p);
    if (s.isNew) { const id = 'sch-' + Date.now().toString(36).slice(-4); S.set({ schedules: [...S.get().schedules, { ...rec, id, status: 'active', runs: [], owner: S.actor() }] }); S.log('schedule.create', id, `Creó ${rec.name} · ${what}`); toast?.({ tone: 'success', msg: 'Schedule creado' }); onSaved(id); }
    else { S.set({ schedules: S.get().schedules.map(x => x.id === s.id ? { ...x, ...rec } : x) }); S.log('schedule.update', s.id, `Editó ${rec.name} · ${what}`, anomaly ? {} : { before: { frecuencia: scSafeLabel(s) }, after: { frecuencia: scLabel(f.p) } }); toast?.({ tone: 'success', msg: 'Cambios guardados' }); onSaved(s.id); }
  };
  const Lb = ({ children, htmlFor }) => <label htmlFor={htmlFor} style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 6 }}>{children}</label>;
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div className="card" role="dialog" aria-modal="true" aria-label={s.isNew ? 'Nuevo schedule' : 'Editar schedule'} onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '94vw', padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}>
        <div className="row between" style={{ padding: '18px 20px 4px' }}><div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-strong)' }}>{s.isNew ? 'Nuevo schedule' : 'Editar ' + s.name}</div><button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button></div>
        <div style={{ padding: '14px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
            <div><Lb htmlFor="sc-n">Nombre</Lb><input id="sc-n" className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus maxLength={48} /></div>
            <div><Lb htmlFor="sc-a">Agente</Lb><select id="sc-a" className="input" value={f.agent} disabled={!opts.length} aria-describedby="sc-a-h" onChange={e => setF({ ...f, agent: e.target.value })}>{opts.length ? opts.map(x => <option key={x.id} value={x.id}>{x.name}</option>) : <option value="">Sin agentes disponibles</option>}</select><div id="sc-a-h" className="mk-meta" style={{ marginTop: 5, fontSize: 12 }}>{opts.length ? 'Solo agentes publicados que puedes usar.' : 'No tienes agentes publicados que puedas usar.'}</div></div>
          </div>
          <div><Lb htmlFor="sc-t">Tarea</Lb><textarea id="sc-t" className="input" rows={3} value={f.task} onChange={e => setF({ ...f, task: e.target.value })} placeholder={anomaly ? 'Qué debe investigar el agente. Recibe la anomalía que la arrancó.' : 'Qué debe hacer el agente en cada ejecución'}></textarea></div>
          <div><Lb>Disparador</Lb>
            {s.isNew ? <>
              <div className="ab-seg" role="group" aria-label="Disparador"><button type="button" className={!anomaly ? 'is-on' : ''} onClick={() => setF({ ...f, trigger: 'schedule' })}>Por horario</button><button type="button" className={anomaly ? 'is-on' : ''} disabled={!central} aria-describedby={central ? undefined : 'sc-trg-why'} onClick={() => setF({ ...f, trigger: 'anomaly' })}>{SC_ANOMALY}</button></div>
              {!central && <div id="sc-trg-why" className="mk-meta" style={{ marginTop: 6, fontSize: 12 }}>Solo las personas centrales pueden suscribirse a las anomalías de costo.</div>}
            </> : <div className="sc-ro">{anomaly ? SC_ANOMALY : 'Por horario'}<span className="mk-meta"> · No se cambia al editar; para otro disparador, crea otra tarea.</span></div>}
            {anomaly && <div className="mc-alert" style={{ marginTop: 10, fontSize: 12.5 }}><I.Zap size={13} /><div><b>Hasta {SC_CAP} investigaciones por día.</b> Arranca sola cuando AWS publica una anomalía de costo y recibe sus datos. Una a la vez: si llega otra mientras investiga, espera en cola. Pasado el tope, las siguientes se omiten hasta el día siguiente (UTC).</div></div>}
          </div>
          {!anomaly && <div><Lb>Frecuencia</Lb>
            <div className="ab-seg">{SC_FREQ.map(([k, l]) => <button key={k} type="button" className={f.p.freq === k ? 'is-on' : ''} onClick={() => setP({ freq: k })}>{l}</button>)}</div>
            <div className="row gap-2" style={{ marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              {f.p.freq === 'days' && <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{SC_DOW.map((d, i) => { const on = (f.p.days || []).includes(i); return <button key={i} type="button" className={'tweak-chip ab-chip' + (on ? ' is-on' : '')} onClick={() => setP({ days: on ? f.p.days.filter(x => x !== i) : [...(f.p.days || []), i].sort() })}>{d.slice(0, 3)}</button>; })}</div>}
              {f.p.freq === 'weekly' && <select className="input" style={{ width: 'auto' }} value={f.p.dow} onChange={e => setP({ dow: +e.target.value })} aria-label="Día">{SC_DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}</select>}
              {f.p.freq === 'monthly' && <select className="input" style={{ width: 'auto' }} value={f.p.dom} onChange={e => setP({ dom: +e.target.value })} aria-label="Día del mes">{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>Día {i + 1}</option>)}</select>}
              {!['15m', 'hourly', '6h'].includes(f.p.freq) && <input type="time" className="input" style={{ width: 'auto' }} value={pad2(f.p.hour) + ':' + pad2(f.p.min)} onChange={e => { const [h, m] = e.target.value.split(':'); setP({ hour: +h, min: +m }); }} aria-label="Hora" />}
              <select className="input" style={{ width: 'auto' }} value={f.tz} onChange={e => setF({ ...f, tz: e.target.value })} aria-label="Zona horaria">{SC_TZ.map(([t]) => <option key={t}>{t}</option>)}</select>
            </div>
            <div className="mk-meta" style={{ marginTop: 8 }}>{scLabel(f.p)} · <span className="mono">{scCron(f.p)}</span></div>
            {nx.length > 0 && <div className="mk-meta" style={{ marginTop: 2 }}>Próximas, {scTzLabel(f.tz)}: {nx.map(d => scFmtTz(d, f.tz)).join(' · ')}{otherTz ? ' · la primera es ' + scFmt(nx[0]) + ' en tu hora' : ''}</div>}
            {heavy && <div className="mc-alert amber" style={{ marginTop: 8, fontSize: 12.5 }}><I.Warn size={13} /><div>{f.p.freq === '15m' ? 'Cada 15 minutos son ~2.880' : 'Cada hora son ~720'} ejecuciones al mes con el presupuesto de {a?.name}. Revisa que te alcance.</div></div>}
            {noDays && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>Elige al menos un día</div>}
          </div>}
          <div><Lb>Resultado</Lb>
            <div className="sc-ro">{inboxOn ? 'Queda en el detalle de la tarea y te llega a la Bandeja.' : 'Queda en el detalle de la tarea.'} Solo tú lo ves.</div>
            <div className="row gap-2" style={{ marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}><span className="mk-meta">También enviar a</span><window.Soon on><div className="ab-seg"><button type="button">Canal de Slack</button></div></window.Soon><window.Soon on><div className="ab-seg"><button type="button">Crear ticket</button></div></window.Soon></div>
          </div>
          <div><Lb>Reporte descargable</Lb>
            {repSoon ? <window.Soon on block><label className="sc-rep-opt"><input type="checkbox" disabled /><span><b>También un PDF con gráficos</b><span className="mk-meta">Para guardarlo o compartirlo fuera de Mango.</span></span></label></window.Soon> : <>
              <label className={'sc-rep-opt' + (canRep ? '' : ' is-off')}><input type="checkbox" checked={!!f.report && canRep} disabled={!canRep} aria-describedby="sc-rep-h" onChange={e => setF({ ...f, report: e.target.checked })} /><span><b>También un PDF · {SC_REPORT[repT][0]}</b><span className="mk-meta">{SC_REPORT[repT][1]}</span></span></label>
              <div id="sc-rep-h" className="mk-meta" style={{ marginTop: 6, fontSize: 12 }}>{!canRep ? (a ? a.name + ' no consulta costos: el reporte solo existe para agentes que leen Cost Explorer o la facturación.' : 'Elige un agente.') : f.report ? 'No hace falta pedirlo en la tarea: Mango le pide al agente los datos y arma el PDF con una plantilla fija. Solo tú lo descargas; se guarda 90 días, como el resultado.' : 'El tipo lo fija el disparador: por horario, resumen de costos; por anomalía, investigación de la anomalía.'}</div>
            </>}
          </div>
          <div className="mc-alert" style={{ fontSize: 12.5 }}><I.User size={13} /><div>Se ejecuta con tu identidad y tus permisos (no con los del agente) y usa {a ? 'el presupuesto de ' + a.name : 'el presupuesto del agente'}. Si pierdes el acceso al agente{anomaly ? ' o dejas de ser persona central' : ''}, la tarea se pausa sola. Si necesita escribir, se crea una aprobación pendiente.</div></div>
        </div>
        {tried && errs.length > 0 && <div style={{ padding: '0 20px 10px', fontSize: 12.5, color: 'var(--red)' }}>{errs.join(' · ')}</div>}
        <div className="row gap-2" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" onClick={save}>{s.isNew ? 'Crear schedule' : 'Guardar'}</button></div>
      </div>
    </div>
  );
}

Object.assign(window, { SchedulesView });
