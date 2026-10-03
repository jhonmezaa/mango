// Agent Builder — crea o edita un borrador y lo envía a aprobación
const AGENT_ICON_COLORS = [
  { name: 'amber', bg: '#f9731622', color: '#fb923c' }, { name: 'green', bg: '#16a34a22', color: '#4ade80' },
  { name: 'blue', bg: '#2563eb22', color: '#60a5fa' }, { name: 'violet', bg: '#8b5cf622', color: '#a78bfa' },
  { name: 'red', bg: '#dc262622', color: '#f87171' }, { name: 'yellow', bg: '#eab30822', color: '#facc15' },
  { name: 'teal', bg: '#14b8a622', color: '#2dd4bf' }, { name: 'slate', bg: '#64748b22', color: '#94a3b8' },
];
const CURATED_ICONS = ['Bot', 'Money', 'Terminal', 'Shield', 'Database', 'Activity', 'BookOpen', 'Zap', 'Lock', 'Cloud', 'Chat', 'Document', 'Tickets', 'Org', 'Skill', 'Eye', 'Clock', 'User', 'Warn', 'Inbox'];
const AB_CATS = ['FinOps', 'DevOps', 'ERP', 'Productivity', 'Security', 'Data'];
const AB_TEMPLATES = [
  { id: 'blank', label: 'En blanco', icon: 'Plus' },
  { id: 'finops', label: 'Analista FinOps', icon: 'Money', color: 1, cat: 'FinOps', budget: 1500, groups: ['mango-admin', 'finops-central'], tools: ['aws-cost-explorer.get_cost_and_usage', 'aws-cost-explorer.get_cost_forecast', 'compute-optimizer.get_recommendations'],
    desc: 'Analiza costos de AWS, detecta drivers de crecimiento y recomienda optimizaciones.', prompt: '# Instrucciones\n\nPrimero consulta Cost Explorer y luego Compute Optimizer.\nUsa tablas para comparativos. No inventes números.\nCierra con las 3 acciones de mayor ahorro.' },
  { id: 'devops', label: 'Operador DevOps', icon: 'Terminal', color: 2, cat: 'DevOps', budget: 1000, groups: ['mango-admin', 'devops'], tools: ['cloudwatch.describe_alarms', 'cloudwatch.filter_log_events', 'codepipeline.get_pipeline_execution'],
    desc: 'Revisa pipelines, logs y alarmas; propone rollbacks cuando algo falla.', prompt: '# Instrucciones\n\nAntes de proponer un rollback, confirma el último deploy estable.\nNunca ejecutes cambios sin aprobación.' },
  { id: 'docs', label: 'Soporte interno', icon: 'BookOpen', color: 3, cat: 'Productivity', budget: 300, groups: ['people'], tools: ['google-drive.search', 'google-drive.get_document', 'confluence.search'],
    desc: 'Responde preguntas sobre políticas y documentación interna, citando la fuente.', prompt: '# Instrucciones\n\nCita siempre el documento y su fecha de actualización.\nSi no encuentras la respuesta, dilo.' },
];
const AB_SECTIONS = [
  { id: 'identity', label: 'Información básica' }, { id: 'org', label: 'Organización' }, { id: 'brain', label: 'Modelo e instrucciones' },
  { id: 'tools', label: 'Tools' }, { id: 'limits', label: 'Límites y presupuesto' }, { id: 'access', label: 'Acceso' },
];
const AB_SERVER_ERR = {
  cycle: ['org', 'El supervisor elegido reporta, directa o indirectamente, a este agente. Elige otro para no crear un ciclo.'],
  'manager-missing': ['org', 'El supervisor elegido no existe o no está publicado. Elige otro.'],
  'model-required': ['brain', 'Elige un modelo por defecto.'],
  'default-not-allowed': ['brain', 'El modelo por defecto tiene que estar entre los permitidos.'],
  'model-disabled': ['brain', 'Uno de los modelos ya no está habilitado en Brains. Elige otro.'],
  'model-no-tools': ['brain', 'El modelo elegido no admite uso de tools y el agente tiene tools. Elige otro modelo o quita las tools.'],
  'tool-disabled': ['tools', 'Una de las tools ya no está habilitada. Quítala o pide habilitar su MCP.'],
  'write-no-approval': ['tools', 'Hay una tool de escritura sin aprobación configurada. Pide a un administrador que defina su política antes de enviar.'],
  'group-missing': ['access', 'Uno de los grupos ya no existe. Quítalo y elige otro.'],
  'too-large': [null, 'La definición del agente es demasiado grande. Acorta las instrucciones o quita tools.'],
  'accounts-users': ['access', 'Tiene tools solo para grupos centrales y está compartido con personas sueltas. Compártelo solo con grupos centrales.'],
  conflict: [null, 'Alguien guardó otra versión mientras editabas. Vuelve a abrir el agente para ver la última.'],
  forbidden: [null, 'No tienes permiso para editar este agente. Solo quien lo creó o un administrador puede hacerlo.'],
  unavailable: [null, 'El servicio no está disponible. Inténtalo de nuevo en unos minutos.'],
  network: [null, 'Sin conexión. Revisa tu red e inténtalo de nuevo.'],
  daily: [null, 'Alcanzaste el límite diario de envíos a revisión. Podrás enviar de nuevo mañana.'],
};
const AB_BLANK = { manager: null, role: '', name: '', desc: '', cat: 'FinOps', icon: 'Bot', color: 0, model: 'Sonnet 4.6', allowedModels: ['Sonnet 4.6'], prompt: '', tools: [], groups: [], limits: { tokens: 4096, iterations: 8, seconds: 120 }, budget: 500 };

