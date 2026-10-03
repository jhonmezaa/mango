// Dashboard view — minimal analytics home
function Dashboard({ agents, tickets, setView, openChat }) {
  const I = window.Icons;
  const [period, setPeriod] = React.useState(() => localStorage.getItem('mango-dash-period') || '30d');
  const [gran, setGran] = React.useState('day');
  const [compare, setCompare] = React.useState(true);
  React.useEffect(() => { localStorage.setItem('mango-dash-period', period); }, [period]);
  const pending = window.useMango(s => s.approvals.filter(a => a.status === 'pending').length);
  const budgets = window.useMango(s => s.budgets);
  const toast = window.useToast?.();
  const g = gran === 'week' && period === '7d' ? 'day' : gran;
  const spend = React.useMemo(() => window.makeSeries({ seed: 3, period, gran: g, base: 410, growth: 0.9, noise: 0.35, shape: 'spiky' }), [period, g]);
  const calls = React.useMemo(() => window.makeSeries({ seed: 7, period, gran: g, base: 1840, growth: 0.7, noise: 0.18 }), [period, g]);
  const resolved = React.useMemo(() => window.makeSeries({ seed: 11, period, gran: g, base: 38, growth: 0.5, noise: 0.3 }), [period, g]);
  const latency = React.useMemo(() => window.makeSeries({ seed: 5, period, gran: 'day', base: 1450, growth: 0.25, noise: 0.12, shape: 'down' }), [period]);
  const byStatus = (st) => agents.filter(a => a.status === st).length;
  const hot = budgets.filter(b => b.scope === 'agent').map(b => ({ b, p: Math.round(b.spent / b.limit * 100), a: agents.find(x => x.id === b.target) })).sort((x, y) => y.p - x.p).slice(0, 4);
  const exp = (t) => toast?.({ tone: 'info', msg: t + ' exportado a CSV' });
  const hour = new Date().getHours();
  return (
    <>
      <Topbar crumbs={["Inicio"]} />
      <div className="content">
        <div className="page-wrap">
          <div className="row between" style={{ alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
            <div>
              <h1 className="page-title">{hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches'}, {window.MangoStore.actor()}</h1>
              <p className="page-subtitle">Así van tus agentes en el periodo seleccionado.</p>
            </div>
            {pending > 0 && (
              <button className="notice-pill" onClick={() => setView('approvals')}><I.Warn size={14} style={{ color: 'var(--red)' }} /><span>Responder {pending} aprobaciones</span></button>
            )}
          </div>
          <div style={{ marginBottom: 20 }}>
            <window.FilterPills period={period} setPeriod={setPeriod} gran={gran} setGran={setGran} compare={compare} setCompare={setCompare} />
          </div>
          <div className="metric-grid">
            <window.MetricCard title="Gasto en Bedrock" info="Costo de invocaciones de modelos, incluye tokens de entrada y salida" series={spend} money compare={compare} goodWhen="down" onMore={() => setView('costs')} onExport={() => exp('Gasto')} />
            <window.ListCard title="Estado de agentes" info="Heartbeat cada 5 minutos" updated="Actualizado hace 1 min" more="Ver todos" onMore={() => setView('marketplace')} rows={[
              { color: 'var(--green)', label: 'En línea', value: byStatus('online') },
              { color: 'var(--amber)', label: 'Iniciando', value: byStatus('warmup') },
              { color: 'var(--red)', label: 'Degradados', value: byStatus('degraded') },
              { color: 'var(--text-dim)', label: 'Fuera de línea', value: byStatus('offline') },
            ]} />
            <window.MetricCard title="Invocaciones" info="Mensajes procesados por todos los agentes" series={calls} compare={compare} onMore={() => setView('observability')} onExport={() => exp('Invocaciones')} />
            <window.MetricCard title="Tickets resueltos" info="Tickets cerrados por agentes sin intervención manual" series={resolved} compare={compare} onMore={() => setView('tickets')} onExport={() => exp('Tickets')} />
            <window.MetricCard title="Latencia p95" info="Tiempo hasta el primer token, percentil 95" series={latency} compare={compare} format="avg" goodWhen="down" onMore={() => setView('observability')} onExport={() => exp('Latencia')} />
            <window.ListCard title="Presupuestos cerca del límite" updated="Actualizado 12:00" more="Ver presupuestos" onMore={() => setView('budgets')} rows={hot.map(({ b, p, a }) => ({
              label: a ? a.name : b.target, sub: (window.GovKit ? window.GovKit.usd(b.spent) + ' de ' + window.GovKit.usd(b.limit) : b.spent + ' de ' + b.limit), value: p + '%',
              tone: p >= 100 ? 'var(--red)' : p >= b.warn ? 'var(--amber)' : 'var(--text)', color: p >= 100 ? 'var(--red)' : p >= b.warn ? 'var(--amber)' : 'var(--green)',
            }))} />
          </div>
        </div>
      </div>
    </>
  );
}

function Widget({ title, action, children, span }) {
  return (
    <div className="card" style={{padding: 0, gridColumn: span ? `span ${span}` : undefined, display:'flex', flexDirection:'column', minHeight: 260}}>
      <div style={{padding:'12px 14px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <div style={{fontSize: 12.5, fontWeight: 600}}>{title}</div>
        {action}
      </div>
      <div style={{flex: 1, overflow:'auto'}}>{children}</div>
    </div>
  );
}

function HealthWidget({ agents }) {
  const I = window.Icons;
  return (
    <Widget title="Salud de agentes" action={<span className="mono" style={{fontSize: 10.5, color:'var(--text-dim)'}}>heartbeat · 5m</span>}>
      <div>
        {agents.slice(0, 7).map(a => {
          const Ag = I[a.icon];
          return (
            <div key={a.id} style={{display:'flex', alignItems:'center', gap: 10, padding:'9px 14px', borderBottom:'1px solid var(--border)'}}>
              <span style={{width: 22, height: 22, borderRadius: 5, background: a.iconBg, color: a.iconColor, display:'flex', alignItems:'center', justifyContent:'center'}}>
                <Ag size={12} />
              </span>
              <span style={{fontSize: 12.5, flex: 1, fontWeight: 500}}>{a.name}</span>
              <span className="mono" style={{fontSize: 10.5, color:'var(--text-dim)'}}>
                {a.status === 'online' ? '42ms' : a.status === 'warmup' ? '—' : a.status === 'degraded' ? '1.2s' : '—'}
              </span>
              <span className={`dot dot-${a.status === 'online' ? 'green' : a.status === 'warmup' ? 'amber' : a.status === 'degraded' ? 'red' : 'gray'} ${a.status === 'online' ? 'pulse' : ''}`} />
            </div>
          );
        })}
      </div>
    </Widget>
  );
}

function BudgetsWidget({ agents }) {
  const sorted = [...agents].sort((a,b) => (b.budget/b.budgetMax) - (a.budget/a.budgetMax)).slice(0, 7);
  return (
    <Widget title="Budget por agente" action={<span className="mono" style={{fontSize: 10.5, color:'var(--text-dim)'}}>USD · mensual</span>}>
      <div style={{padding:'6px 14px'}}>
        {sorted.map(a => {
          const pct = Math.min(100, Math.round(a.budget / a.budgetMax * 100));
          const warn = pct >= 80;
          const danger = pct >= 98;
          return (
            <div key={a.id} style={{padding:'8px 0', borderBottom:'1px solid var(--border)'}}>
              <div style={{display:'flex', justifyContent:'space-between', marginBottom: 5, fontSize: 12}}>
                <span>{a.name}</span>
                <span className="mono" style={{color: danger ? 'var(--red)' : warn ? 'var(--amber)' : 'var(--text-dim)', fontSize: 11}}>
                  ${a.budget.toLocaleString()} / ${a.budgetMax.toLocaleString()} · {pct}%
                </span>
              </div>
              <div style={{height: 4, background:'var(--border)', borderRadius: 2, overflow:'hidden', position:'relative'}}>
                <div style={{width: pct+'%', height:'100%', background: danger ? 'var(--red)' : warn ? 'var(--amber)' : 'var(--accent)'}} />
                <div style={{position:'absolute', left: '80%', top: 0, bottom: 0, width: 1, background:'var(--border-strong)'}} />
              </div>
            </div>
          );
        })}
      </div>
    </Widget>
  );
}

function TicketsWidget({ tickets, setView }) {
  const I = window.Icons;
  const recent = tickets.slice(0, 7);
  return (
    <Widget title="Tickets recientes" action={<button className="btn btn-ghost btn-sm" onClick={() => setView('tickets')}>Ver todos <I.ArrowRight size={11} /></button>}>
      <div>
        {recent.map(t => (
          <div key={t.id} style={{display:'flex', alignItems:'center', gap: 10, padding:'9px 14px', borderBottom:'1px solid var(--border)'}}>
            <span className="mono" style={{fontSize: 10.5, color:'var(--text-dim)', width: 60}}>{t.id}</span>
            <span style={{fontSize: 12.5, flex: 1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{t.title}</span>
            <StatusPill status={t.status} />
            <span style={{fontSize: 10.5, color:'var(--text-dim)', width: 32, textAlign:'right'}}>{t.age}</span>
          </div>
        ))}
      </div>
    </Widget>
  );
}

function ChatPreviewWidget({ agents, openChat }) {
  const a = agents[0];
  return (
    <Widget title="Chat activo" action={<span className="badge badge-green"><span className="dot dot-green pulse" /> streaming</span>}>
      <div style={{padding: 14, display:'flex', flexDirection:'column', gap: 10, height:'100%'}}>
        <div className="row gap-2">
          <span style={{width: 22, height: 22, borderRadius: 5, background: a.iconBg, color: a.iconColor, display:'flex', alignItems:'center', justifyContent:'center'}}>
            {React.createElement(window.Icons[a.icon], {size: 12})}
          </span>
          <span style={{fontSize: 12.5, fontWeight: 500}}>{a.name}</span>
          <span className="mono" style={{fontSize: 10.5, color:'var(--text-dim)', marginLeft:'auto'}}>conv · 4a8f</span>
        </div>
        <div style={{flex: 1, fontSize: 12, color:'var(--text-muted)', lineHeight: 1.55}}>
          <div style={{padding:'6px 10px', background:'var(--accent-soft)', color:'var(--accent-ink)', borderRadius: 14, display:'inline-block', fontSize: 12, marginBottom: 8}}>
            drivers de costo de octubre?
          </div>
          <div style={{color:'var(--text)'}}>
            Analizando con Cost Explorer. Detecté 3 drivers principales: <span className="mono">EC2-Other +18%</span>, <span className="mono">S3 Standard +11%</span>, y <span className="mono">Bedrock +240%</span><span style={{background:'var(--accent)', color:'var(--accent-ink)', marginLeft: 1}}>|</span>
          </div>
        </div>
        <button className="btn btn-sm" style={{alignSelf:'flex-start'}} onClick={() => openChat(a.id)}>Abrir conversación</button>
      </div>
    </Widget>
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
