// Login — correo y contraseña (Cognito), registro con dominio corporativo, verificación, recuperación, MFA y SSO
const LOGIN_SLIDES = [
  { k: 'spend', title: <>Límites de gasto que <b>bloquean al 100 %</b></> },
  { k: 'agents', title: <>Pregúntale a <b>FinOps</b> por tus costos</> },
  { k: 'audit', title: <>Cada acción queda <b>registrada</b></> },
];
const LOGIN_DOMAIN = 'empresa.com';
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const PWD_RULE = 'Mínimo 14 caracteres, con mayúsculas, minúsculas, números y símbolos';
function pwdScore(p) { return [p.length >= 14, /[A-Z]/.test(p), /[a-z]/.test(p), /\d/.test(p), /[^A-Za-z0-9]/.test(p)].filter(Boolean).length; }
const pwdOk = (p) => pwdScore(p) === 5;

function Login({ onLogin }) {
  const cfg = window.useMango(s => s.authCfg);
  const accountState = window.useMango(s => s.accountState);
  const [slide, setSlide] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const reduceMotion = window.useMedia ? window.useMedia('(prefers-reduced-motion: reduce)') : false;
  const paused = userPaused || hover || focusIn || reduceMotion;
  useEffect(() => { if (paused) return; const t = setInterval(() => setSlide(s => (s + 1) % LOGIN_SLIDES.length), 5000); return () => clearInterval(t); }, [paused]);
  const [fresh, setFresh] = useState(false);
  // step: login | newpwd | enroll | mfa | signup | verify | forgot | reset | pending
  const boot = window.MangoStore.get().simSessionBoot;
  const [step, setStep] = useState(boot === 'restoring' || boot === 'ssoReturn' ? 'restoring' : 'login');
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState(boot === 'otherTab' ? 'Cerraste sesión en otra pestaña. Vuelve a entrar para seguir.' : null);
  useEffect(() => { if (step !== 'restoring') return; const t = setTimeout(() => setStep('login'), 1600); return () => clearTimeout(t); }, [step]);
  const go = (s, n = null) => { setStep(s); setNotice(n); };
  const afterAuth = () => { if (accountState === 'nogroup' || fresh) go('pending'); else onLogin(); };
  const mfaOn = cfg.mfa !== 'off';
  const [enrolled, setEnrolled] = useState(cfg.mfaEnrolled);
  useEffect(() => setEnrolled(cfg.mfaEnrolled), [cfg.mfaEnrolled]);
  const resets = window.useMango(s => s.mfaResets) || {};
  const wasReset = !!resets[(email || 'usuario1@empresa.com').trim().toLowerCase()];
  const needsEnroll = (cfg.mfa === 'required' && !enrolled) || wasReset;
  const afterPwd = () => needsEnroll ? go('enroll') : mfaOn && enrolled ? go('mfa') : afterAuth();

  return (
    <div className="login">
      <div className="login-form-col">
        <div className="login-brand"><span className="sb-ws-logo" aria-hidden="true">m</span><span>Mango</span></div>
        {step === 'restoring' && <div className="login-form login-restoring" role="status"><span className="mango-spinner" aria-hidden="true" /><span>{boot === 'ssoReturn' ? 'Completando el ingreso…' : 'Recuperando tu sesión…'}</span></div>}
        {step === 'login' && <SignIn email={email} setEmail={setEmail} notice={notice} idp={cfg.idp} onForgot={() => go('forgot')} onOk={() => { window.MangoStore.set({ loggedVia: 'password' }); accountState === 'temp' ? go('newpwd') : afterPwd(); }} onSso={() => { window.MangoStore.set({ loggedVia: 'sso' }); afterAuth(); }} />}
        {step === 'newpwd' && <NewPassword email={email || 'usuario1@empresa.com'} onBack={() => go('login')} onOk={() => { window.MangoStore?.log('account.password_set', email || 'usuario1@empresa.com', 'Creó su contraseña en el primer ingreso · la temporal dejó de valer'); afterPwd(); }} />}
        {step === 'enroll' && <MfaEnroll email={email || 'usuario1@empresa.com'} onBack={() => go('login')} onOk={() => { setEnrolled(true); if (wasReset) { const r = { ...(window.MangoStore.get().mfaResets || {}) }; delete r[(email || 'usuario1@empresa.com').trim().toLowerCase()]; window.MangoStore.set({ mfaResets: r }); } window.MangoStore?.log('account.mfa_enroll', email || 'usuario1@empresa.com', 'Configuró MFA con app autenticadora en el primer ingreso'); afterAuth(); }} />}
        {step === 'mfa' && <MfaStep onBack={() => go('login')} onOk={afterAuth} />}
        {step === 'signup' && <SignupForm policyUrl={cfg.aiPolicyUrl} onDone={(e) => { setEmail(e); go('verify'); }} />}
        {step === 'verify' && <CodeStep title="Verifica tu correo" sub={<>Si <b>{email}</b> puede registrarse, te enviamos un código de 6 dígitos. Vence en 24 horas.</>} cta="Verificar correo" onBack={() => go('signup')} backLabel="Cambiar correo"
          onOk={() => { window.MangoStore?.log('account.create', email, 'Cuenta creada y correo verificado · sin grupo asignado'); setFresh(true); if (mfaOn) { setEnrolled(false); go('enroll'); } else go('pending'); }} />}
        {step === 'forgot' && <ForgotStep email={email} setEmail={setEmail} onBack={() => go('login')} onSent={() => go('reset')} />}
        {step === 'reset' && <ResetStep email={email} onBack={() => go('forgot')} onDone={() => go('login', 'Contraseña actualizada. Ya puedes entrar.')} />}
        {step === 'pending' && <NoAccess email={email || 'usuario1@empresa.com'} onLogout={() => go('login')} />}
        {(step === 'login' || step === 'signup') && <p className="login-foot">{step === 'login'
          ? <>¿No tienes cuenta? <a href="#" onClick={e => { e.preventDefault(); go('signup'); }}>Crear cuenta</a></>
          : <>¿Ya tienes cuenta? <a href="#" onClick={e => { e.preventDefault(); go('login'); }}>Inicia sesión</a></>}</p>}
      </div>

      <div className="login-panel" role="region" aria-roledescription="carrusel" aria-label="Qué puedes hacer con Mango" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setFocusIn(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocusIn(false); }}>
        <div className="login-stage" aria-live={paused ? 'polite' : 'off'}>
          {[<SlideSpend />, <SlideAgents />, <SlideAudit />].map((el, i) => <div key={i} className="login-tabpanel" id={'login-slide-' + i} role="tabpanel" aria-labelledby={'login-dot-' + i} hidden={slide !== i}><p className="sr-only">{LOGIN_SLIDES[i].title}</p><div aria-hidden="true">{el}</div></div>)}
        </div>
        <div className="login-ctrl">
          <div className="login-dots" role="tablist" aria-label="Diapositivas">
            {LOGIN_SLIDES.map((s, i) => <button key={s.k} id={'login-dot-' + i} role="tab" aria-selected={slide === i} aria-controls={'login-slide-' + i} tabIndex={slide === i ? 0 : -1} aria-label={'Diapositiva ' + (i + 1)} className={slide === i ? 'on' : ''} onClick={() => setSlide(i)}
              onKeyDown={e => { const n = LOGIN_SLIDES.length; const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null; if (to === null) return; e.preventDefault(); setSlide(to); document.getElementById('login-dot-' + to)?.focus(); }} />)}
          </div>
          {!reduceMotion && <button type="button" className="login-pause" onClick={() => setUserPaused(p => !p)}>{userPaused ? 'Reanudar' : 'Pausar'}</button>}
        </div>
        <p className="login-tagline" aria-hidden="true">{LOGIN_SLIDES[slide].title}</p>
      </div>
    </div>
  );
}

