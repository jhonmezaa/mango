// Ajustes de plataforma: General (con Autenticación y acceso a conversaciones con doble aprobación), Grupos, Áreas y OUs, Conectividad
const SET_LABELS = {
  mfa: { title: 'MFA (app autenticadora)', v: { required: 'Obligatorio', optional: 'Opcional', off: 'Desactivado' } },
  session: { title: 'Duración de la sesión', fmt: (n) => n + ' h' },
  idp: { title: 'Identity provider (SSO)', v: { none: 'Sin IdP · solo correo y contraseña', sso: null } },
  convAccess: { title: 'Acceso de admins a conversaciones', v: { true: 'Activado', false: 'Desactivado' } },
};
const setVal = (key, v) => { const L = SET_LABELS[key]; if (key === 'idp' && v !== 'none') return window.MangoStore.get().authCfg.idpName; return L.fmt ? L.fmt(v) : L.v[String(v)]; };
const CHG_STATUS = { pending: ['Pendiente', 'badge-amber'], approved: ['Aprobado', 'badge-green'], rejected: ['Rechazado', 'badge-red'], withdrawn: ['Retirado', 'badge'], expired: ['Vencido', 'badge'] };
const MFA_RESET_TTL = 72 * 36e5;
const chgStatus = (c) => c.status === 'pending' && c.kind === 'mfa_reset' && Date.now() - new Date(c.at).getTime() > MFA_RESET_TTL ? 'expired' : c.status;

