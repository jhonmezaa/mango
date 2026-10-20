// Schedules · programación con zona horaria, estados y motivos de cada ejecución, resultado, datos de ejemplo
const SC_FREQ = [['15m', 'Cada 15 min'], ['hourly', 'Cada hora'], ['6h', 'Cada 6 h'], ['daily', 'Diario'], ['weekdays', 'Lunes a viernes'], ['days', 'Días específicos'], ['weekly', 'Semanal'], ['monthly', 'Mensual']];
const SC_DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const SC_TZ = [['America/Mexico_City', 'Ciudad de México'], ['America/Bogota', 'Bogotá'], ['America/Sao_Paulo', 'São Paulo'], ['UTC', 'UTC']];
const SC_RUN = { ok: ['Completada', 'var(--green)'], failed: ['Fallida', 'var(--red)'], skipped: ['Omitida', 'var(--text-dim)'], approval: ['Espera aprobación', 'var(--amber)'], queued: ['En cola', 'var(--text-muted)'], running: ['Ejecutando…', 'var(--accent-ink)'] };
// tool y timeout: reservados hasta que el producto los distinga; hoy esos fallos salen como «agent».
const SC_REASON = { budget: 'Presupuesto agotado', access: 'El creador perdió el acceso al agente', central: 'El creador dejó de ser persona central', overlap: 'Otra ejecución seguía en curso', cap: 'Se alcanzó el tope de investigaciones del día', paused: 'La tarea se pausó', admin_paused: 'Un administrador pausó la tarea', retired: 'La tarea se retiró', agent: 'El agente falló', budget_reserve: 'No se pudo reservar el presupuesto', agent_unavailable: 'El agente no está disponible', model_disabled: 'El modelo del agente no está habilitado', identity: 'No se pudo obtener la identidad del creador', enqueue: 'No se pudo encolar', tool: 'Falló una tool', timeout: 'Se agotó el tiempo máximo de la ejecución' };
const SC_CAP = 5;
const SC_ANOMALY = 'Al detectar una anomalía de costo';
const SC_STARTED = ['ok', 'failed', 'approval', 'running'];
// Reporte descargable: un tipo fijo por disparador. El agente entrega datos; el servidor arma el PDF con una plantilla fija.
const SC_REPORT = { cost_summary: ['Resumen de costos', 'Total del periodo y contra el anterior, costo diario, servicios y cuentas que más gastan, y las notas del agente.'], anomaly: ['Investigación de anomalía', 'Impacto, costo diario alrededor de la anomalía, qué servicio, cuenta y tipo de uso la explican, la conclusión del agente y sus consultas.'] };
const SC_REPORT_FAIL = { data: 'El agente no entregó los datos del reporte.', size: 'El reporte superó el tamaño máximo (10 MB).', render: 'No se pudo armar el PDF.' };
const SC_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
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
const scShortId = (id) => String(id || '').slice(0, 8);
const scReportType = (trigger) => trigger === 'anomaly' ? 'anomaly' : 'cost_summary';
const scReportable = (a) => !!a && (a.mcp || []).some(id => /cost|billing/.test(id));
const scSlug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
const scParts = (d, tz) => { const p = {}; try { new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach(x => { p[x.type] = x.value; }); } catch (e) { return scParts(d, 'UTC'); } return p; };
// Nombre del archivo: tarea + fecha (zona de la tarea; UTC en las de anomalía) + hora, o el id corto de la anomalía.
const scReportFile = (s, r) => { const an = s.trigger === 'anomaly'; const p = scParts(new Date(r.at), an ? 'UTC' : s.tz); return scSlug(s.name) + '-' + p.year + '-' + p.month + '-' + p.day + '-' + (an && r.anomaly?.id ? scShortId(r.anomaly.id) : p.hour + p.minute) + '.pdf'; };
const scKeepUntil = (r) => new Date(new Date(r.at).getTime() + 90 * 864e5).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
// En el prototipo, «Descargar» abre la plantilla del PDF. En el producto, cada clic pide un enlace que vence a los 5 min.
const scDownload = (s, r) => { const S = window.MangoStore; if (S.get().simReport === 'dlfail') return false; const file = scReportFile(s, r); S.log('schedule.report_download', s.id, 'Descargó el reporte de ' + s.name + ' · ejecución ' + r.id, { run: r.id, file, task: s.name }); window.open(encodeURI('Reporte de tarea.html#' + (s.trigger === 'anomaly' ? 'anomalia' : 'costos')), '_blank', 'noopener'); return true; };
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
  if (s.id === 'sch-11') { const mk = (k) => SC_MES[(new Date().getUTCMonth() - k - 1 + 24) % 12]; const M = [[84312.40, 79880.15, 0, 0, 31420.10, 29360.35, 3120.80, 2644.75], [79880.15, 77402.90, 0, 0, 29360.35, 28911.20, 2644.75, 2601.30], [77402.90, 75118.30, 0, 0, 28911.20, 27840.65, 2601.30, 2552.10]][j] || []; M[2] = mk(j); M[3] = mk(j + 1); const pct = ((M[0] / M[1] - 1) * 100).toFixed(1).replace('.', ','); return {
    steps: [{ text: `Consulto el gasto de ${M[2]} y de ${M[3]} por servicio.`, tool: 'get_cost_and_usage' }, { text: 'Ahora por cuenta, para ver dónde está el cambio.', tool: 'get_cost_and_usage' }, { text: 'Reviso si quedaron anomalías abiertas al cierre.', tool: 'get_anomalies' }],
    report: `## Cierre de ${M[2]}: ${scUsd(M[0])}\n\n**+${pct} %** contra ${M[3]} (${scUsd(M[1])}). La mayor parte del aumento está en Amazon EC2 y AWS Lambda.\n\n| Servicio | ${M[2].replace(/^./, c => c.toUpperCase())} | ${M[3].replace(/^./, c => c.toUpperCase())} | Cambio |\n|---|---|---|---|\n| Amazon EC2 | ${scUsd(M[4])} | ${scUsd(M[5])} | +${Math.round((M[4] / M[5] - 1) * 100)} % |\n| AWS Lambda | ${scUsd(M[6])} | ${scUsd(M[7])} | +${Math.round((M[6] / M[7] - 1) * 100)} % |\n\nSin anomalías abiertas al cierre.` }; }
  if (s.id === 'sch-02') return {
    steps: [{ text: 'Consulto la utilización de CPU y memoria de los últimos 14 días.', tool: 'get_ec2_instance_recommendations' }],
    report: `## Rightsizing: 3 instancias para cambiar\n\nCon 14 días de datos, estas instancias usan menos del 20% de CPU:\n\n| Instancia | Tipo actual | Recomendado | Ahorro al mes |\n|---|---|---|---|\n| \`i-0a1b2c3d\` | m6i.2xlarge | m6i.xlarge | ${scUsd(140.16)} |\n| \`i-0e4f5a6b\` | r6g.xlarge | r6g.large | ${scUsd(73.58)} |\n| \`i-0c7d8e9f\` | c6i.4xlarge | c6i.2xlarge | ${scUsd(248.2)} |\n\nAhorro estimado: **${scUsd(461.94)} al mes**. No se cambió nada: cambiar el tipo de una instancia necesita aprobación.` };
  return { steps: [], report: `## ${s.name}\n\nSin novedades respecto a la ejecución anterior.` };
}

