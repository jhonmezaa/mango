import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Banner, Skel } from '../../components/admin/govKit';
import { RefreshIcon, X2Icon } from '../../components/icons';
import { promptTokens, toolIndex, type Model, type Version } from '../agentBuilder/model';
import { formatCount, type Source } from './model';
import type { PlaygroundData } from './usePlaygroundData';

export type Compare = 'none' | 'model' | 'published';

const VERSION_SKELETON = [30, 100, 30, 100, 40, 100] as const;

interface Props {
  source: Source;
  data: PlaygroundData;
  version: Version | null;
  versionFailed: boolean;
  onRetryVersion: () => void;
  conflict: boolean;
  onReload: () => void;
  onSelect: (key: string) => void;
  models: readonly Model[];
  model: string;
  modelOff: boolean;
  /** The server said the model on screen calls no tools (`model_without_tools`). */
  modelNoTools: boolean;
  onModel: (model: string) => void;
  prompt: string;
  secret: boolean;
  onPrompt: (prompt: string) => void;
  temperature: number;
  onTemperature: (value: number) => void;
  compare: Compare;
  onCompare: (compare: Compare) => void;
  canComparePublished: boolean;
  modelB: string | null;
  otherModels: readonly Model[];
  onModelB: (model: string) => void;
  /** «Antes de enviar», already as text; drafts only. */
  problems: readonly string[];
}

function Label({
  children,
  htmlFor,
  hint,
}: {
  children: ReactNode;
  htmlFor?: string;
  hint?: string | null;
}) {
  return (
    <div className="pg-lb">
      {htmlFor ? <label htmlFor={htmlFor}>{children}</label> : <span>{children}</span>}
      {hint && <span className="mk-meta">{hint}</span>}
    </div>
  );
}