function Settings({ models }) {
  const I = window.Icons; const S = window.MangoStore;
  const avail = window.useMango(s => s.avail);
  const SECTIONS = [
    ['org', 'Organización', 'Org'], ['auth', 'Autenticación', 'Lock'], ['conv', 'Acceso a conversaciones', 'Eye'], ['defaults', 'Defaults de agentes', 'Bot'],
    ['billing', 'Billing y límites', 'Money'], ['notifications', 'Notificaciones', 'Chat'], ['observability', 'Observabilidad', 'Activity'], ['branding', 'Marca y tema', 'Sun'],
  ];
  const [section, setSection] = useState('auth');
  const [tab, setTab] = useState('general');
  const simConn = window.useMango(x => x.simConn);
  useEffect(() => { if (avail && tab === 'groups') setTab('general'); if (avail) setSection('auth'); }, [avail]);
  const toastS = window.useToast?.();
  const notifyS = (msg, tone) => toastS?.({ tone: tone === 'info' ? 'info' : 'success', msg });
  const [dirty, setDirty] = useState(false);
  const [s, setS] = useState({ orgName: 'Empresa', orgDomain: 'empresa.com', timezone: 'America/Mexico_City', language: 'es-MX', contact: 'usuario1@empresa.com', defaultModel: 'Claude Sonnet 4.6', defaultMaxTokens: 4096, defaultTemp: 0.3, alertAt80: true, billingEmail: 'usuario5@empresa.com', emailDigest: 'daily', accentColor: '#f97316', darkMode: 'auto' });
  const set = (k, v) => { setS({ ...s, [k]: v }); setDirty(true); };
  const save = () => { setDirty(false); S.log('settings.update', 'general', 'Guardó preferencias generales'); notifyS('Cambios guardados'); };
  const TABS = [['general', 'General'], ['groups', 'Grupos'], ['areas', 'Áreas y OUs'], ['conn', 'Conectividad']];
  const HEAD = (
    <>
      <div className="page-head">
        <h1 className="page-title">Ajustes</h1>
        <p className="page-subtitle">Preferencias globales, autenticación, áreas de negocio y conectividad con AWS.</p>
      </div>
      <div className="g-frame g-embed g-tabs-wrap"><div className="g-tabs" role="tablist">
        {TABS.map(([k, l]) => { const soon = avail && k === 'groups'; return soon
          ? <window.Soon key={k} on><button role="tab" aria-selected={false}>{l}</button></window.Soon>
          : <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{l}</button>; })}
      </div></div>
    </>
  );
  if (tab !== 'general') return (
    <>
      <Topbar crumbs={['Ajustes']} />
      <div className="content" style={{ overflow: 'auto' }}>
        {HEAD}
        <div className="g-frame g-embed"><div className="g-embed-body">
          {tab === 'groups' ? <window.GroupsAdmin goAreas={() => setTab('areas')} notify={notifyS} /> : tab === 'areas'
            ? <window.GovAreas state="normal" sim="none" retry={() => {}} notify={notifyS} mobile={window.innerWidth < 720} />
            : <window.GovConnectivity state="normal" sim={simConn || 'none'} retry={() => {}} />}
        </div></div>
      </div>
    </>
  );
  const plain = !['auth', 'conv'].includes(section);
  return (
    <>
      <Topbar crumbs={['Ajustes']} actions={plain && <>
        {dirty && <span className="badge badge-amber" style={{ marginRight: 4 }}>Cambios sin guardar</span>}
        <button className="btn btn-sm btn-primary" onClick={save} disabled={!dirty}><I.Check size={12} /> Guardar cambios</button>
      </>} />
      <div className="content" style={{ overflow: 'auto' }}>
        {HEAD}
        <div className="set-grid" style={{ padding: '20px 32px 40px', display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 24, alignItems: 'flex-start' }}>
          <nav style={{ position: 'sticky', top: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {SECTIONS.map(([id, label, icon]) => { const Ic = I[icon] || I.Settings; const active = section === id; const soonS = avail && id !== 'auth'; return soonS ? (
              <window.Soon key={id} on><button style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent', borderRadius: 7, fontSize: 13, textAlign: 'left', width: '100%' }}><Ic size={14} /><span style={{ flex: 1 }}>{label}</span></button></window.Soon>
            ) : (
              <button key={id} onClick={() => setSection(id)} aria-current={active ? 'page' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: active ? 'var(--accent-soft)' : 'transparent', color: active ? 'var(--accent-ink)' : 'var(--text-muted)', border: active ? '1px solid var(--accent-border)' : '1px solid transparent', borderRadius: 7, fontSize: 13, textAlign: 'left', fontWeight: active ? 500 : 400 }}>
                <Ic size={14} /><span style={{ flex: 1 }}>{label}</span>
              </button>
            ); })}
          </nav>
          <div style={{ maxWidth: 760, minWidth: 0 }}>
            {section === 'org' && <SettingsSection title="Organización" desc="Identidad corporativa y preferencias regionales.">
              <SRow label="Nombre de la organización"><input className="input" value={s.orgName} onChange={e => set('orgName', e.target.value)} /></SRow>
              <SRow label="Dominio principal" hint="Solo correos de este dominio pueden registrarse"><div className="ro-field"><I.Lock size={12} />{s.orgDomain}</div></SRow>
              <SRow label="Zona horaria"><select className="input" value={s.timezone} onChange={e => set('timezone', e.target.value)}><option>America/Mexico_City</option><option>America/Bogota</option><option>UTC</option></select></SRow>
              <SRow label="Idioma por defecto"><select className="input" value={s.language} onChange={e => set('language', e.target.value)}><option value="es-MX">Español (MX)</option><option value="en-US">English (US)</option></select></SRow>
              <SRow label="Contacto de plataforma" hint="Correo que aparece en avisos"><input className="input" value={s.contact} onChange={e => set('contact', e.target.value)} /></SRow>
            </SettingsSection>}

            {section === 'auth' && <AuthSection />}
            {section === 'conv' && <ConvAccessSection />}

            {section === 'defaults' && <SettingsSection title="Defaults de agentes" desc="Valores que se aplican al crear un agente nuevo.">
              <SRow label="Modelo por defecto"><select className="input" value={s.defaultModel} onChange={e => set('defaultModel', e.target.value)}>
                {models.map(m => { const n = typeof m === 'string' ? m : m.name; return <option key={n} value={n}>{n}</option>; })}
              </select></SRow>
              <SRow label="Presupuesto de agentes nuevos" hint="Arrancan con el límite por defecto"><button className="mk-link" onClick={() => window.MangoNav?.('budgets')}>Se define en Presupuestos →</button></SRow>
              <SRow label="Max tokens por respuesta"><div className="row gap-2"><input type="range" min="512" max="8192" step="512" value={s.defaultMaxTokens} onChange={e => set('defaultMaxTokens', +e.target.value)} style={{ flex: 1 }} /><span className="mono" style={{ fontSize: 13, width: 52, textAlign: 'right' }}>{s.defaultMaxTokens}</span></div></SRow>
              <SRow label="Temperature default"><div className="row gap-2"><input type="range" min="0" max="1" step="0.05" value={s.defaultTemp} onChange={e => set('defaultTemp', +e.target.value)} style={{ flex: 1 }} /><span className="mono" style={{ fontSize: 13, width: 52, textAlign: 'right' }}>{s.defaultTemp.toFixed(2)}</span></div></SRow>
              <SRow label="Confirmación o aprobación para acciones de escritura" hint="Siempre activa · no se puede desactivar"><div className="row gap-2" style={{ fontSize: 13.5, alignItems: 'center' }}><I.Lock size={13} style={{ color: 'var(--text-muted)' }} /><span>Cada tool de escritura pide confirmación o aprobación, según su política.</span><button className="mk-link" onClick={() => window.MangoNav?.('approvals')}>Ver políticas →</button></div></SRow>
            </SettingsSection>}

            {section === 'billing' && <SettingsSection title="Billing" desc="Contacto de facturación. Los límites de gasto viven en Presupuestos.">
              <SRow label="Límites de gasto" hint="Por usuario, por agente y valores por defecto"><button className="mk-link" onClick={() => window.MangoNav?.('budgets')}>Ir a Presupuestos →</button></SRow>
              <SRow label="Correo de billing"><input className="input" value={s.billingEmail} onChange={e => set('billingEmail', e.target.value)} /></SRow>
            </SettingsSection>}

            {section === 'notifications' && <SettingsSection title="Notificaciones" desc="Resúmenes por correo para admins.">
              <SRow label="Resumen por correo"><select className="input" value={s.emailDigest} onChange={e => set('emailDigest', e.target.value)}><option value="off">Desactivado</option><option value="daily">Diario (09:00)</option><option value="weekly">Semanal (lunes 09:00)</option></select></SRow>
            </SettingsSection>}

            {section === 'observability' && <SettingsSection title="Observabilidad" desc="Logs y trazas de ejecución de agentes. Se definen al instalar Mango.">
              <SRow label="CloudWatch log group" hint="Solo lectura"><div className="ro-field"><I.Lock size={12} />/aws/mango/agents</div></SRow>
              <SRow label="Retención de logs" hint="Solo lectura"><div className="ro-field"><I.Lock size={12} />90 días</div></SRow>
              <SRow label="X-Ray tracing" hint="Solo lectura"><div className="ro-field"><I.Lock size={12} />Activado</div></SRow>
              <SRow label="Texto de las preguntas" hint="Depende del acceso de admins a conversaciones"><button className="mk-link" onClick={() => setSection('conv')}>{window.MangoStore.get().authCfg.convAccess ? 'Visible para admins autorizados' : 'Solo metadatos'} →</button></SRow>
            </SettingsSection>}

            {section === 'branding' && <SettingsSection title="Marca y tema" desc="Cómo se ve Mango para tus usuarios.">
              <SRow label="Color de acento"><div className="row gap-2">{['#f97316', '#3b82f6', '#10b981', '#a855f7'].map(c => <button key={c} aria-label={'Color ' + c} onClick={() => set('accentColor', c)} style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: s.accentColor === c ? '2px solid var(--text)' : '2px solid transparent' }} />)}</div></SRow>
              <SRow label="Modo de tema"><div className="set-choice">{[['auto', 'Auto (sistema)'], ['dark', 'Oscuro'], ['light', 'Claro']].map(([k, l]) => <button key={k} className={s.darkMode === k ? 'is-on' : ''} onClick={() => set('darkMode', k)}>{l}</button>)}</div></SRow>
            </SettingsSection>}
          </div>
        </div>
      </div>
    </>
  );
}

