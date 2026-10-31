// Inicio. Alcance según la cuenta: organización (admin o finops-central), área (bu-lead) o personal (resto).
function dashAgo(at) {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'Actualizado hace unos segundos';
  const m = Math.floor(s / 60); if (m < 60) return 'Actualizado hace ' + (m === 1 ? '1 minuto' : m + ' minutos');
  const h = Math.floor(m / 60); return 'Actualizado hace ' + (h === 1 ? '1 hora' : h + ' horas');
}
function dashSince(series, since, noStart) {
  if (noStart) return { ...series, cur: series.cur.map(() => null), prev: series.prev.map(() => null) };
  if (!since) return series;
  return { ...series, cur: series.cur.map((v, i) => series.dates[i] < since ? null : v), prev: series.prev.map((v, i) => series.prevDates[i] < since ? null : v) };
}
function DashSkeleton({ n }) {
  return (
    <div className="metric-grid" role="status" aria-busy="true" aria-label="Cargando Inicio">
      {Array.from({ length: n }, (_, i) => (
        <section key={i} className="card metric-card" aria-hidden="true" style={{ gap: 10 }}>
          <span className="skeleton" style={{ width: 140, height: 14 }}></span>
          <span className="skeleton" style={{ width: 120, height: 26 }}></span>
          <span className="skeleton" style={{ width: 160, height: 12 }}></span>
          <span className="skeleton" style={{ height: 200, marginTop: 8, borderRadius: 8 }}></span>
        </section>
      ))}
    </div>
  );
}

