import type { TFunction } from 'i18next';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ApiError } from '../../api/errors';
import type { AuditEvent } from '../../api/schemas';
import { useSession } from '../../auth/useSession';
import { TONE_COLOR, toAuditRow } from '../../components/admin/auditModel';
import { auditDetail, auditLabel, auditOutcome } from '../../components/admin/auditText';
import { Denied, GovErrorState, Skel } from '../../components/admin/govKit';
import {
  ArrowRightIcon,
  CheckIcon,
  LockIcon,
  MoneyIcon,
  OrgIcon,
  type IconProps,
} from '../../components/icons';
import { Topbar } from '../../components/Topbar';
import { canView } from '../../layouts/navigation';
import { formatRelative } from '../../lib/format';
import { policySummary } from '../approvals/model';
import {
  NO_APPROVALS,
  budgetSub,
  hiddenOf,
  minutesUntil,
  visibleOf,
  type Governance,
  type Tone,
  type Visible,
} from './model';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; forbidden: boolean }
  | { kind: 'ready'; data: Governance; loadedAt: number };

interface Attention {
  key: string;
  tone: Tone;
  Icon: ComponentType<IconProps>;
  title: string;
  sub: string;
  cta: string;
  to: string;
}

interface Kpi {
  key: string;
  label: string;
  value: string;
  sub: string;
  to: string;
}

const SKELETON_ROWS = [0, 1, 2] as const;

function timeLeft(t: TFunction, minutes: number): string {
  return minutes < 60
    ? t('governance.minutes', { count: minutes })
    : t('governance.hours', { count: Math.round(minutes / 60) });
}

function subtitleOf(t: TFunction, visible: Visible): string {
  const hidden = hiddenOf(visible).map((key) => t(`governance.hidden.${key}`));
  if (hidden.length === 0) return t('governance.subtitle');
  const joined =
    hidden.length > 1
      ? `${hidden.slice(0, -1).join(', ')}${t('governance.and')}${hidden[hidden.length - 1] ?? ''}`
      : (hidden[0] ?? '');
  return t('governance.subtitlePartial', {
    hidden: joined.charAt(0).toUpperCase() + joined.slice(1),
  });
}

function kpisOf(t: TFunction, data: Governance | null, visible: Visible, now: number): Kpi[] {
  const approvals = data?.approvals ?? NO_APPROVALS;
  const left = minutesUntil(approvals.next_expires_at, now);
  const decided = approvals.approved_7d + approvals.rejected_7d;
  const kpis: Kpi[] = [
    {
      key: 'pending',
      label: t('governance.kpi.pending'),
      value: String(approvals.pending),
      sub: !approvals.pending
        ? t('governance.kpi.nothingPending')
        : left !== null
          ? t('governance.kpi.firstExpires', { time: timeLeft(t, left) })
          : t('governance.kpi.noExpiry'),
      to: '/approvals',
    },
    {
      key: 'decisions',
      label: t('governance.kpi.decisions'),
      value: String(decided),
      sub: decided
        ? `${t('governance.kpi.approved', { count: approvals.approved_7d })} · ${t('governance.kpi.rejected', { count: approvals.rejected_7d })}`
        : t('governance.kpi.noDecisions'),
      to: '/approvals',
    },
  ];
  if (visible.audit) {
    const audit = data?.audit;
    kpis.push({
      key: 'audit',
      label: t('governance.kpi.audit'),
      value: audit?.capped ? t('governance.kpi.auditCapped') : String(audit?.events_24h ?? 0),
      sub: t('governance.kpi.auditSub'),
      to: '/audit',
    });
  }
  return kpis;
}

function attentionOf(t: TFunction, data: Governance, releaseAgent: string): Attention[] {
  const items: Attention[] = [];
  const approvals = data.approvals ?? NO_APPROVALS;
  if (approvals.mine > 0) {
    items.push({
      key: 'approvals',
      tone: 'amber',
      Icon: LockIcon,
      title: t('governance.mine', { count: approvals.mine }),
      sub: approvals.mine_soon
        ? t('governance.soon', { count: approvals.mine_soon })
        : t('governance.reviewSoon'),
      cta: t('governance.review'),
      to: '/approvals',
    });
  }
  const over = data.budgets?.over_warn ?? [];
  if (over.length > 0) {
    items.push({
      key: 'budgets',
      tone: over.some((line) => line.exhausted) ? 'red' : 'amber',
      Icon: MoneyIcon,
      title: t('governance.over', { count: over.length }),
      sub: budgetSub(over, releaseAgent),
      cta: t('governance.seeBudgets'),
      to: '/budgets',
    });
  }
  const areas = data.areas?.pending ?? 0;
  if (areas > 0) {
    items.push({
      key: 'areas',
      tone: 'blue',
      Icon: OrgIcon,
      title: t('governance.areas', { count: areas }),
      sub: t('governance.areasSub'),
      cta: t('governance.review'),
      to: '/settings/areas',
    });
  }
  return items;
}