function AuthSection() {
  const I = window.Icons;
  const cfg = window.useMango(s => s.authCfg);
  const avail = window.useMango(s => s.avail);
  const [modal, setModal] = useState(null);
  const client = cfg.install === 'client';
  return (
    <SettingsSection title="Autenticación" desc={avail ? 'Cognito gestiona las cuentas. MFA, sesión e IdP se definen al instalar Mango.' : 'Cognito gestiona las cuentas. La conexión se define al instalar Mango; ' + (client ? 'sesión e IdP cambian' : 'MFA, sesión e IdP cambian') + ' con la aprobación de otro admin.'}>
      <div className="card" style={{ padding: '4px 16px', marginBottom: 20 }}>
        <SRow label="User Pool ID"><div className="ro-field"><I.Lock size={12} />{cfg.pool}</div></SRow>
        <SRow label="Región"><div className="ro-field"><I.Lock size={12} />{cfg.region}</div></SRow>
        <div style={{ borderBottom: 'none' }}><SRow label="App client ID" hint="Solo lectura · se define al instalar"><div className="ro-field"><I.Lock size={12} />{cfg.client}</div></SRow></div>
      </div>
      {['mfa', 'session', 'idp'].map(k => <ProposedRow key={k} k={k} onPropose={() => setModal(k)} />)}
      <SRow label="Política de uso de IA" hint="Se define al instalar · si está vacía, el registro no pide aceptarla">{cfg.aiPolicyUrl ? <a className="ro-field" href={cfg.aiPolicyUrl} target="_blank" rel="noopener noreferrer"><I.Lock size={12} />{cfg.aiPolicyUrl}</a> : <div className="ro-field"><I.Lock size={12} />Sin política configurada</div>}</SRow>
      <SRow label="Política de contraseñas" hint="Cognito · se define al instalar"><div className="ro-field"><I.Lock size={12} />Mínimo 14 caracteres, con mayúsculas, minúsculas, números y símbolos</div></SRow>
      <SRow label="Contraseña y MFA de cada usuario" hint="No se cambian desde la cuenta"><div style={{ fontSize: 13, lineHeight: 1.5 }}>Para cambiar su contraseña, el usuario usa «Olvidé mi contraseña» en el login. Para restablecer su MFA, se lo pide a un admin.</div></SRow>
      <MfaResetBlock />
      {!avail && <ChangeList keys={['mfa', 'session', 'idp']} />}
      {modal && <ProposeSetting k={modal} onClose={() => setModal(null)} />}
    </SettingsSection>
  );
}

