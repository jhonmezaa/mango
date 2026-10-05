import type { OrgOut } from '@mango/api-client/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { Denied, GovErrorState } from '../../components/admin/govKit';
import { PlusIcon, SearchIcon } from '../../components/icons';
import { Soon, SoonTag } from '../../components/Soon';
import { Topbar } from '../../components/Topbar';
import { ExpandIcon, GitBranchIcon } from './icons';
import { OrgSidePanel } from './OrgSidePanel';
import { buildTree, countSupervisors, firstLevelSupervisors } from './orgTree';
import { OrgTreeView } from './OrgTreeView';
import { useViewport } from './useViewport';

type LoadState =
  { kind: 'loading' } | { kind: 'ready'; data: OrgOut } | { kind: 'error' } | { kind: 'denied' };

const NO_AGENTS: OrgOut = { root: 'platform', nodes: [] };
const NONE: ReadonlySet<string> = new Set();
const LEGEND = [
  ['var(--green)', 'online'],
  ['var(--amber)', 'warmup'],
  ['var(--red)', 'degraded'],
  ['var(--chart-muted)', 'offline'],
] as const;

/**
 * Org Chart (design other-views.jsx `OrgChart`), read only (D30): who supervises whom, from the
 * «Reporta a» and role of each published agent. The API returns what the caller may see: admins
 * and creators the whole tree, everyone else the agents they can use (D38); agents whose
 * supervisor the caller cannot see hang from «Supervisor no visible». Agent-to-agent delegation,
 * its counters, the alerts and the agent status have no backend yet ("Próximamente").
 */
