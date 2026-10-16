// Schedules · programación con zona horaria, estados y motivos de cada ejecución, resultado, datos de ejemplo
const SC_FREQ = [['15m', 'Cada 15 min'], ['hourly', 'Cada hora'], ['6h', 'Cada 6 h'], ['daily', 'Diario'], ['weekdays', 'Lunes a viernes'], ['days', 'Días específicos'], ['weekly', 'Semanal'], ['monthly', 'Mensual']];
const SC_DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const SC_TZ = [['America/Mexico_City', 'Ciudad de México'], ['America/Bogota', 'Bogotá'], ['America/Sao_Paulo', 'São Paulo'], ['UTC', 'UTC']];
const SC_RUN = { ok: ['Completada', 'var(--green)'], failed: ['Fallida', 'var(--red)'], skipped: ['Omitida', 'var(--text-dim)'], approval: ['Espera aprobación', 'var(--amber)'], queued: ['En cola', 'var(--text-muted)'], running: ['Ejecutando…', 'var(--accent-ink)'] };
const SC_REASON = { budget: 'Presupuesto agotado', access: 'El creador perdió el acceso al agente', central: 'El creador dejó de ser persona central', overlap: 'Otra ejecución seguía en curso', cap: 'Se alcanzó el tope de investigaciones del día', dup: 'Esta anomalía ya se investigó', agent: 'El agente falló', tool: 'Falló una tool', timeout: 'Se agotó el tiempo máximo de la ejecución' };
const SC_CAP = 5;
const SC_ANOMALY = 'Al detectar una anomalía de costo';
const SC_STARTED = ['ok', 'failed', 'approval', 'running'];
const pad2 = (n) => String(n).padStart(2, '0');
const scUsd = (n) => 'USD ' + (n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
const scLabel = (p) => { const t = pad2(p.hour) + ':' + pad2(p.min); const dl = (p.days || []).map(d => SC_DOW[d]); return ({ '15m': 'Cada 15 minutos', days: (dl.length > 1 ? dl.slice(0, -1).join(', ') + ' y ' + dl[dl.length - 1] : dl[0] || '').replace(/^./, c => c.toUpperCase()) + ` · ${t}`, hourly: `Cada hora, al minuto ${p.min}`, '6h': 'Cada 6 horas', daily: `Todos los días · ${t}`, weekdays: `Lunes a viernes · ${t}`, weekly: `Cada ${SC_DOW[p.dow]} · ${t}`, monthly: `Día ${p.dom} de cada mes · ${t}` })[p.freq]; };
const scSafeLabel = (s) => { if (s.trigger === 'anomaly') return SC_ANOMALY; const l = scLabel(s.p); return /undefined|NaN/.test(l) ? (s.cronLabel || s.cron) : l; };
const scPerMonth = (p) => ({ '15m': 2880, days: (p.days || []).length * 4.3, hourly: 720, '6h': 120, daily: 30, weekdays: 22, weekly: 4.3, monthly: 1 })[p.freq];
function scNext(p, n = 3, from = new Date()) {
  const out = []; const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 40 && out.length < n; i++) {
    const ok = p.freq === '15m' ? d.getMinutes() % 15 === 0 : d.getMinutes() === p.min && (p.freq === 'hourly' || (p.freq === '6h' ? d.getHours() % 6 === 0 : d.getHours() === p.hour)) && (p.freq !== 'days' || (p.days || []).includes(d.getDay())) &&
      (p.freq !== 'weekdays' || (d.getDay() > 0 && d.getDay() < 6)) && (p.freq !== 'weekly' || d.getDay() === p.dow) && (p.freq !== 'monthly' || d.getDate() === p.dom);
    if (ok) out.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}
const scFmt = (d) => d.toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
// Zona horaria: minutos de adelanto respecto a UTC. Las próximas se calculan en la zona de la tarea y se devuelven como instantes reales.
const SC_TZF = {};
const scTzOff = (tz) => {
  if (!tz) return -new Date().getTimezoneOffset();
  try {
    const f = SC_TZF[tz] || (SC_TZF[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }));
    const p = {}; f.formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(Date.now() / 6e4) * 6e4) / 6e4);
  } catch (e) { return -new Date().getTimezoneOffset(); }
};
const scNextTz = (p, tz, n = 3) => { const delta = scTzOff(tz) + new Date().getTimezoneOffset(); return scNext(p, n, new Date(Date.now() + delta * 6e4)).map(d => new Date(d.getTime() - delta * 6e4)); };
const scFmtTz = (d, tz) => { try { return d.toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }); } catch (e) { return scFmt(d); } };
const scTzLabel = (tz) => tz === 'UTC' ? 'en UTC' : 'hora de ' + ((SC_TZ.find(x => x[0] === tz) || [])[1] || tz);
// Tope diario de investigaciones: el día es UTC, como las fechas de AWS. Cuentan las que arrancaron, no las omitidas.
const scDayUTC = (k = 0) => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + k); };
const scToday = (s) => s.runs.filter(r => SC_STARTED.includes(r.status) && new Date(r.at).getTime() >= scDayUTC(0)).length;
const scResetAt = () => new Date(scDayUTC(1)).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
const scBusy = (s) => s.runs.find(r => r.status === 'running' || r.status === 'queued');
const scRange = (a, b) => { const o = { day: 'numeric', month: 'short', timeZone: 'UTC' }; const A = new Date(a), B = new Date(b || a); const fa = A.toLocaleDateString('es-MX', o), fb = B.toLocaleDateString('es-MX', o); if (fa === fb) return fb; return A.getUTCMonth() === B.getUTCMonth() ? A.getUTCDate() + '–' + fb : fa + ' – ' + fb; };
const scReason = (r) => r.reason ? (SC_REASON[r.reason] || 'No se pudo completar') + (r.tool ? ' · ' + r.tool : '') : null;
const scSummary = (r) => (r.result?.report || '').split('\n').map(x => x.replace(/^#+\s*/, '').replace(/\*\*|`/g, '').trim()).find(Boolean) || 'Terminó sin texto.';
function scCanUse(a) {
  const S = window.MangoStore; const role = S.get().role;
  if (!a || a.retired || a.status === 'retired') return false;
  if (role !== 'user' && role !== 'creator') return true;
  const sh = window.sharesOf ? window.sharesOf(a) : { groups: [] }; const g = S.ROLES[role].groups;
  return !!sh.everyone || (sh.groups || []).some(x => g.includes(x.id)) || (sh.users || []).some(u => (u.email || u) === S.actorEmail());
}
// Reglas: solo el dueño edita y ejecuta ahora; la pausa de un admin frena también al dueño y solo un admin la levanta.
function scPerms(s, me, isAdmin) {
  const own = s.owner === me; const anomaly = s.trigger === 'anomaly';
  const adminPaused = s.status === 'paused' && s.paused?.by === 'admin';
  const live = s.status !== 'retired' && !s.autoPaused;
  return { own, anomaly, adminPaused, busy: scBusy(s),
    canRun: own && !anomaly && live && !adminPaused,
    canResume: live && s.status === 'paused' && (adminPaused ? isAdmin : own),
    canPause: live && (s.status !== 'paused' ? (own || isAdmin) : (isAdmin && !own && !adminPaused)) };
}

function scResultFor(s, j = 0, an = null) {
  if (an) return {
    steps: [{ text: `Recibí la anomalía de ${an.service} (${scRange(an.from, an.to)}). Busco qué cuenta y tipo de uso la explican.`, tool: 'get_anomalies' }, { text: 'Comparo con las dos semanas anteriores.', tool: 'get_cost_and_usage' }],
    report: `## Anomalía en ${an.service} · ${scRange(an.from, an.to)}\n\n**Impacto:** ${scUsd(an.impact)} sobre lo esperado (+${Math.round(an.impact / an.expected * 100)}%).\n\n**Causa probable:** más uso de \`${an.usage}\` en la cuenta \`${an.account}\`.\n\n| Tipo de uso | Esperado | Real |\n|---|---|---|\n| ${an.usage} | ${scUsd(an.expected)} | ${scUsd(an.expected + an.impact)} |\n\n**Siguiente paso:** confirmar con el equipo dueño de la cuenta si el aumento fue intencional.` };
  if (s.id === 'sch-01') { const pct = 61 + (j * 3) % 15; return {
    steps: [{ text: 'Voy a consultar el consumo del presupuesto del mes.', tool: 'get_budgets' }, { text: 'Ahora reviso el gasto por servicio para ver qué lo mueve.', tool: 'get_cost_and_usage' }],
    report: `## Presupuesto del mes: ${pct}% consumido\n\nVa en **${scUsd(30 * pct)}** de ${scUsd(3000)}, por debajo del 80%: no hace falta avisar.\n\n| Servicio | Gasto | vs. semana anterior |\n|---|---|---|\n| Amazon EC2 | ${scUsd(912.4)} | +4% |\n| Amazon RDS | ${scUsd(488.1)} | −2% |\n| Amazon S3 | ${scUsd(231.75)} | +1% |\n\nA este ritmo cerraría el mes en **${scUsd(30 * (pct + 18))}** (${pct + 18}%).` }; }
  if (s.id === 'sch-02') return {
    steps: [{ text: 'Consulto la utilización de CPU y memoria de los últimos 14 días.', tool: 'get_ec2_instance_recommendations' }],
    report: `## Rightsizing: 3 instancias para cambiar\n\nCon 14 días de datos, estas instancias usan menos del 20% de CPU:\n\n| Instancia | Tipo actual | Recomendado | Ahorro al mes |\n|---|---|---|---|\n| \`i-0a1b2c3d\` | m6i.2xlarge | m6i.xlarge | ${scUsd(140.16)} |\n| \`i-0e4f5a6b\` | r6g.xlarge | r6g.large | ${scUsd(73.58)} |\n| \`i-0c7d8e9f\` | c6i.4xlarge | c6i.2xlarge | ${scUsd(248.2)} |\n\nAhorro estimado: **${scUsd(461.94)} al mes**. No se cambió nada: cambiar el tipo de una instancia necesita aprobación.` };
  return { steps: [], report: `## ${s.name}\n\nSin novedades respecto a la ejecución anterior.` };
}

function scAnomalyTask() {
  const now = Date.now(), d0 = scDayUTC(0), d1 = scDayUTC(-1), d2 = scDayUTC(-2);
  const T = (ms) => new Date(ms).toISOString();
  const at0 = (min, sec = 0) => T(Math.max(now - min * 6e4 + sec * 1e3, d0 + 6e4 + sec * 1e3));
  const at1 = (h, m = 0, sec = 0) => T(d1 + h * 36e5 + m * 6e4 + sec * 1e3);
  const an = (id, service, account, usage, impact, expected, from, to) => ({ id, service, account, usage, impact, expected, from: T(from), to: T(to) });
  const s = { id: 'sch-10', name: 'Investigar anomalías de costo', agent: 'fin-01', trigger: 'anomaly', owner: 'Usuario 1', status: 'active', deliver: 'inbox', tz: null, p: { freq: 'daily', hour: 9, min: 0 }, cron: null, cronLabel: SC_ANOMALY,
    task: 'Cuando AWS detecte una anomalía de costo, identifica qué cuenta, servicio y tipo de uso la explican, compárala con las dos semanas anteriores y propone el siguiente paso.' };
  const A = {
    s3: an('AN-7f3a', 'Amazon S3', '111111111111', 'TimedStorage-ByteHrs', 86.4, 231.75, d1, d0),
    rds: an('AN-81c2', 'Amazon RDS', '222222222222', 'InstanceUsage:db.r6g.xlarge', 154.2, 488.1, d1, d0),
    ec2: an('AN-8d09', 'Amazon EC2', '111111111111', 'BoxUsage:m6i.2xlarge', 412.3, 640, d1, d0),
    y1: an('AN-6a10', 'AWS Lambda', '333333333333', 'Request', 38.9, 120.4, d2, d1),
    y2: an('AN-6b44', 'Amazon CloudWatch', '222222222222', 'DataProcessing-Bytes', 61.2, 95, d2, d1),
    y3: an('AN-6c02', 'Amazon EC2', '333333333333', 'DataTransfer-Out-Bytes', 129.75, 310, d2, d1),
    y4: an('AN-6d91', 'Amazon DynamoDB', '111111111111', 'WriteCapacityUnit-Hrs', 47.3, 150.2, d2, d1),
    y5: an('AN-6e37', 'Amazon EBS', '222222222222', 'VolumeUsage.gp3', 33.1, 410, d2, d1),
    y6: an('AN-6f58', 'Amazon S3', '333333333333', 'Requests-Tier1', 22.6, 80.5, d2, d1),
    y7: an('AN-7012', 'Amazon RDS', '111111111111', 'StorageIOUsage', 18.4, 64, d2, d1),
    y8: an('AN-7105', 'AWS Lambda', '222222222222', 'Duration', 12.9, 41, d2, d1),
  };
  const R = (id, at, status, a, extra = {}) => ({ id: 'sch-10-' + id, at, status, anomaly: a, ...extra });
  const ok = (id, at, a, ms, cost, extra) => ({ ...R(id, at, 'ok', a, { ms, cost, ...extra }), result: scResultFor(s, 0, a) });
  s.runs = [
    ok('t3', at0(20), A.ec2, 48200, 0.31),
    ok('t2', at0(50, 42), A.rds, 39400, 0.27, { waitMin: 1 }),
    ok('t1', at0(50), A.s3, 41800, 0.24),
    R('y9', at1(21, 40, 5), 'skipped', A.y8, { reason: 'cap' }),
    R('y8', at1(21, 40), 'skipped', A.y7, { reason: 'cap' }),
    R('y7', at1(15, 6), 'skipped', A.y6, { reason: 'overlap' }),
    ok('y5', at1(15, 5), A.y5, 540000, 0.62),
    ok('y4', at1(13), A.y4, 44100, 0.26),
    R('y3b', at1(10), 'skipped', A.y3, { reason: 'dup', dupOf: 'sch-10-y3' }),
    ok('y3', at1(9, 15), A.y3, 52800, 0.34),
    ok('y2', at1(6, 30), A.y2, 37600, 0.22),
    ok('y1', at1(2, 10), A.y1, 35900, 0.21),
  ];
  return s;
}

function scInit() {
  const S = window.MangoStore; if (S.get().schedules) return;
  const tasks = { 'sch-01': 'Revisa el consumo del presupuesto mensual y avisa si pasa del 80%.', 'sch-02': 'Analiza 14 días de utilización y recomienda cambios de tipo de instancia.', 'sch-03': 'Lista findings HIGH de las últimas 6 horas y escala los nuevos.' };
  const owners = ['Usuario 1', 'Usuario 2', 'Usuario 6', 'Usuario 3'];
  const list = (window.MangoData.schedules || []).map((s, i) => {
    const owner = owners[i % 4]; const lost = i === 3; const adminPause = s.id === 'sch-06';
    const base = { ...s, trigger: 'schedule', task: tasks[s.id] || s.desc, deliver: 'inbox', owner, p: scParse(s.cron) };
    const runs = Array.from({ length: Math.min(12, s.runs30d || 0) }, (_, j) => {
      const failed = (s.successRate || 100) < 100 && j % Math.max(2, Math.round(100 / (100 - s.successRate))) === 1;
      const st = s.status === 'error' && j < 2 ? 'failed' : failed ? 'failed' : (s.id === 'sch-02' && j === 0) ? 'approval' : (s.id === 'sch-01' && j === 4) || (s.id === 'sch-03' && j === 2) ? 'skipped' : 'ok';
      const r = { id: s.id + '-' + j, at: new Date(Date.now() - (j + 1) * (s.cron.includes('*/6') ? 6 : s.cron.split(' ')[4] !== '*' ? 168 : 24) * 36e5).toISOString(), status: st };
      if (st === 'skipped') return { ...r, reason: s.id === 'sch-01' ? 'budget' : 'overlap' };
      const m = { ms: 4000 + ((j * 1337 + i * 911) % 18000), cost: 0.02 + ((j * 7 + i * 3) % 30) / 100 };
      if (st === 'failed') return { ...r, ...m, reason: j % 2 ? 'timeout' : 'tool', tool: j % 2 ? null : (i % 2 ? 'get_findings' : 'get_cost_and_usage') };
      return { ...r, ...m, result: st === 'ok' ? scResultFor(base, j) : null };
    });
    const extra = lost ? { status: 'paused', autoPaused: { at: new Date(Date.now() - 5 * 36e5).toISOString(), reason: owner + ' perdió el acceso al agente', kind: 'access' }, paused: { by: 'system' } }
      : adminPause ? { status: 'paused', paused: { by: 'admin', actor: 'Usuario 6', at: new Date(Date.now() - 2 * 864e5).toISOString(), reason: 'Recalcula todo el histórico en cada ejecución; revisemos el costo antes de seguir.' } }
      : s.status === 'paused' ? { paused: { by: 'owner', actor: owner } } : {};
    return { ...base, runs, ...extra };
  });
  S.set({ schedules: [...list, scAnomalyTask()] });
}

function ScRunRow({ r, s, canSee, onOpen, onDup, onApproval }) {
  const [lbl, col] = SC_RUN[r.status] || SC_RUN.ok;
  const why = scReason(r);
  const dupOk = canSee && r.dupOf && s.runs.some(x => x.id === r.dupOf && x.result);
  const acts = (canSee && r.result) || r.status === 'approval' || dupOk;
  return (
    <div className="mk-line sc-run">
      {r.status === 'running' ? <span className="g-spin" aria-hidden="true"></span> : <span className="tk-dot" style={{ background: col }} aria-hidden="true"></span>}
      <div className="sc-run-b">
        <span>{lbl}{r.manual ? ' · manual' : ''}</span>
        {r.anomaly && <span className="mk-meta">Anomalía · {r.anomaly.service ? r.anomaly.service + ' · ' : ''}{scRange(r.anomaly.from, r.anomaly.to)}{r.anomaly.impact != null ? ' · impacto ' + scUsd(r.anomaly.impact) : ''}</span>}
        {why && <span className="mk-meta" style={r.status === 'failed' ? { color: 'var(--red)' } : null}>{why}</span>}
        {r.status === 'queued' && s.trigger === 'anomaly' && <span className="mk-meta">Espera a que termine la investigación anterior</span>}
        {r.waitMin > 0 && <span className="mk-meta">Esperó {r.waitMin} min en cola</span>}
        {acts && <span className="sc-run-acts">
          {canSee && r.result && <button className="sr-link" onClick={onOpen}>Ver resultado</button>}
          {r.status === 'approval' && <button className="sr-link" onClick={onApproval}>Ver aprobación</button>}
          {dupOk && <button className="sr-link" onClick={onDup}>Ver la investigación anterior</button>}
        </span>}
      </div>
      <span className="mk-meta mono sc-run-m">{window.fmtAgo(r.at)}<br />{r.ms != null ? (r.ms / 1000).toFixed(1).replace('.', ',') + ' s · ' + scUsd(r.cost) : '—'}</span>
    </div>
  );
}

function ScResult({ s, r, agent, onBack }) {
  const I = window.Icons;
  const res = r.result || {}; const steps = res.steps || []; const A = r.anomaly;
  const when = new Date(r.at).toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const meta = [agent?.name, (SC_RUN[r.status] || SC_RUN.ok)[0] + (r.manual ? ' · manual' : ''), r.ms != null && (r.ms / 1000).toFixed(1).replace('.', ',') + ' s', r.cost != null && scUsd(r.cost)].filter(Boolean).join(' · ');
  return (
    <div className="sc-res">
      <button className="sr-link sc-res-back" onClick={onBack}><I.ChevronLeft size={12} /> Volver a la tarea</button>
      <div>
        <div className="sc-res-h">Resultado · {when}</div>
        <div className="mk-meta" style={{ marginTop: 3 }}>{meta}</div>
      </div>
      {A && <div className="sc-anom"><span className="mk-sec-t">Anomalía que la arrancó</span><span>{A.service}{A.account ? <> · cuenta <span className="mono">{A.account}</span></> : null}</span><span className="mk-meta">{scRange(A.from, A.to)}{A.impact != null ? ' · impacto ' + scUsd(A.impact) : ''}</span></div>}
      {steps.length > 0 && <details className="sc-steps"><summary>Pasos · {steps.length === 1 ? '1 consulta' : steps.length + ' consultas'}</summary><ol>{steps.map((x, i) => <li key={i}><span>{x.text}</span>{x.tool && <span className="mk-meta mono">{x.tool}</span>}</li>)}</ol></details>}
      <div className="md" dangerouslySetInnerHTML={{ __html: window.renderMarkdown(res.report || res.text || '') }}></div>
      <p className="mk-meta sc-res-foot"><I.Lock size={11} /> Solo tú ves este resultado: se obtuvo con tu acceso.</p>
    </div>
  );
}

scInit();
Object.assign(window, { SC_FREQ, SC_DOW, SC_TZ, SC_RUN, SC_REASON, SC_CAP, SC_ANOMALY, SC_STARTED, scUsd, scParse, scCron, scLabel, scSafeLabel, scPerMonth, scNext, scFmt, scTzOff, scNextTz, scFmtTz, scTzLabel, scToday, scResetAt, scBusy, scRange, scReason, scSummary, scCanUse, scPerms, scResultFor, ScRunRow, ScResult });