function ConvAccessSection() {
  const [modal, setModal] = useState(false);
  const cfg = window.useMango(s => s.authCfg);
  return (
    <SettingsSection title="Acceso de admins a conversaciones" desc="Desactivado por defecto. Al activarlo, los admins autorizados pueden abrir conversaciones de otros usuarios y ver el texto de las preguntas en Observabilidad. Cada lectura queda registrada en Auditoría.">
      <window.GovKit.Banner tone={cfg.convAccess ? 'warn' : 'info'} title={cfg.convAccess ? 'Activado' : 'Desactivado'}>
        {cfg.convAccess ? 'Los admins autorizados pueden leer conversaciones. Cada lectura genera un evento en Auditoría.' : 'Los admins solo ven metadatos: agente, usuario, duración, tokens, costo y tools usadas.'}
      </window.GovKit.Banner>
      <div style={{ height: 12 }} />
      <ProposedRow k="convAccess" onPropose={() => setModal(true)} />
      <ChangeList keys={['convAccess']} />
      {modal && <ProposeSetting k="convAccess" onClose={() => setModal(false)} />}
    </SettingsSection>
  );
}

function MfaResetBlock() {
  const I = window.Icons; const S = window.MangoStore; const K = window.GovKit;
  const role = window.useMango(s => s.role);
  window.useMango(s => s.actorOverride); window.useMango(s => s.changes);
  const toast = window.useToast?.();
  const [q, setQ] = useState(''); const [reason, setReason] = useState(''); const [verified, setVerified] = useState(false); const [tried, setTried] = useState(false);
  const me = S.actorEmail();
  const target = q.trim().toLowerCase();
  const pending = (S.get().changes || []).find(c => c.kind === 'mfa_reset' && c.target === target && chgStatus(c) === 'pending');
  const err = !target ? 'Escribe el correo del usuario' : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target) ? 'Escribe un correo válido' : target === me ? 'No puedes restablecer tu propio MFA: pídeselo a otro admin' : pending ? 'Ya hay una solicitud pendiente para este correo' : !reason.trim() ? 'Escribe el motivo' : !verified ? 'Confirma que verificaste la identidad del usuario por otro canal' : null;
  const [failed, setFailed] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [actErr, setActErr] = useState(null);
  const listErr = window.useMango(s => s.mfaListErr);
  const submit = () => { setTried(true); setFailed(false); setNotFound(false); if (err) return; if (!/^usuario[1-9]@empresa\.com$/.test(target)) { setNotFound(true); return; } try { S.propose({ kind: 'mfa_reset', key: 'mfa_reset', target, from: null, to: null, title: 'Restablecer MFA de ' + target, summary: 'Borra su MFA y cierra todas sus sesiones · identidad verificada por otro canal', reason: reason.trim(), verified: true }); } catch (e) { setFailed(true); return; } toast?.({ tone: 'success', msg: 'Solicitud enviada · la debe aprobar otro admin' }); setQ(''); setReason(''); setVerified(false); setTried(false); };
  if (role !== 'admin') return null;
  return (
    <section style={{ marginTop: 22 }}>
      <div className="g-sec-t" style={{ marginBottom: 4 }}>Restablecer MFA de un usuario</div>
      <div className="g-sec-meta" style={{ marginBottom: 10 }}>Lo propone un admin y lo aprueba otro distinto. Al aplicarse se borra su MFA y se cierran todas sus sesiones; en su próximo ingreso lo configura de nuevo. Nadie puede restablecer el suyo. Si nadie la aprueba en 72 h, vence.</div>
      <div className="card" style={{ padding: 14, display: 'grid', gap: 10 }}>
        <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
          <input className="input" type="email" autoComplete="off" style={{ flex: '1 1 220px' }} value={q} onChange={e => { setQ(e.target.value); setNotFound(false); setFailed(false); setTried(false); }} placeholder="Correo del usuario · usuario3@empresa.com" aria-label="Correo del usuario" />
          <input className="input" style={{ flex: '2 1 260px' }} value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo (obligatorio)" aria-label="Motivo" />
        </div>
        <label className="row gap-2" style={{ fontSize: 13, cursor: 'pointer', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} style={{ accentColor: 'var(--accent-ink)', marginTop: 2 }} />
          <span>Verifiqué la identidad del usuario por otro canal <span style={{ color: 'var(--text-muted)' }}>· llamada, videollamada o en persona; no por el mismo correo</span></span>
        </label>
        <div className="row gap-2" style={{ justifyContent: 'flex-end' }}><button className="btn btn-sm btn-primary" onClick={submit}>Proponer restablecimiento</button></div>
        {tried && err && <div className="g-err" role="alert">{err}</div>}
        {notFound && !err && <div className="g-err" role="alert">Ese correo no está en el directorio</div>}
        {failed && !err && <div className="g-err" role="alert">No se pudo completar la acción. Inténtalo de nuevo.</div>}
        {!tried && q.trim().toLowerCase() === me && <K.Reason>Es tu propia cuenta: otro admin debe restablecer tu MFA.</K.Reason>}
      </div>
      {actErr && <div className="g-err" role="alert" style={{ marginTop: 14 }}>{actErr}</div>}
      {listErr ? <section style={{ marginTop: 22 }}><div className="g-sec-t" style={{ marginBottom: 10 }}>Restablecimientos de MFA</div><div className="g-err" role="alert">No se pudo completar la acción. Inténtalo de nuevo.</div></section>
        : <ChangeList kind="mfa_reset" title="Restablecimientos de MFA" onActError={setActErr} />}
    </section>
  );
}

