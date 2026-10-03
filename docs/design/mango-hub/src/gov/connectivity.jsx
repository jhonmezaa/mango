(() => {
const { useState, useEffect } = React;
const K = window.GovKit;
const CHECKS = [
  { id: 'broker', label: 'Rol intermedio de Mango', help: 'Revisa que el rol intermedio exista y que la cuenta de Mango pueda asumirlo.' },
  { id: 'billing_reader', label: 'Rol de lectura en la cuenta de administración', help: 'Revisa que el rol de lectura exista en la cuenta de administración y que su política de confianza permita al rol intermedio.' },
  { id: 'organizations', label: 'Lectura de la organización', help: 'Revisa que el rol de lectura tenga permisos de solo lectura sobre AWS Organizations.' },
];
const okDetail = { broker: 'Rol asumido correctamente', billing_reader: 'Rol asumido correctamente', organizations: 'Organización leída correctamente' };

function Connectivity({ state, retry, sim }) {
  const Ic = window.Icons;
  const [run, setRun] = useState(() => state === 'normal' ? { status: 'done', at: new Date(K.NOW.getTime() - 5 * 6e4), results: CHECKS.map(c => ({ id: c.id, ok: true, detail: okDetail[c.id] })) } : null);
  const [stamps, setStamps] = useState([]);
  const [wait, setWait] = useState(0);
  const [apiErr, setApiErr] = useState(false);
  useEffect(() => { if (!wait) return; const t = setTimeout(() => setWait(w => Math.max(0, w - 1)), 1000); return () => clearTimeout(t); }, [wait]);

  if (state === 'loading') return <div className="g-card" style={{ padding: 20 }}><K.Skel w={200} /><K.Skel w="60%" h={10} style={{ marginTop: 10 }} /></div>;
  if (state === 'error') return <K.ErrorState title="No pudimos abrir Conectividad" body="El servicio no respondió." onRetry={retry} />;

  const test = () => {
    const now = Date.now(); const recent = stamps.filter(s => now - s < 60000);
    if (sim === 'ratelimit' || recent.length >= 5) { setWait(60); setRun(r => ({ ...(r || {}), limited: true })); return; }
    setStamps([...recent, now]);
    setApiErr(false);
    const prev = run;
    setRun({ status: 'running', at: new Date() });
    setTimeout(() => {
      if (sim === 'apierr') { setRun(prev && prev.status === 'done' ? prev : null); setApiErr(true); return; }
      setRun({ status: 'done', at: new Date(), results: CHECKS.map(c => sim === 'connerr' && c.id === 'billing_reader'
        ? { id: c.id, ok: false, detail: 'AccessDenied al asumir el rol en la cuenta de administración (ejemplo)' }
        : sim === 'connerr' && c.id === 'organizations' ? { id: c.id, ok: false, detail: 'No se ejecutó: depende del rol de lectura' }
        : { id: c.id, ok: true, detail: okDetail[c.id] }) });
    }, 1600);
  };
  const running = run?.status === 'running';
  const results = run?.results;
  const failed = results?.filter(r => !r.ok) || [];
  const limited = run?.limited && wait > 0;

  return (
    <section className="g-sec" style={{ marginTop: 0 }}>
      <div className="g-sec-h">
        <div>
          <div className="g-sec-t">Conexión con AWS</div>
          <div className="g-sec-meta">Verifica que Mango puede leer la organización y la facturación en la cuenta de administración. Solo lectura · máximo 5 pruebas por minuto.</div>
        </div>
        <button className="btn btn-sm btn-primary" disabled={running || limited} onClick={test}>
          {running ? <><K.Spinner /> Probando…</> : limited ? `Disponible en ${wait} s` : <><Ic.Refresh size={12} /> Probar conexión</>}
        </button>
      </div>
      {apiErr && !running && <div style={{ marginBottom: 12 }}><K.Banner tone="error" title="No se pudo ejecutar la prueba">El servicio no respondió; no sabemos el estado actual de la conexión. Vuelve a intentarlo en unos segundos.</K.Banner></div>}
      {limited && <div style={{ marginBottom: 12 }}><K.Banner tone="warn" title="Demasiadas pruebas">Puedes probar hasta 5 veces por minuto. Espera un minuto y vuelve a intentarlo.</K.Banner></div>}
      <div className="g-card">
        {!run?.status ? (
          <K.Empty icon="Cloud" title="Aún no has probado la conexión">La prueba revisa tres permisos y tarda unos segundos. No cambia nada en AWS.</K.Empty>
        ) : (
          <>
            <div className="g-conn-h" aria-live="polite">
              {running ? <><K.Spinner /><span>Probando la conexión…</span></>
                : failed.length ? <><span className="g-dot-lg red"><Ic.X2 size={12} /></span><span><b>{failed.length} de {CHECKS.length} chequeos con error</b></span></>
                : <><span className="g-dot-lg green"><Ic.Check size={12} /></span><span><b>Todo en orden</b></span></>}
              {!running && <span className="g-sub" style={{ marginLeft: 'auto' }}>{K.fmtDate(run.at)}</span>}
            </div>
            {CHECKS.map(c => {
              const r = results?.find(x => x.id === c.id);
              return (
                <div key={c.id} className="g-check">
                  <span className="g-check-i">{running ? <K.Spinner /> : r?.ok ? <span className="g-dot-lg green sm"><Ic.Check size={10} /></span> : <span className="g-dot-lg red sm"><Ic.X2 size={10} /></span>}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row gap-2" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}><span className="mono g-check-n">{c.id}</span><span className="g-sub">{c.label}</span></div>
                    {!running && r && <div className={'g-check-d' + (r.ok ? '' : ' bad')}>{r.detail}</div>}
                    {!running && r && !r.ok && <div className="g-help"><b>Qué revisar:</b> {c.help}</div>}
                  </div>
                  {!running && r && <span className={'badge ' + (r.ok ? 'badge-green' : 'badge-red')}>{r.ok ? 'ok' : 'error'}</span>}
                </div>
              );
            })}
          </>
        )}
      </div>
      {window.MangoStore.get().avail && run?.status === 'done' && !running && <MemberAccounts sim={sim} />}
    </section>
  );
}

const MEMBER_ACCTS = [['prod-main', '210987654321'], ['prod-data', '310987654321'], ['staging', '410987654321'], ['sandbox', '510987654321']];
function MemberAccounts({ sim }) {
  const Ic = window.Icons;
  if (sim === 'member-none') return null;
  const head = <div className="g-sec-h" style={{ marginBottom: 8 }}><div><div className="g-sec-t" style={{ fontSize: 13.5 }}>Cuentas miembro</div><div className="g-sec-meta">Para leer datos de cada cuenta de la organización (sin la cuenta de Mango) hace falta un rol de lectura en cada cuenta, y que el rol intermedio de Mango exija la identidad del usuario que pregunta.</div></div></div>;
  if (sim === 'member-fail') return <div style={{ marginTop: 16 }}>{head}<K.Banner tone="error" title="No se pudieron comprobar las cuentas miembro">La conexión principal está bien, pero la comprobación de las cuentas miembro no respondió. Vuelve a intentarlo en unos segundos.</K.Banner></div>;
  const identity = sim !== 'connerr';
  const rows = MEMBER_ACCTS.map(([n, id], i) => ({ n, id, role: !(sim === 'connerr' && i === 3) }));
  const total = sim === 'member-many' ? 63 : rows.length, checked = Math.min(total, 50);
  const nBad = rows.filter(r => !r.role).length;
  const ok = identity && !nBad;
  return (
    <div style={{ marginTop: 16 }}>
      {head}
      {total > 50 && <div style={{ marginBottom: 10 }}><K.Banner tone="warn" title={'Se comprobaron ' + checked + ' de ' + total + ' cuentas'}>La prueba revisa como máximo 50 cuentas. Las otras {total - checked} no se comprobaron.</K.Banner></div>}
      <div className="g-card">
        <div className="g-conn-h">{ok ? <><span className="g-dot-lg green"><Ic.Check size={12} /></span><span><b>{checked} {checked === 1 ? 'cuenta en orden' : 'cuentas en orden'}</b></span></> : <><span className="g-dot-lg red"><Ic.X2 size={12} /></span><span><b>{!identity ? 'Mango no puede leer ninguna cuenta miembro' : nBad + ' de ' + checked + ' cuentas con problemas'}</b></span></>}</div>
        <div className="g-check">
          <span className="g-check-i">{identity ? <span className="g-dot-lg green sm"><Ic.Check size={10} /></span> : <span className="g-dot-lg red sm"><Ic.X2 size={10} /></span>}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="g-check-n">Exige la identidad del usuario</div>
            <div className={'g-check-d' + (identity ? '' : ' bad')}>Se comprueba en el rol intermedio de Mango, no en cada cuenta: el resultado vale para todas. {identity ? 'Lo exige.' : 'No lo exige.'}</div>
            {!identity && <div className="g-help"><b>Qué revisar:</b> La política del rol intermedio debe pasar la identidad del usuario al asumir el rol de lectura; sin eso, Mango no lee ninguna cuenta miembro.</div>}
          </div>
          <span className={'badge ' + (identity ? 'badge-green' : 'badge-red')}>{identity ? 'ok' : 'error'}</span>
        </div>
        {rows.map(r => (
          <div key={r.id} className="g-check">
            <span className="g-check-i">{r.role ? <span className="g-dot-lg green sm"><Ic.Check size={10} /></span> : <span className="g-dot-lg red sm"><Ic.X2 size={10} /></span>}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row gap-2" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}><span className="g-check-n">{r.n}</span><span className="g-sub mono">{r.id}</span></div>
              <div className={'g-check-d' + (r.role ? '' : ' bad')}>{r.role ? 'El rol de lectura existe.' : 'No existe el rol de lectura en esta cuenta.'}</div>
              {!r.role && <div className="g-help"><b>Qué revisar:</b> Despliega el rol de lectura de Mango en esta cuenta con el stack de la organización.</div>}
            </div>
            <span className={'badge ' + (r.role ? 'badge-green' : 'badge-red')}>{r.role ? 'ok' : 'error'}</span>
          </div>
        ))}
        {checked > rows.length && <div className="g-check"><div className="g-sub" style={{ paddingLeft: 30 }}>Y {checked - rows.length} cuentas más en orden</div></div>}
      </div>
    </div>
  );
}

window.GovConnectivity = Connectivity;
})();
