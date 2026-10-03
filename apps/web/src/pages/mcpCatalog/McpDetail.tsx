import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert } from '../../components/Alert';
import { Spinner } from '../../components/admin/govKit';
import {
  CheckIcon,
  ClockIcon,
  InfoIcon,
  LockIcon,
  RefreshIcon,
  WarnIcon,
  X2Icon,
} from '../../components/icons';
import { Badge } from '../../components/Badge';
import { SidePanel } from '../../components/SidePanel';
import { SoonTag } from '../../components/Soon';
import { formatRelative } from '../../lib/format';
import {
  REASON_MAX_LENGTH,
  currentConfig,
  dataModeOf,
  isCentralTool,
  isWriteTool,
  newPermissions,
  paramChanges,
  requesterOf,
  requiredServices,
  shownVersion,
  statusOf,
  writeTools,
  type Pack,
  type PackRequest,
  type Server,
} from './model';
import {
  AccessBadge,
  KindLabel,
  LevelBadge,
  ModeBadge,
  ServerIcon,
  StatusBadge,
  ToolChip,
} from './parts';

/** What the administrator asks for; the page sends it and answers with an error text or null. */
export type PackAction =
  | { kind: 'request'; config: Record<string, string>; reason: string }
  | { kind: 'params'; config: Record<string, string> }
  | { kind: 'approve'; request: PackRequest }
  | { kind: 'reject'; request: PackRequest; reason: string }
  /** Who asked takes their own pending request back; nothing about the pack changes. */
  | { kind: 'withdraw'; request: PackRequest }
  /** Asks to move to the version of the release; another administrator approves it. */
  | { kind: 'update' }
  | { kind: 'retry' }
  | { kind: 'disable'; reason: string };

type Mode = 'request' | 'reject' | 'disable' | 'params' | null;

function Sec({ title, tag, children }: { title: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <section className="mk-sec">
      <h3 className={tag ? 'mk-sec-t flex items-center gap-2' : 'mk-sec-t'}>
        {title.toLowerCase()}
        {tag}
      </h3>
      {children}
    </section>
  );
}

function Lock({ children }: { children: ReactNode }) {
  return (
    <div className="ap-reason">
      <LockIcon size={12} /> {children}
    </div>
  );
}

/** Design: the requester reads why they cannot decide, next to «Retirar solicitud». */
function OwnRequest({
  busy,
  onWithdraw,
  children,
}: {
  busy: boolean;
  onWithdraw: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Lock>{children}</Lock>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={onWithdraw}>
        {t('mcpCatalog.foot.withdraw')}
      </button>
    </div>
  );
}

interface ParamFieldsProps {
  pack: Pack;
  values: Record<string, string>;
  /** Shows the value in use next to each label (design "· hoy us-east-1"). */
  showCurrent?: boolean;
  onChange: (values: Record<string, string>) => void;
}

