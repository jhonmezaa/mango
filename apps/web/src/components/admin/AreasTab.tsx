import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { adminErrorKey, apiErrorCode, isStaleDataError } from '../../api/adminErrors';
import type { BusinessUnits, Organization, PendingChange, Units } from '../../api/adminSchemas';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import {
  MAX_AREAS,
  MAX_OUS_PER_AREA,
  MAX_PENDING,
  isExpired,
  ousOf,
  ouTree,
  unitsToMap,
  type OuNode,
} from '../../lib/businessUnits';
import { Check2Icon, ExternalIcon, OrgIcon, PlusIcon } from '../icons';
import { ApproveModal, RejectModal, WithdrawModal, type DialogError } from './ChangeModals';
import { Banner, Empty, GovErrorState, Reason, Skel } from './govKit';
import type { ToastTone } from './useToasts';
import { OuChip } from './OuChip';
import { ProposalCard } from './ProposalCard';
import { ProposeModal } from './ProposeModal';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; units: BusinessUnits; organization: Organization | null }
  | { kind: 'error'; forbidden: boolean };

type Dialog =
  // The mapping the editor was opened on: a later background refresh must not move the base
  // version under the draft (TM-A4), or a resend could revert a change approved meanwhile.
  | { kind: 'propose'; base: BusinessUnits }
  | { kind: 'approve'; change: PendingChange }
  | { kind: 'reject'; change: PendingChange }
  | { kind: 'withdraw'; change: PendingChange }
  | null;

type Action = 'propose' | 'approve' | 'reject' | 'withdraw';

const MINUTE = 60_000;

interface Props {
  notify: (msg: string, tone?: ToastTone) => void;
  onForbidden: () => void;
}

/**
 * Settings › Áreas y OUs (design gov/areas.jsx): current mapping, pending proposals and the
 * two-person workflow (D17, TM-A1). The organization tree is optional: without it the mapping is
 * shown with raw OU IDs and new OUs are typed by ID.
 */