function PwdInput({ id, value, onChange, placeholder = 'Contraseña', autoComplete = 'current-password', invalid, describedBy }) {
  const I = window.Icons;
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <label className="sr-only" htmlFor={id}>{placeholder}</label>
      <input id={id} className="login-input" type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ paddingRight: 48 }} aria-invalid={invalid} aria-describedby={describedBy} />
      <button type="button" className="login-eye" aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={show} onClick={() => setShow(v => !v)}><I.Eye size={16} /></button>
    </div>
  );
}

function SignIn({ email, setEmail, notice, idp, onForgot, onOk, onSso }) {
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(null);
  const submit = (e) => {
    e.preventDefault(); setErr(null);
    if (!isEmail(email) || !pwd) { setErr('Escribe tu correo y tu contraseña.'); return; }
    setLoading('pwd');
    setTimeout(() => { setLoading(null); if (pwd.length < 4) { setErr('Correo o contraseña incorrectos.'); return; } onOk(); }, 800);
  };
  const sso = () => { setLoading('sso'); setTimeout(onSso, 900); };
  return (
    <div className="login-form">
      <h1 className="login-title">Bienvenido</h1>
      <p className="login-sub">Entra con tu correo de la empresa para hablar con los agentes de <b>Mango</b>.</p>
      {notice && <div className="login-ok-box" role="status" style={{ marginBottom: 12 }}>{notice}</div>}
      <form onSubmit={submit} className="login-fields" noValidate>
        <label className="sr-only" htmlFor="lg-email">Correo</label>
        <input id="lg-email" className="login-input" type="email" autoComplete="username" value={email} onChange={e => { setEmail(e.target.value); setErr(null); }} placeholder={'Correo · usuario1@' + LOGIN_DOMAIN} />
        <PwdInput id="lg-pwd" value={pwd} onChange={(v) => { setPwd(v); setErr(null); }} />
        {err && <div className="login-err-box" role="alert">{err}</div>}
        <button type="button" className="login-forgot login-link" onClick={onForgot}>¿Olvidaste tu contraseña?</button>
        <button type="submit" className="login-primary" disabled={!!loading}>{loading === 'pwd' ? 'Entrando…' : 'Entrar'}</button>
      </form>
      <p className="login-keep">Sigues dentro hasta 8 h, aunque recargues o cierres el navegador. En un equipo compartido, cierra sesión al terminar.</p>
      {idp !== 'none' && <>
        <div className="login-divider"><span>o</span></div>
        <button className="login-sso-btn" style={{ width: '100%' }} disabled={!!loading} onClick={sso}>{loading === 'sso' ? 'Redirigiendo a tu proveedor…' : 'Continuar con SSO'}</button>
      </>}
    </div>
  );
}

