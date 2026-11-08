// Canvas (D124): documento o código junto al chat, con versiones, cambios, comentarios del agente, exportar y vista previa aislada (D123).
(function () {
const DOC_V = [
  { by: 'agent', at: '12:04', note: 'Primer borrador', text: '## Análisis de costos — Octubre 2026\n\n### Resumen\n\nGasto del mes **USD 124.530**, +14 % contra septiembre.\n\n### Drivers\n\n| Servicio | Mes | Δ |\n|---|---:|---:|\n| EC2-Other | 48.210 | +18 % |\n| S3 Standard | 31.890 | +11 % |\n| Bedrock | 18.440 | +240 % |\n\n### Recomendaciones\n\n1. Migrar `events-ingest` a Intelligent-Tiering — USD 1.100/mes\n2. Eliminar snapshots EBS huérfanos — USD 540/mes' },
  { by: 'you', at: '12:09', note: 'Editado por ti', text: '## Análisis de costos — Octubre 2026\n\n### Resumen\n\nGasto del mes **USD 124.530**, +14 % contra septiembre. Dentro de la proyección anual, con tres drivers atípicos.\n\n### Drivers\n\n| Servicio | Mes | Δ |\n|---|---:|---:|\n| EC2-Other | 48.210 | +18 % |\n| S3 Standard | 31.890 | +11 % |\n| Bedrock | 18.440 | +240 % |\n\n### Recomendaciones\n\n1. Migrar `events-ingest` a Intelligent-Tiering — USD 1.100/mes\n2. Eliminar snapshots EBS huérfanos — USD 540/mes\n3. Consolidar NAT Gateways en us-east-1 — USD 320/mes' },
  { by: 'agent', at: '12:11', note: 'Agregó el ahorro total', text: '## Análisis de costos — Octubre 2026\n\n### Resumen\n\nGasto del mes **USD 124.530**, +14 % contra septiembre. Dentro de la proyección anual, con tres drivers atípicos.\n\n### Drivers\n\n| Servicio | Mes | Δ |\n|---|---:|---:|\n| EC2-Other | 48.210 | +18 % |\n| S3 Standard | 31.890 | +11 % |\n| Bedrock | 18.440 | +240 % |\n\n### Recomendaciones\n\n1. Migrar `events-ingest` a Intelligent-Tiering — USD 1.100/mes\n2. Eliminar snapshots EBS huérfanos — USD 540/mes\n3. Consolidar NAT Gateways en us-east-1 — USD 320/mes\n\n**Ahorro estimado: USD 1.960/mes.**' },
];
const DOC_C = [{ id: 'c1', quote: 'Bedrock | 18.440 | +240 %', text: 'Este aumento es el rollout de Mango: está dentro de lo previsto. ¿Lo saco de «drivers atípicos»?' }, { id: 'c2', quote: 'Consolidar NAT Gateways', text: 'El ahorro supone tráfico constante entre zonas. Con el tráfico de octubre puede ser la mitad.' }];
const CODE_V = [
  { by: 'agent', at: '15:20', note: 'Primer borrador', text: "import pandas as pd\nimport matplotlib.pyplot as plt\n\ndf = pd.DataFrame({\n    'mes': ['may', 'jun', 'jul', 'ago', 'sep', 'oct'],\n    'EC2': [41200, 42900, 44100, 51800, 55600, 58300],\n})\nprint(df.describe())" },
  { by: 'agent', at: '15:24', note: 'Agregó RDS, S3 y la figura', text: "import pandas as pd\nimport matplotlib.pyplot as plt\n\ndf = pd.DataFrame({\n    'mes': ['may', 'jun', 'jul', 'ago', 'sep', 'oct'],\n    'EC2': [41200, 42900, 44100, 51800, 55600, 58300],\n    'RDS': [9800, 9650, 9900, 10100, 10050, 10200],\n    'S3': [12800, 13100, 12950, 13300, 13400, 13600],\n}).set_index('mes')\nprint(df.pct_change().iloc[-1].round(3))\ndf.plot(kind='bar', ylabel='USD')\nplt.show()" },
];
const CODE_C = [{ id: 'c1', quote: 'pct_change()', text: 'Muestra solo el cambio de septiembre a octubre. Si quieres desde mayo, cambio a iloc[0].' }];
const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function lineDiff(a, b) { const A = a.split('\n'), B = b.split('\n'); const sa = new Set(A), sb = new Set(B); const out = []; let i = 0, j = 0; while (i < A.length || j < B.length) { if (i < A.length && j < B.length && A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; } else if (j < B.length && !sa.has(B[j])) out.push(['+', B[j++]]); else if (i < A.length && !sb.has(A[i])) out.push(['-', A[i++]]); else { if (i < A.length) out.push(['-', A[i++]]); if (j < B.length) out.push(['+', B[j++]]); } } return out; }

function CanvasPanel({ artifact, onClose, agent, onExport, onAsk }) {
  const I = window.Icons; const toast = window.useToast?.();
  const isCode = artifact.kind === 'code';
  const [vers, setVers] = React.useState(isCode ? CODE_V : DOC_V);
  const [cur, setCur] = React.useState((isCode ? CODE_V : DOC_V).length - 1);
  const [comments, setComments] = React.useState(isCode ? CODE_C : DOC_C);
  const [diff, setDiff] = React.useState(false);
  const [hist, setHist] = React.useState(false);
  const [exp, setExp] = React.useState(false);
  const [edit, setEdit] = React.useState(null);
  const [tab, setTab] = React.useState(isCode ? 'preview' : 'doc');
  React.useEffect(() => { const v = isCode ? CODE_V : DOC_V; setVers(v); setCur(v.length - 1); setComments(isCode ? CODE_C : DOC_C); setDiff(false); setEdit(null); setTab(isCode ? 'preview' : 'doc'); }, [artifact.id]);
  const last = vers.length - 1; const v = vers[cur]; const old = cur !== last;
  const who = (x) => x.by === 'you' ? 'ti' : agent.name;
  const addVer = (text, note) => { setVers(vs => [...vs, { by: 'you', at: 'ahora', note, text }]); setCur(vers.length); setDiff(false); };
  const fileName = artifact.title.replace(/[^\wÀ-ÿ\- ]/g, '').trim().replace(/\s+/g, '_');
  const doExport = (ext) => { setExp(false); if (ext === 'md' || ext === 'py') { toast?.({ tone: 'success', msg: 'Descargando ' + fileName + '.' + ext }); return; } onExport?.({ name: fileName + '.' + ext, size: ext === 'pdf' ? 182000 : 46000, agent: agent.name }); toast?.({ tone: 'info', msg: 'Generando ' + ext.toUpperCase() + '. Aparecerá en la conversación.' }); };
  let html = '';
  if (!isCode && !diff && edit == null) { html = window.renderMarkdown(v.text); if (!old) comments.forEach(c => { const q = esc(c.quote.split(' | ')[0]); html = html.replace(q, '<mark class="cv-mark" data-c="' + c.id + '">' + q + '</mark>'); }); }
  return (
    <aside className="cv" aria-label={'Canvas: ' + artifact.title}>
      <div className="cv-h">
        <span className="cv-h-ic">{isCode ? <I.Terminal size={14} /> : <I.Document size={14} />}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cv-h-t">{artifact.title}</div>
          <div className="cv-h-s">Canvas · {isCode ? 'Código · Python' : 'Documento'} · v{cur + 1} de {vers.length} · {v.by === 'you' ? 'editada por ti' : 'de ' + agent.name}</div>
        </div>
        <button className="btn btn-ghost btn-icon" aria-label="Historial de versiones" title="Historial" aria-pressed={hist} onClick={() => setHist(h => !h)}><I.History size={13} /></button>
        <div style={{ position: 'relative' }}>
          <button className="btn btn-ghost btn-sm" aria-expanded={exp} onClick={() => setExp(x => !x)}><I.Download size={11} /> Exportar</button>
          {exp && <div className="popover cv-menu" role="menu">{(isCode ? [['py', '.py', 'Se descarga al momento']] : [['md', '.md', 'Se descarga al momento'], ['docx', 'Word (.docx)', 'Se genera y llega al chat como archivo'], ['pdf', 'PDF', 'Se genera y llega al chat como archivo']]).map(([k, l, s]) => <button key={k} role="menuitem" onClick={() => doExport(k)}><span>{l}</span><span className="mk-meta">{s}</span></button>)}</div>}
        </div>
        <button className="btn btn-ghost btn-icon" aria-label="Cerrar Canvas" onClick={onClose}><I.Close size={13} /></button>
      </div>
      <div className="cv-bar">
        {isCode && <div className="tk-quick" role="tablist">{[['code', 'Código'], ['preview', 'Vista previa']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>}
        {(!isCode || tab === 'code') && <button className={'btn btn-sm ' + (diff ? 'btn-primary' : 'btn-ghost')} aria-pressed={diff} disabled={cur === 0 || edit != null} title={cur === 0 ? 'Es la primera versión' : 'Comparar con v' + cur} onClick={() => setDiff(x => !x)}><I.Diff size={11} /> Mostrar cambios</button>}
        <span style={{ flex: 1 }} />
        {(!isCode || tab === 'code') && !old && (edit == null ? <button className="btn btn-sm btn-ghost" onClick={() => { setEdit(v.text); setDiff(false); }}><I.Edit size={11} /> Editar</button> : <><button className="btn btn-sm" onClick={() => setEdit(null)}>Descartar</button><button className="btn btn-sm btn-primary" disabled={edit === v.text} onClick={() => { addVer(edit, 'Editado por ti'); setEdit(null); toast?.({ tone: 'success', msg: 'Guardado como v' + (vers.length + 1) + '.' }); }}>Guardar versión</button></>)}
      </div>
      {old && <div className="cv-old" role="status"><I.History size={13} /><span style={{ flex: 1 }}>Estás viendo v{cur + 1} · {v.at} · {v.by === 'you' ? 'tuya' : 'de ' + agent.name}.</span><button className="btn btn-sm" onClick={() => setCur(last)}>Ir a la actual</button><button className="btn btn-sm btn-primary" onClick={() => { addVer(v.text, 'Restaurada de v' + (cur + 1)); toast?.({ tone: 'success', msg: 'v' + (cur + 1) + ' restaurada como v' + (vers.length + 1) + '.' }); }}>Restaurar esta versión</button></div>}
      <div className="cv-main">
        <div className="cv-body">
          {isCode && tab === 'preview' ? <CanvasPreview code={v.text} /> : edit != null ? <textarea className="cv-edit mono" value={edit} onChange={e => setEdit(e.target.value)} aria-label="Editar el contenido" spellCheck={!isCode} />
            : diff ? <><div className="cv-diff-h">Cambios de v{cur} a v{cur + 1} · {v.note}</div><pre className="rv-diff cv-diff">{lineDiff(vers[cur - 1].text, v.text).map(([k, t], n) => <div key={n} className={k === '+' ? 'add' : k === '-' ? 'rem' : ''}><span>{k}</span>{t || ' '}</div>)}</pre></>
            : isCode ? <pre className="cv-code mono">{v.text}</pre>
            : <div className="md cv-doc" dangerouslySetInnerHTML={{ __html: html }} />}
          {!old && edit == null && !diff && !(isCode && tab === 'preview') && comments.length > 0 && <div className="cv-cmts">
            <div className="cv-cmts-t"><I.Comment size={12} /> {comments.length} {comments.length === 1 ? 'comentario' : 'comentarios'} de {agent.name}</div>
            {comments.map(c => <div key={c.id} className="cv-cmt">
              <div className="cv-cmt-q mono">{c.quote}</div>
              <div className="cv-cmt-x">{c.text}</div>
              <div className="row gap-2"><button className="btn btn-sm btn-ghost" onClick={() => setComments(cs => cs.filter(x => x.id !== c.id))}><I.Check size={11} /> Resolver</button><button className="btn btn-sm btn-ghost" onClick={() => onAsk?.('Sobre «' + c.quote.split(' | ')[0] + '» en el Canvas: ')}><I.Chat size={11} /> Responder en el chat</button></div>
            </div>)}
          </div>}
        </div>
        {hist && <div className="cv-hist" aria-label="Versiones">
          <div className="cv-hist-t">Versiones</div>
          {[...vers].map((x, i) => ({ x, i })).reverse().map(({ x, i }) => <button key={i} className={'cv-hist-i' + (i === cur ? ' is-on' : '')} aria-current={i === cur} onClick={() => { setCur(i); setDiff(false); setEdit(null); if (isCode) setTab('code'); }}><span className="mono">v{i + 1}</span><span style={{ flex: 1, minWidth: 0 }}><span className="cv-hist-n">{x.note}</span><span className="mk-meta">{x.at} · {who(x)}</span></span>{i === last && <span className="badge">Actual</span>}</button>)}
          <div className="mk-meta" style={{ padding: '10px 12px' }}>Las versiones viven lo que vive la conversación.</div>
        </div>}
      </div>
    </aside>
  );
}

// Vista previa: corre en el navegador, en otro origen y en un marco aislado. Mango solo sabe el estado; lo de dentro lo pinta el marco.
const PV_STATE = { init: ['Preparando', 'run'], run: ['Ejecutando', 'run'], ok: ['Lista', 'ok'], error: ['Error en el código', 'err'], 'init-timeout': ['No arrancó a tiempo', 'err'], timeout: ['Tiempo agotado', 'err'] };
function CanvasPreview({ code }) {
  const I = window.Icons;
  const sim = window.useMango(s => s.simCanvas) || null;
  const [st, setSt] = React.useState('init'); const [n, setN] = React.useState(0);
  React.useEffect(() => { if (sim && sim !== 'ok') { setSt(sim); return; } setSt('init'); const a = setTimeout(() => setSt('run'), 1400), b = setTimeout(() => setSt('ok'), 2600); return () => { clearTimeout(a); clearTimeout(b); }; }, [sim, n, code]);
  const [lbl, tone] = PV_STATE[st];
  return <div className="cv-pv">
    <div className="cv-pv-h"><span className="cv-origin"><I.Lock size={11} /> Vista previa · contenido del agente, no de Mango</span><span className={'cv-pv-st is-' + tone} role="status">{tone === 'run' ? <span className="mango-spinner" aria-hidden="true" /> : tone === 'ok' ? <I.Check size={11} /> : <I.Warn size={11} />} {lbl}</span><button className="btn btn-sm btn-ghost" disabled={tone === 'run'} onClick={() => { window.MangoStore.set({ simCanvas: null }); setN(x => x + 1); }}><I.Play size={11} /> Ejecutar de nuevo</button></div>
    <div className="cv-frame">
      {st === 'init' ? <div className="cv-fr-msg"><span className="mango-spinner" /> <div><b>Preparando Python…</b><div>La primera vez descarga Python, numpy, pandas y matplotlib (decenas de MB). Tiene 20 s para arrancar.</div></div></div>
        : st === 'run' ? <div className="cv-fr-msg"><span className="mango-spinner" /> <div><b>Ejecutando…</b><div>Tope de 50 s por ejecución.</div></div></div>
        : st === 'error' ? <pre className="cv-fr-err mono">{'Traceback (most recent call last):\n  File "<canvas>", line 1, in <module>\nModuleNotFoundError: No module named \'seaborn\'\n\nSolo hay numpy, pandas y matplotlib. No se instalan paquetes.'}</pre>
        : st === 'init-timeout' ? <div className="cv-fr-msg is-err"><I.Warn size={14} /><div><b>La vista previa no arrancó en 20 s.</b><div>Puede ser la red de tu equipo al descargar los paquetes. Vuelve a ejecutarla.</div></div></div>
        : st === 'timeout' ? <div className="cv-fr-msg is-err"><I.Warn size={14} /><div><b>La ejecución pasó su tope de 50 s y se detuvo.</b></div></div>
        : <><pre className="cv-fr-out mono">{'EC2    0.049\nRDS    0.015\nS3     0.015\nName: oct, dtype: float64'}</pre><div className="cv-fr-fig"><window.MplFigure /></div></>}
    </div>
    <div className="cv-pv-f">Corre en tu navegador, aislado de Mango, sin red y sin costo de modelo. Dentro no funcionan formularios, ventanas emergentes, diálogos, descargas ni enlaces.</div>
  </div>;
}

Object.assign(window, { CanvasPanel });
})();