function scAnomalyTask() {
  const now = Date.now(), d0 = scDayUTC(0), d1 = scDayUTC(-1), d2 = scDayUTC(-2), d3 = scDayUTC(-3), d4 = scDayUTC(-4);
  const T = (ms) => new Date(ms).toISOString();
  const at0 = (min, sec = 0) => T(Math.max(now - min * 6e4 + sec * 1e3, d0 + 6e4 + sec * 1e3));
  const at1 = (h, m = 0, sec = 0) => T(d1 + h * 36e5 + m * 6e4 + sec * 1e3);
  const at3 = (h, m = 0) => T(d3 + h * 36e5 + m * 6e4);
  const an = (id, service, account, usage, impact, expected, from, to) => ({ id, service, account, usage, impact, expected, from: T(from), to: T(to) });
  const s = { id: 'sch-10', name: 'Investigar anomalías de costo', agent: 'fin-01', trigger: 'anomaly', owner: 'Usuario 1', status: 'active', deliver: 'inbox', tz: null, p: { freq: 'daily', hour: 9, min: 0 }, cron: null, cronLabel: SC_ANOMALY,
    task: 'Cuando AWS detecte una anomalía de costo, identifica qué cuenta, servicio y tipo de uso la explican, compárala con las dos semanas anteriores y propone el siguiente paso.' };
  const A = {
    s3: an('7f3ae1c2-4b5d-4e8f-9a01-7f3a2b3c4d5e', 'Amazon S3', '111111111111', 'TimedStorage-ByteHrs', 86.4, 231.75, d1, d0),
    rds: an('81c2e1c2-4b5d-4e8f-9a01-81c22b3c4d5e', 'Amazon RDS', '222222222222', 'InstanceUsage:db.r6g.xlarge', 154.2, 488.1, d1, d0),
    ec2: an('8d09e1c2-4b5d-4e8f-9a01-8d092b3c4d5e', 'Amazon EC2', '111111111111', 'BoxUsage:m6i.2xlarge', 412.3, 640, d1, d0),
    y1: an('6a10e1c2-4b5d-4e8f-9a01-6a102b3c4d5e', 'AWS Lambda', '333333333333', 'Request', 38.9, 120.4, d2, d1),
    y2: an('6b44e1c2-4b5d-4e8f-9a01-6b442b3c4d5e', 'Amazon CloudWatch', '222222222222', 'DataProcessing-Bytes', 61.2, 95, d2, d1),
    y3: an('6c02e1c2-4b5d-4e8f-9a01-6c022b3c4d5e', 'Amazon EC2', '333333333333', 'DataTransfer-Out-Bytes', 129.75, 310, d2, d1),
    y4: an('6d91e1c2-4b5d-4e8f-9a01-6d912b3c4d5e', 'Amazon DynamoDB', '111111111111', 'WriteCapacityUnit-Hrs', 47.3, 150.2, d2, d1),
    y5: an('6e37e1c2-4b5d-4e8f-9a01-6e372b3c4d5e', 'Amazon EBS', '222222222222', 'VolumeUsage.gp3', 33.1, 410, d2, d1),
    y6: an('6f58e1c2-4b5d-4e8f-9a01-6f582b3c4d5e', 'Amazon S3', '333333333333', 'Requests-Tier1', 22.6, 80.5, d2, d1),
    y7: an('7012e1c2-4b5d-4e8f-9a01-70122b3c4d5e', 'Amazon RDS', '111111111111', 'StorageIOUsage', 18.4, 64, d2, d1),
    y8: an('7105e1c2-4b5d-4e8f-9a01-71052b3c4d5e', 'AWS Lambda', '222222222222', 'Duration', 12.9, 41, d2, d1),
    z1: an(null, 'Amazon EC2', '222222222222', 'BoxUsage:c6i.xlarge', 58.7, 205.3, d4, d3),
  };
  const R = (id, at, status, a, extra = {}) => ({ id: 'sch-10-' + id, at, status, anomaly: a, ...extra });
  const ok = (id, at, a, ms, cost, extra) => ({ ...R(id, at, 'ok', a, { ms, cost, report: { status: 'ready', pages: 2, kb: 240 + Math.round(a.impact) % 80 }, ...extra }), result: scResultFor(s, 0, a) });
  s.report = 'anomaly';
  s.runs = [
    ok('t3', at0(20), A.ec2, 48200, 0.31),
    ok('t2', at0(50, 42), A.rds, 39400, 0.27, { waitMin: 1 }),
    ok('t1', at0(50), A.s3, 41800, 0.24, { report: { status: 'failed', reason: 'data' } }),
    R('y9', at1(21, 40, 5), 'skipped', A.y8, { reason: 'cap' }),
    R('y8', at1(21, 40), 'skipped', A.y7, { reason: 'cap' }),
    R('y7', at1(15, 6), 'skipped', A.y6, { reason: 'overlap' }),
    ok('y5', at1(15, 5), A.y5, 540000, 0.62),
    ok('y4', at1(13), A.y4, 44100, 0.26),
    ok('y3', at1(9, 15), A.y3, 52800, 0.34),
    ok('y2', at1(6, 30), A.y2, 37600, 0.22),
    ok('y1', at1(2, 10), A.y1, 35900, 0.21),
    // Anterior a la versión que guarda el id: solo fechas, y sin reporte.
    { ...R('z1', at3(11, 20), 'ok', A.z1, { ms: 43100, cost: 0.26 }), result: scResultFor(s, 0, A.z1) },
  ];
  return s;
}

