// Human-in-the-loop approvals: bandeja con detalle, tarjeta inline para chat
const { useState: useStateAp, useMemo: useMemoAp, useEffect: useEffectAp } = React;

const fmtAgo = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  if (m < 1440) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} d`;
};
const minsLeft = (ap) => ap.expiresMin ? ap.expiresMin - Math.round((Date.now() - new Date(ap.at).getTime()) / 60000) : null;
const fmtLeft = (ap) => {
  const left = minsLeft(ap);
  if (left == null) return null;
  if (left <= 0) return 'vencida';
  return left < 60 ? `vence en ${left} min` : `vence en ${Math.round(left / 60)} h`;
};
const RISK = { high: ['Riesgo alto', 'badge-red', 3], medium: ['Riesgo medio', 'badge-amber', 2], low: ['Riesgo bajo', 'badge', 1] };
const AP_STATUS = { pending: ['Pendiente', 'badge-amber'], approved: ['Aprobada · sin ejecutar', 'badge-blue'], executing: ['Ejecutando', 'badge-blue'], executed: ['Ejecutada', 'badge-green'], failed: ['Falló', 'badge-red'], rejected: ['Rechazada', 'badge-red'], cancelled: ['Cancelada', ''], expired: ['Vencida', ''] };
const AP_OPEN = ['pending', 'approved', 'executing'];
const apAvail = () => !!window.MangoStore.get().avail;
const apId = (ap) => { if (!apAvail()) return ap.id; let h = 2166136261; for (let i = 0; i < ap.id.length; i++) { h ^= ap.id.charCodeAt(i); h = Math.imul(h, 16777619); } let h2 = h ^ 0x9e3779b9; h2 = Math.imul(h2 ^ (h2 >>> 15), 2246822519); return 'APR-' + ((h >>> 0).toString(36).padStart(7, '0') + (h2 >>> 0).toString(36)).slice(0, 8).toUpperCase(); };
const apTitle = (ap) => { if (!apAvail()) return ap.action; const [srv, ...rest] = (ap.tool || '').split('.'); const t = window.Lifecycle?.serverOf?.(srv)?.tools?.find(x => x.name === rest.join('.')); return t?.desc || ap.action; };
const apWho = (ap) => ap.requestedBy || 'quien la pidió';
const REJECT_REASONS = ['Falta ventana de mantenimiento', 'Necesita más contexto', 'El riesgo no se justifica', 'Hazlo primero en staging'];
const isExpired = (ap) => { const l = minsLeft(ap); return (ap.status === 'pending' || ap.status === 'approved') && l != null && l <= 0; };
const urgency = (ap) => { const l = minsLeft(ap); if (l != null && l <= 0) return -1e9; return (apAvail() ? 1 : (RISK[ap.risk]?.[2] || 1)) * 1000 - (l == null ? 9999 : l); };
const needsMe = (ap, S) => ap.status === 'pending' && !isExpired(ap) && S.can('approval.decide') && ap.requestedBy !== S.actor() && !(ap.approvalsGiven || []).includes(S.actor());

function useWide(min = 1180) {
  const [w, setW] = useStateAp(() => window.innerWidth >= min);
  useEffectAp(() => { const h = () => setW(window.innerWidth >= min); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);
  return w;
}

function ApprovalsView({ agents, openChat }) {
  const I = window.Icons; const S = window.MangoStore;
  const approvals = window.useMango(s => s.approvals);
  const role = window.useMango(s => s.role);
  const wide = useWide();
  const [tab, setTab] = useStateAp('pending');
  const [quick, setQuick] = useStateAp('all');
  const [risk, setRisk] = useStateAp('all');
  const [agent, setAgent] = useStateAp('all');
  const [q, setQ] = useStateAp('');
  const [sel, setSel] = useStateAp(null);

  const avail = window.useMango(s => s.avail);
  const inTab = approvals.filter(a => tab === 'pending' ? AP_OPEN.includes(a.status) : tab === 'done' ? !AP_OPEN.includes(a.status) : false);
  const QUICK = [
    ['all', 'Todas', () => true],
    ['mine', 'Esperan tu firma', a => needsMe(a, S)],
    ['soon', 'Vencen en menos de 1 h', a => { const l = minsLeft(a); return l != null && l > 0 && l < 60; }],
    ['run', 'Listas para ejecutar', a => a.status === 'approved' && !isExpired(a) && a.requestedBy === S.actor()],
    ...(avail ? [] : [['high', 'Riesgo alto', a => a.risk === 'high']]),
  ];
  const Q = q.trim().toLowerCase();
  const base = inTab.filter(a => (risk === 'all' || a.risk === risk) && (agent === 'all' || a.agent === agent) && (!Q || (apId(a) + ' ' + apTitle(a) + ' ' + a.tool).toLowerCase().includes(Q)));
  const list = base.filter(QUICK.find(x => x[0] === quick)[2])
    .sort(tab === 'pending' ? (a, b) => urgency(b) - urgency(a) : (a, b) => new Date(b.decidedAt || b.at) - new Date(a.decidedAt || a.at));
  const pending = approvals.filter(a => AP_OPEN.includes(a.status) && !isExpired(a)).length;
  const anyFilter = quick !== 'all' || risk !== 'all' || agent !== 'all' || Q;
  const clear = () => { setQuick('all'); setRisk('all'); setAgent('all'); setQ(''); };

  useEffectAp(() => { if (wide && !list.find(a => a.id === sel)) setSel(list[0]?.id || null); }, [wide, tab, quick, risk, agent, q, approvals]);
  const selected = sel && approvals.find(a => a.id === sel);
  const idx = list.findIndex(a => a.id === sel);
  useEffectAp(() => {
    const h = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { const n = list[Math.min(list.length - 1, idx + 1)]; if (n) { e.preventDefault(); setSel(n.id); } }
      if (e.key === 'k' || e.key === 'ArrowUp') { const n = list[Math.max(0, idx - 1)]; if (n) { e.preventDefault(); setSel(n.id); } }
    };
    document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h);
  }, [list, idx]);
  const agentOf = (a) => agents.find(x => x.id === a.agent);

  return (
    <>
      <Topbar crumbs={['Gobernanza', 'Aprobaciones']} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Aprobaciones</h1>
          <p className="page-subtitle">Acciones de escritura que necesitan aprobación. Aprobar no ejecuta: lo aprobado lo ejecuta quien lo pidió, antes de que venza. Todo queda en Auditoría.</p>
        </div>
        <div className="ap-bar">
          <div className="mk-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'pending'} className={tab === 'pending' ? 'is-on' : ''} onClick={() => setTab('pending')}>Pendientes{pending > 0 && <span className="mk-count">{pending}</span>}</button>
            <button role="tab" aria-selected={tab === 'done'} className={tab === 'done' ? 'is-on' : ''} onClick={() => setTab('done')}>Resueltas</button>
            <button role="tab" aria-selected={tab === 'policies'} className={tab === 'policies' ? 'is-on' : ''} onClick={() => setTab('policies')}>Políticas</button>
          </div>
          {tab !== 'policies' && <>
          <div className="ap-filters">
            <div className="search-wrap" style={{ flex: '1 1 200px', maxWidth: 260 }}><I.Search size={13} /><input className="input" placeholder="Buscar por ID, acción o tool" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar aprobaciones" /></div>
            {tab === 'pending' && (
              <div className="tk-quick" role="group" aria-label="Vistas rápidas">
                {QUICK.map(([k, l, fn]) => <button key={k} className={quick === k ? 'is-on' : ''} aria-pressed={quick === k} onClick={() => setQuick(k)}>{l}<span className="mk-count">{base.filter(fn).length}</span></button>)}
              </div>
            )}
            {!avail && <select className="input mk-sel" value={risk} onChange={e => setRisk(e.target.value)} aria-label="Riesgo"><option value="all">Cualquier riesgo</option><option value="high">Alto</option><option value="medium">Medio</option><option value="low">Bajo</option></select>}
            <select className="input mk-sel" value={agent} onChange={e => setAgent(e.target.value)} aria-label="Agente"><option value="all">Todos los agentes</option>{agents.filter(a => approvals.some(x => x.agent === a.id)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            {anyFilter && <button className="btn btn-sm btn-ghost" onClick={clear}>Limpiar</button>}
          </div>
          </>}
        </div>
        {tab === 'policies' ? <window.PoliciesPanel /> : <>

        {role === 'user' && (
          <div className="ap-note"><I.Info size={13} /> Ves tus solicitudes y su estado. Las aprueba FinOps central.</div>
        )}

        {!wide && selected ? (
          <div className="ap-narrow">
            <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setSel(null)}><I.ChevronLeft size={12} /> Volver a la lista</button>
            <div className="ap-detail card"><ApprovalDetail key={selected.id} ap={selected} agent={agentOf(selected)} openChat={openChat} /></div>
          </div>
        ) : <div className={'ap-body' + (wide ? ' is-split' : '')}>
          <div className="ap-list" role="listbox" aria-label="Solicitudes">
            {list.length === 0 && (
              <div className="mk-empty">
                <I.Check2 size={22} style={{ color: 'var(--green)' }} />
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>{anyFilter ? 'Nada coincide con los filtros' : tab === 'pending' ? 'Nada pendiente' : 'Aún no hay decisiones'}</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{anyFilter ? 'Prueba quitando algún filtro.' : tab === 'pending' ? 'Cuando una tool de escritura necesite aprobación, aparecerá aquí.' : 'Las solicitudes ejecutadas, rechazadas, canceladas o vencidas se guardan aquí.'}</div>
                {anyFilter && <button className="btn btn-sm" onClick={clear}>Limpiar filtros</button>}
              </div>
            )}
            {list.map(a => <ApprovalRow key={a.id} ap={a} agent={agentOf(a)} active={wide && a.id === sel} onOpen={() => { setSel(a.id); if (!wide) window.scrollTo?.(0, 0); }} />)}
            {wide && list.length > 1 && <div className="sr-hint" style={{ marginTop: 10 }}><kbd>J</kbd><kbd>K</kbd> para moverte entre solicitudes</div>}
          </div>
          {wide && (
            <div className="ap-detail card">
              {selected ? <ApprovalDetail key={selected.id} ap={selected} agent={agentOf(selected)} openChat={openChat} /> : <div className="mk-empty"><div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Selecciona una solicitud para revisarla.</div></div>}
            </div>
          )}
        </div>}
        </>}
      </div>
    </>
  );
}

function ApprovalRow({ ap, agent, onOpen, active }) {
  const I = window.Icons; const S = window.MangoStore;
  const Ic = agent ? I[agent.icon] || I.Bot : I.Bot;
  const left = ap.status === 'pending' || ap.status === 'approved' ? minsLeft(ap) : null;
  const mine = needsMe(ap, S) || (ap.status === 'approved' && !isExpired(ap) && ap.requestedBy === S.actor());
  const avail = apAvail();
  return (
    <button className={'card ap-row' + (active ? ' is-active' : '') + (isExpired(ap) ? ' is-expired' : '')} onClick={onOpen} role="option" aria-selected={!!active}>
      <span className="mk-avatar sm" style={{ background: agent?.iconBg, color: agent?.iconColor }}><Ic size={14} /></span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="ap-row-t">{apTitle(ap)}</span>
        <span className="ap-row-s"><span className="mono">{apId(ap)}</span> · {agent?.name} · pidió {apWho(ap)} · {fmtAgo(ap.at)}</span>
        <span className="row gap-1" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          {!avail && <span className={`badge ${RISK[ap.risk][1]}`}>{RISK[ap.risk][0]}</span>}
          {ap.approvalsNeeded > 1 && ap.status === 'pending' && <span className="badge">{(ap.approvalsGiven || []).length}/{ap.approvalsNeeded} firmas</span>}
          {ap.status !== 'pending' && <span className={`badge ${AP_STATUS[ap.status][1]}`}>{AP_STATUS[ap.status][0]}</span>}
          {left != null && (left <= 0 ? <span className="badge">Vencida</span> : <span className={'badge' + (left < 60 ? ' badge-red' : '')}>{fmtLeft(ap)}</span>)}
        </span>
      </span>
      {mine && <span className="ap-dot" title={ap.status === 'approved' ? 'Lista para que la ejecutes' : 'Espera tu firma'} aria-label={ap.status === 'approved' ? 'Lista para que la ejecutes' : 'Espera tu firma'} />}
    </button>
  );
}

function ApprovalDetail({ ap, agent, openChat }) {
  return (
    <>
      <div className="ap-detail-h">
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{apId(ap)}</span>
        <span className={`badge ${AP_STATUS[ap.status][1]}`}>{AP_STATUS[ap.status][0]}</span>
      </div>
      <div className="ap-detail-b"><ApprovalBody ap={ap} agent={agent} openChat={openChat} /></div>
      <div className="ap-detail-f"><ApprovalDecision ap={ap} /></div>
    </>
  );
}

function ApprovalBody({ ap, agent, openChat, onClose }) {
  const I = window.Icons;
  const avail = apAvail();
  const left = ap.status === 'pending' || ap.status === 'approved' ? minsLeft(ap) : null;
  const given = ap.approvalsGiven || [];
  const needed = ap.approvalsNeeded || 1;
  const env = ap.params?.env;
  const approvedOnce = ['approved', 'executing', 'executed', 'failed'].includes(ap.status) || ap.wasApproved;
  const st = ap.status;
  const timeline = [
    { t: fmtAgo(ap.at), who: apWho(ap), what: 'pidió la acción a ' + (agent?.name || 'el agente'), tone: 'var(--blue)' },
    { t: '', who: 'Sistema', what: 'la retuvo por la política: ' + ap.policy, tone: 'var(--amber)' },
    ...given.filter(g => g !== ap.decidedBy || st === 'pending').map(g => ({ t: '', who: g, what: 'firmó la aprobación', tone: 'var(--green)' })),
    ...(approvedOnce && ap.decidedBy && ap.decidedBy !== 'Sistema' ? [{ t: fmtAgo(ap.decidedAt), who: ap.decidedBy, what: 'aprobó · falta que ' + apWho(ap) + ' la ejecute', tone: 'var(--green)' }] : []),
    ...(st === 'executing' ? [{ t: 'ahora', who: apWho(ap), what: 'la está ejecutando', tone: 'var(--blue)' }] : []),
    ...(st === 'executed' ? [{ t: fmtAgo(ap.executedAt), who: apWho(ap), what: 'la ejecutó', tone: 'var(--green)' }] : []),
    ...(st === 'failed' ? [{ t: fmtAgo(ap.executedAt), who: apWho(ap), what: 'la ejecutó y falló' + (ap.error ? ': ' + ap.error : ''), tone: 'var(--red)' }] : []),
    ...(st === 'rejected' ? [{ t: fmtAgo(ap.decidedAt), who: ap.decidedBy, what: 'rechazó' + (ap.note ? ': “' + ap.note + '”' : ''), tone: 'var(--red)' }] : []),
    ...(st === 'cancelled' ? [{ t: fmtAgo(ap.decidedAt), who: ap.decidedBy, what: 'canceló la solicitud', tone: 'var(--text-muted)' }] : []),
    ...(st === 'expired' ? [{ t: fmtAgo(ap.decidedAt), who: 'Sistema', what: ap.wasApproved ? 'la cerró: venció sin ejecutarse' : 'la cerró: venció sin respuesta', tone: 'var(--text-muted)' }] : []),
  ];
  return (
    <div className="ap-sections">
      <div>
        <h2 className="ap-h2">{apTitle(ap)}</h2>
        {!avail && ap.impact && <p className="ap-impact">{ap.impact}</p>}
      </div>
      <div className="ap-facts">
        <div><span>Agente</span><span className="row gap-2"><TkAgent agent={agent} /></span></div>
        <div><span>Pidió</span><span>{apWho(ap)} · {fmtAgo(ap.at)}</span></div>
        <div><span>Política</span><span>{ap.policy}</span></div>
        {!avail && <div><span>Riesgo</span><span><span className={`badge ${RISK[ap.risk][1]}`}>{RISK[ap.risk][0]}</span></span></div>}
        {env && <div><span>Entorno</span><span className="mono">{env}</span></div>}
        <div><span>Firmas</span><span>
          <span className="ap-sigs">{Array.from({ length: needed }).map((_, i) => <i key={i} className={i < given.length || approvedOnce ? 'on' : ''} />)}</span>
          {Math.min(needed, approvedOnce ? needed : given.length)} de {needed}{needed > 1 && ap.status === 'pending' ? ' · deben ser personas distintas' : ''}
        </span></div>
        {left != null && <div><span>Vencimiento</span><span style={{ color: left < 60 ? 'var(--red)' : 'var(--text)' }}>{fmtLeft(ap)} · {st === 'approved' ? 'si no se ejecuta antes, se cierra' : 'si nadie la aprueba antes, se cierra'}</span></div>}
      </div>
      <div>
        <div className="mk-sec-t">qué va a ejecutar</div>
        <div className="ap-call">
          <div className="mono ap-call-t">{ap.tool}</div>
          <div className="ap-params">{Object.entries(ap.params || {}).map(([k, v]) => (
            <div key={k}><span className="mono">{k}</span><span className="mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span></div>
          ))}</div>
        </div>
      </div>
      <div>
        <div className="mk-sec-t">historial</div>
        <div className="tk-activity">{timeline.map((e, i) => (
          <div key={i} className="tk-act"><span className="tk-dot" style={{ background: e.tone, marginTop: 6 }} /><span style={{ flex: 1 }}><b style={{ fontWeight: 500, color: 'var(--text)' }}>{e.who}</b> {e.what}</span>{e.t && <span className="tk-meta">{e.t}</span>}</div>
        ))}</div>
      </div>
      {ap.threadId && <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => { onClose?.(); openChat?.(ap.agent, ap.threadId); }}><I.Chat size={12} /> Ver conversación de origen</button>}
    </div>
  );
}

function ApprovalDecision({ ap, compact }) {
  const I = window.Icons;
  const S = window.MangoStore;
  const toast = window.useToast?.();
  window.useMango(s => s.role);
  const [note, setNote] = useStateAp('');
  const [mode, setMode] = useStateAp(null);
  const [tried, setTried] = useStateAp(false);
  const ownRequest = ap.requestedBy === S.actor();
  const lft = minsLeft(ap);
  const expired = isExpired(ap);
  const by = (who, at) => <>{who ? 'por ' + who + ' · ' : ''}{fmtAgo(at)}</>;
  const Done = ({ children }) => <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}><span className={`badge ${AP_STATUS[ap.status][1]}`} style={{ marginRight: 8 }}>{AP_STATUS[ap.status][0]}</span>{children}</div>;
  if (ap.status === 'executing') return <div className="ap-reason" role="status"><I.Refresh size={12} className="spin" /> Ejecutando la acción…</div>;
  if (ap.status === 'executed') return <Done>{by(ap.requestedBy, ap.executedAt)}</Done>;
  if (ap.status === 'failed') return <div style={{ display: 'grid', gap: 8 }}><Done>{by(ap.requestedBy, ap.executedAt)}</Done>{ap.error && <div className="mc-alert red" role="alert"><I.X2 size={14} /><div className="mono" style={{ fontSize: 12 }}>{ap.error}</div></div>}<div className="ap-reason"><I.Info size={12} /> La acción se inició y falló. Si hace falta, pide la acción otra vez en el chat.</div></div>;
  if (ap.status === 'cancelled') return <Done>{by(ap.decidedBy, ap.decidedAt)}</Done>;
  if (ap.status === 'expired') return <Done>{ap.wasApproved ? 'Se aprobó y no se ejecutó antes del vencimiento.' : 'Nadie la aprobó antes del vencimiento.'} El agente puede volver a pedirla.</Done>;
  if (ap.status === 'rejected') return <Done>{by(ap.decidedBy, ap.decidedAt)}{ap.note && <> · “{ap.note}”</>}</Done>;
  if (expired) return <div className="ap-reason"><I.Clock size={12} /> Venció. Se cierra sola; el agente puede volver a pedirla.</div>;
  const cancel = () => { S.cancelApproval(ap.id); toast?.({ tone: 'info', msg: apId(ap) + ' cancelada' }); };
  if (ap.status === 'approved') {
    if (!ownRequest) return <div className="ap-reason"><I.Check size={12} /> Aprobada. Falta que {apWho(ap)} la ejecute{lft != null ? ' · ' + fmtLeft(ap) : ''}.</div>;
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {ap.notStarted && <div className="mc-alert amber" role="alert"><I.Warn size={14} /><div>La acción no llegó a iniciarse. Puedes ejecutarla de nuevo.</div></div>}
        <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-primary" onClick={() => S.execute(ap.id)}><I.Play size={11} /> Ejecutar</button>
          <button className="btn btn-sm" onClick={cancel}>Cancelar solicitud</button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: compact ? 0 : 'auto' }}>{lft != null ? 'Ejecútala antes de que venza · ' + fmtLeft(ap) : 'Aprobada por ' + ap.decidedBy}</span>
        </div>
      </div>
    );
  }
  const canDecide = S.can('approval.decide');
  const given = ap.approvalsGiven || [];
  const already = given.includes(S.actor());
  if (ownRequest) return (
    <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
      <span className="ap-reason" style={{ flex: '1 1 220px' }}><I.Lock size={12} /> Tú la pediste: la aprueba otra persona. Cuando esté aprobada, la ejecutas tú.</span>
      <button className="btn btn-sm" onClick={cancel}>Cancelar solicitud</button>
    </div>
  );
  if (!canDecide) return <div className="ap-reason"><I.Lock size={12} /> Esperando la aprobación de FinOps central.</div>;
  if (already) return <div className="ap-reason"><I.Check size={12} /> Ya firmaste. Falta {ap.approvalsNeeded - given.length} firma de otra persona.</div>;
  const approve = () => { const done = given.length + 1 >= (ap.approvalsNeeded || 1); S.decide(ap.id, 'approved', note.trim() || undefined); toast?.({ tone: 'success', msg: done ? `${apId(ap)} aprobada · la ejecuta ${apWho(ap)}` : 'Firma registrada · falta otra aprobación' }); setMode(null); setNote(''); };
  const reject = () => { setTried(true); if (!note.trim()) return; S.decide(ap.id, 'rejected', note.trim()); toast?.({ tone: 'info', msg: `${apId(ap)} rechazada` }); };
  const last = ap.approvalsNeeded > 1 && given.length === ap.approvalsNeeded - 1;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {mode === 'reject' && (
        <div style={{ display: 'grid', gap: 6 }}>
          <label htmlFor={'rej-' + ap.id} style={{ fontSize: 12.5, fontWeight: 500 }}>Motivo del rechazo</label>
          <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{REJECT_REASONS.map(r => <button key={r} className="tk-chip" onClick={() => setNote(r)}>{r}</button>)}</div>
          <textarea id={'rej-' + ap.id} className="input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Lo verá quien pidió la acción" autoFocus style={tried && !note.trim() ? { borderColor: 'var(--red)' } : null} />
          {tried && !note.trim() && <div style={{ fontSize: 12, color: 'var(--red)' }}>Escribe o elige un motivo</div>}
        </div>
      )}
      {mode === 'approve' && (
        <div style={{ display: 'grid', gap: 6 }}>
          <label htmlFor={'apn-' + ap.id} style={{ fontSize: 12.5, fontWeight: 500 }}>Nota <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· opcional</span></label>
          <textarea id={'apn-' + ap.id} className="input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Contexto para Auditoría" autoFocus />
        </div>
      )}
      <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
        {!mode && <>
          <button className="btn btn-sm btn-primary" onClick={compact ? approve : () => setMode('approve')}><I.Check size={12} /> {ap.approvalsNeeded > 1 && !last ? 'Firmar' : 'Aprobar'}</button>
          <button className="btn btn-sm" onClick={() => setMode('reject')}>Rechazar</button>
        </>}
        {mode === 'approve' && <>
          <button className="btn btn-sm btn-primary" onClick={approve}><I.Check size={12} /> Confirmar {ap.approvalsNeeded > 1 && !last ? 'firma' : 'aprobación'}</button>
          <button className="btn btn-sm btn-ghost" onClick={() => { setMode(null); setNote(''); }}>Cancelar</button>
        </>}
        {mode === 'reject' && <>
          <button className="btn btn-sm mk-danger" onClick={reject}>Confirmar rechazo</button>
          <button className="btn btn-sm btn-ghost" onClick={() => { setMode(null); setNote(''); setTried(false); }}>Cancelar</button>
        </>}
        {!compact && <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>Aprobar no ejecuta · firmas como {S.actor()}</span>}
      </div>
    </div>
  );
}

function ApprovalCard({ id }) {
  const I = window.Icons;
  const ap = window.useMango(s => s.approvals.find(a => a.id === id));
  if (!ap) return null;
  const avail = apAvail();
  const tone = ap.status === 'executed' ? 'var(--green)' : ['rejected', 'failed'].includes(ap.status) ? 'var(--red)' : ['approved', 'executing'].includes(ap.status) ? 'var(--blue)' : ['cancelled', 'expired'].includes(ap.status) ? 'var(--border)' : 'var(--amber)';
  const head = ap.status === 'pending' ? 'Requiere aprobación' : AP_STATUS[ap.status][0];
  return (
    <div className="card" role="group" aria-label={'Aprobación ' + apId(ap)} style={{ marginBottom: 20, maxWidth: 760, padding: 14, borderColor: tone }}>
      <div className="row gap-2" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <I.Lock size={13} style={{ color: tone === 'var(--border)' ? 'var(--text-muted)' : tone }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{head}</span>
        {!avail && <span className={`badge ${RISK[ap.risk][1]}`}>{RISK[ap.risk][0]}</span>}
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{apId(ap)}</span>
      </div>
      <div style={{ fontSize: 13.5, marginBottom: 4 }}>{apTitle(ap)}</div>
      <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12, overflowWrap: 'anywhere' }}>{ap.tool} · {ap.policy}</div>
      <ApprovalDecision ap={ap} compact />
    </div>
  );
}

function SelfConfirmCard({ msg, onConfirm, onCancel }) {
  const I = window.Icons;
  const done = msg.status !== 'pending';
  const tone = msg.status === 'confirmed' ? 'var(--green)' : msg.status === 'cancelled' ? 'var(--text-muted)' : 'var(--accent-ink)';
  return (
    <div className="card" role="group" aria-label="Confirmar acción" style={{ marginBottom: 20, maxWidth: 760, padding: 14, borderColor: done ? 'var(--border)' : 'var(--accent-border)' }}>
      <div className="row gap-2" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <I.Warn size={13} style={{ color: tone }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>¿Ejecutar esta acción?</span>
        <span className="badge">Escritura</span>
      </div>
      <div style={{ fontSize: 13.5, marginBottom: 4 }}>{msg.action}</div>
      <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>{msg.tool} · {Object.entries(msg.params || {}).map(([k, v]) => k + '=' + v).join(', ')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Política: {msg.rule}. Tu confirmación queda registrada en Auditoría.</div>
      {done ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}><span className={'badge ' + (msg.status === 'confirmed' ? 'badge-green' : '')} style={{ marginRight: 8 }}>{msg.status === 'confirmed' ? 'Confirmada' : 'Cancelada'}</span>por {msg.by}</div>
        : <div className="row gap-2"><button className="btn btn-sm btn-primary" onClick={onConfirm}><I.Check size={12} /> Ejecutar</button><button className="btn btn-sm" onClick={onCancel}>Cancelar</button></div>}
    </div>
  );
}

Object.assign(window, { ApprovalsView, ApprovalCard, ApprovalDecision, SelfConfirmCard, fmtAgo });
