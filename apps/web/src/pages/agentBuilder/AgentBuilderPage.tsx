import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useSession } from '../../auth/useSession';
import { ErrorState } from '../../components/ErrorState';
import { LockIcon, RefreshIcon, SearchIcon, WarnIcon } from '../../components/icons';
import { Topbar } from '../../components/Topbar';
import { BuilderForm } from './BuilderForm';
import { parseTarget, useBuilderData, type LoadError } from './useBuilderData';

const ERROR_TEXT = {
  forbidden: { title: 'forbiddenTitle', body: 'forbiddenBody', icon: LockIcon },
  not_found: { title: 'notFoundTitle', body: 'notFoundBody', icon: SearchIcon },
  failed: { title: 'title', body: 'body', icon: WarnIcon },
} as const satisfies Record<LoadError, unknown>;

/**
 * Agent Builder (design admin.jsx `AgentAdmin`, view `admin`): `/admin` starts a new agent,
 * `/admin/<agentId>` edits the open version of an agent or starts a change to a published one,
 * and `/admin/<agentId>/<version>` edits that version.
 * Creating is offered from `can.create_agent` of GET /api/me; the API authorizes every call.
 */
export function AgentBuilderPage() {
  const splat = useParams()['*'] ?? '';
  // A different agent is a different form: nothing typed for one may reach another.
  return <Builder key={splat} splat={splat} />;
}

function Builder({ splat }: { splat: string }) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const canCreate = me.can.create_agent;
  const { state, retry } = useBuilderData(api, parseTarget(splat), me.is_admin, canCreate);
  const crumbs = [t('agentBuilder.crumbRoot'), t('agentBuilder.newAgent')];

  if (!canCreate) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <div className="mk-empty ab-denied">
            <LockIcon size={22} />
            <h1 className="ab-denied-title">{t('agentBuilder.denied.title')}</h1>
            <div className="mk-meta">{t('agentBuilder.denied.body')}</div>
          </div>
        </div>
      </>
    );
  }
  if (state.kind === 'ready') return <BuilderForm data={state.data} />;
  if (state.kind === 'loading') {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <p role="status" className="flex items-center gap-2.5 p-8 text-muted">
            <span className="spinner" aria-hidden="true" />
            {t('agentBuilder.loading')}
          </p>
        </div>
      </>
    );
  }
  const text = ERROR_TEXT[state.error];
  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content">
        <ErrorState
          icon={text.icon}
          tone={state.error === 'failed' ? 'amber' : 'muted'}
          role={state.error === 'failed' ? 'alert' : 'status'}
          title={t(`agentBuilder.loadError.${text.title}`)}
          description={t(`agentBuilder.loadError.${text.body}`)}
          actions={
            <>
              {state.error === 'failed' && (
                <button type="button" className="btn btn-sm" onClick={retry}>
                  <RefreshIcon size={12} />
                  {t('common.retry')}
                </button>
              )}
              <Link to="/marketplace" className="btn btn-sm">
                {t('agentBuilder.loadError.backToMarketplace')}
              </Link>
            </>
          }
        />
      </div>
    </>
  );
}