export function OrgChartPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NONE);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api.call('getOrg', {}, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const denied = error instanceof ApiError && error.status === 403;
        setState({ kind: denied ? 'denied' : 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, reloadToken]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);

  const data = state.kind === 'ready' ? state.data : NO_AGENTS;
  const rootName = t('orgChart.root.name');
  const rootRole = t('orgChart.root.role');
  const hiddenName = t('orgChart.hidden.name');
  const hiddenRole = t('orgChart.hidden.role');
  const tree = useMemo(
    () =>
      buildTree(data, {
        root: { name: rootName, role: rootRole },
        hidden: { name: hiddenName, role: hiddenRole },
      }),
    [data, rootName, rootRole, hiddenName, hiddenRole],
  );
  // UX only (D38): the API already returned the tree this caller may see.
  const fullTree = me.is_admin || me.can.create_agent;
  const { wrapRef, treeRef, view, dragging, fitView, zoomBy, reveal, center, canvasHandlers } =
    useViewport(`${state.kind}:${[...collapsed].join(',')}`);

  const select = useCallback((id: string) => {
    setSelected((current) => (current === id ? null : id));
  }, []);
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  // Keep the selected node in view when the panel opens and narrows the canvas.
  useEffect(() => {
    if (selected === null) return;
    const timer = setTimeout(() => {
      reveal('.oc-node.on');
    }, 80);
    return () => {
      clearTimeout(timer);
    };
  }, [selected, reveal]);

  // Bring the first search hit to the center.
  useEffect(() => {
    if (!query) return;
    const timer = setTimeout(() => {
      center('.oc-node.hit');
    }, 60);
    return () => {
      clearTimeout(timer);
    };
  }, [query, center]);

  const topbar = (
    <Topbar
      crumbs={[t('orgChart.crumb')]}
      actions={
        // UX only: the API authorizes the creation of agents.
        me.can.create_agent ? (
          <button type="button" className="btn btn-sm" onClick={() => void navigate('/admin')}>
            <PlusIcon size={12} />
            {t('orgChart.newAgent')}
          </button>
        ) : undefined
      }
    />
  );

  if (state.kind === 'denied') {
    return (
      <>
        {topbar}
        <div className="content">
          <Denied />
        </div>
      </>
    );
  }

  const selectedNode = selected === null ? null : (tree.byId.get(selected) ?? null);
  const ready = state.kind === 'ready';

  return (
    <>
      {topbar}
      <div className="content">
        <div className="oc-page">
          <h1 className="page-title">{t('orgChart.title')}</h1>
          <p className="page-subtitle mb-5">
            {t('orgChart.subtitle')}
            {fullTree ? null : ` ${t('orgChart.subtitleFiltered')}`}
          </p>
          <div className="oc-stats">
            <div>
              <span>{t('orgChart.stats.agents')}</span>
              <b>{ready ? data.nodes.length : '—'}</b>
            </div>
            <div>
              <span>{t('orgChart.stats.supervisors')}</span>
              <b>{ready ? countSupervisors(tree) : '—'}</b>
            </div>
            <div>
              <span>{t('orgChart.stats.alerts')}</span>
              {/* Alerts come from the agent status and budget, which this screen does not have. */}
              <b>
                <SoonTag />
              </b>
            </div>
          </div>

          {state.kind === 'error' ? (
            <GovErrorState
              title={t('orgChart.loadError')}
              body={t('orgChart.loadErrorBody')}
              onRetry={retry}
            />
          ) : (
            <div className={selectedNode ? 'oc-grid has-panel' : 'oc-grid'}>
              <section className="card oc-card" aria-label={t('orgChart.chart')}>
                <div className="oc-toolbar">
                  <div className="search-wrap oc-search">
                    <SearchIcon size={13} />
                    <input
                      className="input"
                      aria-label={t('orgChart.searchLabel')}
                      placeholder={t('orgChart.search')}
                      maxLength={200}
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                      }}
                    />
                  </div>
                  <div className="oc-tools">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setCollapsed(firstLevelSupervisors(tree));
                      }}
                    >
                      {t('orgChart.collapse')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setCollapsed(NONE);
                      }}
                    >
                      {t('orgChart.expand')}
                    </button>
                    <span className="topbar-sep" aria-hidden="true" />
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      aria-label={t('orgChart.zoomOut')}
                      title={t('orgChart.zoomOutHint')}
                      onClick={() => {
                        zoomBy(-10);
                      }}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm oc-zoom"
                      title={t('orgChart.fitHint')}
                      onClick={fitView}
                    >
                      {`${Math.round(view.k * 100)}%`}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      aria-label={t('orgChart.zoomIn')}
                      title={t('orgChart.zoomInHint')}
                      onClick={() => {
                        zoomBy(10);
                      }}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      title={t('orgChart.centerHint')}
                      onClick={fitView}
                    >
                      <ExpandIcon size={12} />
                      {t('orgChart.fit')}
                    </button>
                  </div>
                </div>
                <div
                  ref={wrapRef}
                  className={dragging ? 'oc-canvas grabbing' : 'oc-canvas'}
                  tabIndex={0}
                  role="application"
                  aria-label={t('orgChart.canvasLabel')}
                  aria-busy={state.kind === 'loading'}
                  {...canvasHandlers}
                  style={{
                    backgroundPosition: `${view.x}px ${view.y}px`,
                    backgroundSize: `${20 * view.k}px ${20 * view.k}px`,
                  }}
                >
                  <div className="oc-hint" aria-hidden="true">
                    {t('orgChart.hint')}
                  </div>
                  {state.kind === 'loading' ? (
                    <p role="status" className="oc-loading">
                      <span className="spinner" aria-hidden="true" />
                      {t('orgChart.loading')}
                    </p>
                  ) : null}
                  <div
                    ref={treeRef}
                    className="oc-tree"
                    style={{
                      transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`,
                    }}
                  >
                    {ready ? (
                      <OrgTreeView
                        root={tree.root}
                        selectedId={selected}
                        collapsed={collapsed}
                        query={query}
                        onSelect={select}
                        onToggle={toggle}
                      />
                    ) : null}
                  </div>
                </div>
                <div className="oc-legend">
                  {/* Status dots and running delegations are not drawn yet: nothing reports them. */}
                  <Soon name={t('orgChart.legend.label')}>
                    <span className="oc-legend-items">
                      {LEGEND.map(([color, key]) => (
                        <span key={key} className="flex items-center gap-1">
                          <span className="dot" style={{ background: color }} />
                          {t(`orgChart.legend.${key}`)}
                        </span>
                      ))}
                      <span className="flex items-center gap-1">
                        <span className="spinner" />
                        {t('orgChart.legend.delegating')}
                      </span>
                    </span>
                  </Soon>
                </div>
              </section>
              {selectedNode ? (
                <OrgSidePanel
                  node={selectedNode}
                  canCreate={me.can.create_agent}
                  onClose={() => {
                    setSelected(null);
                  }}
                />
              ) : null}
            </div>
          )}

          <h2 className="oc-deleg-t">
            {t('orgChart.delegations.title')} <SoonTag />
          </h2>
          {/* Design: one "Próximamente" card, without rows (A2A has no backend, D30). */}
          <div className="card oc-deleg-soon">
            <GitBranchIcon size={16} />
            <div className="min-w-0 flex-1">
              <div className="oc-deleg-soon-t">{t('orgChart.delegations.label')}</div>
              <div className="mk-meta">{t('orgChart.delegations.body')}</div>
            </div>
            <SoonTag />
          </div>
        </div>
      </div>
    </>
  );
}
