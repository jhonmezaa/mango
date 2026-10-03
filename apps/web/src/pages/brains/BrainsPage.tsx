import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminErrorKey, apiErrorCode, isStaleDataError } from '../../api/adminErrors';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { Empty, GovErrorState, Skel, Spinner } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { Badge } from '../../components/Badge';
import {
  EyeIcon,
  LockIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  TerminalIcon,
  WarnIcon,
} from '../../components/icons';
import { Topbar } from '../../components/Topbar';
import { formatRelative } from '../../lib/format';
import {
  NO_FILTERS,
  STATUS_ORDER,
  STATUS_TONE,
  formatContext,
  formatPrice,
  hasFilters,
  matchingModels,
  providersOf,
  sortModels,
  type Catalog,
  type Filters,
  type Model,
  type StatusFilter,
} from './model';
import { ModelDetail, type ModelChange } from './ModelDetail';

type LoadState = { kind: 'loading' } | { kind: 'ready'; data: Catalog } | { kind: 'error' };

const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...STATUS_ORDER];
const QUERY_MAX_LENGTH = 200;
// Design: providers outside AWS, shown as "Próximamente" (no backend).
const SOON_PROVIDERS = [
  { name: 'Google Gemini', models: 'geminiModels' },
  { name: 'OpenAI', models: 'openaiModels' },
] as const;
const OWN_ERRORS = new Set([
  'model_no_access',
  'default_model',
  'model_not_enabled',
  'bedrock_unavailable',
  // Design `SRV`: what the panel says when the server refuses a change.
  'version_conflict',
  'forbidden',
  'audit_unavailable',
] as const);
type OwnError = typeof OWN_ERRORS extends Set<infer Code> ? Code : never;

function isOwnError(code: string | null): code is OwnError {
  return code !== null && (OWN_ERRORS as Set<string>).has(code);
}

interface ModelRowProps {
  model: Model;
  /** Bedrock was never asked: the catalog only has identifiers, not names. */
  never: boolean;
  onOpen: (id: string) => void;
}

function ModelRow({ model, never, onOpen }: ModelRowProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={model.status === 'noaccess' ? 'mv-tr is-dim' : 'mv-tr'}
      onClick={() => {
        onOpen(model.id);
      }}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2 [overflow-wrap:anywhere]">
          <span className={never ? 'mk-name mono' : 'mk-name'}>
            {never ? model.id : model.name}
          </span>
          {model.is_default ? (
            <span className="badge badge-accent text-[10.5px]">{t('brains.default')}</span>
          ) : null}
        </span>
        <span className="mk-meta block truncate">
          {model.provider} · <span className="mono">{model.id}</span>
        </span>
      </span>
      <span>
        <Badge tone={STATUS_TONE[model.status]}>{t(`brains.status.${model.status}`)}</Badge>
      </span>
      <span className="flex flex-wrap items-center gap-1">
        {model.supports_tools ? (
          <span className="mv-cap" title={t('brains.capTools')}>
            <TerminalIcon size={11} /> {t('brains.chipTools')}
          </span>
        ) : null}
        {model.supports_vision ? (
          <span className="mv-cap" title={t('brains.capVision')}>
            <EyeIcon size={11} /> {t('brains.chipVision')}
          </span>
        ) : null}
        {model.context_tokens !== null ? (
          <span className="mv-cap" title={t('brains.capContext')}>
            {formatContext(model.context_tokens)}
          </span>
        ) : null}
      </span>
      <span className="mono text-right text-xs whitespace-nowrap">
        {model.input_usd !== null && model.output_usd !== null ? (
          `${formatPrice(model.input_usd)} / ${formatPrice(model.output_usd)}`
        ) : (
          <span className="mk-meta font-sans">{t('brains.noPrice')}</span>
        )}
      </span>
      <span className="mk-meta">{model.agents.length || '—'}</span>
      <span className="mk-meta">{t('brains.noData')}</span>
    </button>
  );
}

/**
 * Brains (design models-view.jsx): the Bedrock models of the installation. An administrator
 * enables or disables a model and confirms its prices; the API authorizes and audits every
 * change (`ManageModels`), the checks here are only UX. Usage per model and providers outside
 * AWS have no backend yet and say so; the context size is shown when the release knows it.
 */