// «Cierre mensual de costos»: tarea por horario con reporte PDF (dos listos y uno que no se pudo armar).
function scMonthlyTask() {
  const s = { id: 'sch-11', name: 'Cierre mensual de costos', agent: 'fin-01', trigger: 'schedule', owner: 'Usuario 1', status: 'active', deliver: 'inbox', tz: 'America/Mexico_City', p: { freq: 'monthly', dom: 1, hour: 8, min: 0 }, cron: '0 8 1 * *', cronLabel: 'Día 1 de cada mes · 08:00', report: 'cost_summary',
    task: 'El día 1 de cada mes, resume el gasto del mes anterior para el área de finanzas: total, comparación con el mes previo, servicios y cuentas que más gastan y qué explica los cambios.' };
  const n = new Date(); const at = (k) => new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - k, 1, 14, 0, 40)).toISOString();
  const per = (k) => { const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - k - 1, 15)); return SC_MES[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
  const reps = [{ status: 'ready', pages: 2, kb: 412, period: per(0) }, { status: 'ready', pages: 2, kb: 398, period: per(1) }, { status: 'failed', reason: 'render', period: per(2) }];
  s.runs = [0, 1, 2].map(k => ({ id: 'sch-11-' + k, at: at(k), status: 'ok', ms: 61000 + k * 4300, cost: 0.38 + k * 0.02, report: reps[k], result: scResultFor(s, k) }));
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
      const st = s.status === 'error' && j < 2 ? 'failed' : failed ? 'failed' : (s.id === 'sch-02' && j === 0) ? 'approval' : (s.id === 'sch-01' && j === 0) || (s.id === 'sch-03' && j === 2) ? 'skipped' : 'ok';
      const r = { id: s.id + '-' + j, at: new Date(Date.now() - (j + 1) * (s.cron.includes('*/6') ? 6 : s.cron.split(' ')[4] !== '*' ? 168 : 24) * 36e5).toISOString(), status: st };
      if (st === 'skipped') return { ...r, reason: s.id === 'sch-01' ? 'budget' : 'overlap' };
      const m = { ms: 4000 + ((j * 1337 + i * 911) % 18000), cost: 0.02 + ((j * 7 + i * 3) % 30) / 100 };
      if (st === 'failed') return { ...r, ...m, reason: ['agent', 'budget_reserve', 'model_disabled'][j % 3] };
      return { ...r, ...m, result: st === 'ok' ? scResultFor(base, j) : null };
    });
    const extra = lost ? { status: 'paused', autoPaused: { at: new Date(Date.now() - 5 * 36e5).toISOString(), reason: owner + ' perdió el acceso al agente', kind: 'access' }, paused: { by: 'system' } }
      : adminPause ? { status: 'paused', paused: { by: 'admin', actor: 'usuario6@empresa.com', at: new Date(Date.now() - 2 * 864e5).toISOString(), reason: 'Recalcula todo el histórico en cada ejecución; revisemos el costo antes de seguir.' } }
      : s.status === 'paused' ? { paused: { by: 'owner', actor: 'usuario' + (owner.match(/\d+/) || ['1'])[0] + '@empresa.com' } } : {};
    return { ...base, runs, ...extra };
  });
  S.set({ schedules: [...list, scMonthlyTask(), scAnomalyTask()] });
}

