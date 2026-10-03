// Disponibilidad: "Próximamente" para lo que todavía no existe en el producto.
function useSoon() { return window.useMango(s => s.avail); }

function Soon({ on, children, block, label = 'Próximamente', style, className = '' }) {
  const ref = React.useRef(null);
  React.useEffect(() => { if (!ref.current) return; if (on) ref.current.setAttribute('inert', ''); else ref.current.removeAttribute('inert'); }, [on]);
  if (!on) return children;
  const Tag = block ? 'div' : 'span';
  return (
    <Tag className={'soon' + (block ? ' soon-block' : '') + (className ? ' ' + className : '')} style={style} title="Todavía no está disponible">
      <Tag ref={ref} className="soon-body" aria-hidden="true">{children}</Tag>
      <span className="soon-tag">{label}</span>
    </Tag>
  );
}

function SoonTag({ label = 'Próximamente' }) { return <span className="soon-tag">{label}</span>; }

function SoonView({ view, label }) {
  const I = window.Icons;
  return (
    <>
      <window.Topbar crumbs={[label || view]} />
      <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 420, textAlign: 'center', padding: 32, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><I.Clock size={20} /></span>
          <div className="row gap-2" style={{ alignItems: 'center' }}><span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-strong)' }}>{label || view}</span><SoonTag /></div>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>Esta sección todavía no está disponible en Mango.</p>
          <button className="btn btn-sm" onClick={() => window.MangoNav?.('chat')}>Ir al chat</button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { useSoon, Soon, SoonTag, SoonView });
