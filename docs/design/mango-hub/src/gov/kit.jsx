(() => {
const { useEffect, useRef } = React;
const NOW = new Date('2026-09-29T14:30:00');
const DAY = 864e5;
const fmtNum = (n) => { const [i, d] = Math.abs(n).toFixed(2).split('.'); return (n < 0 ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d; };
const usd = (n) => 'USD ' + fmtNum(n);
const toInput = (n) => n.toFixed(2).replace('.', ',');
const pctOf = (spent, limit) => limit > 0 ? spent / limit * 100 : 0;
const pctLabel = (p) => (p >= 100 ? Math.round(p) : Math.min(99, Math.round(p))) + ' %';
const statusOf = (p) => p >= 100 ? 'out' : p >= 80 ? 'warn' : 'ok';
const STATUS = {
  ok: { label: 'OK', cls: 'badge-green', color: 'var(--green)' },
  warn: { label: 'En alerta', cls: 'badge-amber', color: 'var(--amber)' },
  out: { label: 'Agotado', cls: 'badge-red', color: 'var(--red)' },
};
function parseMoney(raw) {
  const s = String(raw ?? '').trim().replace(/\s/g, '').replace(/^usd/i, '');
  if (!s) return { error: 'Escribe un monto' };
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!/^\d+(\.\d+)?$/.test(norm)) return { error: 'Usa solo números, por ejemplo 150,00' };
  if (/\.\d{3,}$/.test(norm)) return { error: 'Máximo 2 decimales' };
  const v = Number(norm);
  if (!(v > 0)) return { error: 'Debe ser mayor que 0' };
  if (v > 1e6) return { error: 'El máximo es USD 1.000.000,00' };
  return { value: Math.round(v * 100) / 100 };
}
const fmtDate = (d) => new Date(d).toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtTime = (d) => new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const rel = (d) => {
  const m = Math.round((NOW - new Date(d)) / 6e4);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.round(h / 24);
  return days === 1 ? 'ayer' : `hace ${days} días`;
};
const shortId = (id) => (id || '').split('-')[0].slice(0, 8);

function Modal({ title, sub, onClose, children, footer, width = 520, sheet, autoFocus = true }) {
  const Ic = window.Icons;
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    const el = autoFocus && ref.current?.querySelector('.g-modal-b input:not([type=radio]):not([disabled]), .g-modal-b textarea');
    (el || ref.current)?.focus({ preventScroll: true });
    return () => document.removeEventListener('keydown', h);
  }, []);
  const node = (
    <div className="g-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={'g-modal' + (sheet ? ' sheet' : '')} style={{ maxWidth: width }}>
        <div className="g-modal-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="g-modal-t">{title}</h2>
            {sub && <p className="g-modal-s">{sub}</p>}
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Cerrar" onClick={onClose}><Ic.Close size={14} /></button>
        </div>
        <div className="g-modal-b">{children}</div>
        {footer && <div className="g-modal-f">{footer}</div>}
      </div>
    </div>
  );
  return window.__govPortal ? ReactDOM.createPortal(node, window.__govPortal) : node;
}

function Banner({ tone = 'info', title, children, action }) {
  const Ic = window.Icons;
  const Icon = tone === 'error' ? Ic.X2 : tone === 'warn' ? Ic.Warn : tone === 'ok' ? Ic.Check2 : Ic.Info;
  return (
    <div className={'g-banner ' + tone} role={tone === 'error' || tone === 'warn' ? 'alert' : 'status'}>
      <Icon size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div className="g-banner-t">{title}</div>}
        {children && <div className="g-banner-b">{children}</div>}
      </div>
      {action}
    </div>
  );
}

function Reason({ children, tone }) {
  const Ic = window.Icons;
  const Icon = tone === 'warn' ? Ic.Warn : Ic.Lock;
  return <div className={'g-reason' + (tone ? ' ' + tone : '')}><Icon size={12} style={{ flexShrink: 0, marginTop: 2 }} /><span>{children}</span></div>;
}

function Bar({ pct }) {
  const st = STATUS[statusOf(pct)];
  return <div className="g-bar" role="presentation"><span style={{ width: Math.min(100, pct) + '%', background: st.color }} /></div>;
}
function Status({ pct }) { const st = STATUS[statusOf(pct)]; return <span className={'badge ' + st.cls}>{st.label}</span>; }

function MoneyInput({ id, label, value, onChange, error, hint, disabled }) {
  return (
    <div className="g-field">
      {label && <label htmlFor={id}>{label}</label>}
      <div className={'g-money' + (error ? ' has-error' : '') + (disabled ? ' is-disabled' : '')}>
        <span>USD</span>
        <input id={id} inputMode="decimal" autoComplete="off" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} aria-describedby={id + '-h'} />
      </div>
      <div id={id + '-h'} className={error ? 'g-err' : 'g-hint'}>{error || hint}</div>
    </div>
  );
}

function PageHead({ title, lead, children }) {
  return (
    <div className="g-head">
      <div style={{ minWidth: 0 }}>
        <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 className="g-h1">{title}</h1>
          <span className="g-sample" title="Todos los valores de esta pantalla son de ejemplo">datos de ejemplo</span>
        </div>
        {lead && <p className="g-lead">{lead}</p>}
      </div>
      {children}
    </div>
  );
}

function Skel({ w = '100%', h = 12, r = 6, style }) { return <span className="g-skel" style={{ width: w, height: h, borderRadius: r, ...style }} />; }

function Empty({ icon = 'Inbox', title, children, action }) {
  const Ic = window.Icons; const Icon = Ic[icon] || Ic.Inbox;
  return (
    <div className="g-empty">
      <span className="g-empty-i"><Icon size={18} /></span>
      <div className="g-empty-t">{title}</div>
      {children && <p className="g-empty-b">{children}</p>}
      {action}
    </div>
  );
}

function ErrorState({ title, body, onRetry }) {
  const Ic = window.Icons;
  return (
    <div className="g-card"><Empty icon="Warn" title={title} action={<button className="btn btn-sm" onClick={onRetry}><Ic.Refresh size={12} /> Reintentar</button>}>{body}</Empty></div>
  );
}

function Denied() {
  return (
    <div className="g-denied">
      <Empty icon="Lock" title="No tienes acceso a esta sección">
        Presupuestos, Ajustes y el Audit log son solo para admins. Un admin de Mango puede darte acceso.
      </Empty>
    </div>
  );
}

function Spinner() { return <span className="g-spin" aria-hidden="true" />; }

window.GovKit = { NOW, DAY, fmtNum, usd, toInput, pctOf, pctLabel, statusOf, STATUS, parseMoney, fmtDate, fmtTime, rel, shortId, Modal, Banner, Reason, Bar, Status, MoneyInput, PageHead, Skel, Empty, ErrorState, Denied, Spinner };
})();