function ProposedRow({ k, onPropose }) {
  const S = window.MangoStore; const I = window.Icons;
  const cfg = window.useMango(s => s.authCfg);
  const changes = window.useMango(s => s.changes);
  const role = window.useMango(s => s.role);
  const pending = changes.find(c => c.kind === 'auth' && c.key === k && c.status === 'pending');
  const fixedMfa = k === 'mfa' && cfg.install === 'client';
  const avail = window.useMango(s => s.avail);
  return (
    <SRow label={SET_LABELS[k].title} hint={fixedMfa ? 'Instalación de cliente: siempre obligatorio' : null}>
      <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{setVal(k, cfg[k])}</span>
        {pending && !avail && <span className="badge badge-amber">Cambio pendiente → {setVal(k, pending.to)}</span>}
        <div style={{ flex: 1 }} />
        {fixedMfa ? <span className="ro-field" style={{ fontFamily: 'var(--font-sans)' }}><I.Lock size={12} />Fijo</span>
          : avail ? <window.Soon on><button className="btn btn-sm" title="Hoy se configura al instalar">Proponer cambio</button></window.Soon>
          : <button className="btn btn-sm" disabled={!!pending || role !== 'admin'} title={pending ? 'Ya hay un cambio pendiente para este ajuste' : role !== 'admin' ? 'Solo admins' : undefined} onClick={onPropose}>Proponer cambio</button>}
      </div>
    </SRow>
  );
}

