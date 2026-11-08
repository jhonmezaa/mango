// Chat · código (bloque «Analizando»), figuras, archivos generados, gráfica, tabla y adjuntos (D114, D116, D118).
const CR_CODE_AGENTS = ['fin-01', 'data-01', 'ops-01'];
const crCanCode = (a) => !!a && (a.code ?? CR_CODE_AGENTS.includes(a.id));
const CR_ALLOWED = ['pdf', 'csv', 'txt', 'json', 'xlsx', 'docx', 'pptx', 'png', 'jpg', 'jpeg'];
const CR_MAX_FILES = 20, CR_MAX_MB = 100;
const crSize = (b) => b >= 1048576 ? (b / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MB' : Math.max(1, Math.round(b / 1024)).toLocaleString() + ' KB';
const crExt = (n) => (n.split('.').pop() || '').toLowerCase();
const crSim = (k) => window.MangoStore.get()[k] || null;

function crAddFiles(files, current, setAttachments) {
  const room = Math.max(0, CR_MAX_FILES - current.length);
  const all = [...files]; const take = all.slice(0, room);
  const sim = crSim('simAttach');
  const list = take.map((f, i) => {
    const ext = crExt(f.name);
    const st = !CR_ALLOWED.includes(ext) ? 'type' : f.size > CR_MAX_MB * 1048576 ? 'big' : 'up';
    return { id: Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2, 6), name: f.name, size: f.size, type: f.type, status: st, pct: 0 };
  });
  setAttachments(a => [...a, ...list]);
  const upd = (id, patch) => setAttachments(a => a.map(x => x.id === id ? { ...x, ...patch } : x));
  list.filter(f => f.status === 'up').forEach((f, i) => {
    const d = 300 + i * 180;
    setTimeout(() => upd(f.id, { pct: 45 }), d);
    setTimeout(() => upd(f.id, sim === 'upload-err' ? { status: 'err' } : sim === 'mismatch' ? { status: 'mismatch' } : { status: 'scan', pct: 100 }), d + 700);
    if (sim !== 'upload-err' && sim !== 'mismatch') setTimeout(() => upd(f.id, { status: sim === 'blocked' ? 'blocked' : 'ready' }), d + 700 + 1800);
  });
  const left = all.length - take.length;
  return left > 0 ? `Puedes adjuntar hasta ${CR_MAX_FILES} archivos por mensaje. ${left === 1 ? 'Uno se quedó fuera' : left + ' se quedaron fuera'}.` : null;
}
function crRetryUpload(id, setAttachments) {
  const upd = (patch) => setAttachments(a => a.map(x => x.id === id ? { ...x, ...patch } : x));
  upd({ status: 'up', pct: 30 }); setTimeout(() => upd({ status: 'scan', pct: 100 }), 700); setTimeout(() => upd({ status: 'ready' }), 2300);
}
const CR_ATT_TXT = { up: 'Subiendo', scan: 'Revisando el archivo', ready: null, blocked: 'Bloqueado por el escaneo', type: 'Tipo no permitido', mismatch: 'El contenido no es del tipo que dice', big: 'Supera 100 MB', err: 'No se pudo subir', gone: 'Ya no disponible' };
const CR_BAD = ['blocked', 'type', 'mismatch', 'big', 'err'];

function CrAttachChips({ files, onRemove, onRetry }) {
  const I = window.Icons;
  return (
    <div className="cr-att">
      {files.map((f, i) => { const st = f.gone ? 'gone' : f.status || 'ready'; const bad = CR_BAD.includes(st); return (
        <span key={f.id || i} className={'cr-chip is-' + st + (bad ? ' is-bad' : '')} title={st === 'gone' ? 'Los adjuntos se guardan 90 días.' : undefined}>
          {st === 'up' || st === 'scan' ? <span className="mango-spinner" aria-hidden="true" /> : bad ? <I.Warn size={12} /> : <I.Document size={12} />}
          <span className="cr-chip-n">{f.name}</span>
          <span className="cr-chip-m">{CR_ATT_TXT[st] ? CR_ATT_TXT[st] + (st === 'up' ? ' · ' + (f.pct || 0) + ' %' : st === 'scan' ? '…' : '') : crSize(f.size)}</span>
          {st === 'err' && onRetry && <button className="sr-link" onClick={() => onRetry(f.id)}>Reintentar</button>}
          {onRemove && <button aria-label={'Quitar ' + f.name} onClick={() => onRemove(i)} className="cr-chip-x"><I.Close size={11} /></button>}
        </span>); })}
    </div>
  );
}
const crAttGate = (att) => att.some(f => f.status === 'up' || f.status === 'scan') ? 'busy' : att.some(f => CR_BAD.includes(f.status)) ? 'bad' : null;

