import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../api/errors';
import type { MfaReset } from '../../api/mfaResetSchemas';
import { useSession } from '../../auth/useSession';
import { MfaResetList } from '../../components/account/MfaResetList';
import { Skel } from '../../components/admin/govKit';
import type { ToastTone } from '../../components/admin/useToasts';
import { ChevronRightIcon, InfoIcon, PlusIcon, SearchIcon } from '../../components/icons';
import { PersonChip } from '../../components/PersonChip';
import { unitsToMap } from '../../lib/businessUnits';
import type { GroupsAdmin } from '../settingsGroups/model';
import { decisionErrorKey, inviteServerError, type InviteServerError } from './errors';
import { FirstDay } from './FirstDay';
import { InviteModal } from './InviteModal';
import { MemberChangeList } from './MemberChangeList';
import {
  ADMIN_GROUP,
  FILTERS,
  SYSTEM_GROUPS,
  formatJoined,
  groupOptions,
  hasFirstDaySteps,
  isExternal,
  isSelf,
  pendingOf,
  searchPrefix,
  type ActionResult,
  type ListFilter,
  type MemberChange,
  type People,
  type Person,
} from './model';
import { PersonPanel, type PersonActions } from './PersonPanel';
import { PersonStatusBadge } from './PersonStatus';

const SEARCH_DEBOUNCE_MS = 300;
/**
 * After `busy` the list is read at once and again after this long: the other change of
 * administrators is still being applied, so the first read may still show it pending.
 */
const BUSY_REREAD_MS = 3000;
const NO_PEOPLE: readonly Person[] = [];
const NO_CHANGES: readonly MemberChange[] = [];
const NO_RESETS: readonly MfaReset[] = [];

/** One search of the directory: the first page with its counters, and the pages added to it. */
interface Listing {
  /** Filter and prefix it answers; another one on screen means it is still loading. */
  key: string;
  /** `null`: the directory could not be read. */
  data: People | null;
  items: readonly Person[];
  nextCursor: string | null;
}

interface Props {
  notify: (message: string, tone?: ToastTone) => void;
  onForbidden: () => void;
  onGoTab: (tab: 'areas' | 'groups') => void;
}

/**
 * Ajustes › Personas (design people.jsx): the directory, the groups of each person, invitations
 * and access. Only administrators reach it and the API authorizes every call (`ViewPeople`,
 * `ManagePeople`, `ApprovePeopleChange`); what is disabled here is only UX. The search prefix
 * travels in the body of a POST, never in a URL. Emails, groups and reasons are API data,
 * rendered as text.
 */