function Dashboard({ agents, setView }) {
  const I = window.Icons, S = window.MangoStore;
  const [period, setPeriod] = React.useState(() => localStorage.getItem('mango-dash-period') || '30d');
  const [gran, setGran] = React.useState('day');
  const [compare, setCompare] = React.useState(true);
  React.useEffect(() => { localStorage.setItem('mango-dash-period', period); }, [period]);
  const role = window.useMango(s => s.role);
  const avail = window.useMango(s => s.avail);
  const sim = window.useMango(s => s.simDash);
  const sinceMode = window.useMango(s => s.simDashSince);
  const noName = window.useMango(s => s.simDashNoName);
  const pending = window.useMango(s => s.approvals.filter(a => a.status === 'pending').length);
  const budgets = window.useMango(s => s.budgets);
  const toast = window.useToast?.();
  const [retrying, setRetrying] = React.useState(false);
  const [loadedAt, setLoadedAt] = React.useState(Date.now());
  const [, tick] = React.useState(0);
  React.useEffect(() => { const t = setInterval(() => tick(x => x + 1), 15000); return () => clearInterval(t); }, []);
  React.useEffect(() => { if (!sim) setLoadedAt(Date.now()); }, [sim, period, gran]);
  const R = S.ROLES[role] || {};
  const scope = R.admin || R.central ? 'org' : R.area ? 'area' : 'self';
  const k = scope === 'org' ? 1 : scope === 'area' ? 0.18 : 0.02;
  const g = gran === 'week' && period === '7d' ? 'day' : gran;
  const noStart = sinceMode === 'none';
  const since = React.useMemo(() => { if (!sinceMode || sinceMode === 'none') return null; const d = new Date(window.CHART_TODAY); d.setDate(d.getDate() - (sinceMode === '12d' ? 11 : 0)); return d; }, [sinceMode]);
  const spend = React.useMemo(() => dashSince(window.makeSeries({ seed: 3, period, gran: g, base: 410 * k, growth: 0.9, noise: 0.35, shape: 'spiky' }), since, noStart), [period, g, k, since, noStart]);
  const calls = React.useMemo(() => dashSince(window.makeSeries({ seed: 7, period, gran: g, base: 1840 * k, growth: 0.7, noise: 0.18 }), since, noStart), [period, g, k, since, noStart]);
  const resolved = React.useMemo(() => window.makeSeries({ seed: 11, period, gran: g, base: 38, growth: 0.5, noise: 0.3 }), [period, g]);
  const latency = React.useMemo(() => window.makeSeries({ seed: 5, period, gran: 'day', base: 1450, growth: 0.25, noise: 0.12, shape: 'down' }), [period]);
  const byStatus = (st) => agents.filter(a => a.status === st).length;
  const usd = (v) => window.GovKit ? window.GovKit.usd(v) : 'USD ' + v;
  const exp = () => toast?.({ tone: 'info', msg: 'Exportado a CSV' });
  const updated = dashAgo(loadedAt);
  const more = avail ? null : 'Ver detalles';
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  const name = noName ? null : S.actor(); // D102: con nombre «{saludo}, {nombre}»; sin nombre, el saludo solo
  const area = R.area; // el identificador del área: el producto no tiene otro nombre visible
  const sub = scope === 'org' ? 'Así va Mango en toda la organización en el periodo seleccionado.' : scope === 'area' ? 'Así va tu área, ' + area + ', en el periodo seleccionado.' : 'Así va tu uso de Mango en el periodo seleccionado.';
  const whose = scope === 'org' ? ' de toda la organización' : scope === 'area' ? ' de las personas de tu área' : '';
  const spendInfo = 'Costo de Bedrock en USD' + whose + (scope === 'self' ? ' de tus mensajes' : '') + ': las respuestas de los agentes y el título de las conversaciones nuevas.';
  const callsInfo = scope === 'self' ? 'Tus mensajes que llegaron a un agente, en el chat, en el Playground y en tus tareas programadas.' : 'Turnos' + whose + ' que llegaron a un agente, en el chat, en el Playground y en las tareas programadas.';
  const showPending = pending > 0 && S.can('approval.decide');

  const hot = budgets.filter(b => b.scope === 'agent').map(b => ({ b, p: Math.round(b.spent / b.limit * 100), a: agents.find(x => x.id === b.target) })).sort((x, y) => y.p - x.p).slice(0, 4);
  const tone = (p, w) => ({ tone: p >= 100 ? 'var(--red)' : p >= w ? 'var(--amber)' : 'var(--text)', color: p >= 100 ? 'var(--red)' : p >= w ? 'var(--amber)' : 'var(--green)' });
  const mine = { spent: 3.2, limit: 20, warn: 80 }; const mp = Math.round(mine.spent / mine.limit * 100);
  const budgetCard = R.admin
    ? <window.ListCard key="bud" title="Presupuestos cerca del límite" info="Los cuatro agentes más cerca de su límite del mes." updated={updated} more="Ver presupuestos" onMore={() => setView('budgets')} rows={hot.map(({ b, p, a }) => ({ label: a ? a.name : b.target, sub: usd(b.spent) + ' de ' + usd(b.limit), value: p + '%', ...tone(p, b.warn) }))} />
    : <window.ListCard key="bud" title="Tu presupuesto" info={scope === 'area' ? 'Mango no tiene presupuestos por área. Este es tu límite personal del mes.' : 'Tu límite personal del mes, para todos los agentes.'} updated={updated} rows={[{ label: 'Límite personal', sub: usd(mine.spent) + ' de ' + usd(mine.limit), value: mp + '%', ...tone(mp, mine.warn) }]} />;
  const cards = [
    <window.MetricCard key="spend" title="Gasto en Bedrock" info={spendInfo} series={spend} money compare={compare} goodWhen="down" since={since} noStart={noStart} updated={updated} more={more} onMore={() => setView('costs')} onExport={exp} />,
    !avail && <window.ListCard key="health" title="Estado de agentes" info="Heartbeat cada 5 minutos" updated={updated} more="Ver todos" onMore={() => setView('marketplace')} rows={[
      { color: 'var(--green)', label: 'En línea', value: byStatus('online') },
      { color: 'var(--amber)', label: 'Iniciando', value: byStatus('warmup') },
      { color: 'var(--red)', label: 'Degradados', value: byStatus('degraded') },
      { color: 'var(--text-dim)', label: 'Fuera de línea', value: byStatus('offline') },
    ]} />,
    <window.MetricCard key="calls" title="Invocaciones" info={callsInfo} series={calls} compare={compare} since={since} noStart={noStart} updated={updated} more={more} onMore={() => setView('observability')} onExport={exp} />,
    !avail && <window.MetricCard key="tickets" title="Tickets resueltos" info="Tickets cerrados por agentes sin intervención manual" series={resolved} compare={compare} updated={updated} onMore={() => setView('tickets')} onExport={exp} />,
    !avail && <window.MetricCard key="lat" title="Latencia p95" info="Tiempo hasta el primer token, percentil 95" series={latency} compare={compare} format="avg" goodWhen="down" updated={updated} onMore={() => setView('observability')} onExport={exp} />,
    budgetCard,
  ].filter(Boolean);
  const retry = () => { setRetrying(true); setTimeout(() => { setRetrying(false); S.set({ simDash: null }); }, 900); };
  const loading = sim === 'loading' || retrying;

  return (
    <>
      <Topbar crumbs={["Inicio"]} />
      <div className="content">
        <div className="page-wrap">
          <div className="row between" style={{ alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
            <div style={{ minWidth: 0 }}>
              <h1 className="page-title">{name ? hello + ', ' + name : hello}</h1>
              <p className="page-subtitle">{sub}</p>
            </div>
            {showPending && (
              <button className="notice-pill" onClick={() => setView('approvals')}><I.Warn size={14} style={{ color: 'var(--red)' }} /><span>Responder {pending} aprobaciones</span></button>
            )}
          </div>
          <div style={{ marginBottom: 20 }}>
            <window.FilterPills period={period} setPeriod={setPeriod} gran={gran} setGran={setGran} compare={compare} setCompare={setCompare} />
          </div>
          {loading ? <DashSkeleton n={cards.length} />
            : sim === 'error' ? (
              <div className="card dash-error" role="alert">
                <I.Warn size={16} style={{ color: 'var(--red)', marginTop: 2, flexShrink: 0 }} />
                <div><h2>No se pudo cargar Inicio</h2><p>Inténtalo de nuevo en unos segundos.</p></div>
                <button className="btn" onClick={retry}>Reintentar</button>
              </div>
            ) : <div className="metric-grid">{cards}</div>}
        </div>
      </div>
    </>
  );
}

function StatusPill({ status }) {
  const map = {
    open: { l: "Abierto", cls: "badge" },
    in_progress: { l: "En curso", cls: "badge-blue" },
    needs_approval: { l: "Por aprobar", cls: "badge-amber" },
    done: { l: "Resuelto", cls: "badge-green" },
  };
  const s = map[status] || { l: status, cls: "badge" };
  return <span className={`badge ${s.cls}`}>{s.l}</span>;
}

Object.assign(window, { Dashboard, StatusPill });