// ---------- Bloque «Analizando» ----------
const CR_CELLS = [
  { code: "import pandas as pd\ndf = pd.read_parquet('/data/cur_2026.parquet')\nmes = df.groupby(['mes', 'servicio'])['costo_usd'].sum().unstack()\nprint(mes.tail(6).round(0))", out: [{ k: 'stdout', t: "servicio      EC2     RDS      S3\nmes\n2026-05   41200    9800   12800\n2026-06   42900    9650   13100\n2026-07   44100    9900   12950\n2026-08   51800   10100   13300\n2026-09   55600   10050   13400\n2026-10   58300   10200   13600" }], ms: 1840 },
  { code: "import matplotlib.pyplot as plt\nax = mes.tail(6).plot(kind='bar', figsize=(10, 5))\nax.set_ylabel('USD')\nplt.savefig('costo_por_servicio.png', dpi=120)\ncuentas = df.pivot_table(index=['cuenta', 'servicio', 'region'], values='costo_usd', aggfunc='sum')\ncuentas.to_csv('costo_por_cuenta.csv')\ncuentas.to_excel('detalle_costos.xlsx')", out: [{ k: 'stderr', t: "UserWarning: 14 filas sin región; se agrupan como 'sin-region'." }], figs: [{ name: 'costo_por_servicio.png', w: 1200, h: 600 }], ms: 2410 },
];
function crBuildCells(stage) {
  const sim = crSim('simCode');
  const c1 = { ...CR_CELLS[0], ...(sim === 'trunc' ? { trunc: true } : {}) };
  if (stage === 1) return [{ ...c1, run: true, out: [], ms: null }];
  if (stage === 2) return [c1, { ...CR_CELLS[1], run: true, out: [], figs: [], ms: null }];
  const c2 = sim === 'error' ? { ...CR_CELLS[1], out: [], figs: [], exc: "KeyError: 'region'\n  File \"<celda 2>\", line 5, in <module>\n    cuentas = df.pivot_table(index=['cuenta', 'servicio', 'region'], …)" }
    : sim === 'timeout' ? { ...CR_CELLS[1], out: [], figs: [], exc: 'La celda pasó su tope de 300 s y se detuvo.', timeout: true, ms: 300000 }
    : sim === 'blocked' ? { ...CR_CELLS[1], blocked: true, figs: [] }
    : CR_CELLS[1];
  return [c1, c2];
}
const crBlockState = (cells) => cells.some(c => c.exc) ? 'error' : 'done';

