import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Units } from '../../api/adminSchemas';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { GovErrorState, Skel } from '../../components/admin/govKit';
import type { ToastTone } from '../../components/admin/useToasts';
import { EditIcon, LockIcon, PlusIcon, SearchIcon } from '../../components/icons';
import { unitsToMap } from '../../lib/businessUnits';
import { decisionErrorKey, groupErrorKey } from './errors';
import { GroupChangeList } from './GroupChangeList';
import { GroupModal } from './GroupModal';
import {
  CHANGE_TTL_HOURS,
  TYPE_BADGE,
  TYPE_FILTERS,
  countByType,
  filterGroups,
  pendingByGroup,
  type Group,
  type GroupChange,
  type GroupsAdmin,
  type Proposal,
  type TypeFilter,
} from './model';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: GroupsAdmin; units: Units | null }
  | { kind: 'error' };

/** `null`: closed; `'new'`: a new group; otherwise the group being edited. */
type Editing = Group | 'new' | null;

interface Props {
  notify: (message: string, tone?: ToastTone) => void;
  onForbidden: () => void;
  /** Opens Áreas y OUs (the link of an area group whose area is missing). */
  onGoAreas: () => void;
}

/**
 * Ajustes › Grupos (design groups-admin.jsx): the access groups with their type, and the
 * requests to create, change or delete one (D26: one administrator proposes, another approves).
 * The API authorizes and validates every call (`ProposeGroups`, `ApproveGroups`); what is
 * disabled here is only UX. The number of members is "—": mango-api does not read the
 * directory's membership.
 */
