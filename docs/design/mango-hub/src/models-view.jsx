// Brains — modelos de Amazon Bedrock en la cuenta del cliente
const { useState: useState_mv, useEffect: useEffect_mv } = React;
const MV_STATUS = {
  enabled: ['Habilitado', 'badge-green'],
  available: ['Disponible en Bedrock', 'badge'],
  disabled: ['Deshabilitado', 'badge'],
  noaccess: ['Sin acceso', 'badge-red'],
};
const mvCtx = (n) => n >= 1e6 ? (n / 1e6).toLocaleString('es-ES') + 'M' : Math.round(n / 1000) + 'k';
const mvKnown = (m) => !window.MangoStore.get().avail || m.provider === 'Anthropic' || m.provider === 'Amazon';
const mvHasPrice = (m) => mvKnown(m) || !!m.confirmed;
const mvPrice = (n) => n == null ? 'Sin precio' : 'USD ' + (n < 1 ? n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: window.MangoStore.get().avail ? 4 : 3 }) : n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const mvAgo = (min) => new Date(Date.now() - min * 864e5 / 24 / 60 * 60 * 24).toISOString();
const mvShort = (n) => n >= 1e6 ? (n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' M' : n >= 1e3 ? (n / 1e3).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' k' : String(n);

function ModelsView({ models, setModels, agents }) {
  const I = window.Icons; const S = window.MangoStore;
  const toast = window.useToast?.();
  window.useMango(s => s.role);
  const isAdmin = S.get().role === 'admin';
  const avail = window.useMango(s => s.avail);
  const simB = window.useMango(s => s.simBrains) || null;
  const never = avail && simB === 'never';
  const [q, setQ] = useState_mv('');
  const [status, setStatus] = useState_mv('all');
  const [provider, setProvider] = useState_mv('all');
  const [cap, setCap] = useState_mv({ tools: false, vision: false });
  const [sel, setSel] = useState_mv(null);
  const [sync, setSync] = useState_mv({ at: new Date(Date.now() - 42 * 60000), busy: false });
  const update = (fn) => setModels(prev => { const n = fn(prev); window.MangoData.models = n; return n; });
  const region = models[0]?.region || 'us-east-1';
  const usedBy = (m) => agents.filter(a => a.model === m.short || (avail && (a.availableModels || []).includes(m.short)));
  const mName = (m) => never ? m.modelId : m.name;
  const caps = (m) => mvKnown(m) ? m.caps : { tools: false, vision: false };
  const providers = [...new Set(models.map(m => m.provider))];
  const Q = q.trim().toLowerCase();
  const base = models.filter(m => (provider === 'all' || m.provider === provider) && (!cap.tools || m.caps.tools) && (!cap.vision || m.caps.vision) && (!Q || (m.name + ' ' + m.provider + ' ' + m.modelId).toLowerCase().includes(Q)));
  const list = base.filter(m => status === 'all' || m.status === status).sort((a, b) => ['enabled', 'available', 'disabled', 'noaccess'].indexOf(a.status) - ['enabled', 'available', 'disabled', 'noaccess'].indexOf(b.status) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  const cnt = (k) => base.filter(m => m.status === k).length;
  const anyFilter = Q || status !== 'all' || provider !== 'all' || cap.tools || cap.vision;
  const selected = sel && models.find(m => m.id === sel);
  const refresh = () => { setSync(s => ({ ...s, busy: true })); setTimeout(() => { setSync({ at: new Date(), busy: false }); const n = never ? models.length : 0; if (never) S.set({ simBrains: null }); S.log('model.catalog_sync', 'bedrock', 'Consultó el catálogo de Bedrock' + (n ? ' · ' + n + ' modelos nuevos' : '')); toast?.({ tone: 'success', msg: 'Catálogo de Bedrock actualizado · ' + (n ? n + (n === 1 ? ' modelo nuevo' : ' modelos nuevos') : 'sin modelos nuevos') }); }, 1200); };
  if (avail && !isAdmin) return <><Topbar crumbs={['Construir', 'Brains']} /><div className="content"><div className="g-denied"><window.GovKit.Empty icon="Lock" title="No tienes acceso a esta sección">Brains es solo para administradores de Mango.</window.GovKit.Empty></div></div></>;

  const act = {
    enable: (m, inP, outP) => { update(ms => ms.map(x => x.id === m.id ? { ...x, status: 'enabled', inputPrice: inP, outputPrice: outP, confirmed: { by: S.actor(), at: 0 }, disabledBy: null } : x)); S.log('model.enable', m.modelId, `Habilitó ${m.name} · entrada ${mvPrice(inP)} / salida ${mvPrice(outP)} por millón de tokens`, { after: { inputPrice: inP, outputPrice: outP } }); toast?.({ tone: 'success', msg: m.name + ' habilitado · ya aparece en el Agent Builder' }); },
    price: (m, inP, outP) => { update(ms => ms.map(x => x.id === m.id ? { ...x, inputPrice: inP, outputPrice: outP, confirmed: { by: S.actor(), at: 0 } } : x)); S.log('model.price', m.modelId, `Actualizó precios de ${m.name}`, { before: { inputPrice: m.inputPrice, outputPrice: m.outputPrice }, after: { inputPrice: inP, outputPrice: outP } }); toast?.({ tone: 'success', msg: 'Precios actualizados' }); },
    disable: (m, reason) => { update(ms => ms.map(x => x.id === m.id ? { ...x, status: 'disabled', disabledBy: S.actor(), disabledReason: reason } : x)); S.log('model.disable', m.modelId, `Deshabilitó ${m.name}${reason ? ': ' + reason : ''}`); toast?.({ tone: 'info', msg: m.name + ' deshabilitado' }); },
  };

  return (
    <>
      <Topbar crumbs={['Construir', 'Brains']} actions={<button className="btn btn-sm" onClick={refresh} disabled={sync.busy}>{sync.busy ? <><span className="g-spin" /> Consultando Bedrock…</> : <><I.Refresh size={12} /> Actualizar catálogo</>}</button>} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Brains</h1>
          <p className="page-subtitle">Modelos de Amazon Bedrock disponibles para Mango. Solo los habilitados se pueden elegir al crear agentes, y sus precios se usan para calcular y bloquear presupuestos.</p>
        </div>
        <div className="mv-conn">
          <span className="gv-ic" style={{ color: 'var(--green)', background: 'var(--green-soft)' }}><I.Shield size={14} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Conectado a Amazon Bedrock · <span className="mono">{region}</span></div>
            <div className="mk-meta">{never ? 'Todavía no se ha consultado el catálogo de Bedrock.' : 'Última consulta del catálogo ' + window.fmtAgo(sync.at.toISOString()) + '.'}</div>
          </div>
        </div>
        <div className="ap-bar" style={{ borderTop: 'none' }}>
          <div className="ap-filters" style={{ borderTop: 'none' }}>
            <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}><I.Search size={13} /><input className="input" placeholder="Buscar modelo, proveedor o ID" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar modelos" /></div>
            <div className="tk-quick mv-status-f" role="group" aria-label="Estado">
              {[['all', 'Todos', base.length], ['enabled', 'Habilitados', cnt('enabled')], ['available', 'Disponibles', cnt('available')], ['disabled', 'Deshabilitados', cnt('disabled')], ['noaccess', 'Sin acceso', cnt('noaccess')]].map(([k, l, n]) => <button key={k} className={status === k ? 'is-on' : ''} aria-pressed={status === k} onClick={() => setStatus(k)}>{l}<span className="mk-count">{n}</span></button>)}
            </div>
            <select className="input mk-sel" value={provider} onChange={e => setProvider(e.target.value)} aria-label="Proveedor"><option value="all">Todos los proveedores</option>{providers.map(p => <option key={p}>{p}</option>)}</select>
            <label className="row gap-2" style={{ fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={cap.tools} onChange={e => setCap({ ...cap, tools: e.target.checked })} style={{ accentColor: 'var(--accent)' }} /> Uso de tools</label>
            <label className="row gap-2" style={{ fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={cap.vision} onChange={e => setCap({ ...cap, vision: e.target.checked })} style={{ accentColor: 'var(--accent)' }} /> Visión</label>
            {anyFilter && <button className="btn btn-sm btn-ghost" onClick={() => { setQ(''); setStatus('all'); setProvider('all'); setCap({ tools: false, vision: false }); }}>Limpiar</button>}
          </div>
        </div>

        <div className="mc-body">
          {list.length === 0 ? <div className="mk-empty"><div style={{ fontSize: 14, fontWeight: 600 }}>Ningún modelo coincide</div><div className="mk-meta">Prueba quitando algún filtro.</div></div> : (
            <div className="card mc-table">
              <div className="mv-tr mc-th"><span>modelo</span><span>estado</span><span>capacidades</span><span style={{ textAlign: 'right' }}>entrada / salida · por M</span><span>agentes</span><span>uso · 30 días</span></div>
              {list.map(m => { const u = usedBy(m).length; const [sl, sc] = MV_STATUS[m.status]; return (
                <button key={m.id} className={'mv-tr' + (m.status === 'noaccess' ? ' is-dim' : '')} onClick={() => setSel(m.id)}>
                  <span style={{ minWidth: 0 }}>
                    <span className="row gap-2" style={{ minWidth: 0 }}><span className={'mk-name' + (never ? ' mono' : '')} style={{ overflowWrap: 'anywhere' }}>{mName(m)}</span>{m.default && <span className="badge badge-accent" style={{ fontSize: 10.5 }}>Por defecto</span>}</span>
                    <span className="mk-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.provider} · <span className="mono">{m.modelId}</span></span>
                  </span>
                  <span><span className={'badge ' + sc}>{sl}</span></span>
                  <span className="row gap-1" style={{ flexWrap: 'wrap' }}>
                    {caps(m).tools && <span className="mv-cap" title="Uso de tools"><I.Terminal size={11} /> Tools</span>}
                    {caps(m).vision && <span className="mv-cap" title="Visión"><I.Eye size={11} /> Visión</span>}
                    {mvKnown(m) && <span className="mv-cap" title="Tamaño de contexto">{mvCtx(m.contextWindow)}</span>}
                  </span>
                  <span className="mono" style={{ fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>{mvHasPrice(m) ? mvPrice(m.inputPrice) + ' / ' + mvPrice(m.outputPrice) : <span className="mk-meta" style={{ fontFamily: 'var(--font-sans)' }}>Sin precio</span>}</span>
                  <span className="mk-meta">{u || '—'}</span>
                  <span className="mk-meta">{m.metrics && !avail ? <span className="mono" style={{ fontSize: 12 }}>{mvShort(m.metrics.calls)} llamadas · USD {mvShort(m.metrics.cost)}</span> : 'Sin datos'}</span>
                </button>
              ); })}
            </div>
          )}

          <section style={{ marginTop: 28 }}>
            <div className="mk-sec-t">proveedores fuera de AWS · próximamente</div>
            <div className="mv-soon">
              {[['Google Gemini', 'Gemini 2.5 Pro, Flash'], ['OpenAI', 'GPT-4.1, o-series']].map(([n, s]) => (
                <div key={n} className="card mv-soon-c">
                  <div className="row between" style={{ gap: 8 }}><span className="mk-name">{n}</span><span className="badge">Próximamente</span></div>
                  <div className="mk-meta" style={{ marginTop: 2 }}>{s}</div>
                  <div className="mv-soon-w"><I.Warn size={12} /> Los datos salen de AWS</div>
                </div>
              ))}
              <div className="mv-soon-note">Cuando lleguen estarán desactivados por defecto. Habilitarlos pedirá la aprobación de un segundo administrador y solo una API key, que no se vuelve a mostrar después de guardarla. No se admiten modelos locales ni endpoints propios.</div>
            </div>
          </section>
        </div>
      </div>
      {selected && <ModelDetail m={selected} agents={usedBy(selected)} isAdmin={isAdmin} act={act} onClose={() => setSel(null)} name={mName(selected)} caps={caps(selected)} />}
    </>
  );
}

function ModelDetail({ m, agents, isAdmin, act, onClose, name, caps }) {
  const I = window.Icons; const avail = window.MangoStore.get().avail; const simB = window.MangoStore.get().simBrains;
  const known = mvKnown(m); const hasPrice = mvHasPrice(m);
  const [srvErr, setSrvErr] = useState_mv(null);
  const SRV = { conflict: 'Otro administrador cambió este modelo mientras lo editabas. Cierra el panel y vuelve a abrirlo.', forbidden: 'No tienes acceso para cambiar modelos.', audit: 'No se pudo registrar el cambio en Auditoría, así que no se aplicó. Inténtalo de nuevo.' };
  const guard = (fn) => () => { setSrvErr(null); if (avail && SRV[simB]) { setSrvErr(SRV[simB]); return; } fn(); };
  const [mode, setMode] = useState_mv(null);
  const [inP, setInP] = useState_mv(hasPrice ? String(m.inputPrice).replace('.', ',') : '');
  const [outP, setOutP] = useState_mv(hasPrice ? String(m.outputPrice).replace('.', ',') : '');
  const [ok, setOk] = useState_mv(false);
  const [reason, setReason] = useState_mv('');
  useEffect_mv(() => { const h = e => e.key === 'Escape' && onClose(); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const badDot = (s) => /\./.test(s) && !/^\d{1,3}(\.\d{3})+(,\d*)?$/.test(String(s).trim());
  const num = (s) => avail && badDot(s) ? NaN : Number(String(s).replace(/\./g, '').replace(',', '.'));
  const vIn = num(inP), vOut = num(outP);
  const tooFine = (s) => /,\d{5,}$/.test(String(s).trim());
  const pErr = avail && (badDot(inP) || badDot(outP)) ? 'Usa coma para los decimales (0,8). El punto solo separa miles.' : !(vIn > 0) || !(vOut > 0) ? 'Los precios deben ser mayores que 0' : avail && (vIn > 100000 || vOut > 100000 || tooFine(inP) || tooFine(outP)) ? 'Cada precio debe estar entre 0 y USD 100.000 por millón, con hasta 4 decimales.' : null;
  const changed = hasPrice && (vIn !== m.listInput || vOut !== m.listOutput);
  const [sl, sc] = MV_STATUS[m.status];
  const perK = (vIn * 3000 + vOut * 800) / 1e6;

  const priceForm = (confirmLabel, onConfirm) => (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="mk-meta">Confirma los precios de Bedrock para {m.region}. Se usan para calcular el gasto y bloquear presupuestos.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
        {[['Entrada', inP, setInP, 'mv-in'], ['Salida', outP, setOutP, 'mv-out']].map(([l, v, s, id]) => (
          <div key={id} style={{ minWidth: 0 }}><label htmlFor={id} style={{ fontSize: 12.5, fontWeight: 500, display: 'block', marginBottom: 5 }}>{l} · por millón</label>
            <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 8, paddingLeft: 10, background: 'var(--card)' }}><span className="mono mk-meta">USD</span><input id={id} inputMode="decimal" value={v} onChange={e => s(e.target.value)} style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, minWidth: 0, padding: '7px 8px', font: 'inherit', color: 'var(--text)' }} /></div>
          </div>
        ))}
      </div>
      {changed && !pErr && <div className="mc-alert amber" style={{ fontSize: 12.5 }}><I.Warn size={13} /><div>Difiere del precio de lista de Bedrock ({mvPrice(m.listInput)} / {mvPrice(m.listOutput)}). Úsalo solo si tienes un precio negociado.</div></div>}
      {avail && !pErr && hasPrice && vIn !== m.inputPrice && <div className="mk-meta">Los precios de lectura y escritura de caché se ajustan en la misma proporción que el de entrada.</div>}
      {pErr ? <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{pErr}</div> : <div className="mk-meta">Una consulta típica (3.000 tokens de entrada, 800 de salida) costaría ≈ USD {perK.toLocaleString('es-ES', { maximumFractionDigits: 4 })}.</div>}
      <label className="row gap-2" style={{ fontSize: 13, cursor: 'pointer', alignItems: 'flex-start' }}><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} style={{ accentColor: 'var(--accent)', marginTop: 3 }} /> Confirmo que estos precios son correctos para esta cuenta.</label>
      <div className="row gap-2"><button className="btn btn-sm btn-primary" disabled={!ok || !!pErr} onClick={guard(() => { onConfirm(vIn, vOut); setMode(null); })}>{confirmLabel}</button><button className="btn btn-sm btn-ghost" onClick={() => setMode(null)}>Cancelar</button></div>
    </div>
  );

  let foot = null;
  if (!isAdmin) foot = <div className="ap-reason"><I.Lock size={12} /> Solo los administradores pueden habilitar o deshabilitar modelos.</div>;
  else if (m.status === 'noaccess') foot = <div className="ap-reason"><I.Info size={12} /> Se resuelve en la consola de Bedrock de tu cuenta de AWS, no desde Mango.</div>;
  else if (mode === 'enable') foot = priceForm('Habilitar modelo', (i, o) => act.enable(m, i, o));
  else if (mode === 'price') foot = priceForm('Guardar precios', (i, o) => act.price(m, i, o));
  else if (mode === 'disable') foot = (
    <div style={{ display: 'grid', gap: 8 }}>
      {agents.length > 0 ? <div className="mc-alert amber" style={{ display: 'block', fontSize: 12.5 }}><div style={{ fontWeight: 600, marginBottom: 4 }}>{agents.length === 1 ? 'Un agente publicado lo usa' : agents.length + ' agentes publicados lo usan'}</div>{agents.map(a => <div key={a.id}>· {a.name}</div>)}<div style={{ marginTop: 6, color: 'var(--text-muted)' }}>{avail ? 'Lo siguen usando hasta que se publique otra versión. No se podrá elegir en versiones nuevas.' : 'Quedarán afectados hasta que se apruebe un cambio con otro modelo.'}</div></div> : <div className="mk-meta">Ningún agente publicado lo usa.</div>}
      <label htmlFor="mv-why" style={{ fontSize: 12.5, fontWeight: 500 }}>Motivo <span className="mk-meta">· opcional</span></label>
      <input id="mv-why" className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="Queda en el Audit log" />
      <div className="row gap-2"><button className="btn btn-sm mk-danger" onClick={guard(() => { act.disable(m, reason.trim()); setMode(null); })}>Deshabilitar</button><button className="btn btn-sm btn-ghost" onClick={() => setMode(null)}>Cancelar</button></div>
    </div>
  );
  else if (m.status === 'enabled') foot = <div className="row gap-2"><button className="btn btn-sm" onClick={() => { setOk(false); setMode('price'); }}>Editar precios</button><button className="btn btn-sm" onClick={() => setMode('disable')} disabled={m.default} title={m.default ? 'Es el modelo por defecto' : undefined}>Deshabilitar</button></div>;
  else foot = <button className="btn btn-sm btn-primary" onClick={() => { setOk(false); setMode('enable'); }}>{m.status === 'disabled' ? 'Volver a habilitar' : 'Habilitar en Mango'}</button>;

  return (
    <div className="mk-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="mk-drawer" style={{ width: 500 }} role="dialog" aria-modal="true" aria-label={m.name}>
        <div className="mk-drawer-h">
          <span className="mc-ic lg"><I.Bot size={20} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={avail && name !== m.name ? 'mono' : undefined} style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)', overflowWrap: 'anywhere' }}>{name || m.name}</div>
            <div className="row gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}><span className={'badge ' + sc}>{sl}</span><span className="mk-meta">{m.provider} · vía Amazon Bedrock</span></div>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={14} /></button>
        </div>
        <div className="mk-drawer-b">
          {m.status === 'noaccess' && <div className="mc-alert red"><I.Lock size={14} /><div><b>Sin acceso.</b> {avail ? 'Bedrock no listó este modelo en la última consulta. Mango no sabe si la cuenta tiene el acceso concedido: revísalo en la consola de Bedrock.' : `La cuenta no tiene acceso a este modelo en Bedrock o no existe en ${m.region}. Pídelo al administrador de AWS desde la consola de Bedrock.`}</div></div>}
          {m.status === 'disabled' && m.disabledBy && <div className="mc-alert"><I.Info size={14} /><div>Deshabilitado por {m.disabledBy}{m.disabledReason ? ': “' + m.disabledReason + '”' : ''}.</div></div>}
          <MkSec title="Identificación">
            <div className="mk-kv"><span>Modelo o perfil</span><span className="mono" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>{m.modelId}</span></div>
            <div className="mk-kv"><span>Región</span><span className="mono">{m.region}</span></div>
            <div className="mk-kv"><span>Proveedor</span><span>{m.provider}</span></div>
          </MkSec>
          <MkSec title="Capacidades">
            <div className="mk-kv"><span>Uso de tools</span><span>{caps.tools ? 'Sí' : 'No'}</span></div>
            <div className="mk-kv"><span>Visión</span><span>{caps.vision ? 'Sí' : 'No'}</span></div>
            <div className="mk-kv"><span>Contexto</span>{known ? <span className="mono">{m.contextWindow.toLocaleString('es-ES', { useGrouping: 'always' })} tokens</span> : <span className="mk-meta">Sin datos</span>}</div>
            {!caps.tools && <div className="mk-meta">{known ? 'Sin uso de tools: solo sirve para agentes que no consultan MCP.' : 'La instalación no conoce este modelo: entra sin uso de tools y solo sirve para agentes sin MCP.'}</div>}
          </MkSec>
          <MkSec title="Precio por millón de tokens">
            {hasPrice ? <><div className="mk-kv"><span>Entrada</span><span className="mono">{mvPrice(m.inputPrice)}</span></div>
            <div className="mk-kv"><span>Salida</span><span className="mono">{mvPrice(m.outputPrice)}</span></div>
            {avail && <><div className="mk-kv"><span>Lectura de caché</span><span className="mono">{mvPrice(Math.round(m.inputPrice * 0.1 * 1e4) / 1e4)}</span></div><div className="mk-kv"><span>Escritura de caché</span><span className="mono">{mvPrice(Math.round(m.inputPrice * 1.25 * 1e4) / 1e4)}</span></div></>}
            <div className="mk-meta">{m.confirmed ? 'Confirmado por ' + m.confirmed.by + '.' : 'Precio de lista de Bedrock. Se confirma al habilitarlo.'}</div></>
            : <div className="mk-meta">Sin precio todavía. Se indica al habilitarlo.</div>}
          </MkSec>
          <MkSec title={`Agentes que lo usan · ${agents.length}`}>
            {agents.length ? agents.map(a => <div key={a.id} className="mk-line row between"><span>{a.name}</span><span className="mk-meta">{a.cat}</span></div>) : <div className="mk-meta">Ninguno.</div>}
          </MkSec>
          <MkSec title="Uso · últimos 30 días">
            {m.metrics && !avail ? <><div className="mk-kv"><span>Llamadas</span><span className="mono">{m.metrics.calls.toLocaleString('es-ES', { useGrouping: 'always' })}</span></div><div className="mk-kv"><span>Tokens</span><span className="mono">{mvShort(m.metrics.tokens)}</span></div><div className="mk-kv"><span>Costo</span><span className="mono">{window.GovKit ? window.GovKit.usd(m.metrics.cost) : m.metrics.cost}</span></div></> : <div className="mk-meta">Sin datos. Aparecerán cuando haya llamadas reales.</div>}
          </MkSec>
        </div>
        {foot && <div className="mc-foot">{srvErr && <div className="g-err" role="alert" style={{ marginBottom: 10 }}>{srvErr}</div>}{foot}</div>}
      </aside>
    </div>
  );
}

Object.assign(window, { ModelsView });