function CodeBlock({ block }) {
  const I = window.Icons;
  const [open, setOpen] = React.useState(false);
  const st = block.state;
  const cells = block.cells || [];
  const total = cells.reduce((s, c) => s + (c.ms || 0), 0);
  const figs = cells.flatMap(c => c.figs || []);
  const err = cells.find(c => c.exc);
  const head = st === 'run' ? 'Analizando…' : st === 'error' ? 'Error' : st === 'paused' ? 'Pausado' : 'Analizado';
  return (
    <div className={'cr-code is-' + st} aria-busy={st === 'run'}>
      <button className="cr-code-h" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {st === 'run' ? <span className="mango-spinner" aria-hidden="true" /> : st === 'error' ? <I.X2 size={13} /> : st === 'paused' ? <I.Pause size={12} /> : <I.Check2 size={13} />}
        <span className="cr-code-t" role={st === 'run' ? 'status' : undefined}>{head}</span>
        <span className="cr-code-m mono">{cells.length} {cells.length === 1 ? 'celda' : 'celdas'}{total && st !== 'run' ? ' · ' + (window.fmtDur ? window.fmtDur(total) : total + ' ms') : ''}</span>
        <span className="cr-code-o">{open ? 'Ocultar código' : 'Ver código'} <I.ChevronRight size={10} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} /></span>
      </button>
      {!open && st === 'error' && err && <div className="cr-code-sum mono">{err.exc.split('\n')[0]}</div>}
      {!open && st === 'paused' && <div className="cr-code-sum">Quedó sin terminar porque la respuesta se detuvo.</div>}
      {open && <div className="cr-code-b">
        {cells.map((c, i) => <div key={i} className="cr-cell">
          <div className="cr-cell-h"><span className="mono">Celda {i + 1}</span>{c.run && st === 'run' ? <span className="row gap-1"><span className="mango-spinner" aria-hidden="true" /> corriendo</span> : c.run && st === 'paused' ? <span>sin terminar</span> : c.ms ? <span className="mono">{window.fmtDur ? window.fmtDur(c.ms) : c.ms + ' ms'}</span> : null}</div>
          {c.blocked ? <div className="cr-cell-blk"><I.Lock size={12} /> Mango no muestra el código ni la salida de esta celda: infringían una regla de seguridad.</div> : <>
            <pre className="cr-pre mono">{c.code}</pre>
            {(c.out || []).map((o, j) => <div key={j} className={'cr-out is-' + o.k}><span className="cr-out-k mono">{o.k === 'stderr' ? 'STDERR' : 'STDOUT'}</span><pre className="mono">{o.t}</pre></div>)}
            {c.trunc && <div className="cr-note"><I.Info size={11} /> Salida recortada: se muestran los primeros 20.000 caracteres.</div>}
            {c.exc && <div className="cr-exc"><span className="cr-out-k mono">{c.timeout ? 'TIEMPO' : 'EXCEPCIÓN'}</span><pre className="mono">{c.exc}</pre></div>}
          </>}
        </div>)}
      </div>}
      {figs.length > 0 && <div className="cr-figs">{figs.map(f => <CrFigure key={f.name} fig={f} />)}</div>}
    </div>
  );
}

function CrFigure({ fig }) {
  const I = window.Icons; const toast = window.useToast?.();
  const sim = window.useMango(s => s.simFig) || null;
  const [retry, setRetry] = React.useState(0);
  const [zoom, setZoom] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => { setLoading(true); const t = setTimeout(() => setLoading(false), 900); return () => clearTimeout(t); }, [retry, sim]);
  const st = sim === 'loading' || loading ? 'loading' : sim === 'error' && !retry ? 'error' : 'ok';
  const ph = (big) => <div className={'cr-fig-img' + (big ? ' big' : '')} style={{ aspectRatio: fig.w + ' / ' + fig.h }}><span className="mono">{fig.name}</span><span className="mono">{fig.w} × {fig.h}</span></div>;
  return (
    <figure className="cr-fig">
      {st === 'loading' ? <div className="cr-fig-img is-load" role="status" aria-label="Cargando la figura" style={{ aspectRatio: fig.w + ' / ' + fig.h }}><span className="mango-spinner" /></div>
        : st === 'error' ? <div className="cr-fig-img is-err" role="alert" style={{ aspectRatio: fig.w + ' / ' + fig.h }}><I.Warn size={15} /><span>No se pudo cargar la figura.</span><button className="btn btn-sm" onClick={() => setRetry(r => r + 1)}><I.Refresh size={11} /> Reintentar</button></div>
        : <button className="cr-fig-btn" onClick={() => setZoom(true)} aria-label={'Ampliar ' + fig.name}>{ph()}</button>}
      <figcaption className="row between"><span className="mono">{fig.name}</span>{st === 'ok' && <span className="row gap-1"><button className="btn btn-ghost btn-icon" title="Ampliar" aria-label={'Ampliar ' + fig.name} onClick={() => setZoom(true)}><I.Expand size={11} /></button><button className="btn btn-ghost btn-icon" title="Descargar" aria-label={'Descargar ' + fig.name} onClick={() => toast?.({ tone: 'success', msg: 'Descargando ' + fig.name })}><I.Download size={11} /></button></span>}</figcaption>
      {zoom && <window.Modal open onClose={() => setZoom(false)} title={fig.name} width={880}>{ph(true)}<div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button className="btn btn-sm" onClick={() => toast?.({ tone: 'success', msg: 'Descargando ' + fig.name })}><I.Download size={11} /> Descargar</button></div></window.Modal>}
    </figure>
  );
}

