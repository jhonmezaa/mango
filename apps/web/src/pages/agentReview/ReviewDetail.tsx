import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { Me } from '../../api/schemas';
import type { ToastTone } from '../../components/admin/useToasts';
import { Empty } from '../../components/admin/govKit';
import { Alert } from '../../components/Alert';
import { Badge } from '../../components/Badge';
import { CheckIcon, InfoIcon, LockIcon, RefreshIcon, WarnIcon } from '../../components/icons';
import {
  REASON_MAX_LENGTH,
  isGone,
  isKnownStatus,
  isStale,
  reviewErrorKey,
  ruleText,
  statusTone,
  type ReferenceData,
  type Review,
  type ReviewErrorKey,
  type Version,
} from './reviewModel';
import { VersionDiff } from './VersionDiff';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; error: ReviewErrorKey }
  | { kind: 'gone' }
  | { kind: 'ready'; version: Version };

/** Statuses a version of the queue can have; any other is no longer there to review. */
const REVIEWABLE = new Set(['in_review', 'approved']);

interface Props {
  api: ApiClient;
  me: Me;
  /** The row of the queue; the full version (definition, diff and rules) is loaded here. */
  review: Review;
  refs: ReferenceData;
  notify: (message: string, tone?: ToastTone) => void;
  /** A decision was applied, or the reviewer asked to refresh a stale queue: reload the lists. */
  onChanged: () => void;
}

/**
 * Detail of a version in review (design `ReviewDetail`): the diff against the published version
 * as the backend computed it, and the decision. `is_author` and `violations` only disable the
 * buttons: the API refuses the author's approval and applies the rules again.
 */