/** Left column of the design: what to test, what may change and what comes from the version. */
export function SidePanel(props: Props) {
  const { t } = useTranslation();
  const { source, data, version } = props;
  const note =
    source.kind === 'published'
      ? t('playground.source.publishedNote')
      : version === null
        ? ''
        : version.agent.published_version === null
          ? t('playground.source.newNote')
          : t('playground.source.changeNote');
  return (
    <div className="pg-side">
      {props.conflict && (
        <div className="mt-3.5">
          <Banner tone="error" title={t('playground.conflict.title')}>
            {t('playground.conflict.body')}
            <div className="mt-2">
              <button type="button" className="btn btn-sm" onClick={props.onReload}>
                <RefreshIcon size={11} />
                {t('playground.conflict.reload')}
              </button>
            </div>
          </Banner>
        </div>
      )}
      <Label htmlFor="pg-src">{t('playground.source.label')}</Label>
      <select
        id="pg-src"
        className="input"
        value={source.key}
        onChange={(event) => {
          props.onSelect(event.target.value);
        }}
      >
        {data.drafts.length > 0 && (
          <optgroup label={t('playground.source.drafts')}>
            {data.drafts.map((item) => (
              <option key={item.key} value={item.key}>
                {item.name} ·{' '}
                {t(`playground.source.status.${item.rejection ? 'rejected' : 'draft'}`)}
              </option>
            ))}
          </optgroup>
        )}
        {data.published.length > 0 && (
          <optgroup label={t('playground.source.published')}>
            {data.published.map((item) => (
              <option key={item.key} value={item.key}>
                {item.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <div className="mk-meta pg-note">
        {note} {t('playground.source.common')}
      </div>
      {source.rejection && (
        <div className="mc-alert red mt-2.5 text-[12.5px]">
          <X2Icon size={13} />
          <div>{t('playground.source.rejected', { reason: source.rejection })}</div>
        </div>
      )}
      {version === null ? (
        props.versionFailed ? (
          <div className="mt-4">
            <Banner tone="error" title={t('playground.versionError.title')}>
              {t('playground.versionError.body')}
              <div className="mt-2">
                <button type="button" className="btn btn-sm" onClick={props.onRetryVersion}>
                  <RefreshIcon size={11} />
                  {t('playground.retry')}
                </button>
              </div>
            </Banner>
          </div>
        ) : (
          <div
            className="pg-skel is-version"
            aria-busy="true"
            aria-label={t('playground.loadingVersion')}
          >
            {VERSION_SKELETON.map((width, index) => (
              <Skel key={index} w={`${String(width)}%`} h={index % 2 ? 32 : 10} />
            ))}
          </div>
        )
      ) : (
        <VersionFields {...props} version={version} />
      )}
    </div>
  );
}

function VersionFields(props: Props & { version: Version }) {
  const { t } = useTranslation();
  const { version, data, models, model, modelOff, modelNoTools } = props;
  const { definition } = version;
  const tools = toolIndex(data.context.catalog);
  const writes = definition.tools.filter((ref) => tools.get(ref)?.write).length;
  const skills = definition.skills.map((ref) => {
    const [id = ref, number = ''] = ref.split('@');
    return { ref, name: data.skillNames?.get(id) ?? id, number: number.replace(/^v/, '') };
  });
  const usesTools = definition.tools.length > 0 || definition.knowledge_bases.length > 0;
  return (
    <>
      <Label htmlFor="pg-model">{t('playground.model.label')}</Label>
      <select
        id="pg-model"
        className={modelOff ? 'input is-error' : 'input'}
        value={modelOff ? '' : model}
        onChange={(event) => {
          props.onModel(event.target.value);
        }}
      >
        {modelOff && (
          <option value="" disabled>
            {t('playground.model.choose')}
          </option>
        )}
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {modelOff && (
        <div className="pg-err">
          {t('playground.model.off', {
            model:
              data.context.models.find((item) => item.id === definition.model)?.name ??
              definition.model ??
              '',
          })}
        </div>
      )}
      {modelNoTools && !modelOff && (
        <div className="pg-err">
          {t('playground.model.noTools', {
            model: data.context.models.find((item) => item.id === model)?.name ?? model,
          })}
        </div>
      )}
      {usesTools && <div className="mk-meta mt-[5px]">{t('playground.model.toolsOnly')}</div>}

      <Label
        htmlFor="pg-prompt"
        hint={t('playground.prompt.tokens', { count: promptTokens(props.prompt) })}
      >
        {t('playground.prompt.label')}
      </Label>
      <textarea
        id="pg-prompt"
        className={props.secret ? 'input mono pg-prompt is-error' : 'input mono pg-prompt'}
        rows={9}
        value={props.prompt}
        aria-invalid={props.secret || undefined}
        onChange={(event) => {
          props.onPrompt(event.target.value);
        }}
      />
      {props.secret && <div className="pg-err">{t('playground.prompt.secret')}</div>}

      <Label hint={writes > 0 ? t('playground.tools.writes', { count: writes }) : null}>
        {t('playground.tools.label', { count: definition.tools.length })}
      </Label>
      <div className="pg-tools">
        {definition.tools.map((ref) => {
          const info = tools.get(ref);
          const off = !info?.enabled;
          const title = off
            ? t('playground.tools.unavailableTitle')
            : info.write
              ? t('playground.tools.writeTitle')
              : t('playground.tools.readTitle');
          return (
            <div key={ref} className={off ? 'pg-tool off' : 'pg-tool'} title={title}>
              <span className="mono">{ref}</span>
              {off ? (
                <span className="badge badge-red">{t('playground.tools.unavailable')}</span>
              ) : info.write ? (
                <span className="badge badge-amber">{t('playground.tools.write')}</span>
              ) : null}
            </div>
          );
        })}
        {definition.tools.length === 0 && (
          <div className="mk-meta">{t('playground.tools.none')}</div>
        )}
      </div>
      <div className="mk-meta pg-note">{t('playground.tools.note')}</div>

      {skills.length > 0 && (
        <>
          <Label>{t('playground.skills.label', { count: skills.length })}</Label>
          <div className="pg-tools">
            {skills.map((skill) => (
              <div key={skill.ref} className="pg-tool">
                <span>{skill.name}</span>
                <span className="mono mk-meta">v{skill.number}</span>
              </div>
            ))}
          </div>
          <div className="mk-meta pg-note">{t('playground.skills.note')}</div>
        </>
      )}

      <Label>{t('playground.limits.label')}</Label>
      <div className="pg-limits">
        <span>
          {t('playground.limits.tokens')}{' '}
          <b className="mono">{formatCount(definition.limits.max_tokens)}</b>
        </span>
        <span>
          {t('playground.limits.iterations')}{' '}
          <b className="mono">{definition.limits.max_iterations}</b>
        </span>
        <span>
          {t('playground.limits.time')}{' '}
          <b className="mono">
            {t('playground.limits.seconds', { count: definition.limits.timeout_seconds })}
          </b>
        </span>
      </div>

      <Label htmlFor="pg-temp" hint={t('playground.temperature.hint')}>
        {t('playground.temperature.label', { value: props.temperature.toFixed(1) })}
      </Label>
      <input
        id="pg-temp"
        className="pg-range"
        type="range"
        min="0"
        max="1"
        step="0.1"
        value={props.temperature}
        onChange={(event) => {
          props.onTemperature(Number(event.target.value));
        }}
      />

      <Label>{t('playground.compare.label')}</Label>
      <div className="tk-quick pg-compare">
        {(
          [
            ['none', 'none'],
            ['model', 'model'],
            ...(props.canComparePublished ? ([['published', 'published']] as const) : []),
          ] as const
        ).map(([key]) => (
          <button
            key={key}
            type="button"
            className={props.compare === key ? 'is-on' : ''}
            aria-pressed={props.compare === key}
            onClick={() => {
              props.onCompare(key);
            }}
          >
            {t(`playground.compare.${key}`)}
          </button>
        ))}
      </div>
      {props.compare === 'model' && (
        <select
          className="input mt-2"
          aria-label={t('playground.compare.modelB')}
          value={props.modelB ?? ''}
          onChange={(event) => {
            props.onModelB(event.target.value);
          }}
        >
          {props.otherModels.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      )}
      {props.compare !== 'none' && (
        <div className="mk-meta mt-1.5">{t('playground.compare.note')}</div>
      )}
      {props.problems.length > 0 && (
        <div className="mc-alert amber pg-before">
          <div className="pg-before-t">{t('playground.beforeSubmit')}</div>
          {props.problems.map((text) => (
            <div key={text}>· {text}</div>
          ))}
        </div>
      )}
    </>
  );
}