// ---------- Archivo generado ----------
const CR_KIND = { csv: 'CSV', xlsx: 'Excel', docx: 'Word', pptx: 'PowerPoint', pdf: 'PDF', png: 'Imagen PNG', jpg: 'Imagen JPG' };
function FileCard({ file, compact }) {
  const I = window.Icons; const toast = window.useToast?.();
  const sim = window.useMango(s => s.simGenFile) || null;
  const [dl, setDl] = React.useState(null);
  const [scan, setScan] = React.useState(!file.scanned);
  React.useEffect(() => { if (!scan) return; const t = setTimeout(() => setScan(false), 1600); return () => clearTimeout(t); }, []);
  const st = sim === 'gone' ? 'gone' : sim === 'scanning' || scan ? 'scan' : sim === 'blocked' ? 'blocked' : 'ready';
  const ext = crExt(file.name);
  const go = () => { setDl('prep'); setTimeout(() => { if (sim === 'dl-error') setDl('err'); else if (sim === 'rate') setDl('rate'); else { setDl(null); toast?.({ tone: 'success', msg: 'Descargando ' + file.name }); } }, 700); };
  return (
    <div className={'cr-file is-' + st + (compact ? ' is-compact' : '')}>
      <span className="cr-file-ic mono">{ext.toUpperCase()}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="cr-file-n">{file.name}</div>
        <div className="cr-file-m">{CR_KIND[ext] || ext.toUpperCase()} · {crSize(file.size)} · de {file.agent}{file.thread ? ' · ' + file.thread : ''}</div>
        {st === 'scan' && <div className="cr-file-s" role="status"><span className="mango-spinner" aria-hidden="true" /> Revisando el archivo…</div>}
        {st === 'blocked' && <div className="cr-file-s is-red" role="alert"><I.Lock size={11} /> El escaneo de malware bloqueó este archivo. No se puede descargar.</div>}
        {st === 'gone' && <div className="cr-file-s">Ya no está disponible. Los archivos se guardan 90 días y se borran con la conversación.</div>}
        {dl === 'err' && <div className="cr-file-s is-red" role="alert">No se pudo preparar la descarga. Inténtalo de nuevo.</div>}
        {dl === 'rate' && <div className="cr-file-s is-amber" role="alert">Llegaste al máximo de 60 descargas por hora. Podrás descargar de nuevo en 12 minutos.</div>}
      </div>
      {st === 'ready' && <button className="btn btn-sm" disabled={dl === 'prep' || dl === 'rate'} onClick={go}>{dl === 'prep' ? <><span className="mango-spinner" aria-hidden="true" /> Preparando…</> : <><I.Download size={11} /> {dl === 'err' ? 'Reintentar' : 'Descargar'}</>}</button>}
    </div>
  );
}