export function ReviewDetail({ api, me, review, refs, notify, onChanged }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReviewErrorKey | null>(null);
  // The approval was recorded but the publication did not start (design `pubStuck`).
  const [stuck, setStuck] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const { agent_id: agentId, version: number, status } = review;

  const load = useCallback(
    (signal?: AbortSignal) => {
      api
        .call(
          'readVersion',
          { path: { agent_id: agentId, version: number } },
          signal ? { signal } : {},
        )
        .then(
          (version) => {
            if (!signal?.aborted) setState({ kind: 'ready', version });
          },
          (cause: unknown) => {
            if (signal?.aborted) return;
            setState(
              isGone(cause) ? { kind: 'gone' } : { kind: 'error', error: reviewErrorKey(cause) },
            );
          },
        );
    },
    [api, agentId, number],
  );

  // Loads the version, and again when the list reports another status (e.g. it got published).
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, status]);

  // Design: "Rechazar" opens the reason with the focus already in it.
  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
  }, [rejecting]);

  if (state.kind === 'loading') {
    return (
      <p role="status" className="ap-state">
        <span className="g-spin" aria-hidden="true" />
        {t('agentReview.detail.loading')}
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="ap-state" role="alert">
        {t('agentReview.detail.loadError')} {t(state.error)}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setState({ kind: 'loading' });
            load();
          }}
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  // Design «ya no está en revisión»: somebody else decided it, or its author took it back. The
  // queue is only read again when the reviewer asks, so the explanation stays on screen.
  if (state.kind === 'gone' || (!stuck && !REVIEWABLE.has(state.version.status))) {
    return (
      <div className="ap-detail-b" role="status">
        <Empty
          icon={InfoIcon}
          title={t('agentReview.gone.title')}
          action={
            <button type="button" className="btn btn-sm" onClick={onChanged}>
              <RefreshIcon size={12} /> {t('agentReview.gone.refresh')}
            </button>
          }
        >
          {t('agentReview.gone.body')}
        </Empty>
      </div>
    );
  }

  const { version } = state;
  const name = version.definition.name;
  const violations = version.violations ?? [];
  // The rules could not be evaluated: nobody knows if the version meets them (design `uneval`).
  const uneval = version.violations === null;
  const mine = version.is_author;
  const hash = version.content_hash;
  const reasonMissing = tried && !reason.trim();

  const decide = (action: () => Promise<Version>, done: (result: Version) => void) => {
    setBusy(true);
    setError(null);
    action()
      .then(done, (cause: unknown) => {
        setError(reviewErrorKey(cause));
        // The rules the API refused the approval for are shown at once, before the reload.
        if (cause instanceof ApiError && cause.violations) {
          setState({ kind: 'ready', version: { ...version, violations: [...cause.violations] } });
        }
        // What the API has now: the new content, or a version that is no longer in review.
        if (isStale(cause)) load();
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const approve = () => {
    if (!hash) return;
    decide(
      () =>
        api.call('approveVersion', {
          path: { agent_id: agentId, version: number },
          // The hash the reviewer read: the API refuses it if the content is another one.
          body: { content_hash: hash },
        }),
      (result) => {
        setState({ kind: 'ready', version: result });
        if (result.status === 'failed') {
          // The notice stays in the foot; the lists are read again on the next action.
          setStuck(true);
          return;
        }
        notify(t('agentReview.toast.approved', { name }));
        onChanged();
      },
    );
  };

  const reject = () => {
    setTried(true);
    const text = reason.trim();
    if (!text) return;
    decide(
      () =>
        api.call('rejectVersion', {
          path: { agent_id: agentId, version: number },
          body: { reason: text },
        }),
      () => {
        notify(t('agentReview.toast.rejected', { name }), 'info');
        onChanged();
      },
    );
  };

  return (
    <>
      <div className="ap-detail-h">
        <span className="mono ap-detail-id">
          {t('agentReview.versionId', { agent: version.agent_id, version: version.version })}
        </span>
        <Badge tone={statusTone(version.status)}>
          {isKnownStatus(version.status)
            ? t(`agentReview.status.${version.status}`)
            : version.status}
        </Badge>
        <Badge>
          {version.diff.is_new ? t('agentReview.kind.new') : t('agentReview.kind.change')}
        </Badge>
      </div>
      <div className="ap-detail-b">
        <VersionDiff
          version={version}
          refs={refs}
          onReevaluate={() => {
            setState({ kind: 'loading' });
            load();
          }}
        />
      </div>
      <div className="ap-detail-f">
        {error && (
          <div className="g-err ap-error" role="alert">
            {t(error)}
          </div>
        )}
        {stuck ? (
          <Alert tone="amber" role="alert">
            <div className="ap-alert-t">{t('agentReview.stuck.title')}</div>
            <div className="ap-alert-i">{t('agentReview.stuck.body')}</div>
          </Alert>
        ) : version.status === 'approved' ? (
          <div className="ap-reason" role="status">
            <span className="g-spin" aria-hidden="true" />
            {t('agentReview.actions.publishing', {
              who:
                version.approved_by_email ??
                (version.approved_by === me.user_id ? me.email : null) ??
                version.approved_by ??
                t('agentReview.detail.none'),
            })}
          </div>
        ) : rejecting ? (
          <div className="ap-reject">
            <label htmlFor="rv-why">{t('agentReview.actions.reason')}</label>
            {violations.length > 0 && (
              <div className="rv-chips">
                {violations.map((violation) => {
                  const text = ruleText(t, violation);
                  return (
                    <button
                      key={`${violation.code}/${violation.field}`}
                      type="button"
                      className="tk-chip"
                      onClick={() => {
                        setReason(text.slice(0, REASON_MAX_LENGTH));
                      }}
                    >
                      {t('agentReview.actions.useReason', { text: text.split('.')[0] ?? text })}
                    </button>
                  );
                })}
              </div>
            )}
            <textarea
              id="rv-why"
              ref={reasonRef}
              className={reasonMissing ? 'input has-error' : 'input'}
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              value={reason}
              placeholder={t('agentReview.actions.reasonPlaceholder')}
              aria-invalid={reasonMissing}
              aria-describedby={reasonMissing ? 'rv-why-error' : undefined}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            {reasonMissing && (
              <div id="rv-why-error" className="ap-field-error" role="alert">
                {t('agentReview.actions.reasonRequired')}
              </div>
            )}
            <div className="ap-actions">
              <button
                type="button"
                className="btn btn-sm mk-danger"
                disabled={busy}
                onClick={reject}
              >
                {t('agentReview.actions.confirmReject')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={() => {
                  setRejecting(false);
                  setTried(false);
                }}
              >
                {t('agentReview.actions.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="ap-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={mine || uneval || violations.length > 0 || busy || !hash}
              title={
                mine
                  ? t('agentReview.actions.mineTitle')
                  : uneval
                    ? t('agentReview.actions.unevalTitle')
                    : violations.length > 0
                      ? t('agentReview.actions.rulesTitle')
                      : undefined
              }
              onClick={approve}
            >
              <CheckIcon size={12} /> {t('agentReview.actions.approve')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={mine || busy}
              onClick={() => {
                setRejecting(true);
                setError(null);
              }}
            >
              {t('agentReview.actions.reject')}
            </button>
            {mine ? (
              <span className="ap-reason">
                <LockIcon size={12} /> {t('agentReview.actions.mine')}
              </span>
            ) : uneval ? (
              <span className="ap-reason">
                <WarnIcon size={12} /> {t('agentReview.actions.uneval')}
              </span>
            ) : violations.length > 0 ? (
              <span className="ap-reason">
                <WarnIcon size={12} /> {t('agentReview.actions.blocked')}
              </span>
            ) : (
              <span className="mk-meta ap-as">
                {t('agentReview.actions.approveAs', { who: me.email ?? me.user_id })}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
