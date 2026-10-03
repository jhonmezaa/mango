(() => {
const { useState } = React;
const K = window.GovKit;
const clone = (o) => JSON.parse(JSON.stringify(o));

function computeUsers(list, def, me) {
  return list.map(u => { const limit = u.ownLimit ?? def; const pct = K.pctOf(u.spent, limit); return { ...u, limit, pct, st: K.statusOf(pct), isMe: u.id === me.id }; });
}

const useGovBudgets = () => {
  const data = window.useMango(s => s.govBudgets);
  const setData = (fn) => window.MangoStore.set(st => ({ govBudgets: typeof fn === 'function' ? fn(st.govBudgets) : fn }));
  return [data, setData];
};

function BudgetDefaults({ notify, isAdmin = true, agentsOnDefault = 0 }) {
  const Ic = window.Icons;
  const [data, setData] = useGovBudgets();
  const [open, setOpen] = useState(false);
  const onDefault = data.users.filter(u => u.ownLimit == null).length;
  const row = { display: 'grid', gridTemplateColumns: 'minmax(160px,1.2fr) minmax(160px,2fr) 32px', gap: 16, alignItems: 'center', padding: '14px 16px' };
  const Line = ({ title, sub, value, first }) => (
    <div style={{ ...row, borderTop: first ? 'none' : '1px solid var(--border)' }}>
      <div style={{ minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{sub}</div></div>
      <div className="mono" style={{ fontSize: 12.5 }}>{value}</div>
      {first ? <button className="btn btn-sm btn-ghost" disabled={!isAdmin} onClick={() => setOpen(true)} aria-label="Editar valores por defecto" title={isAdmin ? 'Editar' : 'Solo admins pueden editar'}><Ic.Edit size={12} /></button> : <span />}
    </div>
  );
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="row between" style={{ marginBottom: 10, gap: 12 }}><div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>Valores por defecto</div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Al 100 %: bloquear</div></div>
      <div className="card" style={{ padding: 0 }}>
        <Line first title="Por usuario" sub={onDefault + (onDefault === 1 ? ' usuario' : ' usuarios') + ' sin límite propio'} value={<>{K.usd(data.defaults.user)} <span style={{ color: 'var(--text-muted)' }}>al mes</span></>} />
        <Line title="Por agente" sub={'Los agentes nuevos arrancan con este límite' + (agentsOnDefault ? ' · ' + agentsOnDefault + ' lo usan' : '')} value={<>{K.usd(data.defaults.agent)} <span style={{ color: 'var(--text-muted)' }}>al mes</span></>} />
      </div>
      {open && <DefaultsModal data={data} sim="none" onClose={() => setOpen(false)} onReload={(p) => setData(d => ({ ...d, ...p, version: d.version + 1 }))}
        onSave={(defaults) => { setData(d => ({ ...d, defaults, version: d.version + 1 })); setOpen(false); window.MangoStore?.log('budget.default', 'defaults', 'Por usuario ' + K.usd(defaults.user) + ' · por agente ' + K.usd(defaults.agent)); notify('Valores por defecto guardados'); }} />}
    </div>
  );
}

function UserBudgets({ notify, isAdmin = true }) {
  const Ic = window.Icons; const D = window.GovData; const me = D.me;
  const avail = window.useMango(s => s.avail);
  const [data, setData] = useGovBudgets();
  const [modal, setModal] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const users = computeUsers(data.users, data.defaults.user, me);
  const onDefault = users.filter(u => u.ownLimit == null).length;
  const Q = q.trim().toLowerCase();
  const list = users
    .filter(u => filter === 'all' || (filter === 'own' ? u.ownLimit != null : u.st === filter))
    .filter(u => !Q || (u.email || '').toLowerCase().includes(Q) || u.id.includes(Q))
    .sort((x, y) => (y.isMe - x.isMe) || (y.pct - x.pct));
  const reload = (patch) => setData(d => ({ ...d, ...patch, version: d.version + 1 }));
  const log = (act, t, m) => window.MangoStore?.log(act, t, m);
  const row = { display: 'grid', gridTemplateColumns: 'minmax(160px,1.2fr) minmax(160px,2fr) 118px 32px', gap: 16, alignItems: 'center', padding: '14px 16px' };
  const tone = (st) => st === 'out' ? 'var(--red)' : st === 'warn' ? 'var(--amber)' : 'var(--green)';
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="row between" style={{ marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>Por usuario</div>
        <div className="row gap-2">
          <div className="search-wrap" style={{ width: 200 }}><Ic.Search size={12} /><input className="input" placeholder="Buscar correo o id" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar usuario" style={{ fontSize: 12, padding: '5px 10px 5px 28px' }} /></div>
          <select className="input" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filtrar usuarios" style={{ fontSize: 12, padding: '5px 8px', width: 'auto' }}>
            <option value="all">Todos · {users.length}</option>
            <option value="warn">En alerta · {users.filter(u => u.st === 'warn').length}</option>
            <option value="out">Agotados · {users.filter(u => u.st === 'out').length}</option>
            <option value="own">Límite propio · {users.filter(u => u.ownLimit != null).length}</option>
          </select>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {list.length === 0 && <div style={{ padding: '18px 16px', fontSize: 12.5, color: 'var(--text-muted)' }}>{users.length ? 'Ningún usuario coincide con la búsqueda.' : 'Aún no hay gasto este mes.'}</div>}
        {list.map((u, i) => {
          const p = Math.round(u.pct);
          const label = u.email || K.shortId(u.id);
          return (
            <div key={u.id} style={{ ...row, borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ minWidth: 0 }}>
                <div className="row gap-2" style={{ minWidth: 0 }}>
                  <span className={u.email ? '' : 'mono'} style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</span>
                  {u.isMe && <span className="badge badge-accent" style={{ flexShrink: 0 }}>Tú</span>}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={u.isMe ? 'Otro administrador debe cambiar tu presupuesto' : undefined}>
                  {u.email ? '' : 'Sin correo · '}{u.ownLimit != null ? 'Límite propio' : 'Por defecto'}{u.isMe ? ' · solo lectura' : ''}
                </div>
              </div>
              <div>
                <div role="progressbar" aria-valuenow={Math.min(p, 100)} aria-valuemin={0} aria-valuemax={100} aria-label={'Consumo ' + label} style={{ position: 'relative', height: 6, borderRadius: 3, background: 'var(--border)' }}>
                  <span style={{ position: 'absolute', inset: 0, width: Math.min(p, 100) + '%', background: tone(u.st), borderRadius: 3 }} />
                  {!avail && <span title="Alerta al 80%" style={{ position: 'absolute', left: '80%', top: -3, bottom: -3, width: 2, background: 'var(--text-muted)' }} />}
                </div>
                <div className="row between mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  <span style={{ whiteSpace: 'nowrap' }}>{K.usd(u.spent)} / {K.usd(u.limit)}</span><span style={{ color: tone(u.st) }}>{p}%</span>
                </div>
              </div>
              <span style={{ justifySelf: 'start' }} className={'badge ' + K.STATUS[u.st].cls}>{K.STATUS[u.st].label}</span>
              {u.isMe
                ? <button className="btn btn-sm btn-ghost" disabled aria-label="Solo lectura: otro administrador debe cambiar tu presupuesto" title="Otro administrador debe cambiar tu presupuesto"><Ic.Lock size={12} /></button>
                : <button className="btn btn-sm btn-ghost" disabled={!isAdmin} onClick={() => setModal({ kind: 'user', id: u.id })} aria-label={'Editar ' + label} title={isAdmin ? 'Editar' : 'Solo admins pueden editar'}><Ic.Edit size={12} /></button>}
            </div>
          );
        })}
      </div>
      {modal?.kind === 'user' && <UserModal data={data} user={data.users.find(u => u.id === modal.id)} sim="none" onClose={() => setModal(null)} onReload={reload}
        onSave={(id, ownLimit) => { const u0 = data.users.find(u => u.id === id); setData(d => ({ ...d, version: d.version + 1, users: d.users.map(u => u.id === id ? { ...u, ownLimit } : u) })); setModal(null); log('budget.user', u0.email || K.shortId(id), ownLimit == null ? 'Vuelve al límite por defecto' : 'Límite propio ' + K.usd(ownLimit)); notify(ownLimit == null ? 'El usuario vuelve a usar el límite por defecto' : 'Límite propio guardado'); }} />}
    </div>
  );
}

function ConflictBanner() {
  return <K.Banner tone="warn" title="Otro administrador cambió estos datos">Recargamos los valores actuales. Revísalos y vuelve a guardar.</K.Banner>;
}

function DefaultsModal({ data, sim, onClose, onSave, onReload, userOnly }) {
  const [u, setU] = useState(K.toInput(data.defaults.user));
  const [a, setA] = useState(K.toInput(data.defaults.agent));
  const [tried, setTried] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const pu = K.parseMoney(u), pa = K.parseMoney(a);
  const onDef = data.users.filter(x => x.ownLimit == null);
  const wouldOut = pu.value ? onDef.filter(x => x.spent >= pu.value).length : 0;
  const agentSpent = data.agents[0]?.spent || 0;
  const save = () => {
    setTried(true);
    if (pu.error || (!userOnly && pa.error)) return;
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      if (sim === 'conflict' && !conflict) {
        const fresh = { user: data.defaults.user + 1, agent: data.defaults.agent };
        onReload({ defaults: fresh }); setConflict(true); setTried(false);
        setU(K.toInput(fresh.user)); setA(K.toInput(fresh.agent));
        return;
      }
      onSave({ user: pu.value, agent: userOnly ? data.defaults.agent : pa.value });
    }, 600);
  };
  return (
    <K.Modal title="Valores por defecto" sub={`Período ${data.period}. Los cambios aplican de inmediato a las próximas consultas.`} onClose={onClose}
      footer={<><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button></>}>
      {conflict && <ConflictBanner />}
      <K.MoneyInput id="def-user" label="Límite por usuario" value={u} onChange={setU} error={tried && pu.error}
        hint={`Aplica a ${onDef.length} usuarios sin límite propio.`} />
      {pu.value && wouldOut > 0 && <K.Banner tone="warn">Con este valor, {wouldOut} {wouldOut === 1 ? 'usuario quedaría bloqueado' : 'usuarios quedarían bloqueados'} al instante porque ya gastaron más.</K.Banner>}
      {!userOnly && <K.MoneyInput id="def-agent" label="Límite por agente" value={a} onChange={setA} error={tried && pa.error}
        hint="Aplica a agentes sin límite propio y a los agentes nuevos." />}
      <div className="g-hint">Mayor que 0 y hasta 1.000.000, con hasta 2 decimales.</div>
    </K.Modal>
  );
}

function UserModal({ data, user, sim, onClose, onSave, onReload }) {
  const label = user.email || K.shortId(user.id);
  const [mode, setMode] = useState(user.ownLimit != null ? 'own' : 'default');
  const [v, setV] = useState(K.toInput(user.ownLimit ?? data.defaults.user));
  const [tried, setTried] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const p = K.parseMoney(v);
  const limit = mode === 'default' ? data.defaults.user : p.value;
  const pct = limit ? K.pctOf(user.spent, limit) : null;
  const save = () => {
    setTried(true);
    if (mode === 'own' && p.error) return;
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      if (sim === 'conflict' && !conflict) {
        const fresh = user.ownLimit != null ? user.ownLimit + 5 : 10;
        onReload({ users: data.users.map(x => x.id === user.id ? { ...x, ownLimit: fresh } : x) });
        setConflict(true); setMode('own'); setV(K.toInput(fresh)); setTried(false);
        return;
      }
      onSave(user.id, mode === 'default' ? null : p.value);
    }, 600);
  };
  return (
    <K.Modal title={'Presupuesto de ' + label} sub={`Gastado en ${data.period}: ${K.usd(user.spent)}`} onClose={onClose} autoFocus={false}
      footer={<><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button></>}>
      {conflict && <ConflictBanner />}
      <fieldset className="g-radios">
        <legend>Límite mensual</legend>
        <label className={'g-radio' + (mode === 'default' ? ' is-on' : '')}>
          <input type="radio" name="lim" checked={mode === 'default'} onChange={() => setMode('default')} />
          <span><span className="g-radio-t">Usar el valor por defecto</span><span className="g-sub">{K.usd(data.defaults.user)} · cambia si se edita el valor por defecto</span></span>
        </label>
        <label className={'g-radio' + (mode === 'own' ? ' is-on' : '')}>
          <input type="radio" name="lim" checked={mode === 'own'} onChange={() => setMode('own')} />
          <span><span className="g-radio-t">Límite propio</span><span className="g-sub">Solo para este usuario</span></span>
        </label>
      </fieldset>
      {mode === 'own' && <K.MoneyInput id="own-limit" label="Monto" value={v} onChange={setV} error={tried && p.error} hint="Mayor que 0 y hasta 1.000.000, con hasta 2 decimales." />}
      {pct != null && (
        <div className="g-preview">
          <div className="row between" style={{ marginBottom: 8, gap: 8 }}><span className="g-sub">Con este límite quedaría en</span><K.Status pct={pct} /></div>
          <div className="g-usage"><K.Bar pct={pct} /><span className="g-pct">{K.pctLabel(pct)}</span></div>
          {pct >= 100 && <div className="g-sub" style={{ marginTop: 8 }}>Sus próximas consultas se bloquearán hasta el próximo mes.</div>}
        </div>
      )}
    </K.Modal>
  );
}

window.GovUserBudgets = UserBudgets;
window.GovBudgetDefaults = BudgetDefaults;
})();