// ---------- Gráfica interactiva ----------
const CR_COLORS = ['var(--accent)', 'var(--blue)', 'var(--violet)', 'var(--green)', 'var(--amber)', 'var(--red)'];
const crFmt = (v, f) => typeof v !== 'number' ? String(v ?? '') : f === 'compact' ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v) : f === 'integer' ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v) : new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(v);
const CR_MONTHS = [['may', 41200, 9800, 12800], ['jun', 42900, 9650, 13100], ['jul', 44100, 9900, 12950], ['ago', 51800, 10100, 13300], ['sep', 55600, 10050, 13400], ['oct', 58300, 10200, 13600]].map(([mes, EC2, RDS, S3]) => ({ mes, EC2, RDS, S3 }));
function crDemoSpec(kind) {
  const base = { valueFormat: 'compact', meta: { title: 'Costo mensual por servicio', subtitle: 'may – oct 2026 · USD' } };
  if (kind === 'pie') return { ...base, chartType: 'pie', xKey: 'servicio', series: [{ key: 'costo', label: 'Costo' }], meta: { title: 'Reparto del costo de octubre', subtitle: 'oct 2026 · USD' }, data: [{ servicio: 'EC2', costo: 58300 }, { servicio: 'S3', costo: 13600 }, { servicio: 'RDS', costo: 10200 }, { servicio: 'Otros', costo: 6400 }] };
  if (kind === 'scatter') return { ...base, chartType: 'scatter', xKey: 'cpu', axes: { x: { label: 'CPU media (%)' }, y: { label: 'USD / mes' } }, series: [{ key: 'costo', label: 'Instancias EC2' }], meta: { title: 'Uso contra costo por instancia', subtitle: '42 instancias · oct 2026' }, data: Array.from({ length: 42 }, (_, i) => ({ cpu: Math.round(4 + ((i * 37) % 88)), costo: Math.round(120 + ((i * 53) % 17) * 95 + ((i * 7) % 5) * 40) })) };
  return { ...base, chartType: kind === 'line' ? 'line' : 'bar', xKey: 'mes', axes: { y: { label: 'USD' } }, series: [{ key: 'EC2', label: 'EC2' }, { key: 'RDS', label: 'RDS' }, { key: 'S3', label: 'S3' }], data: CR_MONTHS };
}
function ChatChart({ spec: spec0 }) {
  const I = window.Icons; const toast = window.useToast?.();
  const sim = window.useMango(s => s.simChart) || null;
  const [loading, setLoading] = React.useState(true);
  const [hover, setHover] = React.useState(null);
  React.useEffect(() => { setLoading(true); const t = setTimeout(() => setLoading(false), 700); return () => clearTimeout(t); }, [sim]);
  const spec = ['line', 'pie', 'scatter'].includes(sim) ? crDemoSpec(sim) : spec0;
  const shell = (body) => <div className="cr-chart">{spec.meta?.title && <div className="cr-chart-h"><div><div className="cr-chart-t">{spec.meta.title}</div>{spec.meta.subtitle && <div className="cr-chart-s">{spec.meta.subtitle}</div>}</div>{body.copy}</div>}{body.main}</div>;
  if (sim === 'loading' || loading) return shell({ main: <div className="cr-chart-load" role="status" aria-label="Cargando la gráfica"><span className="mango-spinner" /> Cargando la gráfica…</div> });
  if (sim === 'invalid') return <div className="cr-chart"><div className="mc-alert" role="status"><I.Info size={14} /><div><b>No se pudo dibujar esta gráfica.</b> Los datos que mandó el agente no tienen el formato que espera Mango. Pídele que la vuelva a generar o que te los dé en una tabla.</div></div></div>;
  const { data, xKey, series, valueFormat: vf, chartType: ct } = spec;
  const copy = () => {
    const nf = new Intl.NumberFormat(undefined, { useGrouping: false, maximumFractionDigits: 6 });
    const rows = [[xKey, ...series.map(s => s.label || s.key)].join('\t'), ...data.map(r => [r[xKey], ...series.map(s => typeof r[s.key] === 'number' ? nf.format(r[s.key]) : r[s.key] ?? '')].join('\t'))];
    navigator.clipboard?.writeText(rows.join('\n'));
    toast?.({ tone: 'success', msg: 'Datos copiados. Pégalos en Excel o en una hoja de cálculo.' });
  };
  const copyBtn = <button className="btn btn-sm btn-ghost" onClick={copy}><I.Copy size={11} /> Copiar datos</button>;
  const W = 640, H = 252, L = 48, R = 12, T = 26, B = 30, pw = W - L - R, ph = H - T - B;
  let main;
  if (ct === 'pie') {
    const k = series[0].key; const tot = data.reduce((s, r) => s + r[k], 0); let a0 = -Math.PI / 2;
    const arcs = data.map((r, i) => { const a1 = a0 + (r[k] / tot) * Math.PI * 2; const p = (a) => [120 + 92 * Math.cos(a), 120 + 92 * Math.sin(a)]; const [x0, y0] = p(a0), [x1, y1] = p(a1); const d = `M120 120 L${x0} ${y0} A92 92 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}Z`; a0 = a1; return { d, r, i }; });
    main = <div className="cr-pie"><svg viewBox="0 0 240 240" width="200" height="200" role="img" aria-label={spec.meta?.title}>{arcs.map(a => <path key={a.i} d={a.d} fill={CR_COLORS[a.i % 6]} stroke="var(--card)" strokeWidth="2" opacity={hover == null || hover === a.i ? 1 : .45} onMouseEnter={() => setHover(a.i)} onMouseLeave={() => setHover(null)}><title>{a.r[xKey]}: {crFmt(a.r[k], vf)}</title></path>)}</svg>
      <ul className="cr-legend is-col">{data.map((r, i) => <li key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}><i style={{ background: CR_COLORS[i % 6] }} />{r[xKey]}<b className="mono">{crFmt(r[k], vf)}</b><span className="mono">{Math.round(r[k] / tot * 100)} %</span></li>)}</ul></div>;
  } else {
    const vals = data.flatMap(r => series.map(s => r[s.key])).filter(v => typeof v === 'number');
    const max = Math.max(...vals) * 1.08; const y = (v) => T + ph - (v / max) * ph;
    const ticks = [0, .25, .5, .75, 1].map(f => max * f);
    const grid = <>{ticks.map((t, i) => <g key={i}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border)" /><text x={L - 6} y={y(t) + 3.5} textAnchor="end" className="cr-ax">{crFmt(t, 'compact')}</text></g>)}</>;
    let marks;
    if (ct === 'scatter') {
      const xs = data.map(r => r[xKey]); const xmax = Math.max(...xs) * 1.05; const x = (v) => L + (v / xmax) * pw; const k = series[0].key;
      marks = <>{[0, 25, 50, 75, 100].filter(v => v <= xmax).map(v => <text key={v} x={x(v)} y={H - 10} textAnchor="middle" className="cr-ax">{v}</text>)}{data.map((r, i) => <circle key={i} cx={x(r[xKey])} cy={y(r[k])} r={hover === i ? 5.5 : 4} fill={CR_COLORS[0]} fillOpacity=".75" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}><title>{spec.axes?.x?.label || xKey}: {crFmt(r[xKey], 'raw')} · {crFmt(r[k], vf)}</title></circle>)}</>;
    } else {
      const bw = pw / data.length; const cx = (i) => L + bw * i + bw / 2;
      marks = <>{data.map((r, i) => <text key={i} x={cx(i)} y={H - 10} textAnchor="middle" className="cr-ax">{r[xKey]}</text>)}
        {ct === 'line' ? series.map((s, si) => <g key={s.key}><polyline fill="none" stroke={CR_COLORS[si % 6]} strokeWidth="2" points={data.map((r, i) => cx(i) + ',' + y(r[s.key])).join(' ')} />{data.map((r, i) => <circle key={i} cx={cx(i)} cy={y(r[s.key])} r={hover === i ? 4.5 : 3} fill={CR_COLORS[si % 6]}><title>{r[xKey]} · {s.label}: {crFmt(r[s.key], vf)}</title></circle>)}</g>)
          : data.map((r, i) => { const gw = bw * .72, w = gw / series.length; return <g key={i}>{series.map((s, si) => <rect key={s.key} x={cx(i) - gw / 2 + w * si} y={y(r[s.key])} width={w - 2} height={T + ph - y(r[s.key])} rx="2" fill={CR_COLORS[si % 6]} opacity={hover == null || hover === i ? 1 : .45}><title>{r[xKey]} · {s.label}: {crFmt(r[s.key], vf)}</title></rect>)}</g>; })}
        {data.map((r, i) => <rect key={'h' + i} x={L + bw * i} y={T} width={bw} height={ph} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />)}</>;
    }
    const hv = hover != null && data[hover];
    main = <>
      <svg viewBox={`0 0 ${W} ${H}`} className="cr-svg" role="img" aria-label={spec.meta?.title}>{grid}{marks}{spec.axes?.y?.label && <text x={4} y={11} className="cr-ax">{spec.axes.y.label}</text>}</svg>
      <div className="row between cr-chart-f">
        {series.length > 1 ? <ul className="cr-legend">{series.map((s, si) => <li key={s.key}><i style={{ background: CR_COLORS[si % 6] }} />{s.label}</li>)}</ul> : <span className="cr-ax-l">{spec.axes?.x?.label}</span>}
        <span className="cr-hover mono" aria-live="polite">{hv ? (ct === 'scatter' ? `${crFmt(hv[xKey], 'raw')} % · ${crFmt(hv[series[0].key], vf)}` : hv[xKey] + ' · ' + series.map(s => s.label + ' ' + crFmt(hv[s.key], vf)).join(' · ')) : ''}</span>
      </div></>;
  }
  return shell({ main, copy: copyBtn });
}

