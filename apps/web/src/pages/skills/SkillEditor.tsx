import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { adminErrorKey } from '../../api/adminErrors';
import { useSession } from '../../auth/useSession';
import { GovModal } from '../../components/admin/govKit';
import { CheckIcon, CloseIcon } from '../../components/icons';
import { LevelBadge as ServerLevelBadge } from '../mcpCatalog/parts';
import { statusOf, type Server } from '../mcpCatalog/model';
import {
  DESCRIPTION_MAX_LENGTH,
  INSTRUCTIONS_COUNTER_FROM,
  INSTRUCTIONS_MAX_LENGTH,
  MAX_OUTPUTS,
  MAX_SERVERS,
  NAME_MAX_LENGTH,
  OUTPUT_MAX_LENGTH,
  REASON_MAX_LENGTH,
  draftErrors,
  editorErrorCode,
  editorServers,
  secretIn,
  variablesOf,
  type DataTier,
  type Draft,
  type SkillDetail,
} from './model';
import { LevelBadge } from './parts';

export type EditorMode = { kind: 'new' } | { kind: 'version'; detail: SkillDetail };

interface Props {
  mode: EditorMode;
  categories: readonly string[];
  /** Ids of the skills and of the first proposals still open («Ya existe una skill…»). */
  takenIds: ReadonlySet<string>;
  onClose: () => void;
  onSent: (skillId: string) => void;
}

const TIER_RANK: Record<DataTier, number> = { public: 0, account_data: 1, write: 2 };

function tierOf(level: string): DataTier | null {
  return level === 'public' || level === 'account_data' || level === 'write' ? level : null;
}

function Label({
  children,
  htmlFor,
  hint,
}: {
  children: ReactNode;
  htmlFor?: string;
  hint?: string | undefined;
}) {
  return (
    <div className="sk-lb">
      {htmlFor ? <label htmlFor={htmlFor}>{children}</label> : <span>{children}</span>}
      {hint ? <span className="mk-meta">{hint}</span> : null}
    </div>
  );
}

/**
 * «Nueva skill» and «Nueva versión» (design `SkillEditor`). Only instructions: the request waits
 * for an administrator other than whoever sends it. The API checks every rule again (secrets,
 * servers enabled, limits) and its errors show under the form, which stays open.
 */