function AgentAdmin({ agents, models, setView, routeId }) {
  const I = window.Icons; const S = window.MangoStore; const L = window.Lifecycle;
  const toast = window.useToast?.();
  const revs = window.useMango(s => s.agentRevs);
  const catalog = window.useMango(s => s.mcpCatalog);
  window.useMango(s => s.role);
  const groupDefs = window.useMango(s => s.groupDefs);
  const groups = groupDefs.map(g => g.id);
  const me = S.actor();
  const modelName = (m) => m.short || m.name;
  const avail = window.useMango(s => s.avail);
  const isAdmin = S.get().role === 'admin';
  const narrowBar = window.useMedia('(max-width: 560px)');
  const [barMenu, setBarMenu] = useState(false);
  const simB = window.useMango(s => s.simBuilder) || null;
  const [errKind, setErrKind] = useState('submit');
  const [userQ, setUserQ] = useState('');
  const [lookupErr, setLookupErr] = useState(null);
  const mLabel = (mo) => avail ? mo.name : modelName(mo);

  const [rev] = useState(() => {
    const byId = revs.find(r => r.id === routeId);
    if (byId) return byId;
    const agent = agents.find(a => a.id === routeId);
    if (agent) {
      const open = revs.find(r => r.agentId === agent.id && ['draft', 'rejected', 'review', 'approved', 'failed'].includes(r.status));
      if (open) return open;
      const base = L.snapOf(agent);
      return { id: L.newRevId(), agentId: agent.id, kind: 'change', base, snap: { ...base, color: Math.max(0, AGENT_ICON_COLORS.findIndex(c => c.color === agent.iconColor)) }, unsaved: true };
    }
    return { id: L.newRevId(), agentId: null, kind: 'new', base: null, snap: { ...AB_BLANK }, unsaved: true };
  });
  const live = revs.find(r => r.id === rev.id) || rev;
  const [snap, setSnap] = useState(() => { const s = { color: 0, ...JSON.parse(JSON.stringify(rev.snap)) }; if (!s.allowedModels) s.allowedModels = [s.model]; return s; });
  const govB = window.useMango(s => s.govBudgets);
  const liveAgent = agents.find(a => a.id === rev.agentId);
  const budgetNow = liveAgent ? liveAgent.budgetMax : (govB?.defaults?.agent ?? 0);
  const budgetIsDefault = !liveAgent || !!liveAgent.budgetDefault;
  const setDefaultModel = (m) => set({ model: m, allowedModels: (snap.allowedModels || []).includes(m) ? snap.allowedModels : [...(snap.allowedModels || []), m] });
  const toggleAllowed = (m) => { if (m === snap.model) return; const cur = snap.allowedModels || []; set({ allowedModels: cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m] }); };
  const [template, setTemplate] = useState(rev.kind === 'new' && rev.unsaved ? 'blank' : null);
  const [allIcons, setAllIcons] = useState(false);
  const [errors, setErrors] = useState(null);
  const [activeSec, setActiveSec] = useState('identity');
  const scrollRef = useRef(null);
  const locked = ['review', 'approved', 'published', 'retired'].includes(live.status);
  const canCreate = S.can('agent.create');
  const set = (patch) => { if (!locked) { setSnap(s => ({ ...s, ...patch })); setErrors(null); } };
  const color = AGENT_ICON_COLORS[snap.color || 0];
  const CurrentIcon = I[snap.icon] || I.Bot;
  const enabled = catalog.filter(s => s.status === 'enabled');
  const offTools = snap.tools.filter(t => { const i = L.toolInfo(t); return !i.server || i.server.status !== 'enabled'; });
  const pre = L.validate(snap);
  const secret = L.secretIn(snap);
  const acctSel = snap.tools.some(t => L.toolInfo(t).server?.level === 'accounts');
  const orgSel = snap.tools.filter(t => { const i = L.toolInfo(t); return i.server?.level === 'accounts' && i.tool.scope === 'org'; });
  const usersSel = snap.users || [];
  const userErr = userQ && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(userQ.trim()) ? 'Escribe un correo válido' : null;
  const addUser = () => { const u = userQ.trim().toLowerCase(); if (!u || userErr || usersSel.includes(u)) return; if (usersSel.length >= 50) { setLookupErr('Puedes compartirlo con 50 personas como máximo'); return; } const sim = S.get().simPeople; S.log('directory.lookup', u, 'Buscó ' + u + ' en el directorio' + (sim === 'notfound' ? ' · no encontrado' : sim ? ' · falló' : '')); if (sim) { setLookupErr({ notfound: 'Ese correo no está en el directorio', rate: 'Hiciste demasiadas búsquedas. Espera un momento e inténtalo de nuevo.', error: 'No se pudo buscar el correo. Inténtalo de nuevo.' }[sim]); return; } setLookupErr(null); set({ users: [...usersSel, u] }); setUserQ(''); };
  const areaSel = snap.groups.filter(g => L.isRestricted(g));
  const writeSel = snap.tools.filter(t => L.toolInfo(t).tool.write);
  const cnt = L.counts(me);
  const d = rev.base ? L.diff(rev.base, snap) : null;
  const nChanges = d ? L.diffCount(d) : 0;
  const tokens = Math.ceil((snap.prompt || '').length / 4);
  const secOk = (id) => !pre.some(e => e.sec === id);

  useEffect(() => {
    const root = scrollRef.current; if (!root) return;
    const onScroll = () => {
      let cur = AB_SECTIONS[0].id;
      AB_SECTIONS.forEach(s => { const el = root.querySelector('#ab-' + s.id); if (el && el.offsetTop - root.scrollTop < 140) cur = s.id; });
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) cur = AB_SECTIONS[AB_SECTIONS.length - 1].id;
      setActiveSec(cur);
    };
    root.addEventListener('scroll', onScroll); return () => root.removeEventListener('scroll', onScroll);
  }, []);
  const goSec = (id) => { const root = scrollRef.current; const el = id ? root?.querySelector('#ab-' + id) : null; root?.scrollTo({ top: el ? el.offsetTop - 24 : 0, behavior: 'smooth' }); };

  const applyTemplate = (t) => {
    setTemplate(t.id);
    if (t.id === 'blank') { setSnap({ ...AB_BLANK }); return; }
    if (avail) { setSnap(s => ({ ...s, name: t.label, desc: t.desc, cat: t.cat, icon: t.icon, color: t.color, prompt: t.prompt })); return; }
    setSnap(s => ({ ...s, name: t.label, desc: t.desc, cat: t.cat, icon: t.icon, color: t.color, prompt: t.prompt, groups: t.groups.filter(g => groups.includes(g)), tools: t.tools.filter(id => L.toolInfo(id).server?.status === 'enabled') }));
  };
  const toggleTool = (id) => set({ tools: snap.tools.includes(id) ? snap.tools.filter(x => x !== id) : [...snap.tools, id] });
  const toggleServer = (s) => { const ids = s.tools.map(t => L.toolId(s, t)); const all = ids.every(id => snap.tools.includes(id)); set({ tools: all ? snap.tools.filter(x => !ids.includes(x)) : [...new Set([...snap.tools, ...ids])] }); };
  const toggleGroup = (g) => set({ groups: snap.groups.includes(g) ? snap.groups.filter(x => x !== g) : [...snap.groups, g] });
  const finalSnap = () => ({ ...snap, role: (snap.role || '').trim(), name: snap.name.trim(), desc: snap.desc.trim() || `Agente ${snap.cat}` });

  const serverFail = (save) => { if (!avail || !simB || (save && simB === 'daily')) return false; const [sec, msg] = AB_SERVER_ERR[simB]; setErrKind(save ? 'save' : 'submit'); setErrors([{ sec, code: simB, msg }]); goSec(null); return true; };
  const saveDraft = () => {
    setErrKind('save');
    if (!snap.name.trim()) { setErrors([{ sec: 'identity', code: 'name', msg: 'Ponle un nombre para guardar el borrador.' }]); goSec(null); return; }
    const isNewDraft = live.status !== 'draft';
    if (isNewDraft && cnt.drafts >= L.LIMITS.drafts) { setErrors([{ sec: null, code: 'drafts', msg: `Tienes ${cnt.drafts} borradores, el máximo es ${L.LIMITS.drafts}. Envía o elimina alguno.` }]); goSec(null); return; }
    if (serverFail(true)) return;
    L.saveDraft({ ...live, snap: finalSnap(), unsaved: undefined });
    toast?.({ tone: 'success', msg: 'Borrador guardado' });
    setView('marketplace');
  };
  const submit = () => {
    setErrKind('submit');
    const errs = L.validate(finalSnap(), { submitting: true });
    if (errs.length) { setErrors(errs); goSec(null); return; }
    if (serverFail(false)) return;
    L.submit({ ...live, snap: finalSnap(), unsaved: undefined });
    toast?.({ tone: 'success', msg: 'Enviado a aprobación · lo revisará otro administrador' });
    setView('marketplace');
  };

  if (!canCreate) return (
    <><Topbar crumbs={['Marketplace', 'Nuevo agente']} /><div className="content"><div className="mk-empty" style={{ paddingTop: 100 }}><I.Lock size={22} /><div style={{ fontSize: 14, fontWeight: 600 }}>No puedes crear agentes</div><div className="mk-meta">Necesitas el permiso «crear agentes». Pídeselo a un administrador.</div></div></div></>
  );

  const iconList = allIcons ? Object.keys(I).filter(n => /^[A-Z]/.test(n) && !['Search', 'Plus', 'Close', 'Check', 'ChevronDown', 'ChevronRight', 'ChevronLeft', 'More', 'MoreHorizontal', 'MoreVertical', 'Drag', 'ArrowRight', 'Star'].includes(n)) : CURATED_ICONS.filter(n => I[n]);
  const status = live.unsaved ? null : L.REV_STATUS[live.status];

  return (
    <>
      <Topbar crumbs={['Marketplace', rev.kind === 'change' ? (rev.base?.name || snap.name) : (snap.name || 'Nuevo agente')]}
        actions={locked ? <button className="btn btn-sm" onClick={() => setView('marketplace')}>Volver</button> : narrowBar ? <>
          <div style={{ position: 'relative' }}>
            <button className="btn btn-sm btn-ghost btn-icon" aria-label="Más acciones" aria-haspopup="menu" aria-expanded={barMenu} onClick={() => setBarMenu(v => !v)}><I.MoreHorizontal size={15} /></button>
            {barMenu && <><div onClick={() => setBarMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} /><div role="menu" className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', minWidth: 190, padding: 6, zIndex: 41, boxShadow: 'var(--shadow)' }}>
              <button role="menuitem" className="row gap-2 sb-menu-item" onClick={() => { setBarMenu(false); saveDraft(); }}>Guardar borrador</button>
              <button role="menuitem" className="row gap-2 sb-menu-item" onClick={() => { setBarMenu(false); setView('marketplace'); }}>Cancelar</button>
            </div></>}
          </div>
          <button className="btn btn-sm btn-primary" onClick={submit}>Enviar</button>
        </> : <>
          <button className="btn btn-sm btn-ghost" onClick={() => setView('marketplace')}>Cancelar</button>
          <button className="btn btn-sm" onClick={saveDraft}>Guardar borrador</button>
          <button className="btn btn-sm btn-primary" onClick={submit}>Enviar a aprobación</button>
        </>} />
      <div className="content" ref={scrollRef}>
        <div className="ab-grid">
          <nav className="ab-nav" aria-label="Secciones">
            {AB_SECTIONS.map((s, i) => (
              <button key={s.id} className={'ab-nav-item' + (activeSec === s.id ? ' is-active' : '')} onClick={() => goSec(s.id)}>
                <span className={'ab-step' + (secOk(s.id) ? ' is-done' : '')}>{secOk(s.id) ? <I.Check size={10} /> : i + 1}</span>{avail && s.id === 'limits' ? 'Límites' : s.label}
              </button>
            ))}
          </nav>

          <div className="ab-form">
            <div className="ab-head">
              <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <h1>{rev.kind === 'change' ? 'Editar agente' : 'Nuevo agente'}</h1>
                {status && <span className={'badge ' + status[1]}>{status[0]}</span>}
              </div>
              <p>{rev.kind === 'change' ? 'Los cambios se guardan como un borrador aparte y pasan por aprobación.' : 'Un administrador distinto de ti lo revisa antes de que aparezca en el marketplace.'}</p>
            </div>

            {locked && <div className="mc-alert amber" style={{ marginTop: 16 }}><I.Lock size={14} /><div><b>{live.status === 'review' ? 'En revisión' : live.status === 'approved' ? 'Aprobado, publicando' : L.REV_STATUS[live.status][0]}</b>{live.status === 'review' && ` desde ${window.fmtAgo(live.submittedAt)}`}. Lo enviado a revisión ya no se edita.{S.get().role === 'admin' && <> <button className="sr-link" onClick={() => setView('review')}>Ver en Revisión</button></>}</div></div>}
            {live.clonedFrom && live.status === 'draft' && <div className="mc-alert" style={{ marginTop: 16 }} role="status"><I.Check size={14} /><div>Copia de <b>{live.clonedFrom}</b> guardada como borrador. Envíala a aprobación para publicarla.</div></div>}
            {!locked && rev.kind === 'change' && <div className="mc-alert" style={{ marginTop: 16 }}><I.Info size={14} /><div>Estás editando un borrador de <b>{rev.base?.name}</b>. La versión publicada sigue activa hasta que se apruebe este cambio.{nChanges > 0 && <> · <b>{nChanges}</b> {nChanges === 1 ? 'cambio' : 'cambios'} por ahora.</>}</div></div>}
            {live.status === 'rejected' && <div className="mc-alert red" style={{ marginTop: 16 }}><I.X2 size={14} /><div><b>Rechazado por {avail ? L.reviewerLabel(live) : live.reviewer}:</b> “{live.reason}” Corrígelo y vuelve a enviarlo.</div></div>}
            {live.status === 'failed' && <div className="mc-alert red" style={{ marginTop: 16 }}><I.X2 size={14} /><div><b>La publicación falló</b> en «{avail ? (live.failedCode || 'publication_expired') : live.failedStep}». {avail ? <>Un administrador puede reintentarla desde Revisión pasados 45 minutos, o puedes reabrirla como borrador para corregirla. <button className="sr-link" onClick={() => { L.saveDraft({ ...live, snap: finalSnap(), unsaved: undefined }); toast?.({ tone: 'success', msg: 'Reabierto como borrador' }); }}>Reabrir como borrador</button></> : 'Puedes ajustar y reenviar, o pedir a un administrador que la reintente.'}</div></div>}
            {errors && errors.length > 0 && (
              <div className="mc-alert red" style={{ marginTop: 16, display: 'block' }} role="alert">
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{(errKind === 'save' ? 'No se pudo guardar' : 'No se pudo enviar') + (errors.length > 1 ? `: ${errors.length} problemas` : '')}</div>
                {errors.map(e => <div key={e.code} style={{ fontSize: 12.5, marginTop: 3 }}>· {e.msg} {e.sec && <button className="sr-link" onClick={() => goSec(e.sec)}>Ir</button>}</div>)}
              </div>
            )}

            <fieldset disabled={locked} className="ab-fieldset">
              <ABSection id="identity" title="Información básica" desc="Así aparece en el marketplace y en el chat.">
                {rev.unsaved && rev.kind === 'new' && !locked && (
                  <ABField label="Plantilla">
                    <div className="ab-templates">{AB_TEMPLATES.map(t => { const Ic = I[t.icon] || I.Bot; return <button key={t.id} type="button" className={'ab-tpl' + (template === t.id ? ' is-on' : '')} onClick={() => applyTemplate(t)}><Ic size={14} /><span>{t.label}</span></button>; })}</div>
                  </ABField>
                )}
                <div className="ab-row">
                  <div className="ab-avatar" style={{ background: color.bg, color: color.color }}><CurrentIcon size={26} /></div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <ABField label="Nombre" error={errors?.some(e => e.code === 'name') && 'Escribe un nombre'}>
                      <input className="input" value={snap.name} placeholder="Ej: Analista de costos LATAM" onChange={e => set({ name: e.target.value })} maxLength={40} />
                    </ABField>
                    <ABField label="Descripción" hint={`${snap.desc.length}/140`} error={secret?.key === 'desc' && `Posible secreto detectado (${secret.type}). No pegues credenciales.`}>
                      <textarea className="input" rows={2} maxLength={140} value={snap.desc} placeholder="Qué resuelve y para quién." onChange={e => set({ desc: e.target.value })} />
                    </ABField>
                  </div>
                </div>
                <ABField label="Categoría"><div className="ab-seg">{[...AB_CATS, ...(snap.cat && !AB_CATS.includes(snap.cat) ? [snap.cat] : [])].map(c => <button key={c} type="button" className={snap.cat === c ? 'is-on' : ''} onClick={() => set({ cat: c })}>{c}</button>)}</div></ABField>
                <ABField label="Ícono y color">
                  <div className="ab-icons">{iconList.map(n => { const Ic = I[n]; const on = snap.icon === n; return <button key={n} type="button" title={n} aria-label={n} aria-pressed={on} onClick={() => set({ icon: n })} style={on ? { background: color.bg, color: color.color, borderColor: color.color + '66' } : null}><Ic size={15} /></button>; })}</div>
                  <div className="row between" style={{ marginTop: 10, flexWrap: 'wrap', gap: 10 }}>
                    <div className="row gap-2">{AGENT_ICON_COLORS.map((c, i) => <button key={c.name} type="button" aria-label={'Color ' + c.name} aria-pressed={snap.color === i} onClick={() => set({ color: i })} className="ab-swatch" style={{ background: c.color, boxShadow: snap.color === i ? `0 0 0 2px var(--bg), 0 0 0 4px ${c.color}` : 'none' }} />)}</div>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAllIcons(x => !x)}>{allIcons ? 'Menos íconos' : 'Ver todos'}</button>
                  </div>
                </ABField>
              </ABSection>

              <ABSection id="org" title="Organización" desc="Define dónde aparece en el Org Chart y en el marketplace. El cambio entra con la versión aprobada.">
                <div className="ab-2col">
                  <ABField label="Reporta a" error={errors?.some(e => e.code === 'manager') && 'Elige a quién reporta'} hint="Supervisor del agente">
                    <select className="input" value={snap.manager || ''} onChange={e => set({ manager: e.target.value || null })} aria-label="Reporta a">
                      <option value="" disabled>Elige un supervisor…</option>
                      <option value="platform">Platform Admin · supervisor raíz</option>
                      {(() => { const self = live.agentId; const below = new Set(); const walk = (id) => agents.filter(x => x.manager === id).forEach(x => { if (!below.has(x.id)) { below.add(x.id); walk(x.id); } }); if (self) walk(self);
                        return agents.filter(x => x.id !== self && !below.has(x.id)).map(x => <option key={x.id} value={x.id}>{x.name}{x.role ? ' · ' + x.role : ''}</option>); })()}
                    </select>
                  </ABField>
                  <ABField label="Rol" error={errors?.some(e => e.code === 'role') && 'Escribe el rol'} hint={`${(snap.role || '').length}/40`}>
                    <input className="input" value={snap.role || ''} maxLength={40} placeholder="Ej: Análisis de costos LATAM" onChange={e => set({ role: e.target.value })} />
                  </ABField>
                </div>
              </ABSection>

              <ABSection id="brain" title="Modelo e instrucciones" desc="El modelo define costo y calidad. Las instrucciones se suman al prompt base.">
                <ABField label="Modelo por defecto" hint="Con el que arranca cada conversación">
                  <div className="ab-models">{models.filter(mo => mo.status === 'enabled' || modelName(mo) === snap.model).map(mo => { const m = modelName(mo); const on = m === snap.model; return (
                    <button key={m} type="button" className={'ab-model' + (on ? ' is-on' : '')} onClick={() => setDefaultModel(m)}>
                      <span className="ab-radio" />
                      <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' }}>{mLabel(mo)}</span><span style={{ display: 'block', fontSize: 11.5, color: mo.status !== 'enabled' ? 'var(--red)' : 'var(--text-muted)' }}>{mo.status !== 'enabled' ? 'No habilitado · elige otro' : mo.provider + (mo.contextWindow ? ' · ' + Math.round(mo.contextWindow / 1000) + 'k contexto' : '') + (mo.caps && !mo.caps.tools ? ' · sin tools' : '')}</span></span>
                      {mo.inputPrice != null && <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>USD {mo.inputPrice.toLocaleString('es-ES')} / {mo.outputPrice.toLocaleString('es-ES')} · M</span>}
                    </button>
                  ); })}</div>
                </ABField>
                <ABField label="Modelos permitidos" hint="Los únicos que el usuario puede elegir en el chat">
                  <div className="ab-list">{models.filter(mo => mo.status === 'enabled').map(mo => { const m = modelName(mo); const on = (snap.allowedModels || []).includes(m); const isDef = m === snap.model; return (
                    <button key={m} type="button" className={'ab-item' + (on ? ' is-on' : '')} onClick={() => toggleAllowed(m)} aria-pressed={on} disabled={isDef} title={isDef ? 'El modelo por defecto siempre está permitido' : undefined}>
                      <span className="ab-check">{on && <I.Check size={10} />}</span>
                      <span style={{ flex: 1, minWidth: 0 }}><span className={avail ? undefined : 'mono'} style={{ display: 'block', fontSize: 12.5, fontWeight: 500 }}>{mLabel(mo)}</span><span className="ab-sub">{mo.provider}</span></span>
                      {isDef && <span className="badge badge-accent">Por defecto</span>}
                    </button>
                  ); })}</div>
                </ABField>
                <ABField label="System prompt" hint={`≈ ${tokens} tokens`} error={secret?.key === 'prompt' && `Posible secreto detectado (${secret.type}). No pegues credenciales: usa una conexión segura.`}>
                  <textarea className="input mono" rows={9} value={snap.prompt} onChange={e => set({ prompt: e.target.value })} style={{ fontSize: 12.5, lineHeight: 1.6, borderColor: secret?.key === 'prompt' ? 'var(--red)' : undefined }} placeholder={'# Instrucciones\n\nQué debe hacer primero, cómo responder, qué nunca hacer.'} />
                </ABField>
              </ABSection>

              <ABSection id="tools" title="Tools" desc="Solo aparecen tools de conectores y packs habilitados. Las de escritura piden confirmación o aprobación en cada uso, según su política.">
                {offTools.length > 0 && (
                  <div className="mc-alert red" style={{ display: 'block' }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>{offTools.length === 1 ? 'Esta tool no está habilitada' : 'Estas tools no están habilitadas'}</div>
                    {offTools.map(t => { const i = L.toolInfo(t); return <div key={t} className="row between" style={{ fontSize: 12.5, padding: '3px 0', gap: 8 }}><span className="mono">{t}</span><span className="row gap-2"><span className="mk-meta">{avail ? (!i.server || i.missing ? 'No existe' : 'No habilitado') : i.server ? L.MCP_STATUS[i.server.status][0] : 'No existe'}</span><button type="button" className="sr-link" onClick={() => toggleTool(t)}>Quitar</button></span></div>; })}
                  </div>
                )}
                {avail ? orgSel.length > 0 && (areaSel.length > 0 || usersSel.length > 0) && <div className="mc-alert amber"><I.Warn size={14} /><div>Hay tools <b>solo para grupos centrales</b> y el agente es visible para {areaSel.length ? <>grupos que no son centrales ({areaSel.join(', ')})</> : null}{areaSel.length && usersSel.length ? ' y ' : ''}{usersSel.length ? 'personas sueltas' : ''}. No se podrá enviar así.</div></div>
                  : acctSel && areaSel.length > 0 && <div className="mc-alert amber"><I.Warn size={14} /><div>Hay tools de <b>Datos de cuentas</b> y el agente es visible para roles de área ({areaSel.join(', ')}). No se podrá enviar así.</div></div>}
                <div className="ab-list" style={{ maxHeight: 460 }}>
                  {enabled.map(s => {
                    const ids = s.tools.map(t => L.toolId(s, t)); const nOn = ids.filter(id => snap.tools.includes(id)).length;
                    return (
                      <React.Fragment key={s.id}>
                        <div className="ab-group row between" style={{ gap: 8 }}>
                          <span className="row gap-2" style={{ minWidth: 0 }}><span style={{ color: 'var(--text)', fontWeight: 600, fontSize: 12.5 }}>{s.name}</span><span>{s.kind === 'pack' ? 'pack' : 'conector'}</span><McpLevel level={s.level} /></span>
                          <button type="button" className="sr-link" onClick={() => toggleServer(s)}>{nOn === ids.length ? 'Quitar todas' : 'Todas'}</button>
                        </div>
                        {s.tools.map(t => { const id = L.toolId(s, t); const on = snap.tools.includes(id); return (
                          <button key={id} type="button" className={'ab-item' + (on ? ' is-on' : '')} onClick={() => toggleTool(id)} aria-pressed={on}>
                            <span className="ab-check">{on && <I.Check size={10} />}</span>
                            <span style={{ flex: 1, minWidth: 0 }}><span className="mono" style={{ display: 'block', fontSize: 12.5, fontWeight: 500 }}>{t.name}</span><span className="ab-sub">{t.desc}</span></span>
                            {avail && s.level === 'accounts' && t.scope === 'org' && <span className="badge badge-violet" title="Responde por toda la organización: solo la pueden usar grupos centrales">Solo grupos centrales</span>}
                            {avail && t.service && <span className="badge badge-amber" title={'Responde con error si la cuenta pagadora no tiene activado ' + t.service + '; Mango no lo comprueba'}>Requiere {t.service}</span>}
                            {t.write ? <span className="badge badge-amber" title="Confirmación o aprobación, según su política">Escritura · confirmación o aprobación</span> : <span className="badge">Lectura</span>}
                          </button>
                        ); })}
                      </React.Fragment>
                    );
                  })}
                </div>
                <div className="row between" style={{ fontSize: 12, color: 'var(--text-muted)', gap: 8, flexWrap: 'wrap' }}>
                  <span>{snap.tools.length} {snap.tools.length === 1 ? 'tool elegida' : 'tools elegidas'}{writeSel.length ? ` · ${writeSel.length} de escritura: confirmación o aprobación, según su política` : ''}</span>
                  <button type="button" className="sr-link" onClick={() => setView('mcp')}>¿Falta un MCP? Ver catálogo</button>
                </div>
              </ABSection>

              <ABSection id="limits" title={avail ? 'Límites' : 'Límites y presupuesto'} desc={avail ? 'Topes por ejecución. El presupuesto no es parte de la versión.' : 'Topes por ejecución y gasto mensual del agente.'}>
                <ABField label="Tokens máximos por respuesta" hint={![1024, 2048, 4096, 8192].includes(snap.limits.tokens) ? `Actual: ${snap.limits.tokens.toLocaleString('es-MX')} · se conserva si no eliges otro` : null}><div className="ab-seg">{[1024, 2048, 4096, 8192].map(v => <button key={v} type="button" className={snap.limits.tokens === v ? 'is-on' : ''} onClick={() => set({ limits: { ...snap.limits, tokens: v } })}>{v.toLocaleString('es-MX')}</button>)}</div></ABField>
                <div className="ab-2col">
                  <ABField label="Iteraciones máximas" hint="Llamadas a tools por pregunta">
                    <div className="row gap-2"><input type="range" min="1" max="25" value={snap.limits.iterations} onChange={e => set({ limits: { ...snap.limits, iterations: Number(e.target.value) } })} style={{ flex: 1, accentColor: 'var(--accent)' }} /><span className="ab-pct">{snap.limits.iterations}</span></div>
                  </ABField>
                  <ABField label="Tiempo máximo">
                    <div className="ab-seg">{[30, 60, 120, 300, 600].map(v => <button key={v} type="button" className={snap.limits.seconds === v ? 'is-on' : ''} onClick={() => set({ limits: { ...snap.limits, seconds: v } })}>{v < 60 ? v + ' s' : v / 60 + ' min'}</button>)}</div>
                  </ABField>
                </div>
                {avail && <div className="ab-2col">
                  <ABField label="Tokens por llamada" hint={![1024, 2048, 4096, 8192].includes(snap.perCall ?? 4096) ? `Actual: ${(snap.perCall).toLocaleString('es-MX')} · se conserva si no eliges otro` : 'Por cada llamada al modelo'}><div className="ab-seg">{[1024, 2048, 4096, 8192].map(v => <button key={v} type="button" className={(snap.perCall ?? 4096) === v ? 'is-on' : ''} onClick={() => set({ perCall: v })}>{v.toLocaleString('es-MX')}</button>)}</div></ABField>
                  <ABField label="Temperatura" hint="0 = más preciso · 1 = más variado">
                    <div className="row gap-2"><input type="range" min="0" max="1" step="0.1" value={snap.temperature ?? 0.2} onChange={e => set({ temperature: Number(e.target.value) })} style={{ flex: 1, accentColor: 'var(--accent)' }} aria-label="Temperatura" /><span className="ab-pct">{(snap.temperature ?? 0.2).toLocaleString('es-MX', { minimumFractionDigits: 1 })}</span></div>
                  </ABField>
                </div>}
                {avail ? <ABField label="Presupuesto mensual" hint="Fuera de la versión · al llegar al 100 % se bloquea">
                  <div className="row gap-3" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                    <div className="ro-field"><I.Lock size={12} />{isAdmin ? (window.GovKit ? window.GovKit.usd(budgetNow) : budgetNow) : '—'}</div>
                    <span className="mk-meta">{isAdmin ? (budgetIsDefault ? 'Límite por defecto · hoy todos los agentes usan el mismo' : 'Límite propio del agente') : 'Solo los administradores ven el presupuesto.'}</span>
                    {isAdmin && <button type="button" className="sr-link" onClick={() => setView('budgets')}>Ver en Presupuestos →</button>}
                  </div>
                </ABField> :
                <ABField label="Presupuesto mensual" hint="Solo lectura · al llegar al 100 % se bloquea">
                  <div className="row gap-3" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                    <div className="ro-field"><I.Lock size={12} />{window.GovKit ? window.GovKit.usd(budgetNow) : budgetNow}</div>
                    <span className="mk-meta">{budgetIsDefault ? (liveAgent ? 'Límite por defecto' : 'Los agentes nuevos arrancan con el límite por defecto') : 'Límite propio del agente'}</span>
                    <button type="button" className="sr-link" onClick={() => setView('budgets')}>Ver en Presupuestos →</button>
                  </div>
                  <div className="mk-meta" style={{ marginTop: 6 }}>Solo los admins lo cambian, desde Presupuestos.</div>
                </ABField>}
              </ABSection>

              <ABSection id="access" title="Acceso" desc={avail ? 'Grupos y personas que podrán verlo en el marketplace y usarlo.' : 'Grupos que podrán verlo en el marketplace y usarlo.'}>
                <ABField label="Grupos" error={errors?.some(e => e.code === 'groups') && 'Elige al menos un grupo'}>
                  <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{groups.map(g => { const on = snap.groups.includes(g); const area = L.isRestricted(g); return (
                    <button key={g} type="button" className={'tweak-chip ab-chip' + (on ? ' is-on' : '')} onClick={() => toggleGroup(g)} aria-pressed={on} title={L.groupDef(g)?.desc}>{on && <I.Check size={10} />}{g}{area && <span className="ab-area">{L.groupDef(g)?.type === 'area' ? 'área · ' + L.groupDef(g).area : 'sin datos de cuentas'}</span>}</button>
                  ); })}</div>
                </ABField>
                {avail && <ABField label="Personas" hint="Opcional" error={(userErr && userQ) || lookupErr || (errors?.some(e => e.code === 'accounts-users') && 'Quita a las personas o las tools solo para grupos centrales')}>
                  {usersSel.length > 0 && <div className="row gap-1" style={{ flexWrap: 'wrap', marginBottom: 8 }}>{usersSel.map(u => <span key={u} className="tweak-chip ab-chip is-on" style={{ cursor: 'default' }}>{u}<button type="button" aria-label={'Quitar ' + u} onClick={() => set({ users: usersSel.filter(x => x !== u) })} style={{ display: 'flex', marginLeft: 2 }}><I.Close size={10} /></button></span>)}</div>}
                  <div className="row gap-2"><input className="input" style={{ flex: 1, minWidth: 0 }} type="email" placeholder="correo@empresa.com" value={userQ} onChange={e => { setUserQ(e.target.value); setLookupErr(null); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addUser(); } }} aria-label="Agregar persona por correo" /><button type="button" className="btn btn-sm" disabled={!userQ.trim() || !!userErr} onClick={addUser}>Agregar</button></div>
                </ABField>}
                <div className="mk-meta" style={{ lineHeight: 1.5 }}>{avail ? <>Las tools marcadas <b>Solo grupos centrales</b> responden por toda la organización: solo las pueden usar grupos centrales y no se comparten con personas sueltas. Las que filtran por usuario, como Cost Explorer, sí pueden compartirse con grupos de área.</> : <>Solo los grupos <b>centrales</b> pueden usar tools de «Datos de cuentas». Los grupos de área y los generales no.</>} {isAdmin || !avail ? <>Los administradores gestionan los grupos en <button type="button" className="sr-link" onClick={() => setView('settings')}>Ajustes › Grupos</button>.</> : 'Los grupos los gestiona un administrador.'}</div>
              </ABSection>
            </fieldset>
          </div>

          <aside className="ab-aside">
            <div className="ab-aside-label">vista previa</div>
            <div className="card ab-preview">
              <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
                <span style={{ width: 36, height: 36, borderRadius: 8, background: color.bg, color: color.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><CurrentIcon size={17} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: snap.name ? 'var(--text-strong)' : 'var(--text-dim)' }}>{snap.name || 'Sin nombre'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{snap.cat} · <span className={avail ? undefined : 'mono'}>{avail ? (models.find(mo => modelName(mo) === snap.model)?.name || snap.model) : snap.model}</span></div>
                </div>
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: snap.desc ? 'var(--text)' : 'var(--text-dim)', marginTop: 10, textWrap: 'pretty' }}>{snap.desc || 'La descripción aparecerá aquí.'}</div>
              <div className="row between" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
                <span style={{ whiteSpace: 'nowrap' }}>{snap.tools.length} tools{writeSel.length ? ' · ' + writeSel.length + ' escritura' : ''}</span>
                {(!avail || isAdmin) && <span className="mono">{window.GovKit ? window.GovKit.usd(budgetNow) : '$' + budgetNow}</span>}
              </div>
            </div>

            <div className="ab-aside-label" style={{ marginTop: 20 }}>{pre.length ? 'antes de enviar' : 'listo para enviar'}</div>
            <div className="ab-checks">
              {[['identity', 'Nombre'], ['brain', 'Instrucciones sin secretos'], ['tools', 'Tools habilitadas y compatibles'], ['access', 'Al menos un grupo']].map(([sec, l]) => {
                const ok = !pre.some(e => e.sec === sec);
                return <button key={sec} type="button" onClick={() => goSec(sec)} className={ok ? 'is-ok' : ''}><span className="ab-step">{ok ? <I.Check size={10} /> : null}</span>{l}</button>;
              })}
            </div>

            <div className="ab-aside-label" style={{ marginTop: 20 }}>tus límites</div>
            <div className="ab-quota"><span>Borradores</span><span className="mono">{cnt.drafts} / {L.LIMITS.drafts}</span></div>
            <div className="ab-quota"><span>Envíos a revisión hoy</span><span className="mono" style={{ color: cnt.today >= L.LIMITS.perDay ? 'var(--red)' : undefined }}>{cnt.today} / {L.LIMITS.perDay}</span></div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.5, display: 'flex', gap: 8 }}><I.Shield size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--accent-ink)' }} />Lo aprueba un administrador distinto de ti. Sin aprobación no aparece en el marketplace.</div>
          </aside>
        </div>
      </div>
    </>
  );
}

function ABSection({ id, title, desc, children }) {
  return (
    <section id={'ab-' + id} className="ab-section">
      <h2>{title}</h2>
      <p className="ab-desc">{desc}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>{children}</div>
    </section>
  );
}

function ABField({ label, hint, error, children }) {
  return (
    <div className={error ? 'ab-field has-error' : 'ab-field'}>
      <div className="row between" style={{ marginBottom: 6, gap: 8 }}>
        <label style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)' }}>{label}</label>
        {hint && <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{hint}</span>}
      </div>
      {children}
      {error && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

Object.assign(window, { AgentAdmin });