function KpiCard({ kpi, onOpen }: { kpi: Kpi; onOpen: (to: string) => void }) {
  return (
    <button
      type="button"
      className="card gv-kpi"
      onClick={() => {
        onOpen(kpi.to);
      }}
    >
      <span className="gv-kpi-l">{kpi.label}</span>
      <span className="gv-kpi-v">{kpi.value}</span>
      <span className="gv-kpi-s" title={kpi.sub}>
        {kpi.sub}
      </span>
    </button>
  );
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="gv-sec-h">
      <div className="mk-sec-t">{title}</div>
      {children}
    </div>
  );
}

function Loading({ kpis, visible }: { kpis: Kpi[]; visible: Visible }) {
  const { t } = useTranslation();
  const sections = [t('governance.policies'), ...(visible.audit ? [t('governance.activity')] : [])];
  return (
    <div className="gv-body" role="status" aria-label={t('governance.loading')}>
      <section>
        <div className="mk-sec-t">{t('governance.attention')}</div>
        <div className="card gv-attn">
          {SKELETON_ROWS.map((row) => (
            <div key={row} className="gv-attn-row is-skel">
              <Skel w={30} h={30} />
              <span className="gv-skel-lines">
                <Skel w="44%" />
                <Skel w="66%" h={10} />
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="gv-kpis" data-n={kpis.length}>
        {kpis.map((kpi) => (
          <div key={kpi.key} className="card gv-kpi">
            <span className="gv-kpi-l">{kpi.label}</span>
            <Skel w={64} h={24} />
            <Skel w="70%" h={10} />
          </div>
        ))}
      </section>
      <div className={visible.audit ? 'gv-grid' : 'gv-grid is-single'}>
        {sections.map((title) => (
          <section key={title}>
            <SectionHead title={title} />
            <div className="card gv-card">
              {SKELETON_ROWS.map((row) => (
                <div key={row} className="gv-pol">
                  <span className="gv-skel-lines">
                    <Skel w="48%" />
                    <Skel w="80%" h={10} />
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Activity({ events, now }: { events: AuditEvent[]; now: number }) {
  const { t } = useTranslation();
  const { config } = useSession();
  const navigate = useNavigate();
  const idpName = config.ssoProvider ?? null;
  const rows = useMemo(() => events.map((event, index) => toAuditRow(event, index)), [events]);
  return (
    <section>
      <SectionHead title={t('governance.activity')}>
        <button
          type="button"
          className="sr-link"
          onClick={() => {
            void navigate('/audit');
          }}
        >
          {t('governance.seeAll')}
        </button>
      </SectionHead>
      <div className="card gv-card">
        {rows.length === 0 ? (
          <div className="mk-meta gv-empty">{t('governance.activityEmpty')}</div>
        ) : (
          rows.map((row) => {
            const detail = auditDetail(t, row, idpName);
            const outcome = auditOutcome(t, row);
            return (
              <div key={row.key} className="tk-act gv-act">
                <span className="tk-dot" style={{ background: TONE_COLOR[row.tone] }} />
                <span className="gv-grow">
                  <b>{auditLabel(t, row)}</b>
                  <span className="gv-s gv-wrap">
                    {[row.actor, detail, outcome].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="tk-meta">{formatRelative(row.ts, now)}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/**
 * Gobernanza (design other-views.jsx `Governance`, round 19 «Disponible hoy», D89): what needs
 * attention and how the controls are working, from GET /api/governance. Administrators and
 * central FinOps open it; each section comes only when its own screen would show it (the API
 * decides; a `null` section is not drawn). Agent health and team budgets have no backend and are
 * not shown in this mode.
 */
export function GovernancePage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.call('getGovernance', {}, { signal: controller.signal }).then(
      (data) => {
        setState({ kind: 'ready', data, loadedAt: Date.now() });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          forbidden: error instanceof ApiError && error.status === 403,
        });
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
  const open = useCallback(
    (to: string) => {
      void navigate(to);
    },
    [navigate],
  );

  const data = state.kind === 'ready' ? state.data : null;
  // Before the answer, what the account suggests (the same views the navigation shows).
  const visible: Visible = data
    ? visibleOf(data)
    : {
        budgets: canView(me, 'budgets'),
        areas: canView(me, 'settings'),
        audit: canView(me, 'audit'),
      };
  const now = state.kind === 'ready' ? state.loadedAt : 0;
  const kpis = kpisOf(t, data, visible, now);

  // Design round 20: its own notice, without the rest of the view.
  if (state.kind === 'error' && state.forbidden) {
    return (
      <>
        <Topbar crumbs={[t('governance.title')]} />
        <div className="content">
          <Denied view="governance" />
        </div>
      </>
    );
  }

  let body;
  if (state.kind === 'error') {
    body = (
      <div className="gv-body">
        <div role="alert">
          <GovErrorState
            title={t('governance.errorTitle')}
            body={t('governance.errorBody')}
            onRetry={retry}
          />
        </div>
      </div>
    );
  } else if (state.kind === 'loading' || !data) {
    body = <Loading kpis={kpis} visible={visible} />;
  } else {
    const attention = attentionOf(t, data, t('agent.name'));
    const policies = (data.approvals ?? NO_APPROVALS).policies;
    const okText = !hiddenOf(visible).length
      ? t('governance.okAll')
      : visible.budgets
        ? t('governance.okBudgets')
        : t('governance.okApprovals');
    body = (
      <div className="gv-body">
        <section>
          <div className="mk-sec-t">{t('governance.attention')}</div>
          <div className="card gv-attn">
            {attention.length === 0 ? (
              <div className="gv-ok">
                <span className="gv-ok-ic">
                  <CheckIcon size={14} />
                </span>
                <div>
                  <div className="gv-ok-t">{t('governance.allClear')}</div>
                  <div className="mk-meta">{okText}</div>
                </div>
              </div>
            ) : (
              attention.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="gv-attn-row"
                  onClick={() => {
                    open(item.to);
                  }}
                >
                  <span className={`gv-ic is-${item.tone}`}>
                    <item.Icon size={14} />
                  </span>
                  <span className="gv-grow">
                    <span className="gv-t">{item.title}</span>
                    <span className="gv-s">{item.sub}</span>
                  </span>
                  <span className="gv-cta">
                    {item.cta} <ArrowRightIcon size={11} />
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="gv-kpis" data-n={kpis.length}>
          {kpis.map((kpi) => (
            <KpiCard key={kpi.key} kpi={kpi} onOpen={open} />
          ))}
        </section>

        <div className={visible.audit ? 'gv-grid' : 'gv-grid is-single'}>
          <section>
            <SectionHead title={t('governance.policies')}>
              <span className="mk-meta">{t('governance.policiesMeta')}</span>
            </SectionHead>
            <div className="card gv-card">
              {policies.length === 0 ? (
                <div className="mk-meta gv-empty">{t('governance.policiesEmpty')}</div>
              ) : (
                policies.map((line) => (
                  <div key={line.tool} className="gv-pol">
                    <div className="gv-grow">
                      <div className="gv-t mono gv-pol-tool">{line.tool}</div>
                      <div className="gv-s gv-wrap">
                        {policySummary(t, line.policy)} ·{' '}
                        {t('governance.requests', { count: line.total })}
                      </div>
                    </div>
                    {line.pending > 0 ? (
                      <span className="badge badge-amber">
                        {t('governance.pendingBadge', { count: line.pending })}
                      </span>
                    ) : (
                      <span className="badge">{t('governance.upToDate')}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
          {data.audit ? <Activity events={data.audit.recent} now={now} /> : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <Topbar
        crumbs={[t('governance.title')]}
        actions={
          visible.audit ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                open('/audit');
              }}
            >
              <LockIcon size={12} /> {t('governance.auditLog')}
            </button>
          ) : null
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('governance.title')}</h1>
          <p className="page-subtitle">{subtitleOf(t, visible)}</p>
        </div>
        {body}
      </div>
    </>
  );
}