// ---------- Tabla ----------
const CR_TABLE = (() => { const svc = ['EC2', 'S3', 'RDS', 'Lambda', 'CloudFront', 'DynamoDB'], reg = ['us-east-1', 'us-west-2', 'eu-west-1', 'sa-east-1']; return Array.from({ length: 1248 }, (_, i) => ({ cuenta: '1111111111' + String(11 + (i % 9)), servicio: svc[(i * 7) % 6], region: reg[(i * 3) % 4], costo_usd: Math.round(((i * 7919) % 9000) + 40) / 1 })).sort((a, b) => b.costo_usd - a.costo_usd); })();
const CR_TABLE_CAP = 200;
function DataTable({ table }) {
  const rows = CR_TABLE; const cols = ['cuenta', 'servicio', 'region', 'costo_usd'];
  const shown = rows.slice(0, CR_TABLE_CAP);
  return (
    <div className="cr-table">
      <div className="cr-table-h"><span className="cr-chart-t">{table.title}</span><span className="mono">{rows.length.toLocaleString()} filas · {cols.length} columnas</span></div>
      <div className="cr-table-s" tabIndex="0" role="region" aria-label={table.title}>
        <table><thead><tr>{cols.map(c => <th key={c} className={c === 'costo_usd' ? 'num' : ''}>{c}</th>)}</tr></thead>
          <tbody>{shown.map((r, i) => <tr key={i}>{cols.map(c => <td key={c} className={c === 'costo_usd' ? 'num mono' : c === 'cuenta' ? 'mono' : ''}>{c === 'costo_usd' ? crFmt(r[c], 'integer') : r[c]}</td>)}</tr>)}</tbody></table>
      </div>
      {rows.length > CR_TABLE_CAP && <div className="cr-table-f">Se muestran {CR_TABLE_CAP.toLocaleString()} de {rows.length.toLocaleString()} filas. Descarga el CSV para verlas todas.</div>}
      <FileCard file={table.file} compact />
    </div>
  );
}