function useCode() {
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const refs = React.useRef([]);
  useEffect(() => { setTimeout(() => refs.current[0]?.focus(), 50); }, []);
  const setDigit = (i, v) => {
    const d = v.replace(/\D/g, '');
    if (d.length > 1) { const arr = d.slice(0, 6).split(''); setCode([...arr, ...Array(6 - arr.length).fill('')]); refs.current[Math.min(5, arr.length)]?.focus(); return; }
    const n = [...code]; n[i] = d; setCode(n);
    if (d && i < 5) refs.current[i + 1]?.focus();
  };
  const reset = () => { setCode(['', '', '', '', '', '']); refs.current[0]?.focus(); };
  const cells = (label) => (
    <div className="login-code" role="group" aria-label={label}>
      {code.map((d, i) => (
        <input key={i} ref={el => refs.current[i] = el} className="login-input login-code-cell" inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={6} aria-label={'Dígito ' + (i + 1)} value={d}
          onChange={e => setDigit(i, e.target.value)} onKeyDown={e => { if (e.key === 'Backspace' && !d && i > 0) refs.current[i - 1]?.focus(); }} />
      ))}
    </div>
  );
  return { value: code.join(''), cells, reset };
}

function CodeStep({ title, sub, cta, onOk, onBack, backLabel, resend = true, label = 'Código de verificación', children, before }) {
  const c = useCode();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);
  const submit = (e) => { e.preventDefault(); if (c.value.length < 6) return; setLoading(true); setErr(null); setTimeout(() => { setLoading(false); if (c.value === '000000') { setErr('El código no es válido o venció. Pide uno nuevo.'); return; } onOk(c.value); }, 800); };
  return (
    <div className="login-form">
      <h1 className="login-title">{title}</h1>
      <p className="login-sub">{sub}</p>
      <form onSubmit={submit} className="login-fields">
        {before}
        {c.cells(label)}
        {children}
        {err && <div className="login-err-box" role="alert">{err}</div>}
        {sent && !err && <div className="login-ok-box" role="status">Si corresponde, te enviamos un código nuevo.</div>}
        <button type="submit" className="login-primary" disabled={loading || c.value.length < 6} style={{ marginTop: 12 }}>{loading ? 'Verificando…' : cta}</button>
      </form>
      <div className="row gap-2" style={{ justifyContent: 'center', marginTop: 18, fontSize: 13, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        {resend && <><span>¿No te llegó?</span><button className="login-link" onClick={() => { c.reset(); setErr(null); setSent(true); }}>Reenviar código</button><span aria-hidden="true">·</span></>}
        <button className="login-link" onClick={onBack}>{backLabel || 'Volver'}</button>
      </div>
    </div>
  );
}

function MfaEnroll({ email, onOk, onBack }) {
  const I = window.Icons;
  const secret = 'XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX';
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(secret.replace(/\s/g, '')); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <CodeStep title="Configura la verificación en dos pasos" cta="Activar y entrar" label="Primer código de la app autenticadora" resend={false} backLabel="Usar otra cuenta" onOk={onOk} onBack={onBack}
      sub={<>Tu empresa exige MFA. Escanea el código con tu app autenticadora (Google Authenticator, Microsoft Authenticator, 1Password…) para <b>{email}</b> y escribe el primer código de 6 dígitos.</>}
      before={<div className="mfa-enroll">
        <div className="mfa-qr" role="img" aria-label="Código QR para la app autenticadora"><I.Lock size={18} /><span>Código QR</span></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 6 }}>¿No puedes escanear? Escribe este secreto en la app:</div>
          <code className="mfa-secret">{secret}</code>
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={copy} aria-label="Copiar secreto"><I.Copy size={12} /> {copied ? 'Copiado' : 'Copiar secreto'}</button>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>Tipo: basado en tiempo (TOTP) · 6 dígitos · cada 30 s. Si pierdes el acceso a la app, un admin puede restablecer tu MFA.</div>
        </div>
      </div>} />
  );
}