function ScRepDl({ s, r, btn, label = 'Descargar PDF' }) {
  const I = window.Icons; const [st, setSt] = React.useState(null);
  const go = () => { if (st === 'busy') return; setSt('busy'); if (scDownload(s, r)) { setSt(null); return; } setTimeout(() => setSt('err'), 500); };
  return <>
    <button className={btn ? 'btn btn-sm' : 'sr-link sc-dl'} disabled={st === 'busy'} onClick={go}>{st === 'busy' ? <><span className="g-spin" aria-hidden="true"></span> Preparando…</> : <><I.Download size={btn ? 12 : 11} /> {label}</>}</button>
    {st === 'err' && <span role="alert" className="sc-rep-err">No se pudo preparar la descarga. Vuelve a intentarlo.</span>}
  </>;
}

function ScRepState({ r, own, owner }) {
  const rep = r.report; if (!rep) return null;
  if (rep.status === 'generating') return <span className="mk-meta sc-rep-st"><span className="g-spin" aria-hidden="true"></span> Generando el PDF…</span>;
  if (rep.status === 'failed') return <span className="mk-meta" style={{ color: 'var(--red)' }}>No se generó el PDF</span>;
  return own ? null : <span className="mk-meta">PDF listo · solo {owner} lo descarga</span>;
}