function CrOutputs({ items }) {
  return <>{(items || []).map((o, i) => o.type === 'chart' ? <ChatChart key={i} spec={o.spec} /> : o.type === 'table' ? <DataTable key={i} table={o} /> : o.type === 'file' ? <FileCard key={i} file={o.file} /> : null)}</>;
}

// ---------- Reconexión del stream ----------
function ConnLine({ conn, onReconnect }) {
  const I = window.Icons;
  if (!conn) return null;
  if (conn.k === 're') return <div className="cr-conn" role="status"><span className="mango-spinner" aria-hidden="true" /> Se cortó la conexión. Reconectando… <span className="mono">intento {conn.n} de 12</span></div>;
  if (conn.k === 'ok') return <div className="cr-conn is-ok" role="status"><I.Check size={12} /> Reconectado. La respuesta sigue donde iba.</div>;
  return <div className="mc-alert amber" role="alert" style={{ marginTop: 10 }}><I.Warn size={14} /><div style={{ flex: 1 }}><b>No se pudo reconectar.</b> La respuesta puede seguir en Mango. «Volver a conectar» trae lo que haya, sin preguntar otra vez. También la verás al abrir de nuevo la conversación.</div><button className="btn btn-sm" onClick={onReconnect}><I.Refresh size={11} /> Volver a conectar</button></div>;
}

Object.assign(window, { crCanCode, crAddFiles, crRetryUpload, crAttGate, CrAttachChips, crBuildCells, crBlockState, CodeBlock, FileCard, ChatChart, DataTable, CrOutputs, ConnLine, crDemoSpec, CR_MAX_FILES, CR_MAX_MB });