function MfaStep({ onOk, onBack }) {
  return <CodeStep title="Verificación en dos pasos" sub="Abre tu app autenticadora y escribe el código de 6 dígitos de Mango. ¿Perdiste el acceso a la app? Pídele a un admin que restablezca tu MFA." cta="Verificar y entrar" label="Código de la app autenticadora" resend={false} backLabel="Usar otra cuenta" onOk={onOk} onBack={onBack} />;
}

function ForgotStep({ email, setEmail, onBack, onSent }) {
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const submit = (e) => { e.preventDefault(); if (!isEmail(email)) { setErr('Escribe un correo válido.'); return; } setLoading(true); setTimeout(() => { setLoading(false); onSent(); }, 700); };
  return (
    <div className="login-form">
      <h1 className="login-title">Recupera tu contraseña</h1>
      <p className="login-sub">Escribe tu correo. Si tiene una cuenta en Mango, te enviaremos un código para crear una contraseña nueva. El código vence en 1 hora.</p>
      <form onSubmit={submit} className="login-fields" noValidate>
        <label className="sr-only" htmlFor="fg-email">Correo</label>
        <input id="fg-email" className="login-input" type="email" autoComplete="username" value={email} onChange={e => { setEmail(e.target.value); setErr(null); }} placeholder="Correo" aria-invalid={!!err} />
        {err && <span className="login-err">{err}</span>}
        <button type="submit" className="login-primary" disabled={loading}>{loading ? 'Enviando…' : 'Enviar código'}</button>
      </form>
      <div style={{ textAlign: 'center', marginTop: 18 }}><button className="login-link" onClick={onBack}>Volver a iniciar sesión</button></div>
    </div>
  );
}