export function PeopleTab({ notify, onForbidden, onGoTab }: Props) {
  const { t } = useTranslation();
  const { api, me, config } = useSession();
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [filter, setFilter] = useState<ListFilter>('all');
  const [listing, setListing] = useState<Listing | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [changes, setChanges] = useState<readonly MemberChange[]>(NO_CHANGES);
  const [resets, setResets] = useState<readonly MfaReset[]>(NO_RESETS);
  const [resetsError, setResetsError] = useState(false);
  const [registry, setRegistry] = useState<GroupsAdmin['items'] | null>(null);
  const [areas, setAreas] = useState<number | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // The person whose panel is open, as last seen: it may leave the page that is listed.
  const [open, setOpen] = useState<Person | null>(null);
  const [invite, setInvite] = useState<readonly string[] | null>(null);

  // The directory is asked once the typing stops, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearched(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  const prefix = searchPrefix(searched);
  const key = `${filter} ${prefix ?? ''}`;

  useEffect(() => {
    // What was typed cannot start any email: nothing is asked and the list is empty.
    if (prefix === undefined) return;
    const controller = new AbortController();
    api.call('searchPeople', { body: { prefix, filter } }, { signal: controller.signal }).then(
      (data) => {
        if (controller.signal.aborted) return;
        setListing({ key, data, items: data.items, nextCursor: data.next_cursor });
        setMore('idle');
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 403) onForbidden();
        setListing({ key, data: null, items: NO_PEOPLE, nextCursor: null });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, prefix, filter, key, refreshToken, onForbidden]);

  // The changes waiting for a second administrator and the MFA resets, with every refresh.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      api.call('getMemberChanges', {}, { signal: controller.signal }),
      api.listMfaResets(),
    ]).then(([memberChanges, mfaResets]) => {
      if (controller.signal.aborted) return;
      if (memberChanges.status === 'fulfilled') setChanges(memberChanges.value.items);
      setResetsError(mfaResets.status === 'rejected');
      if (mfaResets.status === 'fulfilled') setResets(mfaResets.value);
    });
    return () => {
      controller.abort();
    };
  }, [api, refreshToken]);

  // The groups a person can be given and the areas: independent requests, read once.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      api.call('getAdminGroups', {}, { signal: controller.signal }),
      api.getBusinessUnits(),
    ]).then(([groups, units]) => {
      if (controller.signal.aborted) return;
      if (groups.status === 'fulfilled') setRegistry(groups.value.items);
      if (units.status === 'fulfilled') setAreas(unitsToMap(units.value.units).size);
    });
    return () => {
      controller.abort();
    };
  }, [api]);

  /** Reads everything again in the background, keeping the screen. */
  const refresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);
  const rereadTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (rereadTimer.current !== null) window.clearTimeout(rereadTimer.current);
    },
    [],
  );
  const retry = () => {
    setListing(null);
    refresh();
  };
  const options = useMemo(() => groupOptions(registry), [registry]);
  const pendingCount = useMemo(() => {
    const counts = new Map<string, number>();
    const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const change of changes) if (change.status === 'pending') bump(change.target_user);
    for (const reset of resets) {
      if (reset.status === 'pending' && reset.target_email) bump(reset.target_email);
    }
    return counts;
  }, [changes, resets]);

  const current = prefix === undefined ? null : listing?.key === key ? listing : null;
  const loading = prefix !== undefined && current === null;
  const failed = current !== null && current.data === null;
  const rows = current?.items ?? NO_PEOPLE;
  // The counters are of the whole directory: the last answer stands while another loads.
  const totals = listing?.data ?? null;
  const waiting = totals?.pending ?? 0;
  const ownGroups = registry
    ? registry.filter((group) => !SYSTEM_GROUPS.includes(group.id)).length
    : null;
  const facts = totals
    ? { admins: totals.admins, withAccess: totals.with_access, areas, ownGroups }
    : null;
  const shown = open ? (rows.find((person) => person.user_id === open.user_id) ?? open) : null;

  const loadMore = () => {
    if (!current?.nextCursor || prefix === undefined) return;
    setMore('loading');
    api.call('searchPeople', { body: { prefix, filter, cursor: current.nextCursor } }).then(
      (page) => {
        setMore('idle');
        // Added only to the search it continues; another one on screen drops the page.
        setListing((previous) =>
          previous?.key === key
            ? {
                ...previous,
                items: [...previous.items, ...page.items],
                nextCursor: page.next_cursor,
              }
            : previous,
        );
      },
      () => {
        setMore('error');
      },
    );
  };

  /** Shows a change the API applied at once, before the directory is read again. */
  const patch = (userId: string, change: (person: Person) => Person) => {
    setListing((previous) =>
      previous
        ? {
            ...previous,
            items: previous.items.map((person) =>
              person.user_id === userId ? change(person) : person,
            ),
          }
        : previous,
    );
    setOpen((previous) => (previous?.user_id === userId ? change(previous) : previous));
  };

  /**
   * One change on a person. The API answers whether it was applied or proposed: the toast and
   * the screen follow that answer, never the labels of the panel.
   */
  const changePerson = async (
    request: () => Promise<{ result: ActionResult }>,
    person: Person,
    applied: string,
    change: (person: Person) => Person,
  ) => {
    try {
      const { result } = await request();
      if (result === 'proposed') notify(t('people.toast.proposed'));
      else {
        notify(applied);
        patch(person.user_id, change);
      }
    } catch (error) {
      // The person or the change moved meanwhile: what is on screen is stale.
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) refresh();
      throw error;
    }
    refresh();
  };

  const actionsFor = (person: Person): PersonActions => {
    const path = { user_id: person.user_id };
    return {
      addGroup: (group, reason) =>
        changePerson(
          () => api.call('addGroup', { path, body: { group, reason } }),
          person,
          t('people.toast.groupAdded'),
          (previous) => ({ ...previous, groups: [...previous.groups, group].sort() }),
        ),
      removeGroup: (group, reason) =>
        changePerson(
          () => api.call('removeGroup', { path, body: { group, reason } }),
          person,
          t('people.toast.groupRemoved'),
          (previous) => ({
            ...previous,
            groups: previous.groups.filter((other) => other !== group),
          }),
        ),
      disable: (reason) =>
        changePerson(
          () => api.call('disablePerson', { path, body: { reason } }),
          person,
          t('people.toast.disabled'),
          (previous) => ({ ...previous, status: 'disabled' }),
        ),
      enable: (reason) =>
        changePerson(
          () => api.call('enablePerson', { path, body: { reason } }),
          person,
          t('people.toast.enabled'),
          // Invited or active is the directory's to say: the refresh brings it.
          (previous) => ({ ...previous, status: 'active' }),
        ),
      resetMfa: async (reason) => {
        await api.proposeMfaReset(person.email, reason, true);
        notify(t('people.toast.mfaProposed'));
        refresh();
      },
    };
  };

  const sendInvite = async (
    email: string,
    groups: string[],
  ): Promise<InviteServerError | 'failed' | null> => {
    try {
      await api.call('invitePerson', { body: { email, groups } });
    } catch (error) {
      return inviteServerError(error) ?? 'failed';
    }
    notify(t('people.toast.invited'));
    refresh();
    return null;
  };

  const decide = async (
    action: () => Promise<{ items: MemberChange[] }>,
    approving?: MemberChange,
  ): Promise<boolean> => {
    setDecisionError(null);
    try {
      setChanges((await action()).items);
    } catch (error) {
      setDecisionError(
        t(decisionErrorKey(error, approving !== undefined), {
          id: approving?.change_id.slice(0, 8) ?? '',
          group: approving?.group ?? '',
        }),
      );
      // What is on screen is stale: the change was decided, another one is being applied, or
      // its person is gone. The list is read again and the error stays visible (design).
      const stale =
        error instanceof ApiError &&
        (error.status === 409 || error.status === 410 || error.code === 'user_not_found');
      if (stale) refresh();
      if (error instanceof ApiError && error.code === 'busy') {
        if (rereadTimer.current !== null) window.clearTimeout(rereadTimer.current);
        rereadTimer.current = window.setTimeout(refresh, BUSY_REREAD_MS);
      }
      return false;
    }
    refresh();
    return true;
  };
  const changePath = (change: MemberChange) => ({ change_id: change.change_id });

  return (
    <section aria-labelledby="people-title">
      {facts && hasFirstDaySteps(facts) ? (
        <FirstDay
          {...facts}
          waiting={waiting}
          domains={config.signUpDomains}
          onInviteAdmin={() => {
            setInvite([ADMIN_GROUP]);
          }}
          onShowWaiting={() => {
            setFilter('pending');
          }}
          onGoTab={onGoTab}
        />
      ) : null}
      <div className="g-sec-h pp-head mb-3">
        <div>
          <h2 id="people-title" className="g-sec-t">
            {t('people.title')}
          </h2>
          <div className="g-sec-meta">
            {t('people.desc.lead')} <span className="mono">mango-admin</span> {t('people.desc.or')}{' '}
            <span className="mono">finops-central</span> {t('people.desc.tail')}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!totals}
          onClick={() => {
            setInvite([]);
          }}
        >
          <PlusIcon size={12} />
          {t('people.invite')}
        </button>
      </div>
      {totals?.incomplete ? (
        <div className="pp-pending" role="status">
          <InfoIcon size={14} />
          <div>{t('people.incomplete')}</div>
        </div>
      ) : null}
      {waiting > 0 && filter !== 'pending' && !loading && !failed ? (
        <div className="pp-pending" role="status">
          <InfoIcon size={14} />
          <div>
            <b>{t('people.waiting.lead', { count: waiting })}</b> {t('people.waiting.body')}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setFilter('pending');
            }}
          >
            {t('people.waiting.show')}
          </button>
        </div>
      ) : null}
      <div className="pp-toolbar">
        <div className="search-wrap pp-search">
          <SearchIcon size={13} />
          <input
            className="input"
            type="search"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={query}
            placeholder={t('people.searchPlaceholder')}
            aria-label={t('people.searchLabel')}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <div className="tk-quick" role="group" aria-label={t('people.filterLabel')}>
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'is-on' : ''}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
              }}
            >
              {t(`people.filters.${value}`)}
              {value === 'pending' && waiting > 0 ? (
                <span className="mk-count">{waiting}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      {failed ? (
        <div className="g-err pp-load-error" role="alert">
          {t('people.loadError')}
          <button type="button" className="btn btn-sm" onClick={retry}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <div className="card pp-table">
          <div className="pp-tr mc-th" aria-hidden="true">
            <span>{t('people.cols.person')}</span>
            <span>{t('people.cols.status')}</span>
            <span>{t('people.cols.mfa')}</span>
            <span>{t('people.cols.groups')}</span>
            <span>{t('people.cols.created')}</span>
            <span />
          </div>
          {loading ? (
            <div role="status" aria-label={t('people.loading')}>
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="pp-tr">
                  <Skel w="70%" h={14} />
                  <Skel h={14} />
                  <Skel h={14} />
                  <Skel h={14} />
                  <Skel h={14} />
                  <span />
                </div>
              ))}
            </div>
          ) : (
            <ul className="m-0 list-none p-0" aria-label={t('people.listLabel')}>
              {rows.map((person) => {
                const waitingChanges =
                  (pendingCount.get(person.user_id) ?? 0) + (pendingCount.get(person.email) ?? 0);
                return (
                  <li key={person.user_id}>
                    <button
                      type="button"
                      className="pp-tr pp-row"
                      aria-label={t('people.manage', { email: person.email })}
                      onClick={() => {
                        setOpen(person);
                      }}
                    >
                      <span className="pp-person">
                        <PersonChip email={person.email} you={isSelf(me, person)} />
                        {isExternal(person.email, config.signUpDomains) ? (
                          <span className="badge" title={t('people.externalTitle')}>
                            {t('people.external')}
                          </span>
                        ) : null}
                        {waitingChanges > 0 ? (
                          <span className="badge badge-amber">
                            {t('people.pendingChanges', { count: waitingChanges })}
                          </span>
                        ) : null}
                      </span>
                      <span>
                        <PersonStatusBadge person={person} />
                      </span>
                      <span className="mk-meta">
                        {person.mfa ? t('people.mfa.registered') : t('people.mfa.missing')}
                      </span>
                      <span className="pp-groups">
                        {person.groups.length > 0 ? (
                          <>
                            {person.groups.slice(0, 2).map((group) => (
                              <span key={group} className="pp-g mono">
                                {group}
                              </span>
                            ))}
                            {person.groups.length > 2 ? (
                              <span className="mk-meta">+{person.groups.length - 2}</span>
                            ) : null}
                          </>
                        ) : (
                          <span className="mk-meta">{t('people.noGroups')}</span>
                        )}
                      </span>
                      <span className="mk-meta">{formatJoined(person.created_at)}</span>
                      <span className="pp-chevron">
                        <ChevronRightIcon size={14} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {!loading && rows.length === 0 ? (
            <div className="mk-meta pp-empty">
              {searched.trim()
                ? t('people.empty.search', { query: searched.trim().toLowerCase() })
                : filter === 'pending'
                  ? t('people.empty.pending')
                  : t('people.empty.other')}
            </div>
          ) : null}
        </div>
      )}
      {current?.nextCursor ? (
        <div className="pp-more">
          {more === 'error' ? (
            <div className="g-err" role="alert">
              {t('people.moreError')}
            </div>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            disabled={more === 'loading'}
            onClick={loadMore}
          >
            {more === 'loading' ? t('people.loadingMore') : t('people.more')}
          </button>
        </div>
      ) : null}
      <MemberChangeList
        changes={changes}
        me={me}
        error={decisionError}
        onWithdraw={(change) =>
          decide(() => api.call('withdrawMemberChange', { path: changePath(change), body: {} }))
        }
        onApprove={(change) =>
          decide(
            () => api.call('approveMemberChange', { path: changePath(change), body: {} }),
            change,
          )
        }
        onReject={(change, reason) =>
          decide(() =>
            api.call('rejectMemberChange', { path: changePath(change), body: { reason } }),
          )
        }
      />
      <MfaResetList
        api={api}
        me={me}
        items={resets}
        listError={resetsError}
        onItems={(items) => {
          setResets(items);
          // An approved reset leaves the person without MFA: the directory is read again.
          refresh();
        }}
      />
      {shown ? (
        <PersonPanel
          // A new panel per person: its forms never outlive the person they were opened on.
          key={shown.user_id}
          person={shown}
          me={me}
          admins={totals?.admins ?? 0}
          options={options}
          external={isExternal(shown.email, config.signUpDomains)}
          pending={pendingOf(changes, shown.user_id)}
          mfaPending={resets.find(
            (reset) => reset.status === 'pending' && reset.target_email === shown.email,
          )}
          actions={actionsFor(shown)}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {invite && totals ? (
        <InviteModal
          preset={invite}
          admins={totals.admins}
          options={options}
          domains={config.signUpDomains}
          onClose={() => {
            setInvite(null);
          }}
          onInvite={sendInvite}
        />
      ) : null}
    </section>
  );
}