function ScRepCard({ s, r, onRetry }) {
  const I = window.Icons; const rep = r.report; const name = (SC_REPORT[s.report] || SC_REPORT[scReportType(s.trigger)])[0];
  const per = rep.period || (r.anomaly ? scRange(r.anomaly.from, r.anomaly.to) : '');
  if (rep.status === 'generating') return <div className="sc-rep" role="status"><span className="sc-rep-i"><span className="g-spin" aria-hidden="true"></span></span><div className="sc-rep-b"><b>Generando el PDF · {name}</b><span className="mk-meta">El informe ya está abajo; el PDF tarda un poco más.</span></div></div>;
  if (rep.status === 'failed') return <div className="sc-rep bad"><span className="sc-rep-i"><I.Warn size={15} /></span><div className="sc-rep-b"><b>No se pudo generar el PDF · {name}</b><span className="mk-meta">{SC_REPORT_FAIL[rep.reason] || SC_REPORT_FAIL.render} {rep.reason === 'render' ? 'Puedes generarlo de nuevo con los mismos datos: no vuelve a ejecutar al agente ni tiene costo.' : 'El informe de abajo está completo.'}</span></div>{rep.reason === 'render' && <button className="btn btn-sm" onClick={onRetry}><I.Refresh size={12} /> Generar de nuevo</button>}</div>;
  return <div className="sc-rep"><span className="sc-rep-i"><I.Document size={16} /></span><div className="sc-rep-b"><b>{name}{per ? ' · ' + per : ''}</b><span className="mk-meta mono sc-rep-f">{scReportFile(s, r)}</span><span className="mk-meta">PDF · {rep.pages} páginas · {rep.kb} KB · se guarda hasta el {scKeepUntil(r)}</span></div><ScRepDl s={s} r={r} btn label="Descargar" /></div>;
}