export function AreasTab({ notify, onForbidden }: Props) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const sheet = useMediaQuery('(max-width: 720px)');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<DialogError | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, MINUTE);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([api.getBusinessUnits(), api.getOrganization()]).then(
      ([units, organization]) => {
        if (cancelled) return;
        if (units.status === 'rejected') {
          const error: unknown = units.reason;
          const forbidden = error instanceof ApiError && error.status === 403;
          if (forbidden) onForbidden();
          setState({ kind: 'error', forbidden });
          return;
        }
        setState((previous) => ({
          kind: 'ready',
          units: units.value,
          // A background refresh keeps the tree if only the tree call failed this time.
          organization:
            organization.status === 'fulfilled'
              ? organization.value
              : previous.kind === 'ready'
                ? previous.organization
                : null,
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, reloadToken, onForbidden]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);
  /** Reloads in the background, keeping the screen (and any open dialog). */
  const refresh = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const organization = state.kind === 'ready' ? state.organization : null;
  const nodes = useMemo(() => (organization ? ouTree(organization.ous) : null), [organization]);
  const tree = useMemo<ReadonlyMap<string, OuNode> | null>(
    () => (nodes ? new Map(nodes.map((node) => [node.id, node] as const)) : null),
    [nodes],
  );

  const closeDialog = () => {
    setDialog(null);
    setDialogError(null);
  };

  /** Server refusal → message in the dialog (design error banners). The UI never decides. */
  const dialogErrorFor = (action: Action, error: unknown): DialogError => {
    const code = apiErrorCode(error);
    if (code === 'audit_unavailable') {
      return {
        title: t('settings.areas.errors.audit'),
        body: t(`settings.areas.errors.auditBody.${action}`),
      };
    }
    if (action === 'propose' && code === 'unknown_ou') {
      return {
        title: t('settings.areas.errors.unknownOu'),
        body: t('settings.areas.errors.unknownOuBody'),
      };
    }
    if (isStaleDataError(error)) {
      if (action === 'approve' && error instanceof ApiError && error.status === 410) {
        return { title: t('admin.errors.expired'), lock: true };
      }
      return {
        title: t('settings.areas.errors.conflict'),
        body: t(`settings.areas.errors.conflictBody.${action}`),
        // Every action is locked: a proposal must be redone on the current version (TM-A4).
        lock: true,
      };
    }
    return { title: t(adminErrorKey(error)) };
  };

  const run = async (action: Action, write: () => Promise<BusinessUnits | null>, done: string) => {
    setBusy(true);
    setDialogError(null);
    try {
      const updated = await write();
      setDialog(null);
      if (updated) {
        setState((previous) =>
          previous.kind === 'ready' ? { ...previous, units: updated } : previous,
        );
      } else {
        refresh();
      }
      notify(done);
    } catch (error) {
      setDialogError(dialogErrorFor(action, error));
      if (isStaleDataError(error)) refresh();
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === 'loading') return <AreasSkeleton />;
  if (state.kind === 'error') {
    if (state.forbidden) return null;
    return (
      <GovErrorState
        title={t('settings.areas.loadError')}
        body={t('settings.areas.loadErrorBody')}
        onRetry={retry}
      />
    );
  }

  const { units } = state;
  const areas = [...unitsToMap(units.units).keys()];
  const pending = units.pending.filter((change) => !isExpired(change, now)).length;
  const blocked = pending >= MAX_PENDING;
  const openPropose = () => {
    setDialogError(null);
    setDialog({ kind: 'propose', base: units });
  };

  return (
    <>
      {!tree && (
        <div className="mb-5">
          <Banner tone="warn" title={t('settings.areas.noOrg')}>
            {t('settings.areas.noOrgBody')}
          </Banner>
        </div>
      )}

      <section className="g-sec mt-0" aria-labelledby="areas-current">
        <div className="g-sec-h">
          <div>
            <h2 id="areas-current" className="g-sec-t">
              {t('settings.areas.current')}
            </h2>
            <div className="g-sec-meta">
              {t('settings.areas.currentMeta', {
                version: units.version,
                count: areas.length,
                max: MAX_AREAS,
              })}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void navigate('/audit?cat=config')}
            >
              {t('settings.areas.history')}
              <ExternalIcon size={11} />
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={blocked || busy}
              aria-describedby={blocked ? 'why-propose' : undefined}
              onClick={openPropose}
            >
              <PlusIcon size={12} />
              {t('settings.areas.propose')}
            </button>
          </div>
        </div>
        {blocked && (
          <div className="-mt-0.5 mb-2.5">
            <Reason id="why-propose">{t('settings.areas.tooMany', { max: MAX_PENDING })}</Reason>
          </div>
        )}
        <div className="g-card">
          {areas.length === 0 ? (
            <Empty
              icon={OrgIcon}
              title={t('settings.areas.empty')}
              action={
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={blocked}
                  onClick={openPropose}
                >
                  <PlusIcon size={12} />
                  {t('settings.areas.proposeFirst')}
                </button>
              }
            >
              {t('settings.areas.emptyBody')}
            </Empty>
          ) : (
            <>
              <div className="g-thead g-mcols" aria-hidden="true">
                <span>{t('settings.areas.colArea')}</span>
                <span>{t('settings.areas.colOus')}</span>
                <span />
              </div>
              <ul className="m-0 list-none p-0" aria-label={t('settings.areas.current')}>
                {areas.map((area) => {
                  const ous = ousOf(units.units, area);
                  return (
                    <li key={area} className="g-tr m g-mcols">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="g-area">{area}</span>
                        {area === me.business_unit && (
                          <span className="badge badge-accent">{t('settings.areas.yourArea')}</span>
                        )}
                      </div>
                      <div className="g-chips">
                        {ous.map((id) => (
                          <OuChip key={id} id={id} tree={tree} />
                        ))}
                      </div>
                      <div className="g-sub g-num c-count">
                        {t('settings.areas.ofMax', { count: ous.length, max: MAX_OUS_PER_AREA })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </section>

      <section className="g-sec" aria-labelledby="areas-pending">
        <div className="g-sec-h">
          <div>
            <h2 id="areas-pending" className="g-sec-t">
              {t('settings.areas.pending')}
            </h2>
            <div className="g-sec-meta">
              {t('settings.areas.pendingMeta', { count: pending, max: MAX_PENDING })}
            </div>
          </div>
        </div>
        {units.pending.length === 0 ? (
          <div className="g-card">
            <Empty icon={Check2Icon} title={t('settings.areas.noPending')}>
              {t('settings.areas.noPendingBody')}
            </Empty>
          </div>
        ) : (
          <div className="g-props">
            {units.pending.map((change) => (
              <ProposalCard
                key={change.change_id}
                change={change}
                current={units.units}
                currentVersion={units.version}
                tree={tree}
                meId={me.user_id}
                myArea={me.business_unit}
                busy={busy}
                now={now}
                onApprove={() => {
                  setDialogError(null);
                  setDialog({ kind: 'approve', change });
                }}
                onReject={() => {
                  setDialogError(null);
                  setDialog({ kind: 'reject', change });
                }}
                onWithdraw={() => {
                  setDialogError(null);
                  setDialog({ kind: 'withdraw', change });
                }}
              />
            ))}
          </div>
        )}
      </section>

      {dialog?.kind === 'propose' && (
        <ProposeModal
          current={dialog.base.units}
          version={dialog.base.version}
          tree={tree}
          nodes={nodes}
          myArea={me.business_unit}
          busy={busy}
          error={dialogError}
          sheet={sheet}
          onClose={closeDialog}
          onSubmit={(next: Units, reason: string) =>
            void run(
              'propose',
              async () => {
                await api.proposeBusinessUnits({
                  base_version: dialog.base.version,
                  units: next,
                  reason,
                });
                return null;
              },
              t('settings.areas.toast.proposed'),
            )
          }
        />
      )}
      {dialog?.kind === 'approve' && (
        <ApproveModal
          change={dialog.change}
          current={units.units}
          currentVersion={units.version}
          tree={tree}
          busy={busy}
          error={dialogError}
          sheet={sheet}
          onClose={closeDialog}
          onApprove={() =>
            void run(
              'approve',
              () => api.approveBusinessUnitChange(dialog.change.change_id),
              t('settings.areas.toast.approved', { version: units.version + 1 }),
            )
          }
        />
      )}
      {dialog?.kind === 'reject' && (
        <RejectModal
          change={dialog.change}
          busy={busy}
          error={dialogError}
          sheet={sheet}
          onClose={closeDialog}
          onReject={(reason) =>
            void run(
              'reject',
              () => api.rejectBusinessUnitChange(dialog.change.change_id, reason),
              t('settings.areas.toast.rejected'),
            )
          }
        />
      )}
      {dialog?.kind === 'withdraw' && (
        <WithdrawModal
          change={dialog.change}
          current={units.units}
          tree={tree}
          busy={busy}
          error={dialogError}
          onClose={closeDialog}
          onWithdraw={() =>
            void run(
              'withdraw',
              () => api.withdrawBusinessUnitChange(dialog.change.change_id),
              t('settings.areas.toast.withdrawn'),
            )
          }
        />
      )}
    </>
  );
}

function AreasSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" aria-label={t('settings.areas.loading')}>
      <Skel w={140} h={14} />
      <Skel w={320} h={10} className="mt-2 mb-3.5" />
      <div className="g-card">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="g-tr m g-mcols">
            <Skel w={90} />
            <div className="flex gap-2">
              <Skel w={180} h={22} />
              <Skel w={150} h={22} />
            </div>
            <span />
          </div>
        ))}
      </div>
      <div className="g-card mt-8 p-5">
        <Skel w="40%" />
        <Skel w="60%" h={10} className="mt-2.5" />
        <Skel w="30%" h={22} className="mt-4" />
      </div>
    </div>
  );
}
