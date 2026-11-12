// Chat · código (bloque «Analizando»), figuras, archivos generados, gráfica, tabla y adjuntos (D114, D116, D118). Ronda 41: gráfica interactiva y figura grande.
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
  { code: "import matplotlib.pyplot as plt\nax = mes.tail(6).plot(kind='bar', figsize=(10, 5))\nax.set_ylabel('USD')\nplt.savefig('costo_por_servicio.png', dpi=120)\ncuentas = df.pivot_table(index=['cuenta', 'servicio', 'region'], values='costo_usd', aggfunc='sum')\ncuentas.to_csv('costo_por_cuenta.csv')\ncuentas.to_excel('detalle_costos.xlsx')", out: [{ k: 'stderr', t: "UserWarning: 14 filas sin región; se agrupan como 'sin-region'." }], figs: [{ name: 'costo_por_servicio.png', title: 'Costo por servicio, may – oct 2026', w: 1200, h: 600 }], ms: 2410 },
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

// Ronda 41: la figura sale DEBAJO del bloque, en una tarjeta grande a todo el ancho del mensaje (una figura, una tarjeta).
// Dentro del bloque plegado quedan el código, la salida y una referencia a la figura («Ir a la figura»).
function CodeBlock({ block }) {
  const I = window.Icons;
  const [open, setOpen] = React.useState(false);
  const uid = React.useId();
  const st = block.state;
  const cells = block.cells || [];
  const total = cells.reduce((s, c) => s + (c.ms || 0), 0);
  const figs = cells.flatMap(c => c.figs || []);
  const figId = (f) => 'crfig-' + uid + '-' + figs.indexOf(f);
  const err = cells.find(c => c.exc);
  const head = st === 'run' ? 'Analizando…' : st === 'error' ? 'Error' : st === 'paused' ? 'Pausado' : 'Analizado';
  return (<>
    <div className={'cr-code is-' + st} aria-busy={st === 'run'}>
      <button className="cr-code-h" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {st === 'run' ? <span className="mango-spinner" aria-hidden="true" /> : st === 'error' ? <I.X2 size={13} /> : st === 'paused' ? <I.Pause size={12} /> : <I.Check2 size={13} />}
        <span className="cr-code-t" role={st === 'run' ? 'status' : undefined}>{head}</span>
        <span className="cr-code-m mono">{cells.length} {cells.length === 1 ? 'celda' : 'celdas'}{total && st !== 'run' ? ' · ' + (window.fmtDur ? window.fmtDur(total) : total + ' ms') : ''}{figs.length ? ' · ' + figs.length + (figs.length === 1 ? ' figura' : ' figuras') : ''}</span>
        <span className="cr-code-o">{open ? 'Ocultar código' : 'Ver código'} <I.ChevronRight size={10} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} /></span>
      </button>
      {!open && st === 'error' && err && <div className="cr-code-sum mono">{err.exc.split('\n')[0]}</div>}
      {!open && st === 'paused' && <div className="cr-code-sum">Quedó sin terminar porque la respuesta se detuvo.</div>}
      {open && <div className="cr-code-b">
        {cells.map((c, i) => <div key={i} className="cr-cell">
          <div className="cr-cell-h"><span className="mono">Celda {i + 1}</span>{c.run && st === 'run' ? <span className="row gap-1"><span className="mango-spinner" aria-hidden="true" /> corriendo</span> : c.run && st === 'paused' ? <span>sin terminar</span> : c.ms ? <span className="mono">{window.fmtDur ? window.fmtDur(c.ms) : c.ms + ' ms'}</span> : null}</div>
          {c.blocked ? <div className="cr-cell-blk"><I.Lock size={12} /> Mango no muestra el código ni la salida de esta celda: infringían una regla de seguridad.</div> : <>
            {c.run && st === 'run' ? <div className="cr-note"><I.Info size={11} /> El código se ve cuando termine la celda y pase la revisión de seguridad.</div> : <pre className="cr-pre mono">{c.code}</pre>}
            {(c.out || []).map((o, j) => <div key={j} className={'cr-out is-' + o.k}><span className="cr-out-k mono">{o.k === 'stderr' ? 'STDERR' : 'STDOUT'}</span><pre className="mono">{o.t}</pre></div>)}
            {c.trunc && <div className="cr-note"><I.Info size={11} /> Salida recortada: se muestran los primeros 20.000 caracteres.</div>}
            {c.exc && <div className="cr-exc"><span className="cr-out-k mono">{c.timeout ? 'TIEMPO' : 'EXCEPCIÓN'}</span><pre className="mono">{c.exc}</pre></div>}
            {(c.figs || []).map(f => <div key={f.name} className="cr-cell-fig"><I.Image size={12} /><span className="mono">{f.name}</span><span>· figura, debajo del bloque</span><button className="sr-link" onClick={() => { const el = document.getElementById(figId(f)); el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el?.focus({ preventScroll: true }); }}>Ir a la figura</button></div>)}
          </>}
        </div>)}
      </div>}
    </div>
    {figs.map(f => <CrFigure key={f.name} fig={f} id={figId(f)} />)}
  </>);
}