function ResetStep({ email, onBack, onDone }) {
  const [pwd, setPwd] = useState('');
  const [tried, setTried] = useState(false);
  const bad = !pwdOk(pwd);
  return (
    <CodeStep title="Crea una contraseña nueva" sub={<>Si <b>{email}</b> tiene una cuenta, te enviamos un código. Vence en 1 hora. Escríbelo junto con tu nueva contraseña.</>} cta="Guardar contraseña" backLabel="Cambiar correo" onBack={onBack}
      onOk={() => { setTried(true); if (!bad) onDone(); }}>
      <div style={{ marginTop: 12 }}><PwdInput id="rs-pwd" value={pwd} onChange={setPwd} placeholder="Nueva contraseña" autoComplete="new-password" invalid={tried && bad} /></div>
      <PwdMeter pwd={pwd} />
      <span className={tried && bad ? 'login-err' : 'login-hint'}>{PWD_RULE}</span>
    </CodeStep>
  );
}

function NewPassword({ email, onOk, onBack }) {
  const [pwd, setPwd] = useState(''); const [pwd2, setPwd2] = useState('');
  const [tried, setTried] = useState(false); const [loading, setLoading] = useState(false);
  const err = !pwdOk(pwd) ? PWD_RULE : pwd2 !== pwd ? 'Las contraseñas no coinciden' : null;
  const submit = (e) => { e.preventDefault(); setTried(true); if (err) return; setLoading(true); setTimeout(() => { setLoading(false); onOk(); }, 800); };
  return (
    <div className="login-form">
      <h1 className="login-title">Crea tu contraseña</h1>
      <p className="login-sub">Un admin creó tu cuenta <b>{email}</b> con una contraseña temporal. Elige una nueva para seguir; la temporal deja de valer.</p>
      <form onSubmit={submit} className="login-fields" noValidate>
        <PwdInput id="np-pwd" value={pwd} onChange={setPwd} placeholder="Nueva contraseña" autoComplete="new-password" invalid={tried && !pwdOk(pwd)} describedBy="np-rule" />
        <PwdMeter pwd={pwd} />
        <span id="np-rule" className={tried && !pwdOk(pwd) ? 'login-err' : 'login-hint'}>{PWD_RULE}</span>
        <PwdInput id="np-pwd2" value={pwd2} onChange={setPwd2} placeholder="Confirma la contraseña" autoComplete="new-password" invalid={tried && pwdOk(pwd) && pwd2 !== pwd} describedBy="np-err2" />
        {tried && pwdOk(pwd) && pwd2 !== pwd && <span id="np-err2" className="login-err">Las contraseñas no coinciden</span>}
        <button type="submit" className="login-primary" disabled={loading} style={{ marginTop: 6 }}>{loading ? 'Guardando…' : 'Guardar y continuar'}</button>
      </form>
      <div style={{ textAlign: 'center', marginTop: 18 }}><button className="login-link" onClick={onBack}>Usar otra cuenta</button></div>
    </div>
  );
}