function ScRunRow({ r, s, canSee, rep, onOpen, onApproval }) {
  const [lbl, col] = SC_RUN[r.status] || SC_RUN.ok;
  const why = scReason(r);
  const dl = rep && canSee && r.result && r.report?.status === 'ready';
  const acts = (canSee && r.result) || r.status === 'approval';
  return (
    <div className="mk-line sc-run">
      {r.status === 'running' ? <span className="g-spin" aria-hidden="true"></span> : <span className="tk-dot" style={{ background: col }} aria-hidden="true"></span>}
      <div className="sc-run-b">
        <span>{lbl}{r.manual ? ' · manual' : ''}</span>
        {r.anomaly && <span className="mk-meta">Anomalía · {scRange(r.anomaly.from, r.anomaly.to)}{r.anomaly.id && <> · <span className="mono">{scShortId(r.anomaly.id)}</span></>}</span>}
        {why && <span className="mk-meta" style={r.status === 'failed' ? { color: 'var(--red)' } : null}>{why}</span>}
        {r.status === 'queued' && s.trigger === 'anomaly' && <span className="mk-meta">Espera a que termine la investigación anterior</span>}
        {r.waitMin > 0 && <span className="mk-meta">Esperó {r.waitMin} min en cola</span>}
        {rep && <ScRepState r={r} own={canSee} owner={s.owner} />}
        {acts && <span className="sc-run-acts">
          {canSee && r.result && <button className="sr-link" onClick={onOpen}>Ver resultado</button>}
          {dl && <ScRepDl s={s} r={r} />}
          {r.status === 'approval' && <button className="sr-link" onClick={onApproval}>Ver aprobación</button>}
        </span>}
      </div>
      <span className="mk-meta mono sc-run-m">{window.fmtAgo(r.at)}<br />{r.ms != null ? (r.ms / 1000).toFixed(1).replace('.', ',') + ' s · ' + scUsd(r.cost) : '—'}</span>
    </div>
  );
}

function ScResult({ s, r, agent, rep, onBack, onRetry }) {
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
      {A && <div className="sc-anom"><span className="mk-sec-t">Anomalía que la arrancó</span><span>{scRange(A.from, A.to)}</span>{A.id && <span className="mk-meta mono sc-anom-id">{A.id}</span>}</div>}
      {rep && r.report && <ScRepCard s={s} r={r} onRetry={onRetry} />}
      {steps.length > 0 && <details className="sc-steps"><summary>Pasos · {steps.length === 1 ? '1 consulta' : steps.length + ' consultas'}</summary><ol>{steps.map((x, i) => <li key={i}><span>{x.text}</span>{x.tool && <span className="mk-meta mono">{x.tool}</span>}</li>)}</ol></details>}
      <div className="md" dangerouslySetInnerHTML={{ __html: window.renderMarkdown(res.report || res.text || '') }}></div>
      <p className="mk-meta sc-res-foot"><I.Lock size={11} /><span>{rep && r.report ? 'Solo tú ves este resultado y descargas el PDF: se obtuvo con tu acceso. Cada descarga queda en Auditoría.' : 'Solo tú ves este resultado: se obtuvo con tu acceso.'}</span></p>
    </div>
  );
}

scInit();
Object.assign(window, { SC_FREQ, SC_DOW, SC_TZ, SC_RUN, SC_REASON, SC_CAP, SC_ANOMALY, SC_STARTED, SC_REPORT, SC_REPORT_FAIL, SC_MES, scReportType, scReportable, scReportFile, scKeepUntil, scDownload, ScRepDl, ScRepCard, scUsd, scParse, scCron, scLabel, scSafeLabel, scPerMonth, scNext, scFmt, scTzOff, scNextTz, scFmtTz, scTzLabel, scToday, scResetAt, scBusy, scRange, scReason, scShortId, scSummary, scCanUse, scPerms, scResultFor, ScRunRow, ScResult });