function CrFigure({ fig, id }) {
  const I = window.Icons; const toast = window.useToast?.();
  const sim = window.useMango(s => s.simFig) || null;
  const [retry, setRetry] = React.useState(0);
  const [zoom, setZoom] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => { setLoading(true); const t = setTimeout(() => setLoading(false), 900); return () => clearTimeout(t); }, [retry, sim]);
  const st = sim === 'loading' || loading ? 'loading' : sim === 'error' && !retry ? 'error' : 'ok';
  const title = fig.title || fig.name;
  const dl = () => toast?.({ tone: 'success', msg: 'Descargando ' + fig.name });
  const ph = (big) => <div className={'cr-fig-img is-real' + (big ? ' big' : '')} style={{ aspectRatio: fig.w + ' / ' + fig.h }}>{window.MplFigure ? <window.MplFigure /> : <span className="mono">{fig.name}</span>}</div>;
  return (
    <figure className="cr-figcard" id={id} tabIndex="-1" aria-label={title}>
      <figcaption className="cr-figcard-h">
        <div style={{ minWidth: 0 }}><div className="cr-chart-t">{title}</div><div className="cr-chart-s mono">{fig.name} · {fig.w} × {fig.h} px</div></div>
        {st === 'ok' && <div className="cr-chart-a">
          <button className="btn btn-sm btn-ghost" aria-label={'Ampliar ' + fig.name} title="Ampliar" onClick={() => setZoom(true)}><I.Expand size={12} /><span className="cr-lbl">Ampliar</span></button>
          <button className="btn btn-sm btn-ghost" aria-label={'Descargar ' + fig.name} title="Descargar PNG" onClick={dl}><I.Download size={12} /><span className="cr-lbl">Descargar</span></button>
        </div>}
      </figcaption>
      <div className="cr-figcard-b">
        {st === 'loading' ? <div className="cr-fig-img is-load" role="status" aria-label="Cargando la figura" style={{ aspectRatio: fig.w + ' / ' + fig.h }}><span className="mango-spinner" /></div>
          : st === 'error' ? <div className="cr-fig-img is-err" role="alert" style={{ aspectRatio: fig.w + ' / ' + fig.h }}><I.Warn size={15} /><span>No se pudo cargar la figura.</span><button className="btn btn-sm" onClick={() => setRetry(r => r + 1)}><I.Refresh size={11} /> Reintentar</button></div>
          : <button className="cr-fig-btn" onClick={() => setZoom(true)} aria-label={'Ampliar ' + fig.name}>{ph()}</button>}
      </div>
      {zoom && <window.Modal open onClose={() => setZoom(false)} title={title} width={960}>{ph(true)}<div className="row between" style={{ marginTop: 12, gap: 10 }}><span className="mk-meta mono">{fig.name} · {fig.w} × {fig.h} px</span><button className="btn btn-sm" onClick={dl}><I.Download size={11} /> Descargar</button></div></window.Modal>}
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

// ---------- Gráfica interactiva (D118 · ronda 41: globo, leyenda que oculta series, teclado, «Ver datos») ----------
// Todo lo que viene del modelo (título, etiquetas, valores) se pinta como nodos de texto de React: nunca HTML.
Object.assign(window.Icons, {
  Table: window.Icons.Table || ((p) => <svg width={p?.size || 14} height={p?.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 10v10" /></svg>),
  BarChart: window.Icons.BarChart || ((p) => <svg width={p?.size || 14} height={p?.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" /></svg>),
  Image: window.Icons.Image || ((p) => <svg width={p?.size || 14} height={p?.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.75" /><path d="m21 16-5-5-9 9" /></svg>),
});
const CR_COLORS = ['var(--accent)', 'var(--blue)', 'var(--violet)', 'var(--green)', 'var(--amber)', 'var(--red)'];
const CR_MAX_ROWS = 5000, CR_MAX_SERIES = 20, CR_DT_CAP = 200;
const crNF = (o) => new Intl.NumberFormat(undefined, o);
const crFmt = (v, f, cur) => {
  if (typeof v !== 'number') return String(v ?? '');
  if (f === 'currency') { const d = Math.abs(v) >= 100 ? 0 : 2; return crNF({ style: 'currency', currency: cur || 'USD', minimumFractionDigits: d, maximumFractionDigits: d }).format(v); }
  if (f === 'currency-axis') return crNF({ style: 'currency', currency: cur || 'USD', minimumFractionDigits: 0, maximumFractionDigits: Math.abs(v) >= 100000 ? 1 : 0, ...(Math.abs(v) >= 100000 ? { notation: 'compact' } : {}) }).format(v);
  if (f === 'compact') return crNF({ notation: 'compact', maximumFractionDigits: 1 }).format(v);
  if (f === 'integer') return crNF({ maximumFractionDigits: 0 }).format(v);
  return crNF({ maximumFractionDigits: 6 }).format(v);
};
// Escala «redonda»: 0 … tope en 4–5 pasos (0, 1.500, 3.000…).
const crNice = (max) => { if (!(max > 0)) return { top: 1, step: .25 }; const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p; const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; return { top: Math.ceil(max / step) * step, step }; };
const crCut = (s, m) => { s = String(s ?? ''); return s.length > m ? s.slice(0, Math.max(1, m - 1)) + '…' : s; };
const CR_MONTHS = [['may', 41200, 9800, 12800], ['jun', 42900, 9650, 13100], ['jul', 44100, 9900, 12950], ['ago', 51800, 10100, 13300], ['sep', 55600, 10050, 13400], ['oct', 58300, 10200, 13600]].map(([mes, EC2, RDS, S3]) => ({ mes, EC2, RDS, S3 }));
const CR_DEMO_SIMS = ['line', 'pie', 'scatter', 'hbar', 'many'];
function crDemoSpec(kind) {
  const base = { valueFormat: 'currency', currency: 'USD', meta: { title: 'Costo mensual por servicio', subtitle: 'May – oct 2026 · Valores en USD' } };
  if (kind === 'pie') return { ...base, chartType: 'pie', xKey: 'servicio', series: [{ key: 'costo', label: 'Costo' }], meta: { title: 'Reparto del costo de octubre', subtitle: 'Octubre 2026 · Valores en USD' }, data: [{ servicio: 'EC2', costo: 58300 }, { servicio: 'S3', costo: 13600 }, { servicio: 'RDS', costo: 10200 }, { servicio: 'Otros', costo: 6400 }] };
  if (kind === 'scatter') return { ...base, chartType: 'scatter', xKey: 'cpu', axes: { x: { label: 'CPU media (%)' }, y: { label: 'USD / mes' } }, series: [{ key: 'costo', label: 'Instancias EC2' }], meta: { title: 'Uso contra costo por instancia', subtitle: '42 instancias · Octubre 2026' }, data: Array.from({ length: 42 }, (_, i) => ({ cpu: Math.round(4 + ((i * 37) % 88)), costo: Math.round(120 + ((i * 53) % 17) * 95 + ((i * 7) % 5) * 40) })) };
  if (kind === 'hbar') return { ...base, chartType: 'bar', layout: 'vertical', xKey: 'servicio', series: [{ key: 'oct', label: 'Octubre' }, { key: 'nov', label: 'Noviembre' }], meta: { title: 'Costo por servicio de AWS', subtitle: 'Noviembre 2026 · Valores en USD' }, data: [['Amazon Elastic Compute Cloud', 5310, 5820], ['Amazon Relational Database Service', 2050, 2140], ['Amazon Simple Storage Service', 1290, 1360], ['Amazon CloudFront', 640, 610], ['AWS Lambda', 310, 380], ['Amazon DynamoDB', 270, 290], ['Elastic Load Balancing', 235, 240], ['Amazon CloudWatch', 150, 170]].map(([servicio, oct, nov]) => ({ servicio, oct, nov })) };
  if (kind === 'many') return { ...base, chartType: 'line', xKey: 'dia', axes: { y: { label: 'USD' } }, series: [{ key: 'EC2', label: 'EC2' }, { key: 'RDS', label: 'RDS' }, { key: 'S3', label: 'S3' }], meta: { title: 'Costo diario por servicio', subtitle: '1 jul – 28 oct 2026 · 120 días · Valores en USD' }, data: Array.from({ length: 120 }, (_, i) => { const d = new Date(2026, 6, 1 + i); return { dia: d.toLocaleDateString('es', { day: 'numeric', month: 'short' }), EC2: Math.round(1300 + i * 6 + ((i * 37) % 11) * 25), RDS: Math.round(330 + ((i * 13) % 7) * 8), S3: Math.round(420 + i * 1.2 + ((i * 17) % 5) * 10) }; }) };
  return { ...base, chartType: kind === 'line' ? 'line' : 'bar', xKey: 'mes', axes: { y: { label: 'USD' } }, series: [{ key: 'EC2', label: 'EC2' }, { key: 'RDS', label: 'RDS' }, { key: 'S3', label: 'S3' }], data: CR_MONTHS };
}
const CR_KB_HINT = 'Usa las flechas para recorrer los puntos, Inicio y Fin para ir al primero y al último, y Escape para soltar el punto. «Ver datos» muestra la tabla.';

function ChatChart({ spec: spec0 }) {
  const I = window.Icons; const toast = window.useToast?.();
  const sim = window.useMango(s => s.simChart) || null;
  const [loading, setLoading] = React.useState(true);
  const [retry, setRetry] = React.useState(0);
  const [view, setView] = React.useState('chart');
  const [hidden, setHidden] = React.useState([]); // claves de serie ocultas (en la tarta: índices de porción)
  const [act, setAct] = React.useState(null); // punto activo: { i: fila, s: posición entre las series visibles | null, via: 'mouse' | 'touch' | 'kb' }
  const [hi, setHi] = React.useState(null); // serie resaltada (índice original)
  const cardRef = React.useRef(null);
  const liveId = React.useId();
  React.useEffect(() => { setLoading(true); setHidden([]); setAct(null); setHi(null); setView('chart'); const t = setTimeout(() => setLoading(false), 700); return () => clearTimeout(t); }, [sim, retry]);
  // En táctil el globo queda fijo; se cierra al tocar fuera de la tarjeta o el mismo punto otra vez.
  React.useEffect(() => { if (act?.via !== 'touch') return; const f = (e) => { if (!cardRef.current?.contains(e.target)) { setAct(null); setHi(null); } }; document.addEventListener('pointerdown', f); return () => document.removeEventListener('pointerdown', f); }, [act?.via]);

  const spec = CR_DEMO_SIMS.includes(sim) ? crDemoSpec(sim) : spec0;
  const head = (actions) => (spec?.meta?.title || actions) ? <div className="cr-chart-h"><div style={{ minWidth: 0 }}>{spec?.meta?.title && <div className="cr-chart-t">{spec.meta.title}</div>}{spec?.meta?.subtitle && <div className="cr-chart-s">{spec.meta.subtitle}</div>}</div>{actions}</div> : null;
  if (sim === 'loading' || loading) return <div className="cr-chart">{head()}<div className="cr-chart-load" role="status" aria-label="Cargando la gráfica"><span className="mango-spinner" /> Cargando la gráfica…</div></div>;
  if (sim === 'held') return <div className="cr-chart">{head()}<div className="mc-alert amber" role="status"><I.Lock size={14} /><div><b>Gráfica retenida por seguridad.</b> Sus datos infringían una regla de seguridad y Mango no la muestra. El resto de la respuesta sigue.</div></div></div>;
  if (sim === 'error' && !retry) return <div className="cr-chart">{head()}<div className="mc-alert" role="alert"><I.Warn size={14} /><div style={{ flex: 1 }}><b>No se pudo cargar la gráfica.</b> Inténtalo de nuevo.</div><button className="btn btn-sm" onClick={() => setRetry(r => r + 1)}><I.Refresh size={11} /> Reintentar</button></div></div>;
  const valid = spec && Array.isArray(spec.data) && spec.data.length > 0 && spec.data.length <= CR_MAX_ROWS && Array.isArray(spec.series) && spec.series.length > 0 && spec.series.length <= CR_MAX_SERIES;
  if (sim === 'invalid' || !valid) return <div className="cr-chart"><div className="mc-alert" role="status"><I.Info size={14} /><div><b>No se pudo dibujar esta gráfica.</b> Los datos que mandó el agente no tienen el formato que espera Mango. Pídele que la vuelva a generar o que te los dé en una tabla.</div></div></div>;

  const { data, xKey, series, valueFormat: vf, currency: cur } = spec; const ct = spec.chartType;
  const isPie = ct === 'pie', isSc = ct === 'scatter', horiz = ct === 'bar' && spec.layout === 'vertical';
  const fv = (v) => crFmt(v, vf, cur);
  const fa = (v) => crFmt(v, vf === 'currency' ? 'currency-axis' : 'compact', cur);
  const sLabel = (s) => s.label || s.key;
  const color = (i) => CR_COLORS[i % CR_COLORS.length];
  const xLabel = spec.axes?.x?.label || xKey;
  const yLabel = spec.axes?.y?.label || sLabel(series[0]);
  const vis = isPie ? [] : series.map((s, si) => ({ ...s, si })).filter(s => !hidden.includes(s.key));
  const visRows = isPie ? data.map((_, i) => i).filter(i => !hidden.includes(i)) : null;
  const multi = !isPie && vis.length > 1;
  const clear = () => { setAct(null); setHi(null); };
  const toggle = (k) => { setHidden(h => h.includes(k) ? h.filter(x => x !== k) : [...h, k]); clear(); };

  // Copiar datos (D118 (4)): TSV con todas las filas y todas las series, también las ocultas.
  const copy = () => {
    const nf = crNF({ useGrouping: false, maximumFractionDigits: 6 });
    const rows = [[xLabel, ...series.map(sLabel)].join('\t'), ...data.map(r => [r[xKey], ...series.map(s => typeof r[s.key] === 'number' ? nf.format(r[s.key]) : r[s.key] ?? '')].join('\t'))];
    navigator.clipboard?.writeText(rows.join('\n'));
    toast?.({ tone: 'success', msg: 'Datos copiados. Pégalos en Excel o en una hoja de cálculo.' });
  };
  const actions = <div className="cr-chart-a">
    <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setView(v => v === 'chart' ? 'table' : 'chart'); clear(); }}>{view === 'chart' ? <><I.Table size={12} /> Ver datos</> : <><I.BarChart size={12} /> Ver gráfica</>}</button>
    <button type="button" className="btn btn-ghost btn-icon" aria-label="Copiar datos" title="Copiar datos (se pegan en Excel)" onClick={copy}><I.Copy size={12} /></button>
  </div>;

  // ---- Vista de tabla ----
  if (view === 'table') {
    const tot = isPie ? data.reduce((s, r) => s + (r[series[0].key] || 0), 0) : 0;
    const cols = isPie ? [xLabel, sLabel(series[0]), '% del total'] : isSc ? [xLabel, yLabel] : [xLabel, ...series.map(sLabel)];
    const shown = data.slice(0, CR_DT_CAP);
    return <div className="cr-chart" ref={cardRef}>{head(actions)}
      <div className="cr-dt" tabIndex="0" role="region" aria-label={'Datos de ' + (spec.meta?.title || 'la gráfica')}>
        <table><caption className="sr-only">{spec.meta?.title || 'Datos de la gráfica'}{spec.meta?.subtitle ? ' · ' + spec.meta.subtitle : ''}</caption>
          <thead><tr>{cols.map((c, j) => <th key={j} scope="col" className={j ? 'num' : ''}>{c}</th>)}</tr></thead>
          <tbody>{shown.map((r, i) => <tr key={i}><th scope="row" className={isSc ? 'mono' : ''}>{isSc ? crFmt(r[xKey], 'raw') : String(r[xKey] ?? '')}</th>
            {isPie ? <><td className="num mono">{fv(r[series[0].key])}</td><td className="num mono">{crFmt(Math.round(r[series[0].key] / tot * 1000) / 10, 'raw')} %</td></>
              : isSc ? <td className="num mono">{fv(r[series[0].key])}</td>
              : series.map(s => <td key={s.key} className="num mono">{fv(r[s.key])}</td>)}</tr>)}</tbody></table>
      </div>
      {data.length > CR_DT_CAP && <div className="cr-dt-f">Se muestran {CR_DT_CAP.toLocaleString()} de {data.length.toLocaleString()} filas. «Copiar datos» las copia todas.</div>}
    </div>;
  }

  // ---- Recorrido (ratón, toque y teclado comparten el mismo punto activo) ----
  const order = isPie ? visRows : isSc ? data.map((_, i) => i).sort((a, b) => data[a][xKey] - data[b][xKey]) : data.map((_, i) => i);
  const n = order.length;
  const setPoint = (h, via) => { if (act && act.i === h.i && act.s === h.s && act.via === via) return; setAct({ ...h, via }); setHi(multi && h.s != null && vis[h.s] ? vis[h.s].si : null); };
  const onKey = (e) => {
    const K = e.key;
    if (K === 'Escape') { if (act) { e.preventDefault(); clear(); } return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(K)) return;
    e.preventDefault();
    const c = act || { i: order[0], s: 0 };
    let p = Math.max(0, order.indexOf(c.i)), s = Math.min(c.s ?? 0, Math.max(0, vis.length - 1));
    if (act) {
      const cat = isPie || isSc ? [['ArrowLeft', 'ArrowUp'], ['ArrowRight', 'ArrowDown']] : horiz ? [['ArrowUp'], ['ArrowDown']] : [['ArrowLeft'], ['ArrowRight']];
      const ser = isPie || isSc ? null : horiz ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      const pg = Math.max(1, Math.round(n / 10));
      if (cat[0].includes(K)) p = Math.max(0, p - 1); else if (cat[1].includes(K)) p = Math.min(n - 1, p + 1);
      else if (K === 'Home') p = 0; else if (K === 'End') p = n - 1;
      else if (K === 'PageUp') p = Math.max(0, p - pg); else if (K === 'PageDown') p = Math.min(n - 1, p + pg);
      else if (ser && K === ser[0]) s = Math.max(0, s - 1); else if (ser && K === ser[1]) s = Math.min(vis.length - 1, s + 1);
    }
    setPoint({ i: order[p], s: isPie ? null : s }, 'kb');
  };
  const onFocus = (e) => { let fv2 = true; try { fv2 = e.currentTarget.matches(':focus-visible'); } catch (_) {} if (!act && fv2) setPoint({ i: order[0], s: isPie ? null : 0 }, 'kb'); };
  const onBlur = () => { if (act?.via === 'kb') clear(); };
  const plotProps = { tabIndex: 0, role: 'application', 'aria-roledescription': 'gráfica', 'aria-label': (spec.meta?.title || 'Gráfica') + '. ' + CR_KB_HINT, 'aria-describedby': liveId, onKeyDown: onKey, onFocus, onBlur };

  let main, tip = null, live = '';
  const tipBox = (x, y, side, h, rows, foot) => <div className={'cr-tip is-' + side} style={{ left: x + '%', top: y + '%' }} aria-hidden="true">
    <div className="cr-tip-h">{h}</div>
    {rows.map((r, j) => <div key={j} className={'cr-tip-r' + (r.on ? ' is-on' : '')}>{r.c && <i style={{ background: r.c }} />}<span>{r.label}</span><b className="mono">{r.v}</b></div>)}
    {foot && <div className="cr-tip-f">{foot}</div>}
  </div>;

  if (isPie) {
    const k = series[0].key; const tot = visRows.reduce((s, i) => s + data[i][k], 0); let a0 = -Math.PI / 2;
    const arcs = visRows.map(i => { const r = data[i]; const a1 = a0 + (r[k] / tot) * Math.PI * 2; const p = (a, rad = 92) => [120 + rad * Math.cos(a), 120 + rad * Math.sin(a)]; const [x0, y0] = p(a0), [x1, y1] = p(a1); const full = visRows.length === 1; const d = full ? 'M120 28 A92 92 0 1 1 119.99 28Z' : `M120 120 L${x0} ${y0} A92 92 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}Z`; const [mx, my] = p((a0 + a1) / 2, 58); a0 = a1; return { d, r, i, mx, my }; });
    const pin = (i, e) => { if (e.pointerType === 'mouse') return; if (act?.via === 'touch' && act.i === i) clear(); else setPoint({ i, s: null }, 'touch'); };
    if (act && visRows.includes(act.i)) {
      const a = arcs.find(x => x.i === act.i); const r = data[act.i]; const pct = crFmt(Math.round(r[k] / tot * 1000) / 10, 'raw') + ' %';
      tip = tipBox(a.mx / 240 * 100, a.my / 240 * 100, 'r', String(r[xKey] ?? ''), [{ c: color(act.i), label: sLabel(series[0]), v: fv(r[k]) }, { label: hidden.length ? 'De lo visible' : 'Del total', v: pct }]);
      live = `${r[xKey]} · ${fv(r[k])} · ${pct}${act.via === 'kb' ? ' · ' + (order.indexOf(act.i) + 1) + ' de ' + n : ''}`;
    }
    main = <div className="cr-pie">
      <div className="cr-plot is-pie" {...plotProps}>
        <svg viewBox="0 0 240 240" aria-hidden="true">{arcs.map(a => <path key={a.i} d={a.d} fill={color(a.i)} stroke="var(--card)" strokeWidth="2" opacity={!act || act.i === a.i ? 1 : .4} onPointerEnter={(e) => e.pointerType === 'mouse' && setPoint({ i: a.i, s: null }, 'mouse')} onPointerLeave={(e) => e.pointerType === 'mouse' && act?.via === 'mouse' && clear()} onPointerDown={(e) => pin(a.i, e)} />)}
          {act?.via === 'kb' && arcs.filter(a => a.i === act.i).map(a => <path key="ring" d={a.d} fill="none" stroke="var(--text-strong)" strokeWidth="2" />)}</svg>
        {tip}
      </div>
      <ul className="cr-legend is-col" aria-label="Porciones">{data.map((r, i) => { const off = hidden.includes(i), last = !off && visRows.length === 1; return <li key={i}>
        <button type="button" className={'cr-leg' + (off ? ' is-off' : '') + (act?.i === i ? ' is-hi' : '')} aria-pressed={!off} aria-disabled={last || undefined} title={last ? 'Tiene que quedar al menos una porción a la vista' : (off ? 'Mostrar ' : 'Ocultar ') + r[xKey]} onClick={() => !last && toggle(i)} onPointerEnter={(e) => e.pointerType === 'mouse' && !off && setPoint({ i, s: null }, 'mouse')} onPointerLeave={(e) => e.pointerType === 'mouse' && act?.via === 'mouse' && clear()}>
          <i style={{ background: off ? 'transparent' : color(i), borderColor: color(i) }} /><span className="cr-leg-n">{String(r[xKey] ?? '')}</span><b className="mono">{fv(r[k])}</b><span className="mono">{off ? '–' : Math.round(r[k] / tot * 100) + ' %'}</span>
        </button></li>; })}</ul>
    </div>;
  } else {
    const W = 640, R = 16, T = horiz ? 8 : 26, L = horiz ? 196 : 58, B = 30;
    const rowH = horiz ? Math.min(10 + 9 * vis.length, 640 / data.length) : 0;
    const H = horiz ? T + data.length * rowH + B : 252; const pw = W - L - R, ph = H - T - B;
    const k0 = vis[0].key;
    const vals = (isSc ? data.map(r => r[k0]) : data.flatMap(r => vis.map(s => r[s.key]))).filter(v => typeof v === 'number');
    const { top, step } = crNice(Math.max(0, ...vals)); const ticks = []; for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
    const vy = (v) => T + ph - (v / top) * ph, vx = (v) => L + (v / top) * pw;
    const bw = pw / data.length, cx = (i) => L + bw * i + bw / 2, cy = (i) => T + rowH * i + rowH / 2;
    const xsc = isSc ? crNice(Math.max(...data.map(r => r[xKey]))) : null; const sx = (v) => L + (v / xsc.top) * pw;
    const toVB = (e) => { const b = e.currentTarget.getBoundingClientRect(); return [(e.clientX - b.left) / b.width * W, (e.clientY - b.top) / b.height * H]; };
    const hit = (e) => {
      const [x, y] = toVB(e);
      if (x < L - 4 || x > W - R + 4 || y < T - 4 || y > T + ph + 4) return null;
      if (isSc) { let best = null, bd = 20 * 20; data.forEach((r, i) => { const dx = sx(r[xKey]) - x, dy = vy(r[k0]) - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }); return best == null ? null : { i: best, s: 0 }; }
      const i = Math.max(0, Math.min(data.length - 1, Math.floor(horiz ? (y - T) / rowH : (x - L) / bw)));
      let s = null;
      if (ct === 'line') { let bd = 14; vis.forEach((sr, p) => { const v = data[i][sr.key]; if (typeof v !== 'number') return; const d = Math.abs(vy(v) - y); if (d < bd) { bd = d; s = p; } }); }
      else { const g = (horiz ? rowH : bw) * .72, w = g / vis.length, off = horiz ? y - (cy(i) - g / 2) : x - (cx(i) - g / 2); if (off >= 0 && off < g) s = Math.min(vis.length - 1, Math.floor(off / w)); }
      return { i, s };
    };
    const move = (e) => { if (e.pointerType !== 'mouse') return; const h = hit(e); if (!h) { if (act?.via === 'mouse') clear(); return; } setPoint(h, 'mouse'); };
    const leave = (e) => { if (e.pointerType === 'mouse' && act?.via === 'mouse') clear(); };
    const down = (e) => { if (e.pointerType === 'mouse') return; const h = hit(e); if (!h || (act?.via === 'touch' && act.i === h.i)) { clear(); return; } setPoint(h, 'touch'); };
    const dimS = (si) => hi != null && hi !== si;
    const ai = act ? act.i : null;
    const ring = act?.via === 'kb';
    let marks;
    if (isSc) {
      const xt = []; for (let t = 0; t <= xsc.top + xsc.step / 2; t += xsc.step) xt.push(t);
      marks = <>{xt.map(v => <text key={v} x={sx(v)} y={H - 10} textAnchor="middle" className="cr-ax">{crFmt(v, 'compact')}</text>)}
        {data.map((r, i) => <circle key={i} cx={sx(r[xKey])} cy={vy(r[k0])} r={ai === i ? 6 : 4} fill={color(vis[0].si)} fillOpacity={ai == null || ai === i ? .8 : .35} stroke={ai === i && ring ? 'var(--text-strong)' : 'none'} strokeWidth="1.5" />)}</>;
    } else {
      const maxLab = Math.max(1, Math.floor(horiz ? ph / 14 : pw / 46)), labStep = Math.ceil(data.length / maxLab);
      const catLab = data.map((r, i) => i % labStep ? null : horiz
        ? <text key={i} x={L - 8} y={cy(i) + 3.5} textAnchor="end" className={'cr-ax' + (ai === i ? ' is-on' : '')}>{crCut(r[xKey], 30)}</text>
        : <text key={i} x={cx(i)} y={H - 10} textAnchor="middle" className={'cr-ax' + (ai === i ? ' is-on' : '')}>{crCut(r[xKey], Math.max(3, Math.floor(bw * labStep / 6.5)))}</text>);
      const band = ai != null && ct !== 'line' && (horiz ? <rect x={L} y={T + rowH * ai} width={pw} height={rowH} fill="var(--row-hover)" /> : <rect x={L + bw * ai} y={T} width={bw} height={ph} fill="var(--row-hover)" />);
      let body;
      if (ct === 'line') {
        body = <>{ai != null && <line x1={cx(ai)} x2={cx(ai)} y1={T} y2={T + ph} stroke="var(--text-dim)" strokeDasharray="3 3" opacity=".7" />}
          {vis.map((s, p) => <g key={s.key} opacity={dimS(s.si) ? .25 : 1}>
            <polyline fill="none" stroke={color(s.si)} strokeWidth={hi === s.si ? 2.75 : 2} strokeLinejoin="round" points={data.map((r, i) => typeof r[s.key] === 'number' ? cx(i) + ',' + vy(r[s.key]) : null).filter(Boolean).join(' ')} />
            {data.length <= 60 && data.map((r, i) => typeof r[s.key] === 'number' && <circle key={i} cx={cx(i)} cy={vy(r[s.key])} r="3" fill={color(s.si)} />)}
            {ai != null && typeof data[ai][s.key] === 'number' && <circle cx={cx(ai)} cy={vy(data[ai][s.key])} r="5" fill={color(s.si)} stroke="var(--card)" strokeWidth="2" />}
            {ai != null && ring && act.s === p && <circle cx={cx(ai)} cy={vy(data[ai][s.key])} r="8.5" fill="none" stroke="var(--text-strong)" strokeWidth="1.5" />}
          </g>)}</>;
      } else {
        body = data.map((r, i) => { const g = (horiz ? rowH : bw) * .72, w = g / vis.length, gap = w > 6 ? 2 : 0; return <g key={i}>{vis.map((s, p) => { const v = typeof r[s.key] === 'number' ? r[s.key] : 0; const dim = (ai != null && ai !== i) || dimS(s.si); const on = ring && ai === i && act.s === p;
          return horiz ? <rect key={s.key} x={L} y={cy(i) - g / 2 + w * p} width={Math.max(0, vx(v) - L)} height={Math.max(1, w - gap)} rx="2" fill={color(s.si)} opacity={dim ? .35 : 1} stroke={on ? 'var(--text-strong)' : 'none'} strokeWidth="1.5" />
            : <rect key={s.key} x={cx(i) - g / 2 + w * p} y={vy(v)} width={Math.max(1, w - gap)} height={T + ph - vy(v)} rx="2" fill={color(s.si)} opacity={dim ? .35 : 1} stroke={on ? 'var(--text-strong)' : 'none'} strokeWidth="1.5" />; })}</g>; });
      }
      marks = <>{band}{catLab}{body}</>;
    }
    const grid = ticks.map((t, i) => horiz
      ? <g key={i}><line x1={vx(t)} x2={vx(t)} y1={T} y2={T + ph} stroke="var(--border)" /><text x={vx(t)} y={H - 10} textAnchor="middle" className="cr-ax">{fa(t)}</text></g>
      : <g key={i}><line x1={L} x2={W - R} y1={vy(t)} y2={vy(t)} stroke="var(--border)" /><text x={L - 6} y={vy(t) + 3.5} textAnchor="end" className="cr-ax">{fa(t)}</text></g>);

    if (act && data[act.i]) {
      const r = data[act.i]; const pos = order.indexOf(act.i) + 1;
      if (isSc) {
        const x = sx(r[xKey]), y = vy(r[k0]);
        tip = tipBox(x / W * 100, Math.min(Math.max(y, H * .25), H * .75) / H * 100, x > W * .6 ? 'l' : 'r', sLabel(vis[0]), [{ label: xLabel, v: crFmt(r[xKey], 'raw') }, { label: yLabel, v: fv(r[k0]) }]);
        live = `${xLabel} ${crFmt(r[xKey], 'raw')} · ${yLabel} ${fv(r[k0])}${act.via === 'kb' ? ' · ' + pos + ' de ' + n : ''}`;
      } else {
        const rows = vis.map((s, p) => ({ c: color(s.si), label: sLabel(s), v: fv(r[s.key]), on: multi && act.s === p }));
        const vmax = Math.max(0, ...vis.map(s => typeof r[s.key] === 'number' ? r[s.key] : 0));
        const ax = horiz ? (ct === 'line' ? 0 : vx(vmax)) : cx(act.i), ay = horiz ? cy(act.i) : vy(vmax);
        tip = tipBox(ax / W * 100, Math.min(Math.max(ay, H * .25), H * .75) / H * 100, ax > W * .6 ? 'l' : 'r', String(r[xKey] ?? ''), rows, hidden.length ? hidden.length + (hidden.length === 1 ? ' serie oculta' : ' series ocultas') : null);
        const one = multi && act.via === 'kb' && act.s != null ? [rows[act.s]] : rows;
        live = `${r[xKey]} · ${one.map(x => x.label + ' ' + x.v).join(' · ')}${act.via === 'kb' ? ' · ' + pos + ' de ' + n : ''}`;
      }
    }
    main = <>
      <div className="cr-plot" {...plotProps}>
        <svg viewBox={`0 0 ${W} ${H}`} className="cr-svg" aria-hidden="true" onPointerMove={move} onPointerLeave={leave} onPointerDown={down}>{grid}{marks}{!horiz && spec.axes?.y?.label && <text x={4} y={11} className="cr-ax">{spec.axes.y.label}</text>}</svg>
        {tip}
      </div>
      <div className="row between cr-chart-f">
        {series.length > 1 ? <ul className="cr-legend" aria-label="Series">{series.map((s, si) => { const off = hidden.includes(s.key), last = !off && vis.length === 1; return <li key={s.key}>
          <button type="button" className={'cr-leg' + (off ? ' is-off' : '') + (hi === si ? ' is-hi' : '')} aria-pressed={!off} aria-disabled={last || undefined} title={last ? 'Tiene que quedar al menos una serie a la vista' : (off ? 'Mostrar ' : 'Ocultar ') + sLabel(s)} onClick={() => !last && toggle(s.key)} onPointerEnter={(e) => e.pointerType === 'mouse' && !off && setHi(si)} onPointerLeave={(e) => e.pointerType === 'mouse' && act?.via !== 'kb' && setHi(null)} onFocus={() => !off && setHi(si)} onBlur={() => setHi(null)}>
            <i style={{ background: off ? 'transparent' : color(si), borderColor: color(si) }} />{sLabel(s)}</button></li>; })}
          {hidden.length > 0 && <li><button type="button" className="sr-link" onClick={() => { setHidden([]); clear(); }}>Mostrar todas</button></li>}</ul>
          : <span className="cr-ax-l">{isSc ? xLabel : spec.axes?.x?.label}</span>}
      </div></>;
  }
  return <div className="cr-chart" ref={cardRef}>{head(actions)}{main}<div id={liveId} className="cr-hover sr-only" aria-live="polite">{live}</div></div>;
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
