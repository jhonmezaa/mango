// Políticas de aprobación por tool de escritura. Cambiarlas lo propone un admin y lo aprueba otro.
const POL_COND = { always: 'Siempre', amount: 'Según monto', count: 'Según cantidad de recursos', env: 'Según entorno' };
const POL_EXP = [1, 4, 24, 48, 72];
const polDefault = { cond: 'always', approvers: 1, expiresH: 24 };
const polEff = (p) => p;
// Datos que informa cada tool al pedir la acción. Disponible hoy: solo el monto, y solo en las tools que lo informan.
const TOOL_REPORTS = { 'aws-budgets.create_budget': ['amount'], 'sap-s4-hana.release_payment': ['amount'] };
const polCondOff = (toolId, k) => k !== 'always' && window.MangoStore.get().avail && !(TOOL_REPORTS[toolId] || []).includes(k);
const polMoney = (n) => window.GovKit ? window.GovKit.usd(n || 0) : n;
const polText = (p) => p.cond === 'amount' ? 'Más de ' + polMoney(p.amount) : p.cond === 'count' ? 'Más de ' + (p.count || 1) + ' recursos' : p.cond === 'env' ? 'En ' + (p.env || 'prod') : 'Siempre';
const polBelow = (p) => p.cond === 'amount' ? 'Hasta ' + polMoney(p.amount) : p.cond === 'count' ? 'Hasta ' + (p.count || 1) + ' recursos' : p.cond === 'env' ? 'Fuera de ' + (p.env || 'prod') : null;
// Ninguna condición deja una tool de escritura sin confirmación: por debajo del umbral confirma el propio usuario; por encima, N aprobadores distintos de quien la pidió.
function approvalTier(tool, params = {}) {
  const pol = polEff({ ...polDefault, ...((window.MangoStore.get().toolPolicies || {})[tool] || {}) });
  // Si falta el dato o no se puede interpretar, se usa el tramo de aprobadores.
  const n = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) || Number(v) <= 0) ? null : Number(v);
  const known = pol.cond === 'always' || (pol.cond === 'amount' ? n(params.amount) !== null : pol.cond === 'count' ? n(params.count) !== null : pol.cond === 'env' ? ['prod', 'staging'].includes(params.env) : false);
  const above = !known || pol.cond === 'always' ? true : pol.cond === 'amount' ? n(params.amount) > (pol.amount || 0) : pol.cond === 'count' ? n(params.count) > (pol.count || 1) : params.env === (pol.env || 'prod');
  return { tier: above ? 'approvers' : 'self', pol, rule: !known ? 'No se pudo determinar ' + ({ amount: 'el monto', count: 'la cantidad', env: 'el entorno' })[pol.cond] + ' · ' + pol.approvers + (pol.approvers === 1 ? ' aprobador distinto' : ' aprobadores distintos') + ' de quien la pide' : above ? polText(pol) + ' · ' + pol.approvers + (pol.approvers === 1 ? ' aprobador distinto' : ' aprobadores distintos') + ' de quien la pide' : polBelow(pol) + ' · confirma quien la pide' };
}
const polSummary = (p) => (polBelow(p) ? polBelow(p) + ': confirma el usuario · ' : '') + polText(p) + ': ' + p.approvers + (p.approvers === 1 ? ' aprobador' : ' aprobadores') + ' · vence en ' + p.expiresH + ' h';

function writeTools() {
  const S = window.MangoStore;
  const cat = S.get().mcpCatalog || [];
  const fromCat = cat.flatMap(s => s.tools.filter(t => t.write).map(t => ({ id: s.id + '.' + t.name, server: s.name, desc: t.desc, status: s.status })));
  const extra = Object.keys(S.get().toolPolicies || {}).filter(id => !fromCat.some(x => x.id === id)).map(id => ({ id, server: id.split('.')[0], desc: '', status: 'enabled' }));
  return [...fromCat, ...extra];
}

