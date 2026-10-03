// System primitives: routing, focus trap, modal, error boundary/states, offline banner, onboarding
const { useState: useStateSys, useEffect: useEffectSys, useRef: useRefSys } = React;

// ---------- Routing (hash) ----------
const MangoRouter = {
  parse() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    const [view, param] = h.split('/');
    return { view: view || null, param: param ? decodeURIComponent(param) : null };
  },
  href(view, param) { return '#/' + view + (param ? '/' + encodeURIComponent(param) : ''); },
  go(view, param) {
    const next = MangoRouter.href(view, param);
    if (location.hash !== next) history.pushState(null, '', next);
  },
};

function useMedia(q) {
  const [m, setM] = useStateSys(() => window.matchMedia(q).matches);
  useEffectSys(() => { const mq = window.matchMedia(q); const h = () => setM(window.matchMedia(q).matches); h(); mq.addEventListener('change', h); window.addEventListener('resize', h); return () => { mq.removeEventListener('change', h); window.removeEventListener('resize', h); }; }, [q]);
  return m;
}

// ---------- Focus trap ----------
function useFocusTrap(active, onEscape) {
  const ref = useRefSys(null);
  useEffectSys(() => {
    if (!active || !ref.current) return;
    const prev = document.activeElement;
    const sel = 'button:not([disabled]),[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
    const first = ref.current.querySelector('[data-autofocus]') || ref.current.querySelector(sel);
    setTimeout(() => first && first.focus(), 30);
    const onKey = (e) => {
      if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const els = [...ref.current.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
      if (!els.length) return;
      const a = els[0], z = els[els.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev && prev.focus && prev.focus(); };
  }, [active]);
  return ref;
}

function Modal({ open, onClose, title, children, width = 480, labelId }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  const id = labelId || 'modal-' + (title || '').replace(/\W+/g, '-');
  return (
    <div className="drawer-backdrop" onClick={onClose} style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className="card" onClick={e => e.stopPropagation()} style={{ width, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', padding: 20 }}>
        {title && <div id={id} style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

function Drawer({ open, onClose, title, children, width = 520, footer }) {
  const ref = useFocusTrap(open, onClose);
  const I = window.Icons;
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Detalle'} className="drawer" style={{ width }} onClick={e => e.stopPropagation()}>
        <div className="row between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, minWidth: 0 }}>{title}</div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><I.Close size={13} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>{children}</div>
        {footer && <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)' }}>{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Errors ----------
const ERR_META = {
  network: { icon: 'Cloud', tone: 'var(--amber)', code: 'ERR_NETWORK', cta: 'retry' },
  '401': { icon: 'Lock', tone: 'var(--amber)', code: 'HTTP 401', cta: 'login' },
  '403': { icon: 'Shield', tone: 'var(--red)', code: 'HTTP 403', cta: null },
  timeout: { icon: 'Clock', tone: 'var(--amber)', code: 'BEDROCK_TIMEOUT · 60s', cta: 'retry' },
  crash: { icon: 'Warn', tone: 'var(--red)', code: 'RENDER_ERROR', cta: 'reload' },
  notfound: { icon: 'Search', tone: 'var(--text-muted)', code: null, cta: null, home: 'err.back' },
};

function ErrorState({ kind = 'network', onRetry, onHome, onLogin, detail, view, requestId }) {
  const I = window.Icons, t = window.t;
  const m = ERR_META[kind] || ERR_META.network;
  const Ic = I[m.icon];
  return (
    <div role={kind === 'notfound' ? 'status' : 'alert'} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <div style={{ maxWidth: 440, width: '100%' }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--row-hover)', color: m.tone, marginBottom: 18 }}><Ic size={20} /></div>
        <h1 style={{fontWeight: 500, fontSize: 26, margin: '0 0 8px', letterSpacing: '-0.01em' }}>{t('err.' + kind + '.t')}</h1>
        <p style={{ margin: '0 0 20px', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6, textWrap: 'pretty' }}>{t('err.' + kind + '.d')}</p>
        <div className="row gap-2" style={{ marginBottom: 22, flexWrap: 'wrap' }}>
          {m.cta === 'retry' && <button className="btn btn-sm btn-primary" onClick={onRetry}><I.Refresh size={11} /> {t('err.retry')}</button>}
          {m.cta === 'login' && <button className="btn btn-sm btn-primary" onClick={onLogin}><I.Lock size={11} /> {t('err.login')}</button>}
          {m.cta === 'reload' && <button className="btn btn-sm btn-primary" onClick={() => location.reload()}><I.Refresh size={11} /> {t('err.reload')}</button>}
          <button className="btn btn-sm" onClick={() => window.MangoNav ? window.MangoNav('chat') : onHome?.()}>{t(m.home || 'err.home')}</button>
        </div>
        {m.code && <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, display: 'grid', gap: 3 }}>
          <span>{m.code}</span>
          {requestId && <span>request_id: {requestId}</span>}
          {detail && kind !== 'crash' && <span style={{ color: 'var(--red)' }}>{detail}</span>}
        </div>}
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { try { window.MangoStore.log('client.error', this.props.view || '—', String(err && err.message || err)); } catch (e) {} }
  componentDidUpdate(pp) { if (pp.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (this.state.err) return <ErrorState kind="crash" onRetry={() => this.setState({ err: null })} onHome={this.props.onHome} />;
    return this.props.children;
  }
}

function OfflineBanner() {
  const [off, setOff] = useStateSys(!navigator.onLine);
  useEffectSys(() => { const a = () => setOff(false), b = () => setOff(true); addEventListener('online', a); addEventListener('offline', b); return () => { removeEventListener('online', a); removeEventListener('offline', b); }; }, []);
  if (!off) return null;
  return <div role="status" style={{ padding: '6px 16px', fontSize: 12, background: 'var(--amber-soft)', color: 'var(--amber)', borderBottom: '1px solid var(--border)', textAlign: 'center' }}>{window.t('offline')}</div>;
}

// ---------- Onboarding ----------
function Onboarding({ open, onClose, setView, role }) {
  const I = window.Icons;
  const [step, setStep] = useStateSys(0);
  const ref = useFocusTrap(open, onClose);
  useEffectSys(() => { if (open) setStep(0); }, [open]);
  if (!open) return null;
  const steps = [
    { icon: 'Mango', title: 'Bienvenido a Mango', body: 'Aquí conversas con agentes especializados de tu empresa. Cada agente tiene sus herramientas, presupuesto y reglas de aprobación.', cta: null },
    { icon: 'Store', title: 'Elige tus agentes', body: 'En el Marketplace ves solo los agentes que tu grupo de Cognito permite. Fija con la estrella los que uses a diario y aparecerán en el sidebar.', cta: ['Abrir Marketplace', 'marketplace'] },
    { icon: 'Chat', title: 'Empieza una conversación', body: 'Escribe en lenguaje natural, adjunta archivos o usa / para comandos. Las acciones sensibles se detienen hasta que alguien las apruebe.', cta: ['Ir al chat', 'chat'] },
    role === 'user'
      ? { icon: 'Check2', title: 'Revisa tus aprobaciones', body: 'Cuando un agente pida permiso para actuar en tu nombre, lo verás en Aprobaciones. Tú decides qué se ejecuta.', cta: ['Ver aprobaciones', 'approvals'] }
      : { icon: 'Money', title: 'Pon límites de gasto', body: 'Define presupuestos por agente o equipo, con alerta al porcentaje que elijas y pausa automática al 100%.', cta: ['Configurar presupuestos', 'budgets'] },
  ];
  const s = steps[step];
  const Ic = I[s.icon] || I.Bot;
  const last = step === steps.length - 1;
  return (
    <div className="drawer-backdrop" style={{ justifyContent: 'center', alignItems: 'center', zIndex: 1600 }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="onb-title" className="card" style={{ width: 460, maxWidth: '92vw', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '28px 28px 22px' }}>
          <div className="row between" style={{ marginBottom: 22 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent-soft)', color:'var(--accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic size={18} /></div>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{step + 1} / {steps.length}</span>
          </div>
          <h2 id="onb-title" style={{fontWeight: 500, fontSize: 24, margin: '0 0 10px', letterSpacing: '-0.01em' }}>{s.title}</h2>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6, textWrap: 'pretty' }}>{s.body}</p>
          {s.cta && <button className="btn btn-sm" style={{ marginTop: 16 }} onClick={() => { setView(s.cta[1]); }}>{s.cta[0]} <I.ArrowRight size={11} /></button>}
        </div>
        <div style={{ display: 'flex', gap: 4, padding: '0 28px' }}>
          {steps.map((_, i) => <span key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= step ? 'var(--accent)' : 'var(--border)' }} />)}
        </div>
        <div className="row between" style={{ padding: '18px 28px' }}>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>Saltar tour</button>
          <div className="row gap-2">
            {step > 0 && <button className="btn btn-sm" onClick={() => setStep(step - 1)}>Atrás</button>}
            <button className="btn btn-sm btn-primary" data-autofocus onClick={() => last ? onClose() : setStep(step + 1)}>{last ? 'Empezar' : 'Siguiente'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentThread({ ticketId, composer = true, onSent, placeholder, autoFocus }) {
  const allComments = window.useMango(s => s.comments);
  const comments = allComments[ticketId] || [];
  const [draft, setDraft] = useStateSys('');
  const toast = window.useToast?.();
  const send = (e) => { e.preventDefault(); const t = draft.trim(); if (!t) return; window.MangoStore.addComment(ticketId, t); setDraft(''); toast?.({ tone: 'success', msg: 'Comentario publicado en ' + ticketId }); onSent && onSent(); };
  return (
    <div>
      {comments.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Sin comentarios todavía.</div>}
      <div style={{ display: 'grid', gap: 14, marginBottom: composer ? 14 : 0 }}>
        {comments.map((c, i) => (
          <div key={i} className="row gap-3" style={{ alignItems: 'flex-start' }}>
            <span className="sb-user-avatar" style={{ width: 28, height: 28, fontSize: 11, background: c.mine ? 'var(--accent-soft)' : undefined, color: c.mine ? 'var(--accent-ink)' : undefined }} aria-hidden="true">{c.initials}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}><b style={{ fontWeight: 600 }}>{c.mine ? 'Tú' : c.author}</b> <span style={{ color: 'var(--text-muted)' }}>· {c.at}</span></div>
              <div style={{ fontSize: 14, lineHeight: 1.55, marginTop: 2, whiteSpace: 'pre-wrap' }}>{c.text}</div>
            </div>
          </div>
        ))}
      </div>
      {composer && (
        <form className="card" style={{ padding: 10 }} onSubmit={send}>
          <label htmlFor={'cm-' + ticketId} className="sr-only">Comentario</label>
          <textarea id={'cm-' + ticketId} autoFocus={autoFocus} className="input" rows={2} value={draft} onChange={e => setDraft(e.target.value)} placeholder={placeholder || 'Escribe un comentario…'} style={{ border: 'none', padding: 4, resize: 'vertical', fontSize: 14, background: 'transparent' }}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form.requestSubmit(); }} />
          <div className="row between" style={{ marginTop: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>⌘↵ para enviar</span>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!draft.trim()}>Comentar</button>
          </div>
        </form>
      )}
    </div>
  );
}

Object.assign(window, { CommentThread, MangoRouter, useMedia, useFocusTrap, Modal, Drawer, ErrorState, ErrorBoundary, OfflineBanner, Onboarding });