/** One select per parameter: only the values the signed manifest allows can be chosen. */
function ParamFields({ pack, values, showCurrent = false, onChange }: ParamFieldsProps) {
  const { t } = useTranslation();
  const id = useId();
  const current = currentConfig(pack);
  return pack.params.map((param) => (
    <div key={param.key}>
      <label htmlFor={`${id}-${param.key}`} className="mb-[5px] block text-[12.5px] font-medium">
        {param.description ?? param.key}
        {showCurrent ? (
          <>
            {' '}
            <span className="mk-meta">
              {t('mcpCatalog.form.today', { value: current[param.key] ?? '' })}
            </span>
          </>
        ) : null}
      </label>
      <select
        id={`${id}-${param.key}`}
        className="input mc-param"
        value={values[param.key] ?? param.default}
        onChange={(event) => {
          onChange({ ...values, [param.key]: event.target.value });
        }}
      >
        {param.allowed.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  ));
}

interface FormProps {
  busy: boolean;
  onCancel: () => void;
}

/** Design `mode === 'request'`: parameters and an optional reason for the approver. */
function RequestForm({
  pack,
  busy,
  onSend,
  onCancel,
}: FormProps & { pack: Pack; onSend: (config: Record<string, string>, reason: string) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [values, setValues] = useState(() => currentConfig(pack));
  const [reason, setReason] = useState('');
  return (
    <form
      className="grid gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSend(values, reason.trim());
      }}
    >
      <ParamFields pack={pack} values={values} onChange={setValues} />
      <div>
        <label htmlFor={id} className="mb-[5px] block text-[12.5px] font-medium">
          {t('mcpCatalog.form.reasonRequest')}{' '}
          <span className="mk-meta">{t('mcpCatalog.form.optional')}</span>
        </label>
        <textarea
          id={id}
          className="input"
          rows={2}
          maxLength={REASON_MAX_LENGTH}
          placeholder={t('mcpCatalog.form.reasonRequestPlaceholder')}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          {t('mcpCatalog.form.send')}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

/** Design `mode === 'params'`: the change waits for another administrator. */
function ParamsForm({
  pack,
  busy,
  onSend,
  onCancel,
}: FormProps & { pack: Pack; onSend: (config: Record<string, string>) => void }) {
  const { t } = useTranslation();
  const [values, setValues] = useState(() => currentConfig(pack));
  const unchanged = paramChanges(pack, values).length === 0;
  return (
    <form
      className="grid gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !unchanged) onSend(values);
      }}
    >
      <ParamFields pack={pack} values={values} showCurrent onChange={setValues} />
      <div className="mk-meta">{t('mcpCatalog.form.paramsNote')}</div>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || unchanged}>
          {busy ? <Spinner /> : null}
          {t('mcpCatalog.form.askChange')}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

/** Design `mode === 'reject' | 'reject-upd' | 'disable'`: the reason is mandatory. */
function ReasonForm({
  server,
  disable,
  busy,
  onSend,
  onCancel,
}: FormProps & { server: Server; disable: boolean; onSend: (reason: string) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const missing = tried && reason.trim() === '';
  return (
    <form
      className="grid gap-2"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (!busy && reason.trim() !== '') onSend(reason.trim());
      }}
    >
      {disable && server.agents.length > 0 ? (
        <Alert tone="amber" className="text-[12.5px]">
          <div className="mb-1 font-semibold">{t('mcpCatalog.form.affected')}</div>
          <div>
            {t('mcpCatalog.form.affectedAgents', {
              count: server.agents.length,
              names: server.agents.map((agent) => agent.name).join(', '),
            })}
          </div>
        </Alert>
      ) : null}
      <label htmlFor={id} className="text-[12.5px] font-medium">
        {t(disable ? 'mcpCatalog.form.reasonDisable' : 'mcpCatalog.form.reasonReject')}
      </label>
      <textarea
        id={id}
        className={missing ? 'input mc-invalid' : 'input'}
        rows={2}
        maxLength={REASON_MAX_LENGTH}
        // The form opens after the administrator's own click: the focus follows the action.
        autoFocus
        aria-invalid={missing}
        aria-describedby={missing ? `${id}-error` : undefined}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      {missing ? (
        <div id={`${id}-error`} className="text-xs text-danger" role="alert">
          {t('mcpCatalog.form.reasonRequired')}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-sm mk-danger" disabled={busy}>
          {busy ? <Spinner /> : null}
          {t(disable ? 'mcpCatalog.foot.disable' : 'mcpCatalog.foot.reject')}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

interface Props {
  server: Server;
  /** The whole catalog: what the enabled servers already use tells which permissions are new. */
  servers: readonly Server[];
  /** UX only (`is_admin` of GET /api/me): the API authorizes every action. */
  isAdmin: boolean;
  /** Sends the action. Resolves to a localized error, or null when it was applied. */
  onAction: (server: Server, action: PackAction) => Promise<string | null>;
  onClose: () => void;
}

/**
 * Detail of one connector or pack (design mcp-catalog.jsx `McpDetail`). Health is
 * "Próximamente"; the installation shows no steps because the API only knows `installing`.
 * Every text that comes from the API is rendered as text.
 */
export function McpDetail({ server, servers, isAdmin, onAction, onClose }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pack = server.pack ?? null;
  const status = statusOf(server);
  const pending = pack?.pending ?? null;
  const update = pack?.update ?? null;
  const pendingUpdate = pending?.kind === 'update' ? pending : null;
  const agents = server.agents;
  const hasWrite = writeTools(server) > 0;
  const dataMode = dataModeOf(server);
  const services = requiredServices(server);
  // Design: a connector over account data says, tool by tool, who may call it.
  const toolScopes = pack === null && server.data_tier === 'account_data';

  const open = (next: Mode) => {
    setError(null);
    setMode(next);
  };
  const cancel = () => {
    open(null);
  };
  const send = async (action: PackAction) => {
    setBusy(true);
    setError(null);
    const failure = await onAction(server, action);
    setBusy(false);
    if (failure === null) setMode(null);
    else setError(failure);
  };

  const changesText = (request: PackRequest, withFrom: boolean): string =>
    pack === null
      ? ''
      : paramChanges(pack, request.config)
          .map((change) =>
            t(withFrom ? 'mcpCatalog.foot.paramChangeFromTo' : 'mcpCatalog.foot.paramChangeTo', {
              ...change,
            }),
          )
          .join(', ');

  let foot: ReactNode;
  if (!isAdmin) {
    foot = <Lock>{t('mcpCatalog.foot.adminsOnly')}</Lock>;
  } else if (pack === null) {
    foot =
      status === 'enabled' ? (
        <div className="ap-reason">
          <InfoIcon size={12} /> {t('mcpCatalog.foot.connector')}
        </div>
      ) : null;
  } else if (mode === 'request') {
    foot = (
      <RequestForm
        pack={pack}
        busy={busy}
        onSend={(config, reason) => void send({ kind: 'request', config, reason })}
        onCancel={cancel}
      />
    );
  } else if (mode === 'disable' || (mode === 'reject' && pending !== null)) {
    foot = (
      <ReasonForm
        server={server}
        disable={mode === 'disable'}
        busy={busy}
        onSend={(reason) =>
          void send(
            mode === 'reject' && pending !== null
              ? { kind: 'reject', request: pending, reason }
              : { kind: 'disable', reason },
          )
        }
        onCancel={cancel}
      />
    );
  } else if (mode === 'params') {
    foot = (
      <ParamsForm
        pack={pack}
        busy={busy}
        onSend={(config) => void send({ kind: 'params', config })}
        onCancel={cancel}
      />
    );
  } else if (pending?.kind === 'params' && status === 'enabled') {
    foot = pending.own ? (
      <OwnRequest busy={busy} onWithdraw={() => void send({ kind: 'withdraw', request: pending })}>
        {t('mcpCatalog.foot.paramsOwn', { changes: changesText(pending, false) })}
      </OwnRequest>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <span className="mk-meta basis-full">
          {t('mcpCatalog.foot.paramsTheirs', {
            by: requesterOf(pending),
            changes: changesText(pending, true),
          })}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() => void send({ kind: 'approve', request: pending })}
        >
          {t('mcpCatalog.foot.approveParams')}
        </button>
        {/* Design: a parameter change is rejected without a reason (the API allows it). */}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void send({ kind: 'reject', request: pending, reason: '' })}
        >
          {t('mcpCatalog.foot.reject')}
        </button>
      </div>
    );
  } else if (status === 'pending') {
    if (pending === null) foot = null;
    else if (pending.own) {
      foot = (
        <OwnRequest
          busy={busy}
          onWithdraw={() => void send({ kind: 'withdraw', request: pending })}
        >
          {t('mcpCatalog.foot.own')}
        </OwnRequest>
      );
    } else {
      foot = (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void send({ kind: 'approve', request: pending })}
          >
            {busy ? <Spinner /> : <CheckIcon size={12} />} {t('mcpCatalog.foot.approve')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              open('reject');
            }}
          >
            {t('mcpCatalog.foot.reject')}
          </button>
        </div>
      );
    }
  } else if (status === 'available' || status === 'disabled') {
    foot = (
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => {
          open('request');
        }}
      >
        {t('mcpCatalog.foot.request')}
      </button>
    );
  } else if (status === 'installing' || status === 'disabling') {
    foot = (
      <div className="ap-reason" role="status">
        <Spinner />{' '}
        {status === 'disabling'
          ? t('mcpCatalog.foot.disabling')
          : pack.status_at
            ? t('mcpCatalog.foot.installingSince', { when: formatRelative(pack.status_at) })
            : t('mcpCatalog.foot.installing')}
      </div>
    );
  } else if (status === 'error') {
    foot = (
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() => void send({ kind: 'retry' })}
        >
          {busy ? <Spinner /> : <RefreshIcon size={12} />} {t('mcpCatalog.foot.retry')}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => {
            open('disable');
          }}
        >
          {t('mcpCatalog.foot.disable')}
        </button>
      </div>
    );
  } else {
    foot = (
      <div className="flex flex-wrap items-center gap-2">
        {update && pending === null ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void send({ kind: 'update' })}
          >
            {t('mcpCatalog.foot.requestUpdate', { version: update.version })}
          </button>
        ) : null}
        {pack.params.length > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              open('params');
            }}
          >
            {t('mcpCatalog.foot.changeParams')}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            open('disable');
          }}
        >
          {t('mcpCatalog.foot.disable')}
        </button>
      </div>
    );
  }

  const fresh = newPermissions(server, servers);

  return (
    <SidePanel
      title={server.name}
      width={520}
      lead={<ServerIcon server={server} large />}
      meta={
        <>
          <StatusBadge status={status} />
          <LevelBadge server={server} />
          <ModeBadge server={server} />
          <span className="mk-meta">
            <KindLabel server={server} />
            {pack ? ` · ${t('mcpCatalog.version', { version: shownVersion(pack) })}` : null}
          </span>
        </>
      }
      footer={
        foot !== null || error !== null ? (
          <>
            {error !== null ? (
              <Alert tone="red" role="alert" className="mb-2.5 text-[12.5px]">
                {error}
              </Alert>
            ) : null}
            {foot}
          </>
        ) : null
      }
      onClose={onClose}
    >
      <p className="m-0 text-sm leading-[1.55]">{server.description}</p>

      {pack && status === 'error' ? (
        <Alert tone="red" icon={<X2Icon size={14} />}>
          <b>{t('mcpCatalog.detail.failedLead')}</b>
          {pack.failed_step
            ? ` ${t('mcpCatalog.detail.failedStep', { step: pack.failed_step })}`
            : null}
          {pack.failure === 'not_started'
            ? ` ${t('mcpCatalog.detail.failedNotStarted')}`
            : pack.failure === 'interrupted'
              ? ` ${t('mcpCatalog.detail.failedInterrupted')}`
              : pack.failure
                ? ` ${t('mcpCatalog.detail.failedCode', { code: pack.failure })}`
                : null}
          {pack.installed_version !== null
            ? ` ${t('mcpCatalog.detail.failedStillActive', { version: pack.installed_version })}`
            : null}
        </Alert>
      ) : null}
      {dataMode !== null ? (
        <Alert className="text-[12.5px]">
          <div className="mb-0.5 font-semibold">
            {t(`mcpCatalog.detail.mode.${dataMode}.title`)}
          </div>
          {t(`mcpCatalog.detail.mode.${dataMode}.body`)}
        </Alert>
      ) : null}
      {services.length > 0 && status === 'enabled' ? (
        <Alert tone="amber" icon={<WarnIcon size={14} />}>
          {t('mcpCatalog.detail.servicesRequired', {
            count: services.length,
            services: services.join(t('mcpCatalog.detail.servicesJoin')),
          })}
        </Alert>
      ) : null}
      {status === 'pending' && pending ? (
        <Alert tone="amber" icon={<ClockIcon size={14} />}>
          <b>{requesterOf(pending)}</b>
          {t('mcpCatalog.detail.requested', { when: formatRelative(pending.created_at) })}
          {Object.keys(pending.config).length > 0
            ? t('mcpCatalog.detail.requestedConfig', {
                config: Object.entries(pending.config)
                  .map(([key, value]) => `${key} ${value}`)
                  .join(', '),
              })
            : null}
          .{pending.reason ? ` “${pending.reason}”` : null}
        </Alert>
      ) : null}
      {status === 'disabled' && agents.length > 0 ? (
        <Alert tone="amber" icon={<WarnIcon size={14} />}>
          {agents.length === 1
            ? t('mcpCatalog.detail.disabledOne')
            : t('mcpCatalog.detail.disabledMany', { count: agents.length })}
          <b>{t('mcpCatalog.detail.unavailable')}</b>:{' '}
          {agents.map((agent) => agent.name).join(', ')}.{t('mcpCatalog.detail.disabledKeeps')}
        </Alert>
      ) : null}
      {pack?.last_rejected && status !== 'pending' ? (
        <Alert icon={<InfoIcon size={14} />}>
          {t('mcpCatalog.detail.lastRejected', {
            by: pack.last_rejected.decided_by_email ?? pack.last_rejected.decided_by ?? '—',
          })}
          {pack.last_rejected.reason ? `: “${pack.last_rejected.reason}”` : null}
        </Alert>
      ) : null}
      {pack && update && pendingUpdate ? (
        <Alert tone="amber">
          <div className="mb-1 font-semibold">
            {t('mcpCatalog.detail.updateTitle', { from: shownVersion(pack), to: update.version })}
          </div>
          <div className="text-[12.5px]">
            {update.added_tools.length > 0 ? (
              <>
                {t('mcpCatalog.detail.updateAdds')}{' '}
                {update.added_tools.map((name) => (
                  <ToolChip key={name} name={name} tone="add" write={isWriteTool(server, name)} />
                ))}
              </>
            ) : null}
            {update.removed_tools.length > 0 ? (
              <>
                {update.added_tools.length > 0 ? ' · ' : null}
                {t('mcpCatalog.detail.updateRemoves')}{' '}
                {update.removed_tools.map((name) => (
                  <ToolChip key={name} name={name} tone="rem" />
                ))}
              </>
            ) : null}
            {update.added_tools.length + update.removed_tools.length === 0
              ? t('mcpCatalog.detail.updateNoTools')
              : null}
          </div>
          <div className="mt-1.5 mb-2 text-xs text-muted">
            {t('mcpCatalog.detail.updateBy', {
              by: requesterOf(pendingUpdate),
              when: formatRelative(pendingUpdate.created_at),
              version: shownVersion(pack),
            })}
          </div>
          {isAdmin && mode !== 'reject' ? (
            pendingUpdate.own ? (
              <OwnRequest
                busy={busy}
                onWithdraw={() => void send({ kind: 'withdraw', request: pendingUpdate })}
              >
                {t('mcpCatalog.detail.updateOwn')}
              </OwnRequest>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void send({ kind: 'approve', request: pendingUpdate })}
                >
                  {t('mcpCatalog.detail.approveUpdate')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    open('reject');
                  }}
                >
                  {t('mcpCatalog.detail.reject')}
                </button>
              </div>
            )
          ) : null}
        </Alert>
      ) : null}

      {pack && pack.params.length > 0 ? (
        <Sec title={t('mcpCatalog.detail.params')}>
          {pack.params.map((param) => (
            <div key={param.key} className="mk-kv">
              <span>{param.description ?? param.key}</span>
              <span className="mono">{param.value ?? param.default}</span>
            </div>
          ))}
        </Sec>
      ) : null}

      <Sec title={t('mcpCatalog.detail.tools', { count: server.tools.length })}>
        {server.tools.map((tool) => (
          <div key={tool.ref} className="mk-line flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="mono text-[12.5px] font-semibold [overflow-wrap:anywhere]">
                {tool.name}
              </div>
              {/* The signed manifest of a pack brings no descriptions (the API sends ""). */}
              {tool.description ? <div className="mk-meta">{tool.description}</div> : null}
            </div>
            <span className="flex flex-wrap justify-end gap-1">
              {tool.requires_service ? (
                <Badge tone="amber" title={t('mcpCatalog.detail.requiresServiceTitle')}>
                  {t('mcpCatalog.detail.requiresService', { service: tool.requires_service })}
                </Badge>
              ) : null}
              {toolScopes ? (
                <Badge tone={isCentralTool(tool) ? 'violet' : 'neutral'}>
                  {t(
                    isCentralTool(tool)
                      ? 'mcpCatalog.toolScope.central'
                      : 'mcpCatalog.toolScope.user',
                  )}
                </Badge>
              ) : null}
              <AccessBadge tool={tool} />
            </span>
          </div>
        ))}
        {pack ? <div className="mk-meta mt-1.5">{t('mcpCatalog.detail.toolsPackNote')}</div> : null}
      </Sec>

      {status === 'pending' && isAdmin && pending && !pending.own ? (
        <Alert tone="amber" className="text-[12.5px]">
          <div className="mb-1 font-semibold">{t('mcpCatalog.detail.beforeApproving')}</div>
          {fresh.length > 0 ? (
            <div>
              {t('mcpCatalog.detail.newPermissions', { count: fresh.length })}{' '}
              {fresh.map((permission) => (
                <ToolChip key={permission} name={permission} />
              ))}
            </div>
          ) : (
            <div>{t('mcpCatalog.detail.noNewPermissions')}</div>
          )}
          {server.data_tier === 'account_data' ? (
            <div className="mt-1">{t('mcpCatalog.detail.accountsNote')}</div>
          ) : null}
          {hasWrite ? <div className="mt-1">{t('mcpCatalog.detail.writeNote')}</div> : null}
        </Alert>
      ) : null}

      <Sec title={t('mcpCatalog.detail.permissions')}>
        {server.permissions.length > 0 ? (
          <>
            {/* The API sends one list: it is only called "Lectura" when no tool writes. */}
            {hasWrite ? null : (
              <div className="mk-meta mb-1.5">{t('mcpCatalog.detail.permissionsRead')}</div>
            )}
            <div className="mc-perms">
              {server.permissions.map((permission) => (
                <code key={permission}>{permission}</code>
              ))}
            </div>
          </>
        ) : (
          <div className="mk-meta">{t('mcpCatalog.detail.permissionsNone')}</div>
        )}
        {update && update.added_permissions.length > 0 ? (
          <div className="mk-meta mc-perms mt-2 items-center">
            {t('mcpCatalog.detail.permissionsAdded', { version: update.version })}
            {update.added_permissions.map((permission) => (
              <code key={permission}>{permission}</code>
            ))}
          </div>
        ) : null}
        {server.permissions.length > 0 && !hasWrite ? (
          <div className="mk-meta mt-1.5">{t('mcpCatalog.detail.permissionsReadOnly')}</div>
        ) : null}
      </Sec>

      <Sec title={t('mcpCatalog.detail.agents', { count: agents.length })}>
        {agents.length > 0 ? (
          agents.map((agent) => (
            <div key={agent.id} className="mk-line flex items-center justify-between">
              <span>{agent.name}</span>
              <span className="mk-meta">
                {server.enabled ? agent.category : t('mcpCatalog.detail.toolsUnavailable')}
              </span>
            </div>
          ))
        ) : (
          <div className="mk-meta">{t('mcpCatalog.detail.agentsNone')}</div>
        )}
      </Sec>

      <Sec title={t('mcpCatalog.detail.health')} tag={<SoonTag />}>
        <div className="mk-meta">{t('mcpCatalog.detail.healthNone')}</div>
      </Sec>

      {pack && (pack.approved_by || pack.disabled_by) ? (
        <Sec title={t('mcpCatalog.detail.history')}>
          {pack.requested_by ? (
            <div className="mk-kv">
              <span>{t('mcpCatalog.detail.historyRequested')}</span>
              <span>
                {pack.requested_at
                  ? t('mcpCatalog.detail.byWhen', {
                      by: pack.requested_by_email ?? pack.requested_by,
                      when: formatRelative(pack.requested_at),
                    })
                  : (pack.requested_by_email ?? pack.requested_by)}
              </span>
            </div>
          ) : null}
          {pack.approved_by ? (
            <div className="mk-kv">
              <span>{t('mcpCatalog.detail.historyApproved')}</span>
              <span>{pack.approved_by_email ?? pack.approved_by}</span>
            </div>
          ) : null}
          {pack.disabled_by ? (
            <div className="mk-kv">
              <span>{t('mcpCatalog.detail.historyDisabled')}</span>
              <span>
                {pack.disabled_at
                  ? t('mcpCatalog.detail.byWhen', {
                      by: pack.disabled_by_email ?? pack.disabled_by,
                      when: formatRelative(pack.disabled_at),
                    })
                  : (pack.disabled_by_email ?? pack.disabled_by)}
              </span>
            </div>
          ) : null}
        </Sec>
      ) : null}
    </SidePanel>
  );
}