function ProposeSetting({ k, onClose }) {
  const S = window.MangoStore; const K = window.GovKit;
  const cfg = S.get().authCfg;
  const [to, setTo] = useState(k === 'convAccess' ? !cfg.convAccess : cfg[k]);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const toast = window.useToast?.();
  const same = to === cfg[k];
  const lockedOff = k === 'mfa' && cfg.install === 'client';
  const err = !reason.trim() ? 'El motivo es obligatorio' : null;
  const submit = () => { setTried(true); if (err || same) return; S.propose({ kind: 'auth', key: k, from: cfg[k], to, reason: reason.trim() }); toast?.({ tone: 'success', msg: 'Propuesta enviada · la debe aprobar otro admin' }); onClose(); };
  return (
    <K.Modal title={'Proponer cambio · ' + SET_LABELS[k].title} sub="No se aplica hasta que otro admin lo apruebe. Queda registrado en Auditoría." onClose={onClose} autoFocus={false}
      footer={<><button className="btn btn-sm" onClick={onClose}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={same} onClick={submit}>Enviar propuesta</button></>}>
      <div className="g-field">
        <label>Valor actual: {setVal(k, cfg[k])}</label>
        {k === 'session' ? (
          <div className="row gap-2"><input type="range" min="1" max="24" value={to} onChange={e => setTo(+e.target.value)} style={{ flex: 1 }} aria-label="Horas" /><span className="mono" style={{ width: 48, textAlign: 'right' }}>{to} h</span></div>
        ) : (
          <div className="set-choice" role="radiogroup">
            {Object.keys(SET_LABELS[k].v).filter(v => !(lockedOff && v !== 'required')).map(v => { const val = k === 'convAccess' ? v === 'true' : v; const dis = false; return (
              <button key={v} role="radio" aria-checked={to === val} className={to === val ? 'is-on' : ''} disabled={dis} title={dis ? 'En instalaciones de clientes MFA no se puede desactivar' : undefined} onClick={() => setTo(val)}>{setVal(k, val)}</button>
            ); })}
          </div>
        )}
        {lockedOff && <K.Reason>Instalación de cliente: MFA solo puede ser obligatorio.</K.Reason>}
        {k === 'convAccess' && to === true && <K.Reason tone="warn">Los admins autorizados podrán leer conversaciones de otros usuarios. Cada lectura queda en Auditoría.</K.Reason>}
        {k === 'idp' && to !== 'none' && <div className="g-hint">Al aprobarse, el login muestra «Continuar con SSO».</div>}
        {same && <div className="g-hint">Elige un valor distinto del actual.</div>}
      </div>
      <div className="g-field">
        <label htmlFor="chg-reason">Motivo</label>
        <textarea id="chg-reason" className={'input' + (tried && err ? ' has-error' : '')} rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Por qué se necesita. Lo verá quien lo revise." />
        {tried && err ? <div className="g-err">{err}</div> : <div className="g-hint">Obligatorio.</div>}
      </div>
    </K.Modal>
  );
}