export function GroupsTab({ notify, onForbidden, onGoAreas }: Props) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [editing, setEditing] = useState<Editing>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Independent requests: the areas only feed the select of an area group.
    void Promise.allSettled([
      api.call('getAdminGroups', {}, { signal: controller.signal }),
      api.getBusinessUnits(),
    ]).then(([groups, units]) => {
      if (controller.signal.aborted) return;
      if (groups.status === 'rejected') {
        const error: unknown = groups.reason;
        if (error instanceof ApiError && error.status === 403) onForbidden();
        setState({ kind: 'error' });
        return;
      }
      setState((previous) => ({
        kind: 'ready',
        data: groups.value,
        units:
          units.status === 'fulfilled'
            ? units.value.units
            : previous.kind === 'ready'
              ? previous.units
              : null,
      }));
    });
    return () => {
      controller.abort();
    };
  }, [api, reloadToken, onForbidden]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);
  /** Reloads in the background, keeping the screen. */
  const refresh = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const data = state.kind === 'ready' ? state.data : null;
  const units = state.kind === 'ready' ? state.units : null;
  const groups = useMemo(() => data?.items ?? [], [data]);
  const changes = useMemo(() => data?.changes ?? [], [data]);
  const pending = useMemo(() => pendingByGroup(changes), [changes]);
  const counts = useMemo(() => countByType(groups), [groups]);
  const areas = useMemo(
    () =>
      new Map(
        units ? [...unitsToMap(units)].map(([area, ous]) => [area, ous.length] as const) : [],
      ),
    [units],
  );
  const taken = useMemo(
    () => new Set([...groups.map((group) => group.id), ...pending.keys()]),
    [groups, pending],
  );

  if (state.kind === 'loading') return <GroupsSkeleton />;
  if (state.kind === 'error') {
    return (
      <GovErrorState
        title={t('groups.loadError')}
        body={t('groups.loadErrorBody')}
        onRetry={retry}
      />
    );
  }

  const listed = filterGroups(groups, type, query);
  const pendingNew = changes.filter(
    (change) => change.kind === 'create' && change.status === 'pending',
  );

  const propose = async (proposal: Proposal): Promise<string | null> => {
    try {
      await api.call('postGroupChange', { body: proposal });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) refresh();
      return t(groupErrorKey(error));
    }
    refresh();
    notify(t('groups.toast.proposed'));
    return null;
  };

  const saveDescription = async (group: Group, description: string): Promise<string | null> => {
    try {
      const updated = await api.call('putGroupDescription', {
        path: { group_id: group.id },
        body: { version: group.version, description },
      });
      setState((previous) =>
        previous.kind === 'ready' ? { ...previous, data: updated } : previous,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) refresh();
      return t(groupErrorKey(error));
    }
    notify(t('groups.toast.description'));
    return null;
  };

  const decide = async (action: () => Promise<GroupsAdmin>): Promise<boolean> => {
    setDecisionError(null);
    try {
      const updated = await action();
      setState((previous) =>
        previous.kind === 'ready' ? { ...previous, data: updated } : previous,
      );
      return true;
    } catch (error) {
      setDecisionError(t(decisionErrorKey(error)));
      if (error instanceof ApiError && (error.status === 409 || error.status === 410)) refresh();
      return false;
    }
  };
  const path = (change: GroupChange) => ({ change_id: change.change_id });

  return (
    <section aria-labelledby="groups-title">
      <div className="g-sec-h gr-head mb-3">
        <div>
          <h2 id="groups-title" className="g-sec-t">
            {t('groups.title')}
          </h2>
          <div className="g-sec-meta">{t('groups.desc', { hours: CHANGE_TTL_HOURS })}</div>
        </div>
        {me.is_admin ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              setEditing('new');
            }}
          >
            <PlusIcon size={12} />
            {t('groups.create')}
          </button>
        ) : null}
      </div>
      <div className="gr-toolbar">
        <div className="search-wrap gr-search">
          <SearchIcon size={13} />
          <input
            className="input"
            type="search"
            value={query}
            placeholder={t('groups.searchPlaceholder')}
            aria-label={t('groups.searchLabel')}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <div className="tk-quick" role="group" aria-label={t('groups.typeFilter')}>
          {TYPE_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={type === key ? 'is-on' : ''}
              aria-pressed={type === key}
              onClick={() => {
                setType(key);
              }}
            >
              {t(`groups.filters.${key}`)}
              <span className="mk-count">{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="card gr-table">
        <div className="gr-tr mc-th" aria-hidden="true">
          <span>{t('groups.cols.group')}</span>
          <span>{t('groups.cols.type')}</span>
          <span>{t('groups.cols.area')}</span>
          <span>{t('groups.cols.members')}</span>
          <span>{t('groups.cols.agents')}</span>
          <span />
        </div>
        <ul className="m-0 list-none p-0" aria-label={t('groups.title')}>
          {listed.map((group) => {
            const open = pending.get(group.id);
            return (
              <li key={group.id} className="gr-tr">
                <span className="min-w-0">
                  <span className="mono gr-id">{group.id}</span>
                  {open ? (
                    <span className="badge badge-amber">
                      {open.kind === 'delete'
                        ? t('groups.pendingDelete')
                        : t('groups.pendingChange')}
                    </span>
                  ) : null}
                  <span className="mk-meta gr-desc">{group.description || '—'}</span>
                </span>
                <span>
                  <span
                    className={`badge ${TYPE_BADGE[group.type]}`}
                    title={t(`groups.typeHints.${group.type}`)}
                  >
                    {t(`groups.types.${group.type}`)}
                  </span>
                </span>
                <span className={group.area ? 'mono gr-area' : 'mk-meta'}>{group.area ?? '—'}</span>
                <span className="mk-meta" title={t('groups.noMembers')}>
                  —
                </span>
                <span className="mk-meta">{group.agents.length || '—'}</span>
                <span className="flex justify-end">
                  {me.is_admin ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      aria-label={t('groups.edit', { id: group.id })}
                      disabled={Boolean(open)}
                      title={open ? t('groups.editPending') : t('groups.editTitle')}
                      onClick={() => {
                        setEditing(group);
                      }}
                    >
                      <EditIcon size={12} />
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
          {pendingNew.map((change) => (
            <li key={change.change_id} className="gr-tr is-pending">
              <span className="min-w-0">
                <span className="mono gr-id">{change.group_id}</span>
                <span className="badge badge-amber">{t('groups.pendingCreate')}</span>
                <span className="mk-meta gr-desc">{change.after?.description || '—'}</span>
              </span>
              <span>
                {change.after ? (
                  <span className={`badge ${TYPE_BADGE[change.after.type]}`}>
                    {t(`groups.types.${change.after.type}`)}
                  </span>
                ) : null}
              </span>
              <span className="mono gr-area">{change.after?.area ?? '—'}</span>
              <span className="mk-meta">—</span>
              <span className="mk-meta">—</span>
              <span />
            </li>
          ))}
        </ul>
        {listed.length === 0 && pendingNew.length === 0 ? (
          <div className="mk-meta gr-empty">{t('groups.none')}</div>
        ) : null}
      </div>
      <GroupChangeList
        changes={changes}
        me={me}
        error={decisionError}
        onWithdraw={(change) =>
          decide(() => api.call('withdrawGroupChange', { path: path(change), body: {} }))
        }
        onApprove={(change) =>
          decide(() => api.call('approveGroupChange', { path: path(change), body: {} }))
        }
        onReject={(change, reason) =>
          decide(() => api.call('rejectGroupChange', { path: path(change), body: { reason } }))
        }
      />
      {me.is_admin ? null : (
        <div className="ap-reason mt-2.5">
          <LockIcon size={12} />
          {t('groups.adminsOnly')}
        </div>
      )}
      {editing ? (
        <GroupModal
          // A new dialog per group: its draft never outlives the group it was opened on.
          key={editing === 'new' ? 'new' : editing.id}
          group={editing === 'new' ? null : editing}
          taken={taken}
          ownGroups={me.groups}
          areas={areas}
          onClose={() => {
            setEditing(null);
          }}
          onGoAreas={() => {
            setEditing(null);
            onGoAreas();
          }}
          onPropose={propose}
          onSaveDescription={saveDescription}
        />
      ) : null}
    </section>
  );
}

function GroupsSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" aria-label={t('groups.loading')}>
      <Skel w={140} h={14} />
      <Skel w={320} h={10} className="mt-2 mb-3.5" />
      <div className="card gr-table">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="gr-tr">
            <Skel w={140} />
            <Skel w={70} h={20} />
            <Skel w={60} />
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}
