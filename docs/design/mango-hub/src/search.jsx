// Buscar en todas las conversaciones
const { useState: useStateSr, useMemo: useMemoSr, useEffect: useEffectSr, useRef: useRefSr } = React;
const SR_KIND = { title: 'Título', user: 'Tú', agent: 'Agente', tool: 'Herramienta' };
const SR_RECENT_KEY = 'mango-search-recent';
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
      else if (m.type === 'tool_call') test(m.tool + ' ' + JSON.stringify(m.params), 'tool', idx);
    });
    if (hits.length) out.push({ thread: t, agent: agents.find(a => a.id === t.agentId), hits, score: hits.length + (hits[0].kind === 'title' ? 5 : 0) });
  });
  return out;
}

function SrSnip({ snip }) {
  return <>{snip.pre && '…'}{snip.parts.map((p, i) => p.hit ? <mark key={i} className="sr-mark">{p.hit}</mark> : <React.Fragment key={i}>{p.txt}</React.Fragment>)}{snip.post && '…'}</>;
}

function GlobalSearch({ threads, agents, openChat }) {
  const I = window.Icons;
  const [q, setQ] = useStateSr('');
  const [agent, setAgent] = useStateSr('all');
  const [kind, setKind] = useStateSr('all');
  const [when, setWhen] = useStateSr('all');
  const [sort, setSort] = useStateSr('relevance');
  const [expanded, setExpanded] = useStateSr({});
  const [active, setActive] = useStateSr(0);
  const [recent, setRecent] = useStateSr(() => { try { return JSON.parse(localStorage.getItem(SR_RECENT_KEY) || '[]'); } catch { return []; } });
  const inputRef = useRefSr(null);
  const listRef = useRefSr(null);

  const rawResults = useMemoSr(() => searchMessages(q, threads, agents, { agent, kind, when }), [q, agent, kind, when, threads, agents]);
  const order = (threads || []).map(t => t.id);
  const results = [...rawResults].sort(sort === 'recent' ? (a, b) => order.indexOf(a.thread.id) - order.indexOf(b.thread.id) : (a, b) => b.score - a.score);
  const total = results.reduce((s, r) => s + Math.max(1, r.hits.filter(h => h.kind !== 'title').length), 0);
  const searching = q.trim().length >= 2;

  useEffectSr(() => { setActive(0); }, [q, agent, kind, when, sort]);
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
    const next = [t, ...recent.filter(x => x.toLowerCase() !== t.toLowerCase())].slice(0, 6);
    setRecent(next); localStorage.setItem(SR_RECENT_KEY, JSON.stringify(next));
  };
  const clearRecent = () => { setRecent([]); localStorage.removeItem(SR_RECENT_KEY); };
  const go = (r) => { remember(q); openChat(r.thread.agentId, r.thread.id); };
  const onKey = (e) => {
    if (e.key === 'Escape') { setQ(''); return; }
    if (!results.length) { if (e.key === 'Enter') remember(q); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(results.length - 1, a + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
  };
  const anyFilter = agent !== 'all' || kind !== 'all' || when !== 'all';
  const suggestions = useMemoSr(() => {
    const seeds = window.seedMessages || {};
    const tools = new Set();
    Object.values(seeds).flat().forEach(m => { if (m.type === 'tool_call') tools.add(m.tool.split('.')[0]); });
    return [...tools].slice(0, 5);
  }, []);

  return (
    <>
      <Topbar crumbs={['Buscar conversaciones']} />
      <div className="content">
        <div className="sr-wrap">
          <h1 className="sr-h1">Buscar conversaciones</h1>
          <div className="search-wrap sr-input">
            <I.Search size={15} />
            <input ref={inputRef} className="input" autoFocus aria-label="Buscar en conversaciones" placeholder="Busca en títulos, mensajes, respuestas y herramientas"
              value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} onBlur={() => searching && results.length && remember(q)}
              role="combobox" aria-expanded={searching} aria-controls="sr-results" aria-activedescendant={searching && results.length ? 'sr-' + active : undefined} />
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

          {!searching ? (
            <div className="sr-idle">
              {recent.length > 0 && (
                <section>
                  <div className="sr-sec-h"><span>búsquedas recientes</span><button className="sr-link" onClick={clearRecent}>Borrar</button></div>
                  <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{recent.map(r => <button key={r} className="tk-chip" onClick={() => setQ(r)}><I.Clock size={11} />{r}</button>)}</div>
                </section>
              )}
              {suggestions.length > 0 && (
                <section>
                  <div className="sr-sec-h"><span>prueba con</span></div>
                  <div className="row gap-1" style={{ flexWrap: 'wrap' }}>{suggestions.map(s => <button key={s} className="tk-chip mono" onClick={() => setQ(s)}>{s}</button>)}</div>
                </section>
              )}
              <section>
                <div className="sr-sec-h"><span>conversaciones recientes</span></div>
                <div className="card sr-card">
                  {(threads || []).slice(0, 6).map(t => { const a = agents.find(x => x.id === t.agentId); const Ic = a ? I[a.icon] || I.Chat : I.Chat; return (
                    <button key={t.id} className="sr-thread" onClick={() => openChat(t.agentId, t.id)}>
                      <span className="tk-agent-ic" style={{ background: a?.iconBg, color: a?.iconColor, width: 24, height: 24, borderRadius: 6 }}><Ic size={12} /></span>
                      <span style={{ flex: 1, minWidth: 0 }}><span className="sr-t">{t.title}</span><span className="sr-s">{a?.name} · {t.last}</span></span>
                      <span className="tk-meta">{t.time}</span>
                    </button>
                  ); })}
                </div>
              </section>
            </div>
          ) : results.length === 0 ? (
            <div className="mk-empty">
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>Sin resultados para “{q.trim()}”</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{anyFilter ? 'Prueba quitando algún filtro.' : 'Revisa la ortografía o usa menos palabras. Todas las palabras deben aparecer en el mismo mensaje.'}</div>
              {anyFilter && <button className="btn btn-sm" onClick={() => { setAgent('all'); setKind('all'); setWhen('all'); }}>Quitar filtros</button>}
            </div>
          ) : (
            <>
              <div className="sr-count">
                <span><b>{total}</b> {total === 1 ? 'coincidencia' : 'coincidencias'} en <b>{results.length}</b> {results.length === 1 ? 'conversación' : 'conversaciones'}</span>
                <select className="input mk-sel" aria-label="Ordenar" value={sort} onChange={e => setSort(e.target.value)}>
                  <option value="relevance">Más relevantes</option><option value="recent">Más recientes</option>
                </select>
              </div>
              <div id="sr-results" ref={listRef} role="listbox" className="sr-results">
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
                        <button key={h.idx} className="sr-hit" onClick={() => go(r)}>
                          <span className={'sr-kind k-' + h.kind}>{SR_KIND[h.kind]}</span>
                          <span className={'sr-snip' + (h.kind === 'tool' ? ' mono' : '')}><SrSnip snip={h.snip} /></span>
                        </button>
                      ))}
                      {hits.length > 3 && <button className="sr-more" onClick={() => setExpanded(x => ({ ...x, [thread.id]: !open }))}>{open ? 'Ver menos' : `Ver ${hits.length - 3} más`}</button>}
                    </div>
                  );
                })}
              </div>
              <div className="sr-hint"><kbd>↑</kbd><kbd>↓</kbd> para moverte · <kbd>Enter</kbd> abre la conversación · <kbd>Esc</kbd> borra</div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

Object.assign(window, { GlobalSearch, searchMessages });