export function BrainsPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { notify, stack } = useToasts();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [forbidden, setForbidden] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!me.is_admin) return;
    const controller = new AbortController();
    api.call('getAdminModels', {}, { signal: controller.signal }).then(
      (data) => {
        setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 403) setForbidden(true);
        setState({ kind: 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, me.is_admin, reloadToken]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);

  const errorText = (error: unknown): string => {
    const code = apiErrorCode(error);
    return isOwnError(code) ? t(`brains.errors.${code}`) : t(adminErrorKey(error));
  };

  const refresh = async () => {
    if (state.kind !== 'ready' || refreshing) return;
    const known = new Set(state.data.items.map((model) => model.id));
    setRefreshing(true);
    try {
      const data = await api.call('refreshAdminModels', { body: {} });
      setState({ kind: 'ready', data });
      const added = data.items.filter((model) => !known.has(model.id)).length;
      notify(
        added > 0 ? t('brains.refreshedNew', { count: added }) : t('brains.refreshedNone'),
        'success',
      );
    } catch (error) {
      notify(errorText(error), 'error');
    } finally {
      setRefreshing(false);
    }
  };

  /** Sends one change with the catalog version; a stale catalog is reloaded (409). */
  const change = async (model: Model, request: ModelChange): Promise<string | null> => {
    if (state.kind !== 'ready') return t('admin.errors.generic');
    const version = state.data.version;
    try {
      const data = await api.call('putAdminModel', {
        path: { model_id: model.id },
        body:
          request.kind === 'disable'
            ? { version, enabled: false, reason: request.reason || null }
            : {
                version,
                enabled: true,
                input_usd: request.inputUsd,
                output_usd: request.outputUsd,
              },
      });
      setState({ kind: 'ready', data });
      if (request.kind === 'enable') notify(t('brains.toast.enabled', { name: model.name }));
      else if (request.kind === 'price') notify(t('brains.toast.prices'));
      else notify(t('brains.toast.disabled', { name: model.name }), 'info');
      return null;
    } catch (error) {
      if (isStaleDataError(error)) {
        try {
          setState({ kind: 'ready', data: await api.call('getAdminModels') });
        } catch (reloadError) {
          return t(adminErrorKey(reloadError));
        }
      }
      return errorText(error);
    }
  };

  const crumbs = [t('brains.crumbBuild'), t('brains.title')];
  if (!me.is_admin || forbidden) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <div className="g-denied">
            <Empty icon={LockIcon} title={t('gov.denied.title')}>
              {t('brains.denied')}
            </Empty>
          </div>
        </div>
      </>
    );
  }

  const data = state.kind === 'ready' ? state.data : null;
  const models = data?.items ?? [];
  const base = matchingModels(models, filters);
  const list = sortModels(
    filters.status === 'all' ? base : base.filter((model) => model.status === filters.status),
  );
  const count = (status: StatusFilter) =>
    status === 'all' ? base.length : base.filter((model) => model.status === status).length;
  const detail = selected === null ? null : models.find((model) => model.id === selected);
  const never = data !== null && data.refreshed_at === null;
  const patch = (changes: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...changes }));
  };

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          <button
            type="button"
            className="btn btn-sm"
            disabled={refreshing || data === null}
            onClick={() => void refresh()}
          >
            {refreshing ? (
              <>
                <Spinner /> {t('brains.refreshing')}
              </>
            ) : (
              <>
                <RefreshIcon size={12} /> {t('brains.refresh')}
              </>
            )}
          </button>
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('brains.title')}</h1>
          <p className="page-subtitle">{t('brains.subtitle')}</p>
        </div>
        {state.kind === 'error' ? (
          <div className="mc-body">
            <GovErrorState
              title={t('brains.loadError')}
              body={t('admin.errors.unavailable')}
              onRetry={retry}
            />
          </div>
        ) : data === null ? (
          <div className="mc-body" role="status" aria-label={t('app.loading')}>
            <Skel h={56} className="mb-4 rounded-xl" />
            <Skel h={220} className="rounded-xl" />
          </div>
        ) : (
          <>
            <div className="mv-conn">
              <span className="gv-ic mv-conn-ic">
                <ShieldIcon size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold">
                  {t('brains.connected')} · <span className="mono">{data.region}</span>
                </div>
                <div className="mk-meta">
                  {data.refreshed_at !== null
                    ? t('brains.lastCheck', { when: formatRelative(data.refreshed_at) })
                    : t('brains.neverChecked')}
                </div>
              </div>
            </div>
            <div className="ap-bar mv-bar">
              <div className="ap-filters">
                <div className="search-wrap max-w-[300px] flex-[1_1_220px]">
                  <SearchIcon size={13} />
                  <input
                    className="input"
                    placeholder={t('brains.search')}
                    aria-label={t('brains.searchLabel')}
                    maxLength={QUERY_MAX_LENGTH}
                    value={filters.query}
                    onChange={(event) => {
                      patch({ query: event.target.value });
                    }}
                  />
                </div>
                <div
                  className="tk-quick mv-status-f"
                  role="group"
                  aria-label={t('brains.statusLabel')}
                >
                  {STATUS_FILTERS.map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={filters.status === status ? 'is-on' : undefined}
                      aria-pressed={filters.status === status}
                      onClick={() => {
                        patch({ status });
                      }}
                    >
                      {t(`brains.filters.${status}`)}
                      <span className="mk-count">{count(status)}</span>
                    </button>
                  ))}
                </div>
                <select
                  className="input mk-sel"
                  aria-label={t('brains.providerLabel')}
                  value={filters.provider}
                  onChange={(event) => {
                    patch({ provider: event.target.value });
                  }}
                >
                  <option value="all">{t('brains.allProviders')}</option>
                  {providersOf(models).map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
                <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
                  <input
                    type="checkbox"
                    className="mv-check"
                    checked={filters.tools}
                    onChange={(event) => {
                      patch({ tools: event.target.checked });
                    }}
                  />
                  {t('brains.capTools')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
                  <input
                    type="checkbox"
                    className="mv-check"
                    checked={filters.vision}
                    onChange={(event) => {
                      patch({ vision: event.target.checked });
                    }}
                  />
                  {t('brains.capVision')}
                </label>
                {hasFilters(filters) ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setFilters(NO_FILTERS);
                    }}
                  >
                    {t('brains.clear')}
                  </button>
                ) : null}
              </div>
            </div>

            <div className="mc-body">
              {list.length === 0 ? (
                <div className="mk-empty" role="status">
                  <div className="text-sm font-semibold">{t('brains.emptyTitle')}</div>
                  <div className="mk-meta">{t('brains.emptyBody')}</div>
                </div>
              ) : (
                <div className="card mc-table">
                  <div className="mv-tr mc-th" aria-hidden="true">
                    <span>{t('brains.table.model')}</span>
                    <span>{t('brains.table.status')}</span>
                    <span>{t('brains.table.capabilities')}</span>
                    <span className="text-right">{t('brains.table.price')}</span>
                    <span>{t('brains.table.agents')}</span>
                    <span>{t('brains.table.usage')}</span>
                  </div>
                  {list.map((model) => (
                    <ModelRow key={model.id} model={model} never={never} onOpen={setSelected} />
                  ))}
                </div>
              )}

              <section className="mt-7">
                <h2 className="mk-sec-t">{t('brains.soon.title')}</h2>
                <div className="mv-soon">
                  {SOON_PROVIDERS.map((provider) => (
                    <div key={provider.name} className="card mv-soon-c">
                      <div className="flex items-center justify-between gap-2">
                        <span className="mk-name">{provider.name}</span>
                        <span className="badge">{t('brains.soon.tag')}</span>
                      </div>
                      <div className="mk-meta mt-0.5">{t(`brains.soon.${provider.models}`)}</div>
                      <div className="mv-soon-w">
                        <WarnIcon size={12} /> {t('brains.soon.leavesAws')}
                      </div>
                    </div>
                  ))}
                  <div className="mv-soon-note">{t('brains.soon.note')}</div>
                </div>
              </section>
            </div>
          </>
        )}
      </div>
      {detail && data ? (
        <ModelDetail
          // A new panel per model: its forms never carry over to another model.
          key={detail.id}
          model={detail}
          region={data.region}
          never={never}
          onChange={change}
          onClose={() => {
            setSelected(null);
          }}
        />
      ) : null}
      {stack}
    </>
  );
}
