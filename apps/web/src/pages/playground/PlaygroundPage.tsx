import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useSession } from '../../auth/useSession';
import { Denied, Empty, GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { PlayIcon, PlusIcon } from '../../components/icons';
import { Topbar } from '../../components/Topbar';
import { canView } from '../../layouts/navigation';
import { usePlaygroundData } from './usePlaygroundData';
import { Workspace } from './Workspace';

const SKELETON = [40, 100, 40, 100, 60, 180] as const;

/**
 * Playground (design playground.jsx, round 21, D91): whoever edits an agent tests a draft or the
 * published version before sending it to review. Hiding the view is only UX: the API checks
 * `EditAgent` on every test.
 */
export function PlaygroundPage() {
  const { t } = useTranslation();
  const { me } = useSession();
  if (!canView(me, 'playground')) {
    return (
      <>
        <Topbar crumbs={[t('playground.crumbRoot'), t('playground.crumb')]} />
        <div className="content">
          <Denied view="playground" />
        </div>
      </>
    );
  }
  return <Playground />;
}

function Playground() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { state, retry, refresh } = usePlaygroundData(api, me.is_admin);
  const { notify, stack } = useToasts();
  const [selected, setSelected] = useState<string | null>(null);
  // A new key remounts the workspace: «Recargar» drops what changed on screen.
  const [nonce, setNonce] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const crumbs = [t('playground.crumbRoot'), t('playground.crumb')];

  const markUnavailable = useCallback(() => {
    setUnavailable(true);
  }, []);
  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);
  /** After saving or sending: read the list again and show what the action left. */
  const afterWrite = useCallback(
    async (key: string | null) => {
      await refresh();
      setSelected(key);
    },
    [refresh],
  );

  if (unavailable) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <Empty icon={PlayIcon} title={t('playground.unavailable.title')}>
            {t('playground.unavailable.body')}
          </Empty>
        </div>
      </>
    );
  }
  if (state.kind === 'loading') {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="pg-grid" aria-busy="true" aria-label={t('playground.loadingList')}>
          <div className="pg-side pg-skel">
            {SKELETON.map((width, index) => (
              <Skel key={index} w={`${String(width)}%`} h={index % 2 ? 32 : 10} />
            ))}
          </div>
          <div />
        </div>
      </>
    );
  }
  if (state.kind === 'error') {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <GovErrorState
            title={t('playground.loadError.title')}
            body={t('playground.loadError.body')}
            onRetry={retry}
          />
        </div>
      </>
    );
  }
  const { data } = state;
  const sources = [...data.drafts, ...data.published];
  const source = sources.find((item) => item.key === selected) ?? sources[0];
  if (!source) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <Empty
            icon={PlayIcon}
            title={t('playground.empty.title')}
            action={
              me.can.create_agent && (
                <Link to="/admin" className="btn btn-sm btn-primary">
                  <PlusIcon size={12} />
                  {t('playground.empty.create')}
                </Link>
              )
            }
          >
            {t('playground.empty.body')}
          </Empty>
        </div>
        {stack}
      </>
    );
  }
  return (
    <>
      <Workspace
        key={`${source.key}#${String(nonce)}`}
        source={source}
        data={data}
        onSelect={setSelected}
        onReload={reload}
        onWritten={afterWrite}
        onUnavailable={markUnavailable}
        notify={notify}
      />
      {stack}
    </>
  );
}
