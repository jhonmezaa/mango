// Buscar en todas las conversaciones
const { useState: useStateSr, useMemo: useMemoSr, useEffect: useEffectSr, useRef: useRefSr } = React;
const SR_KIND = { title: 'Título', user: 'Tú', agent: 'Agente', tool: 'Herramienta' };
// Búsquedas recientes solo en memoria de la pestaña: lo buscado es contenido de las conversaciones y no se deja en el navegador.
let srRecentMem = [];
const SR_SCAN = 200, SR_MAX = 100;
const srWhen = (t) => /^\d{1,2}:\d{2}$/.test(t.time) || /hoy|ahora|min/i.test(t.time || '') ? 'today' : /ayer/i.test(t.time || '') ? 'yesterday' : 'week';
const srPlain = (s) => String(s || '').replace(/\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?/g, ' ').replace(/[*`|#_>]/g, ' ').replace(/\s+/g, ' ').trim();

function srSnippet(plain, terms) {
  const low = plain.toLowerCase();
  const first = Math.min(...terms.map(t => { const i = low.indexOf(t); return i < 0 ? Infinity : i; }));
  const s = Math.max(0, first - 60);
  const e = Math.min(plain.length, first + 140);
  const text = plain.slice(s, e);
  const re = new RegExp('(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  const parts = text.split(re).map((p, i) => i % 2 ? { hit: p } : { txt: p });
  return { pre: s > 0, post: e < plain.length, parts };
}

function searchMessages(q, threads, agents, opts = {}) {
  const seeds = window.seedMessages || {};
  const terms = q.trim().toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  if (!terms.length) return [];
  const out = [];
  (threads || []).forEach(t => {
    if (opts.agent && opts.agent !== 'all' && t.agentId !== opts.agent) return;
    if (opts.when && opts.when !== 'all' && (opts.when === 'today' ? srWhen(t) !== 'today' : opts.when === 'yesterday' ? srWhen(t) === 'week' : false)) return;
    const hits = [];
    const test = (text, kind, idx) => {
      if (opts.kind && opts.kind !== 'all' && opts.kind !== kind) return;
      const plain = srPlain(text); const low = plain.toLowerCase();
      if (!terms.every(term => low.includes(term))) return;
      hits.push({ kind, idx, snip: srSnippet(plain, terms) });
    };
    test(t.title, 'title', -1);
    (seeds[t.id] || []).forEach((m, idx) => {
      if (m.type === 'user_message') test(m.text, 'user', idx);
      else if (m.type === 'agent_response') test(m.text + (m.artifact ? ' ' + m.artifact.title : ''), 'agent', idx);
      else if (m.type === 'tool_call') test(m.tool, 'tool', idx);
    });
    if (hits.length) out.push({ thread: t, agent: agents.find(a => a.id === t.agentId), hits, score: hits.length + (hits[0].kind === 'title' ? 5 : 0) });
  });
  return out;
}

function SrSnip({ snip }) {
  return <>{snip.pre && '…'}{snip.parts.map((p, i) => p.hit ? <mark key={i} className="sr-mark">{p.hit}</mark> : <React.Fragment key={i}>{p.txt}</React.Fragment>)}{snip.post && '…'}</>;
}

// La última búsqueda se recuerda solo en memoria, mientras la pestaña siga abierta.
let srMemo = null;
function GlobalSearch({ threads, agents, openChat }) {
  const I = window.Icons;
  const S = window.MangoStore;
  const sim = window.useMango(s => s.simSearch) || null;
  const [q, setQ] = useStateSr(srMemo?.q || '');
  const [agent, setAgent] = useStateSr(srMemo?.agent || 'all');
  const [kind, setKind] = useStateSr(srMemo?.kind || 'all');
  const [when, setWhen] = useStateSr(srMemo?.when || 'all');
  React.useEffect(() => { srMemo = { q, agent, kind, when }; }, [q, agent, kind, when]);
  const [sort, setSort] = useStateSr('relevance');
  const [expanded, setExpanded] = useStateSr({});
  const [active, setActive] = useStateSr(0);
  const [recent, setRecent] = useStateSr(srRecentMem);
  const [res, setRes] = useStateSr({ done: false, list: [], q: '' });
  const [pending, setPending] = useStateSr(false);
  const [slow, setSlow] = useStateSr(false);
  const [tick, setTick] = useStateSr(0);
  const inputRef = useRefSr(null);
  const listRef = useRefSr(null);
  const searching = q.trim().length >= 2;

  // Simula la llamada al servidor: la lista anterior se conserva mientras llega la nueva.
  useEffectSr(() => {
    if (!searching) { setPending(false); setSlow(false); setRes({ done: false, list: [], q: '' }); return; }
    if (res.err === 'rate' && res.at > Date.now()) return;
    setPending(true); setSlow(false);
    const st = setTimeout(() => setSlow(true), 400);
    const t = setTimeout(() => {
      clearTimeout(st); setPending(false); setSlow(false);
      if (sim === 'error') return setRes(r => ({ ...r, done: true, err: 'fail' }));
      if (sim === '429') return setRes(r => ({ ...r, done: true, err: 'rate', at: Date.now() + 178000 }));
      setRes({ done: true, err: null, q: q.trim(), list: searchMessages(q, threads, agents, { agent, kind, when }), scanned: sim === 'cap' || sim === 'capmore' ? SR_SCAN : 0, more: sim === 'capmore' });
    }, sim === 'loading' ? 1800 : 160);
    return () => { clearTimeout(t); clearTimeout(st); };
  }, [q, agent, kind, when, sim, tick, threads]);

  const order = (threads || []).map(t => t.id);
  const results = [...res.list].sort(sort === 'recent' ? (a, b) => order.indexOf(a.thread.id) - order.indexOf(b.thread.id) : (a, b) => b.score - a.score);
  const total = results.reduce((s, r) => s + Math.max(1, r.hits.filter(h => h.kind !== 'title').length), 0);
  const countTxt = (n, m) => n + ' ' + (n === 1 ? 'coincidencia' : 'coincidencias') + ' en ' + m + ' ' + (m === 1 ? 'conversación' : 'conversaciones');

  useEffectSr(() => { setActive(0); }, [res, sort]);
  useEffectSr(() => {
    const h = (e) => { if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') { e.preventDefault(); inputRef.current?.focus(); } };
    document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h);
  }, []);
  useEffectSr(() => {
    const el = listRef.current?.querySelector(`[data-sr="${active}"]`);
    const sc = el?.closest('.content');
    if (el && sc) { const r = el.getBoundingClientRect(), c = sc.getBoundingClientRect(); if (r.top < c.top + 60 || r.bottom > c.bottom) sc.scrollTop += r.top - c.top - 120; }
  }, [active]);

  const remember = (term) => {
    const t = term.trim(); if (t.length < 2) return;
    if (recent[0]?.toLowerCase() !== t.toLowerCase()) S.log('conversation.search', 'conversations', 'Buscó en sus conversaciones · ' + (results.length === 1 ? '1 resultado' : results.length + ' resultados'), { results: results.length });
    srRecentMem = [t, ...recent.filter(x => x.toLowerCase() !== t.toLowerCase())].slice(0, 6);
    setRecent(srRecentMem);
  };
  const clearRecent = () => { srRecentMem = []; setRecent([]); };
  // Abre en el mensaje de la coincidencia; las de título abren la conversación como siempre.
  const go = (r, h) => { const hit = h || r.hits.find(x => x.kind !== 'title'); remember(q); openChat(r.thread.agentId, r.thread.id, hit && hit.idx >= 0 ? hit.idx : undefined); };
  const retry = () => { S.set({ simSearch: null }); setRes(r => ({ ...r, err: null })); setTick(t => t + 1); };
  const onKey = (e) => {
    if (e.key === 'Escape') { setQ(''); return; }
    if (!results.length || res.err) { if (e.key === 'Enter') remember(q); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(results.length - 1, a + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
  };
  const anyFilter = agent !== 'all' || kind !== 'all' || when !== 'all';
  const capLines = res.done && !res.err && (res.scanned || res.more) ? (
    <div className="sr-cap">
      {res.scanned > 0 && <span><I.Info size={12} /><span>{`Buscamos en tus ${res.scanned} conversaciones más recientes; las más antiguas no se revisaron.`}</span></span>}
      {res.more && results.length > 0 && <span><I.Info size={12} /><span>{`Se muestran las ${SR_MAX} conversaciones con más coincidencias; afina la búsqueda para ver otras.`}</span></span>}
    </div>
  ) : null;
  const live = !searching ? '' : pending ? (slow ? 'Buscando…' : '') : res.err === 'fail' ? 'No se pudo buscar en tus conversaciones.' : res.err === 'rate' ? 'Demasiadas solicitudes.' : results.length ? countTxt(total, results.length) : 'Sin resultados';

  return (
    <>
      <Topbar crumbs={['Buscar conversaciones']} />
      <div className="content">
        <div className="sr-wrap">
          <h1 className="sr-h1">Buscar conversaciones</h1>
          <div className="search-wrap sr-input">
            <I.Search size={15} />
            <input ref={inputRef} className="input" autoFocus aria-label="Buscar en conversaciones" placeholder="Busca en títulos, mensajes, respuestas y herramientas"
              value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} onBlur={() => searching && results.length && !res.err && remember(q)}
              role="combobox" aria-expanded={searching && results.length > 0} aria-controls="sr-results" aria-activedescendant={searching && results.length && !res.err ? 'sr-' + active : undefined} />
            {q ? <button className="sr-clear" aria-label="Borrar búsqueda" onClick={() => { setQ(''); inputRef.current?.focus(); }}><I.Close size={13} /></button>
               : <kbd className="sr-kbd">/</kbd>}
          </div>

          <div className="sr-filters">
            <select className="input mk-sel" aria-label="Agente" value={agent} onChange={e => setAgent(e.target.value)}>
              <option value="all">Todos los agentes</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select className="input mk-sel" aria-label="Fecha" value={when} onChange={e => setWhen(e.target.value)}>
              <option value="all">Cualquier fecha</option><option value="today">Hoy</option><option value="yesterday">Desde ayer</option>
            </select>
            <div className="tk-quick" role="group" aria-label="Buscar en">
              {[['all', 'Todo'], ['title', 'Títulos'], ['user', 'Mis mensajes'], ['agent', 'Respuestas'], ['tool', 'Herramientas']].map(([k, l]) => (
                <button key={k} className={kind === k ? 'is-on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>
              ))}
            </div>
            {anyFilter && <button className="btn btn-sm btn-ghost" onClick={() => { setAgent('all'); setKind('all'); setWhen('all'); }}>Limpiar</button>}
          </div>
          <div className="sr-only" role="status" aria-live="polite">{live}</div>

          {!searching ? (
            <div className="sr-idle">
              {recent.length > 0 && (
                <section>
                  <div className="sr-sec-h"><span>búsquedas recientes</span><button className="sr-link" onClick={clearRecent}>Borrar</button></div>
                  <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{recent.map(r => <button key={r} className="tk-chip" onClick={() => setQ(r)}><I.Clock size={11} />{r}</button>)}</div>
                </section>
              )}
              <section>
                <div className="sr-sec-h"><span>conversaciones recientes</span></div>
                <div className="card sr-card">
                  {(threads || []).slice(0, 6).map(t => { const a = agents.find(x => x.id === t.agentId); const Ic = a ? I[a.icon] || I.Chat : I.Chat; return (
                    <button key={t.id} className="sr-thread" onClick={() => openChat(t.agentId, t.id)}>
                      <span className="tk-agent-ic" style={{ background: a?.iconBg, color: a?.iconColor, width: 24, height: 24, borderRadius: 6 }}><Ic size={12} /></span>
                      <span style={{ flex: 1, minWidth: 0 }}><span className="sr-t">{t.title}</span><span className="sr-s">{a?.name}</span></span>
                      <span className="tk-meta">{t.time}</span>
                    </button>
                  ); })}
                </div>
              </section>
            </div>
          ) : res.err === 'fail' ? (
            <div className="mk-empty sr-err" role="alert">
              <span className="sr-err-ic"><I.Warn size={16} /></span>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>No se pudo buscar en tus conversaciones.</div>
              <button className="btn btn-sm" onClick={retry} disabled={pending}><I.Refresh size={11} /> Reintentar</button>
            </div>
          ) : res.err === 'rate' ? (
            <div className="mk-empty sr-err" role="alert">
              <span className="sr-err-ic"><I.Clock size={16} /></span>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>Demasiadas solicitudes</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Hiciste muchas búsquedas seguidas.<window.RateWait inline at={res.at} /></div>
              <window.RateWait at={res.at} onRetry={retry} />
            </div>
          ) : !res.done ? (
            <div className="sr-count" aria-hidden="true">{slow && <span className="sr-busy"><span className="mango-spinner sm" />Buscando…</span>}</div>
          ) : results.length === 0 ? (
            <>
              <div className="mk-empty" aria-busy={pending}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>Sin resultados para “{res.q}”</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{anyFilter ? 'Prueba quitando algún filtro.' : 'Revisa la ortografía o usa menos palabras. Todas las palabras deben aparecer en el mismo mensaje.'}</div>
                {anyFilter && <button className="btn btn-sm" onClick={() => { setAgent('all'); setKind('all'); setWhen('all'); }}>Quitar filtros</button>}
                {slow && <span className="sr-busy"><span className="mango-spinner sm" />Buscando…</span>}
              </div>
              {capLines}
            </>
          ) : (
            <>
              <div className="sr-count">
                <span className="row gap-2" style={{ flexWrap: 'wrap', flex: 1, minWidth: 0 }}><span style={{ whiteSpace: 'nowrap' }}><b>{total}</b> {total === 1 ? 'coincidencia' : 'coincidencias'} en <b>{results.length}</b> {results.length === 1 ? 'conversación' : 'conversaciones'}</span>{slow && <span className="sr-busy" aria-hidden="true"><span className="mango-spinner sm" />Buscando…</span>}</span>
                <select className="input mk-sel" aria-label="Ordenar" value={sort} onChange={e => setSort(e.target.value)}>
                  <option value="relevance">Más relevantes</option><option value="recent">Más recientes</option>
                </select>
              </div>
              {capLines}
              <div id="sr-results" ref={listRef} role="listbox" aria-busy={pending} className="sr-results">
                {results.map((r, i) => {
                  const { thread, agent: a, hits } = r;
                  const Ic = a ? I[a.icon] || I.Chat : I.Chat;
                  const open = expanded[thread.id];
                  const shown = open ? hits : hits.slice(0, 3);
                  return (
                    <div key={thread.id} id={'sr-' + i} data-sr={i} role="option" aria-selected={i === active} className={'card sr-card' + (i === active ? ' is-active' : '')} onMouseEnter={() => setActive(i)}>
                      <button className="sr-thread head" onClick={() => go(r)}>
                        <span className="tk-agent-ic" style={{ background: a?.iconBg, color: a?.iconColor, width: 24, height: 24, borderRadius: 6 }}><Ic size={12} /></span>
                        <span style={{ flex: 1, minWidth: 0 }}><span className="sr-t">{thread.title}</span><span className="sr-s">{a?.name} · {thread.time}</span></span>
                        <span className="sr-open">Abrir <I.ArrowRight size={11} /></span>
                      </button>
                      {(hits.some(h => h.kind !== 'title') ? shown.filter(h => h.kind !== 'title') : shown).map(h => (
                        <button key={h.idx} className="sr-hit" onClick={() => go(r, h)}>
                          <span className={'sr-kind k-' + h.kind}>{SR_KIND[h.kind]}</span>
                          <span className={'sr-snip' + (h.kind === 'tool' ? ' mono' : '')}><SrSnip snip={h.snip} /></span>
                        </button>
                      ))}
                      {hits.length > 3 && <button className="sr-more" onClick={() => setExpanded(x => ({ ...x, [thread.id]: !open }))}>{open ? 'Ver menos' : `Ver ${hits.length - 3} más`}</button>}
                    </div>
                  );
                })}
              </div>
              <div className="sr-hint"><kbd>↑</kbd><kbd>↓</kbd> para moverte · <kbd>Enter</kbd> abre en la coincidencia · <kbd>Esc</kbd> borra</div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

Object.assign(window, { GlobalSearch, searchMessages });