export function SkillEditor({ mode, categories, takenIds, onClose, onSent }: Props) {
  const { t } = useTranslation();
  const { api } = useSession();
  const ids = { name: useId(), category: useId(), description: useId(), instructions: useId() };
  const base = mode.kind === 'version' ? mode.detail : null;
  const [draft, setDraft] = useState<Draft>(() =>
    base
      ? {
          name: base.skill.name,
          category: base.skill.category,
          description: base.skill.description,
          instructions: base.instructions,
          outputs: [...base.outputs],
          servers: base.skill.servers.map((server) => server.id),
        }
      : {
          name: '',
          category: categories[0] ?? '',
          description: '',
          instructions: '',
          outputs: [],
          servers: [],
        },
  );
  const [output, setOutput] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [catalog, setCatalog] = useState<readonly Server[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.call('getCatalog', {}, { signal: controller.signal }).then(
      (data) => {
        setCatalog(editorServers(data.items));
      },
      () => {
        if (!controller.signal.aborted) setCatalogFailed(true);
      },
    );
    return () => {
      controller.abort();
    };
  }, [api]);

  const byId = useMemo(
    () => new Map((catalog ?? []).map((server) => [server.id, server])),
    [catalog],
  );
  // Until the catalog arrives, the servers of the approved version count as enabled.
  const enabled = useMemo(
    () =>
      catalog === null
        ? new Set(base?.skill.servers.filter((s) => s.enabled).map((s) => s.id) ?? [])
        : new Set(catalog.filter((server) => server.enabled).map((server) => server.id)),
    [catalog, base],
  );
  const errors = draftErrors(draft, reason, {
    isNew: base === null,
    takenIds,
    enabledServers: enabled,
  });
  const secret = secretIn({ ...draft, name: '', description: '', outputs: [] });
  const vars = variablesOf(draft.instructions);
  const chosen = draft.servers.map((id) => byId.get(id)).filter((s) => s !== undefined);
  const level = chosen.reduce<DataTier>((current, server) => {
    const tier = tierOf(server.data_tier);
    return tier && TIER_RANK[tier] > TIER_RANK[current] ? tier : current;
  }, 'public');
  const writes = chosen.some((server) => server.tools.some((tool) => tool.access !== 'read'));
  const agents = base?.skill.agents ?? 0;
  const patch = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  };

  const save = async () => {
    setTried(true);
    setServerError(null);
    if (errors.length) return;
    setSending(true);
    const content = {
      name: draft.name.trim(),
      category: draft.category,
      description: draft.description.trim(),
      instructions: draft.instructions,
      outputs: draft.outputs,
      servers: draft.servers,
      reason: reason.trim(),
    };
    try {
      const created = base
        ? await api.call('postSkillVersion', {
            path: { skill_id: base.skill.id },
            body: { ...content, base_version: base.skill.version },
          })
        : await api.call('postSkill', { body: content });
      onSent(created.skill_id);
    } catch (error) {
      setSending(false);
      const code = editorErrorCode(error);
      setServerError(code ? t(`skills.editor.server.${code}`) : t(adminErrorKey(error)));
    }
  };

  const sub =
    t('skills.editor.sub') +
    (base && agents > 0
      ? agents === 1
        ? t('skills.editor.subOne', { version: base.skill.version })
        : t('skills.editor.subMany', { count: agents, version: base.skill.version })
      : '') +
    '.';

  return (
    <GovModal
      title={
        base
          ? t('skills.editor.versionTitle', {
              name: base.skill.name,
              from: base.skill.version,
              to: base.skill.version + 1,
            })
          : t('skills.editor.newTitle')
      }
      sub={sub}
      width={720}
      sheet
      busy={sending}
      onClose={onClose}
      footer={
        <div className="sk-edit-foot">
          <input
            className={tried && !reason.trim() ? 'input sk-invalid' : 'input'}
            value={reason}
            maxLength={REASON_MAX_LENGTH}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            placeholder={t('skills.editor.reasonPlaceholder')}
            aria-label={t('skills.editor.reason')}
          />
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={sending}>
            {t('skills.editor.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={sending}
            onClick={() => {
              void save();
            }}
          >
            {sending ? t('skills.editor.sending') : t('skills.editor.submit')}
          </button>
        </div>
      }
    >
      <div className="sk-edit">
        <div className="sk-edit-col">
          <div>
            <Label htmlFor={ids.name}>{t('skills.editor.name')}</Label>
            <input
              id={ids.name}
              className="input"
              value={draft.name}
              maxLength={NAME_MAX_LENGTH}
              onChange={(event) => {
                patch({ name: event.target.value });
              }}
            />
          </div>
          <div className="sk-edit-pair">
            <div>
              <Label htmlFor={ids.category}>{t('skills.editor.category')}</Label>
              <select
                id={ids.category}
                className="input"
                value={draft.category}
                onChange={(event) => {
                  patch({ category: event.target.value });
                }}
              >
                {categories.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor={ids.description}>{t('skills.editor.description')}</Label>
              <input
                id={ids.description}
                className="input"
                value={draft.description}
                maxLength={DESCRIPTION_MAX_LENGTH}
                onChange={(event) => {
                  patch({ description: event.target.value });
                }}
              />
            </div>
          </div>
          <div>
            <Label
              htmlFor={ids.instructions}
              hint={
                draft.instructions.length > INSTRUCTIONS_COUNTER_FROM
                  ? t('skills.editor.counter', {
                      n: draft.instructions.length.toLocaleString('es-ES'),
                    })
                  : t('skills.editor.instructionsHint', { example: '{{variable}}' })
              }
            >
              {t('skills.editor.instructions')}
            </Label>
            <textarea
              id={ids.instructions}
              className={secret ? 'input mono sk-ins-input sk-invalid' : 'input mono sk-ins-input'}
              rows={10}
              maxLength={INSTRUCTIONS_MAX_LENGTH}
              value={draft.instructions}
              onChange={(event) => {
                patch({ instructions: event.target.value });
              }}
              placeholder={t('skills.editor.placeholder', {
                service: '{{servicio}}',
                period: '{{período}}',
              })}
            />
            {secret ? <div className="sk-err">{t('skills.editor.secret')}</div> : null}
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <span className="mk-meta">{t('skills.editor.variables')}</span>
              {vars.length ? (
                vars.map((name) => (
                  <code key={name} className="mc-tool-chip">
                    {name}
                  </code>
                ))
              ) : (
                <span className="mk-meta">{t('skills.editor.noVariables')}</span>
              )}
            </div>
          </div>
          <div>
            <Label>{t('skills.editor.outputs')}</Label>
            <div className="flex flex-wrap items-center gap-1">
              {draft.outputs.map((item) => (
                <span key={item} className="badge gap-1.5">
                  {item}
                  <button
                    type="button"
                    className="flex"
                    aria-label={t('skills.editor.removeOutput', { output: item })}
                    onClick={() => {
                      patch({ outputs: draft.outputs.filter((value) => value !== item) });
                    }}
                  >
                    <CloseIcon size={9} />
                  </button>
                </span>
              ))}
              {draft.outputs.length < MAX_OUTPUTS ? (
                <input
                  className="input sk-out-input"
                  value={output}
                  maxLength={OUTPUT_MAX_LENGTH}
                  aria-label={t('skills.editor.outputLabel')}
                  placeholder={t('skills.editor.outputPlaceholder')}
                  onChange={(event) => {
                    setOutput(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    const value = output.trim();
                    if (event.key !== 'Enter' || !value) return;
                    event.preventDefault();
                    patch({ outputs: [...new Set([...draft.outputs, value])] });
                    setOutput('');
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>
        <div>
          <Label hint={t('skills.editor.serversCount', { count: draft.servers.length })}>
            {t('skills.editor.servers')}
          </Label>
          {catalogFailed ? (
            <div className="sk-err" role="alert">
              {t('skills.editor.serversError')}
            </div>
          ) : (
            <div className="ab-list sk-servers" aria-busy={catalog === null}>
              {(catalog ?? []).map((server) => {
                const on = draft.servers.includes(server.id);
                const usable = server.enabled && draft.servers.length < MAX_SERVERS;
                const write = server.tools.some((tool) => tool.access !== 'read');
                return (
                  <button
                    key={server.id}
                    type="button"
                    className={
                      on ? 'ab-item is-on' : !server.enabled ? 'ab-item is-dim' : 'ab-item'
                    }
                    disabled={!on && !usable}
                    aria-pressed={on}
                    onClick={() => {
                      patch({
                        servers: on
                          ? draft.servers.filter((id) => id !== server.id)
                          : [...draft.servers, server.id],
                      });
                    }}
                  >
                    <span className="ab-check">{on ? <CheckIcon size={10} /> : null}</span>
                    <span className="ab-item-text">
                      <span className="ab-item-name">{server.name}</span>
                      <span className="ab-sub">
                        {server.enabled
                          ? t('skills.editor.serverTools', { count: server.tools.length }) +
                            (write ? t('skills.editor.serverWrite') : '')
                          : t(`mcpCatalog.status.${statusOf(server)}`)}
                      </span>
                    </span>
                    <ServerLevelBadge server={server} />
                  </button>
                );
              })}
            </div>
          )}
          <div className="mk-meta mt-2 leading-normal">
            {t('skills.editor.resultLevel')} <LevelBadge tier={level} />
            {writes ? t('skills.editor.resultWrites') : ''}
          </div>
        </div>
      </div>
      {tried && errors.length > 0 ? (
        <div className="sk-err">
          {errors.map((error) => t(`skills.editor.errors.${error}`)).join(' · ')}
        </div>
      ) : null}
      {serverError ? (
        <div className="sk-err" role="alert">
          {serverError}
        </div>
      ) : null}
    </GovModal>
  );
}