function PoliciesPanel() {
  const I = window.Icons; const S = window.MangoStore;
  const pols = window.useMango(s => s.toolPolicies);
  const changes = window.useMango(s => s.changes);
  window.useMango(s => s.mcpCatalog);
  const role = window.useMango(s => s.role);
  const [edit, setEdit] = useState(null);
  const tools = writeTools();
  const pendingOf = (id) => changes.find(c => c.kind === 'policy' && c.target === id && c.status === 'pending');
  return (
    <div style={{ padding: '0 28px 40px' }}>
      <div className="ap-note" style={{ margin: '0 0 14px' }}><I.Info size={13} /> Ninguna tool de escritura se ejecuta sin confirmación. Por debajo del umbral, la confirma el propio usuario en el chat («¿Ejecutar esta acción?», queda auditada); por encima, la aprueban personas distintas de quien la pidió. Si falta el monto, la cantidad o el entorno, o no se puede interpretar, se piden aprobadores. Lo que no se resuelve a tiempo queda «Vencida». Cambiar una política lo aprueba otro admin.</div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="pol-tr mc-th"><span>tool de escritura</span><span>confirmación del usuario · aprobación</span><span>aprobadores</span><span>vence en</span><span /></div>
        {tools.map(t => { const p = polEff({ ...polDefault, ...(pols[t.id] || {}) }); const pend = pendingOf(t.id); return (
          <div key={t.id} className="pol-tr">
            <span style={{ minWidth: 0 }}><span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-strong)' }}>{t.id}</span>{t.status === 'soon' && <span style={{ marginLeft: 6 }}><window.SoonTag /></span>}{pend && <span className="badge badge-amber" style={{ marginLeft: 6 }}>Cambio pendiente</span>}<span className="mk-meta" style={{ display: 'block' }}>{t.server}{t.desc ? ' · ' + t.desc : ''}</span></span>
            <span style={{ fontSize: 13 }}>{polBelow(p) && <span className="mk-meta" style={{ display: 'block' }}>{polBelow(p)}: confirma el usuario</span>}<span style={{ display: 'block' }}>{polText(p)}: aprobación</span></span>
            <span className="mk-meta">{p.approvers}</span>
            <span className="mk-meta">{p.expiresH} h · luego vence</span>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>{role === 'admin' && <button className="btn btn-sm btn-ghost" disabled={!!pend} title={pend ? 'Tiene un cambio pendiente' : 'Proponer cambio'} aria-label={'Editar política de ' + t.id} onClick={() => setEdit({ tool: t, p })}><I.Edit size={12} /></button>}</span>
          </div>
        ); })}
      </div>
      <window.ChangeList kind="policy" title="Cambios de políticas" />
      {edit && <PolicyModal tool={edit.tool} p={edit.p} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PolicyModal({ tool, p: p0, onClose }) {
  const S = window.MangoStore; const K = window.GovKit;
  const toast = window.useToast?.();
  const p = polEff(p0);
  const [f, setF] = useState({ ...p });
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const same = JSON.stringify(f) === JSON.stringify(p);
  const err = f.cond === 'amount' && !(f.amount > 0) ? 'Escribe un monto mayor que 0' : f.cond === 'count' && !(f.count >= 1) ? 'Mínimo 1 recurso' : !reason.trim() ? 'El motivo es obligatorio' : null;
  const submit = () => { setTried(true); if (err || same) return; S.propose({ kind: 'policy', key: tool.id, target: tool.id, from: p, to: f, title: 'Política de ' + tool.id, summary: polSummary(p) + ' → ' + polSummary(f), reason: reason.trim() }); toast?.({ tone: 'success', msg: 'Propuesta enviada · la debe aprobar otro admin' }); onClose(); };
  return (
    <K.Modal title={'Política de aprobación'} sub={tool.id + ' · el cambio se aplica cuando otro admin lo apruebe'} onClose={onClose} autoFocus={false}
      footer={<><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={same} onClick={submit}>Enviar propuesta</button></>}>
      <div className="g-field">
        <label>Cuándo pide aprobación de otras personas</label>
        <div className="set-choice">{Object.entries(POL_COND).map(([k, l]) => { const off = polCondOff(tool.id, k); return <button key={k} className={f.cond === k ? 'is-on' : ''} disabled={off} title={off ? 'Esta tool no informa ese dato' : undefined} onClick={() => setF({ ...f, cond: k })}>{l}</button>; })}</div>
        {Object.keys(POL_COND).some(k => polCondOff(tool.id, k)) && <div className="g-hint">Las opciones deshabilitadas dependen de datos que esta tool no informa.</div>}
        {f.cond === 'amount' && <K.MoneyInput id="pol-amt" label="Monto" value={String(f.amount ?? '')} onChange={(v) => setF({ ...f, amount: K.parseMoney(v).value || 0 })} hint={'Hasta este monto, la acción pide la confirmación del propio usuario en el chat (queda auditada). Por encima, requiere ' + f.approvers + (f.approvers === 1 ? ' aprobador distinto' : ' aprobadores distintos') + ' de quien la pidió.'} />}
        {f.cond === 'always' && <div className="g-hint">Cada uso requiere {f.approvers === 1 ? 'un aprobador distinto' : f.approvers + ' aprobadores distintos'} de quien la pidió.</div>}
        {f.cond === 'count' && <div className="g-hint">Hasta esta cantidad confirma el propio usuario en el chat; por encima, se necesitan aprobadores.</div>}
        {f.cond === 'env' && <div className="g-hint">En el entorno elegido se necesitan aprobadores; en los demás confirma el propio usuario en el chat.</div>}
        {f.cond === 'count' && <div className="row gap-2" style={{ alignItems: 'center' }}><input type="number" min="1" className="input" style={{ width: 90 }} value={f.count || 1} onChange={e => setF({ ...f, count: +e.target.value })} aria-label="Recursos" /><span className="g-hint">recursos por solicitud</span></div>}
        {f.cond === 'env' && <div className="set-choice">{['prod', 'staging'].map(e => <button key={e} className={(f.env || 'prod') === e ? 'is-on' : ''} onClick={() => setF({ ...f, env: e })}>{e}</button>)}</div>}
      </div>
      <div className="g-field">
        <label>Aprobadores necesarios</label>
        <div className="set-choice">{[1, 2, 3].map(n => <button key={n} className={f.approvers === n ? 'is-on' : ''} onClick={() => setF({ ...f, approvers: n })}>{n}</button>)}</div>
        <div className="g-hint">Personas distintas de quien pidió la acción; esa persona no puede aprobarla.</div>
      </div>
      <div className="g-field">
        <label>La solicitud vence en</label>
        <div className="set-choice">{POL_EXP.map(h => <button key={h} className={f.expiresH === h ? 'is-on' : ''} onClick={() => setF({ ...f, expiresH: h })}>{h} h</button>)}</div>
        <div className="g-hint">Si nadie la resuelve a tiempo, queda «Vencida» y en Auditoría.</div>
      </div>
      <div className="g-field">
        <label htmlFor="pol-why">Motivo</label>
        <textarea id="pol-why" className={'input' + (tried && !reason.trim() ? ' has-error' : '')} rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Lo verá el admin que lo revise" />
        {tried && err ? <div className="g-err">{err}</div> : same ? <div className="g-hint">Cambia algún valor para proponer.</div> : null}
      </div>
    </K.Modal>
  );
}

window.MangoStore.onDecide.policy = (c, d) => { if (d !== 'approved') return; const S = window.MangoStore; S.set({ toolPolicies: { ...S.get().toolPolicies, [c.target]: c.to } }); };

// Lo que vence se cierra como «Vencida»
(function expireSweep() {
  const S = window.MangoStore;
  const run = () => {
    const now = Date.now();
    const exp = S.get().approvals.filter(a => (a.status === 'pending' || a.status === 'approved') && a.expiresMin && now - new Date(a.at).getTime() >= a.expiresMin * 60000);
    if (!exp.length) return;
    S.set({ approvals: S.get().approvals.map(a => exp.some(x => x.id === a.id) ? { ...a, status: 'expired', wasApproved: a.status === 'approved', decidedBy: 'Sistema', decidedAt: new Date(new Date(a.at).getTime() + a.expiresMin * 60000).toISOString(), note: 'Venció sin respuesta', expired: true } : a) });
    exp.forEach(a => S.log('approval.expire', a.id, 'Venció sin ejecutarse: "' + a.action + '"'));
  };
  run(); setInterval(run, 30000);
})();

Object.assign(window, { PoliciesPanel, polText, approvalTier });
