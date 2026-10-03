import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert } from '../../components/Alert';
import { Spinner } from '../../components/admin/govKit';
import { Badge } from '../../components/Badge';
import { BotIcon, InfoIcon, LockIcon, WarnIcon } from '../../components/icons';
import { SidePanel } from '../../components/SidePanel';
import {
  STATUS_TONE,
  formatPrice,
  isKnownModel,
  parsePrice,
  priceInputValue,
  typicalQueryCost,
  type Model,
} from './model';

/** What the administrator asks for; the page sends it and answers with an error text or null. */
export type ModelChange =
  | { kind: 'enable' | 'price'; inputUsd: string; outputUsd: string }
  | { kind: 'disable'; reason: string };

const REASON_MAX_LENGTH = 500;

type Mode = 'enable' | 'price' | 'disable' | null;

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mk-sec">
      <h3 className="mk-sec-t">{title.toLowerCase()}</h3>
      {children}
    </section>
  );
}

function Row({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="mk-kv">
      <span>{label}</span>
      <span className={mono ? 'mono' : undefined}>{children}</span>
    </div>
  );
}

interface PriceFormProps {
  model: Model;
  region: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: (inputUsd: string, outputUsd: string) => void;
  onCancel: () => void;
}

/** Design `priceForm`: the administrator confirms the prices used to compute and block budgets. */
function PriceForm({ model, region, confirmLabel, busy, onConfirm, onCancel }: PriceFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const [inputText, setInputText] = useState(() => priceInputValue(model.input_usd));
  const [outputText, setOutputText] = useState(() => priceInputValue(model.output_usd));
  const [confirmed, setConfirmed] = useState(false);
  const input = parsePrice(inputText);
  const output = parsePrice(outputText);
  const invalid = !input.ok ? input.reason : !output.ok ? output.reason : null;
  const hasList = model.list_input_usd !== null && model.list_output_usd !== null;
  const differs =
    input.ok &&
    output.ok &&
    hasList &&
    (input.amount !== Number(model.list_input_usd) ||
      output.amount !== Number(model.list_output_usd));
  // The API keeps the cache prices at the same ratio to the input price.
  const movesCache =
    input.ok && model.input_usd !== null && input.amount !== Number(model.input_usd);
  const fields = [
    { key: 'in', label: t('brains.priceForm.input'), value: inputText, set: setInputText },
    { key: 'out', label: t('brains.priceForm.output'), value: outputText, set: setOutputText },
  ];

  return (
    <form
      className="grid gap-2.5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (input.ok && output.ok && confirmed && !busy) onConfirm(input.value, output.value);
      }}
    >
      <div className="mk-meta">{t('brains.priceForm.intro', { region })}</div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
        {fields.map((field) => (
          <div key={field.key} className="min-w-0">
            <label
              htmlFor={`${id}-${field.key}`}
              className="mb-[5px] block text-[12.5px] font-medium"
            >
              {field.label}
            </label>
            <div className="mv-price">
              <span className="mono mk-meta">USD</span>
              <input
                id={`${id}-${field.key}`}
                inputMode="decimal"
                autoComplete="off"
                maxLength={16}
                aria-invalid={invalid !== null}
                aria-describedby={`${id}-hint`}
                value={field.value}
                onChange={(event) => {
                  field.set(event.target.value);
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {differs ? (
        <Alert tone="amber" icon={<WarnIcon size={13} />} className="text-[12.5px]">
          {t('brains.priceForm.differs', {
            input: formatPrice(model.list_input_usd ?? ''),
            output: formatPrice(model.list_output_usd ?? ''),
          })}
        </Alert>
      ) : null}
      {movesCache && invalid === null ? (
        <div className="mk-meta">{t('brains.priceForm.cache')}</div>
      ) : null}
      {invalid !== null ? (
        <div id={`${id}-hint`} className="text-xs text-danger" role="alert">
          {t(`brains.priceForm.${invalid}`)}
        </div>
      ) : (
        <div id={`${id}-hint`} className="mk-meta">
          {t('brains.priceForm.typical', {
            cost: input.ok && output.ok ? typicalQueryCost(input.amount, output.amount) : '',
          })}
        </div>
      )}
      <label className="flex cursor-pointer items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mv-check mt-[3px]"
          checked={confirmed}
          onChange={(event) => {
            setConfirmed(event.target.checked);
          }}
        />
        {t('brains.priceForm.confirm')}
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={!confirmed || invalid !== null || busy}
        >
          {busy ? <Spinner /> : null}
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

interface DisableFormProps {
  model: Model;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/** Design `mode === 'disable'`: who is affected, and an optional reason for the audit log. */
function DisableForm({ model, busy, onConfirm, onCancel }: DisableFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onConfirm(reason.trim());
      }}
    >
      {model.agents.length > 0 ? (
        <Alert tone="amber" className="text-[12.5px]">
          <div className="mb-1 font-semibold">
            {t('brains.disableForm.affected', { count: model.agents.length })}
          </div>
          {model.agents.map((agent) => (
            <div key={agent.id}>· {agent.name}</div>
          ))}
          <div className="mt-1.5 text-muted">{t('brains.disableForm.affectedNote')}</div>
        </Alert>
      ) : (
        <div className="mk-meta">{t('brains.disableForm.none')}</div>
      )}
      <label htmlFor={id} className="text-[12.5px] font-medium">
        {t('brains.disableForm.reason')}{' '}
        <span className="mk-meta">{t('brains.disableForm.optional')}</span>
      </label>
      <input
        id={id}
        className="input"
        maxLength={REASON_MAX_LENGTH}
        placeholder={t('brains.disableForm.reasonPlaceholder')}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-sm mk-danger" disabled={busy}>
          {busy ? <Spinner /> : null}
          {t('brains.foot.disable')}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

interface Props {
  model: Model;
  region: string;
  /** Bedrock was never asked: the model is shown by its identifier. */
  never: boolean;
  /** Sends the change. Resolves to a localized error, or null when it was applied. */
  onChange: (model: Model, change: ModelChange) => Promise<string | null>;
  onClose: () => void;
}

/**
 * Detail of one model (design models-view.jsx `ModelDetail`). Context size and usage have no
 * data source yet and say so. Every text that comes from the API is rendered as text.
 */
export function ModelDetail({ model, region, never, onChange, onClose }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (next: Mode) => {
    setError(null);
    setMode(next);
  };
  const send = async (change: ModelChange) => {
    setBusy(true);
    setError(null);
    const failure = await onChange(model, change);
    setBusy(false);
    if (failure === null) setMode(null);
    else setError(failure);
  };
  const cancel = () => {
    open(null);
  };

  let foot: ReactNode;
  if (model.status === 'noaccess') {
    foot = (
      <div className="ap-reason">
        <InfoIcon size={12} /> {t('brains.foot.noAccess')}
      </div>
    );
  } else if (mode === 'enable' || mode === 'price') {
    foot = (
      <PriceForm
        model={model}
        region={region}
        confirmLabel={t(mode === 'enable' ? 'brains.priceForm.enable' : 'brains.priceForm.save')}
        busy={busy}
        onConfirm={(inputUsd, outputUsd) => void send({ kind: mode, inputUsd, outputUsd })}
        onCancel={cancel}
      />
    );
  } else if (mode === 'disable') {
    foot = (
      <DisableForm
        model={model}
        busy={busy}
        onConfirm={(reason) => void send({ kind: 'disable', reason })}
        onCancel={cancel}
      />
    );
  } else if (model.status === 'enabled') {
    foot = (
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            open('price');
          }}
        >
          {t('brains.foot.editPrices')}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={model.is_default}
          title={model.is_default ? t('brains.foot.isDefault') : undefined}
          onClick={() => {
            open('disable');
          }}
        >
          {t('brains.foot.disable')}
        </button>
      </div>
    );
  } else {
    foot = (
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => {
          open('enable');
        }}
      >
        {t(model.status === 'disabled' ? 'brains.foot.enableAgain' : 'brains.foot.enable')}
      </button>
    );
  }

  return (
    <SidePanel
      title={never ? model.id : model.name}
      titleClassName={never ? 'mono' : undefined}
      width={500}
      lead={
        <span className="mc-ic lg">
          <BotIcon size={20} />
        </span>
      }
      meta={
        <>
          <Badge tone={STATUS_TONE[model.status]}>{t(`brains.status.${model.status}`)}</Badge>
          <span className="mk-meta">{t('brains.detail.via', { provider: model.provider })}</span>
        </>
      }
      footer={
        <>
          {error !== null ? (
            <div className="g-err mt-0 mb-2.5" role="alert">
              {error}
            </div>
          ) : null}
          {foot}
        </>
      }
      onClose={onClose}
    >
      {model.status === 'noaccess' ? (
        <Alert tone="red" icon={<LockIcon size={14} />}>
          <b>{t('brains.detail.noAccessLead')}</b> {t('brains.detail.noAccessBody')}
        </Alert>
      ) : null}
      {model.status === 'disabled' && model.disabled_by !== null ? (
        <Alert icon={<InfoIcon size={14} />}>
          {model.disabled_reason
            ? t('brains.detail.disabledByReason', {
                by: model.disabled_by,
                reason: model.disabled_reason,
              })
            : t('brains.detail.disabledBy', { by: model.disabled_by })}
        </Alert>
      ) : null}
      <Sec title={t('brains.detail.identification')}>
        <div className="mk-kv">
          <span>{t('brains.detail.modelId')}</span>
          <span className="mono text-[11.5px] [overflow-wrap:anywhere]">{model.id}</span>
        </div>
        <Row label={t('brains.detail.region')} mono>
          {region}
        </Row>
        <Row label={t('brains.detail.provider')}>{model.provider}</Row>
      </Sec>
      <Sec title={t('brains.detail.capabilities')}>
        <Row label={t('brains.detail.tools')}>
          {t(model.supports_tools ? 'brains.detail.yes' : 'brains.detail.no')}
        </Row>
        <Row label={t('brains.detail.vision')}>
          {t(model.supports_vision ? 'brains.detail.yes' : 'brains.detail.no')}
        </Row>
        <Row label={t('brains.detail.context')} mono={model.context_tokens !== null}>
          {model.context_tokens !== null
            ? t('brains.detail.contextTokens', {
                tokens: model.context_tokens.toLocaleString('es-ES', { useGrouping: 'always' }),
              })
            : t('brains.noData')}
        </Row>
        {model.supports_tools ? null : (
          <div className="mk-meta">
            {t(isKnownModel(model) ? 'brains.detail.noTools' : 'brains.detail.unknownModel')}
          </div>
        )}
      </Sec>
      <Sec title={t('brains.detail.price')}>
        {model.input_usd !== null && model.output_usd !== null ? (
          <>
            <Row label={t('brains.detail.input')} mono>
              {formatPrice(model.input_usd)}
            </Row>
            <Row label={t('brains.detail.output')} mono>
              {formatPrice(model.output_usd)}
            </Row>
            {model.cache_read_usd !== null ? (
              <Row label={t('brains.detail.cacheRead')} mono>
                {formatPrice(model.cache_read_usd)}
              </Row>
            ) : null}
            {model.cache_write_usd !== null ? (
              <Row label={t('brains.detail.cacheWrite')} mono>
                {formatPrice(model.cache_write_usd)}
              </Row>
            ) : null}
            <div className="mk-meta">
              {model.confirmed_by !== null
                ? t('brains.detail.confirmedBy', { by: model.confirmed_by })
                : t('brains.detail.listPrice')}
            </div>
          </>
        ) : (
          <div className="mk-meta">{t('brains.detail.noPriceYet')}</div>
        )}
      </Sec>
      <Sec title={t('brains.detail.agents', { total: model.agents.length })}>
        {model.agents.length > 0 ? (
          model.agents.map((agent) => (
            <div key={agent.id} className="mk-line flex items-center justify-between">
              <span>{agent.name}</span>
              <span className="mk-meta">{agent.category}</span>
            </div>
          ))
        ) : (
          <div className="mk-meta">{t('brains.detail.noAgents')}</div>
        )}
      </Sec>
      <Sec title={t('brains.detail.usage')}>
        <div className="mk-meta">{t('brains.detail.noUsage')}</div>
      </Sec>
    </SidePanel>
  );
}