function PwdMeter({ pwd }) {
  if (!pwd) return null;
  const score = pwdScore(pwd);
  return (
    <div className="row gap-2" style={{ padding: '0 6px', fontSize: 12, color: 'var(--text-muted)' }}>
      <span style={{ display: 'flex', gap: 4, flex: 1 }}>{[0, 1, 2, 3, 4].map(i => <span key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i < score ? (score === 5 ? 'var(--green)' : 'var(--amber)') : 'var(--border)' }} />)}</span>
      <span>{score === 5 ? 'Cumple la política' : 'Aún no cumple'}</span>
    </div>
  );
}

function SignupForm({ onDone, policyUrl }) {
  const [f, setF] = useState({ name: '', email: '', pwd: '', terms: false });
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const domain = (f.email.split('@')[1] || '').toLowerCase();
  const errs = {
    name: !f.name.trim() && 'Escribe tu nombre',
    email: !isEmail(f.email) ? 'Escribe un correo válido' : domain !== LOGIN_DOMAIN ? 'Solo se aceptan correos @' + LOGIN_DOMAIN + '. Usa tu correo de la empresa.' : null,
    pwd: !pwdOk(f.pwd) && PWD_RULE,
    terms: !!policyUrl && !f.terms && 'Acepta la política de uso de IA',
  };
  const valid = !Object.values(errs).some(Boolean);
  const submit = (e) => { e.preventDefault(); setTouched(true); if (!valid) return; setLoading(true); setTimeout(() => { setLoading(false); onDone(f.email); }, 900); };
  const Err = ({ k }) => touched && errs[k] ? <span className="login-err" id={'err-' + k}>{errs[k]}</span> : null;
  return (
    <div className="login-form">
      <h1 className="login-title">Crea tu cuenta</h1>
      <p className="login-sub">Usa tu correo @{LOGIN_DOMAIN}. Después de verificarlo, un admin te asigna a un grupo para darte acceso.</p>
      <form onSubmit={submit} className="login-fields" noValidate>
        <label className="sr-only" htmlFor="su-name">Nombre</label>
        <input id="su-name" className="login-input" autoComplete="name" placeholder="Nombre · Usuario 1" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} aria-invalid={touched && !!errs.name} aria-describedby="err-name" />
        <Err k="name" />
        <label className="sr-only" htmlFor="su-email">Correo de la empresa</label>
        <input id="su-email" className="login-input" type="email" autoComplete="email" placeholder={'Correo · usuario1@' + LOGIN_DOMAIN} value={f.email} onChange={e => setF({ ...f, email: e.target.value })} aria-invalid={touched && !!errs.email} aria-describedby="err-email" />
        <Err k="email" />
        <PwdInput id="su-pwd" value={f.pwd} onChange={(v) => setF({ ...f, pwd: v })} autoComplete="new-password" invalid={touched && !!errs.pwd} describedBy="err-pwd" />
        <PwdMeter pwd={f.pwd} />
        {touched && errs.pwd ? <Err k="pwd" /> : <span className="login-hint">{PWD_RULE}</span>}
        {policyUrl && <><label className="row gap-2" style={{ fontSize: 13, padding: '4px 6px', cursor: 'pointer', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={f.terms} onChange={e => setF({ ...f, terms: e.target.checked })} style={{ accentColor: 'var(--accent-ink)', marginTop: 2 }} />
          <span>Acepto la <a href={policyUrl} target="_blank" rel="noopener noreferrer">política de uso de IA</a> de la empresa</span>
        </label>
        <Err k="terms" /></>}
        <button type="submit" className="login-primary" disabled={loading} style={{ marginTop: 6 }}>{loading ? 'Creando cuenta…' : 'Crear cuenta'}</button>
      </form>
    </div>
  );
}

function NoAccess({ email, onLogout }) {
  const I = window.Icons;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const check = () => { setChecking(true); setTimeout(() => { setChecking(false); setChecked(true); }, 800); };
  return (
    <div className="login-form">
      <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}><I.Lock size={20} /></span>
      <h1 className="login-title">Todavía no tienes acceso</h1>
      <p className="login-sub">Tu cuenta <b>{email}</b> está creada y verificada, pero aún no pertenece a ningún grupo. Mientras tanto no puedes ver agentes ni abrir conversaciones.</p>
      <div className="login-note">
        <div style={{ fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>Qué sigue</div>
        Un administrador de Mango tiene que agregarte a un grupo: ya te ve en su lista como pendiente. Cuando lo haga, vuelve a comprobar y verás los agentes de ese grupo. Si lo necesitas antes, pídeselo al equipo que administra Mango en tu empresa.
      </div>
      {checked && <div className="login-err-box" role="status" style={{ marginTop: 12 }}>Aún no tienes un grupo asignado.</div>}
      <div className="row gap-2" style={{ marginTop: 16 }}>
        <button className="login-primary" style={{ flex: 1 }} onClick={check} disabled={checking}>{checking ? 'Comprobando…' : 'Volver a comprobar'}</button>
      </div>
      <div style={{ textAlign: 'center', marginTop: 16 }}><button className="login-link" onClick={onLogout}>Cerrar sesión</button></div>
    </div>
  );
}

function SlideSpend() {
  const I = window.Icons;
  return (
    <div className="login-slide">
      <div className="card login-card-main">
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>Presupuestos</div>
        <div style={{ fontSize: 13.5, marginBottom: 8 }}>Límite mensual por agente</div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--red)' }} />
        <div className="row gap-2" style={{ marginTop: 14, fontSize: 13, color: 'var(--text-muted)' }}><I.Lock size={13} style={{ color: 'var(--red)' }} /> Al llegar al 100 % se bloquean las nuevas consultas hasta el próximo mes.</div>
      </div>
    </div>
  );
}

function SlideAgents() {
  const I = window.Icons;
  const line = (w) => <div style={{ height: 8, width: w, borderRadius: 4, background: 'var(--border)', marginTop: 8 }} />;
  return (
    <div className="login-slide">
      <div className="card login-card-main">
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>FinOps</div>
        <div style={{ marginLeft: 'auto', maxWidth: '80%', padding: '9px 12px', borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent-ink)', fontSize: 13.5, width: 'fit-content' }}>¿Qué servicio subió más este mes?</div>
        <div style={{ marginTop: 14 }}>{line('92%')}{line('78%')}{line('55%')}</div>
      </div>
      <div className="card login-float" style={{ right: -30, top: -22 }}>
        <div className="row gap-2" style={{ fontSize: 12.5, fontWeight: 500 }}><I.Lock size={13} style={{ color: 'var(--accent-ink)' }} /> Según tus grupos</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Solo ves los datos de tus áreas</div>
      </div>
    </div>
  );
}

function SlideAudit() {
  const rows = [['Cambió el límite por defecto de agentes', 'Usuario 1'], ['Preguntó a FinOps', 'Usuario 4'], ['Intentó abrir el Audit log · sin permiso', 'Usuario 5']];
  return (
    <div className="login-slide">
      <div className="card login-card-main" style={{ padding: '8px 0' }}>
        <div style={{ padding: '10px 18px 6px', fontSize: 13, color: 'var(--text-muted)' }}>Audit log</div>
        {rows.map(([d, who]) => (
          <div key={d} style={{ padding: '12px 18px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13.5 }}>{d}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{who}</div>
          </div>
        ))}
      </div>
      <div className="card login-float" style={{ left: -26, bottom: -24 }}>
        <div className="row gap-2" style={{ fontSize: 12.5, fontWeight: 500 }}><span className="dot" style={{ background: 'var(--green)' }} /> Solo lectura</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Nadie puede editar ni borrar eventos</div>
      </div>
    </div>
  );
}

window.Login = Login;