function ChangeList({ keys, kind = 'auth', target, title = 'Cambios propuestos', onActError }) {
  const S = window.MangoStore; const K = window.GovKit;
  const changes = window.useMango(s => s.changes);
  window.useMango(s => s.actorOverride);
  const role = window.useMango(s => s.role);
  const me = S.actor();
  const list = changes.filter(c => c.kind === kind && (keys ? keys.includes(c.key) : true) && (!target || c.target === target));
  const [rej, setRej] = useState(null);
  const [busy, setBusy] = useState(null);
  const act = (id, fn) => { onActError?.(null); setBusy(id); setTimeout(() => { setBusy(null); const sim = kind === 'mfa_reset' && S.get().mfaActErr; if (sim) { onActError?.(sim === '409' || sim === '410' ? 'La solicitud ya no está pendiente: otro admin la decidió o venció.' : 'No se pudo completar la acción. Inténtalo de nuevo.'); return; } fn(); }, kind === 'mfa_reset' ? 600 : 0); };
  const [note, setNote] = useState('');
  if (!list.length) return null;
  return (
    <section style={{ marginTop: 22 }}>
      <div className="g-sec-t" style={{ marginBottom: 4 }}>{title}</div>
      <div className="g-sec-meta" style={{ marginBottom: 10 }}>Los propone un admin y los aprueba otro distinto.</div>
      <div className="chg-list">
        {list.map(c => { const status = chgStatus(c); const st = CHG_STATUS[status] || CHG_STATUS.pending; const mine = c.by === me; return (
          <article key={c.id} className="chg">
            <div className="chg-h">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}><span className="chg-t">{c.kind === 'auth' ? SET_LABELS[c.key].title : c.title || 'Acceso al agente'}</span>{c.decidedBy === 'Sistema' && <span className="badge">Rechazado automáticamente</span>}<span className={'badge ' + st[1]}>{st[0]}</span></div>
                <div className="chg-m"><span>{mine ? 'Tu propuesta' : 'Propuesta de ' + c.by}</span><span>{window.fmtAgo ? window.fmtAgo(c.at) : ''}</span><span className="mono">{c.id}</span>{status === 'expired' && <span>Nadie la aprobó en 72 h</span>}{status === 'withdrawn' && <span>La retiró {c.by}</span>}{c.decidedBy && <span>{c.status === 'approved' ? 'Aprobó' : 'Rechazó'} {c.decidedBy}</span>}</div>
              </div>
              {status === 'pending' && <div className="chg-act">
                {mine ? <><K.Reason>Otro admin debe aprobarla</K.Reason><button className="btn btn-sm" disabled={busy === c.id} onClick={() => act(c.id, () => S.withdrawChange(c.id))}>Retirar</button></>
                  : c.kind === 'mfa_reset' && c.target === S.actorEmail() ? <K.Reason>Es sobre tu cuenta: la debe aprobar otro admin</K.Reason>
                  : role === 'admin' ? <><button className="btn btn-sm" disabled={busy === c.id} onClick={() => { setRej(c.id); setNote(''); }}>Rechazar</button><button className="btn btn-sm btn-primary" disabled={busy === c.id} onClick={() => act(c.id, () => S.decideChange(c.id, 'approved'))}>Aprobar</button></> : null}
              </div>}
            </div>
            <div className="chg-diff">{c.kind === 'auth' ? <><span className="old">{setVal(c.key, c.from)}</span><span aria-hidden="true">→</span><span className="new">{setVal(c.key, c.to)}</span></> : <span className="new">{c.summary}</span>}</div>
            {c.reason && <div className="chg-why"><span className="g-diff-k">Motivo</span> {c.reason}</div>}
            {c.note && <div className="chg-why"><span className="g-diff-k">Motivo del rechazo</span> {c.note}</div>}
            {rej === c.id && <div className="g-field" style={{ marginTop: 10 }}>
              <textarea className="input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Explica por qué no se aplica (obligatorio)" aria-label="Motivo del rechazo" autoFocus />
              <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 6 }}><button className="btn btn-sm" disabled={busy === c.id} onClick={() => setRej(null)}>Cancelar</button><button className="btn btn-sm btn-primary" disabled={!note.trim() || busy === c.id} onClick={() => act(c.id, () => { S.decideChange(c.id, 'rejected', note.trim()); setRej(null); })}>Rechazar</button></div>
            </div>}
          </article>
        ); })}
      </div>
    </section>
  );
}

function SettingsSection({ title, desc, children }) {
  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em', margin: '0 0 4px' }}>{title}</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5, textWrap: 'pretty' }}>{desc}</p>
      </div>
      {children}
    </div>
  );
}

function SRow({ label, hint, children }) {
  return (
    <div className="set-row" style={{ padding: '14px 0', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'minmax(0,220px) minmax(0,1fr)', gap: 20, alignItems: 'flex-start' }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {hint && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>{hint}</div>}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

function SToggle({ label, desc, checked, onChange }) {
  return (
    <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>{desc}</div>}
      </div>
      <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} style={{ width: 36, height: 20, borderRadius: 10, background: checked ? 'var(--accent)' : 'var(--border-strong)', border: 'none', position: 'relative', flexShrink: 0, marginTop: 2 }}>
        <span style={{ position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s' }} />
      </button>
    </div>
  );
}

Object.assign(window, { Settings, ChangeList, SET_LABELS });
