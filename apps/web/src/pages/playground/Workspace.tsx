import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { Banner } from '../../components/admin/govKit';
import type { ToastTone } from '../../components/admin/useToasts';
import { PlayIcon, ShieldIcon } from '../../components/icons';
import { Topbar } from '../../components/Topbar';
import {
  TEMPERATURE_DEFAULT,
  findSecrets,
  modelName,
  precheck,
  problemOfError,
  problemOfViolation,
  toInput,
  type Version,
} from '../agentBuilder/model';
import { problemText } from '../agentBuilder/problemText';
import { MESSAGE_MAX_LENGTH } from '../../api/schemas';
import {
  SAMPLE_KEYS,
  publishedVersionOf,
  testModels,
  withChanges,
  type Block,
  type Column,
  type Source,
} from './model';
import { RunCard, type Vote } from './RunCard';
import { SidePanel, type Compare } from './SidePanel';
import type { PlaygroundData } from './usePlaygroundData';
import { usePlaygroundRuns } from './usePlaygroundRuns';

type VersionState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; version: Version };

/** What changed on screen; null keeps the stored value. Temperature is only for this screen. */
interface Edits {
  prompt: string | null;
  model: string | null;
  temperature: number | null;
}

interface Props {
  source: Source;
  data: PlaygroundData;
  onSelect: (key: string) => void;
  onReload: () => void;
  /** After a save (the draft's key) or a submission (null). */
  onWritten: (key: string | null) => Promise<void>;
  onUnavailable: () => void;
  notify: (msg: string, tone?: ToastTone) => void;
}

const NO_SKILLS: readonly string[] = [];

/** The Agent Builder on the draft, or on the published agent (an id the API returned). */
const builderPath = (source: Source) =>
  source.kind === 'draft'
    ? `/admin/${encodeURIComponent(source.agentId)}/${String(source.version)}`
    : `/admin/${encodeURIComponent(source.agentId)}`;

const draftKey = (agentId: string, version: number) => `draft:${agentId}:${String(version)}`;

/** The screen for one source: its version, what changes, the tests and their answers. */
export function Workspace({
  source,
  data,
  onSelect,
  onReload,
  onWritten,
  onUnavailable,
  notify,
}: Props) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { context } = data;
  const [versionState, setVersionState] = useState<VersionState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [edits, setEdits] = useState<Edits>({ prompt: null, model: null, temperature: null });
  const [compare, setCompare] = useState<Compare>('none');
  const [modelB, setModelB] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [openTrace, setOpenTrace] = useState<Record<string, boolean>>({});
  const [votes, setVotes] = useState<Record<string, Vote>>({});
  const [block, setBlock] = useState<Exclude<Block, { kind: 'unavailable' }> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.call('readVersion', { path: { agent_id: source.agentId, version: source.version } }).then(
      (version) => {
        if (!cancelled) setVersionState({ kind: 'ready', version });
      },
      () => {
        if (!cancelled) setVersionState({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, source.agentId, source.version, attempt]);

  const onBlock = useCallback(
    (next: Block) => {
      if (next.kind === 'unavailable') onUnavailable();
      else setBlock(next);
    },
    [onUnavailable],
  );
  const { runs, start, clear } = usePlaygroundRuns(api, source.agentId, onBlock);

  // Design: «Podrás probar de nuevo en {n} s», counted down until the limit lets go.
  const rateUntil = block?.kind === 'rate' ? block.until : null;
  useEffect(() => {
    if (rateUntil === null) return;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= rateUntil) setBlock(null);
    };
    tick();
    const handle = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(handle);
    };
  }, [rateUntil]);

  const version = versionState.kind === 'ready' ? versionState.version : null;
  const definition = version?.definition ?? null;
  const models = useMemo(
    () => (definition ? testModels(context.models, definition) : []),
    [context.models, definition],
  );

  const storedPrompt = definition?.system_prompt ?? '';
  const storedModel = definition?.model ?? '';
  const storedTemperature = definition?.limits.temperature ?? TEMPERATURE_DEFAULT;
  const prompt = edits.prompt ?? storedPrompt;
  const model = edits.model ?? storedModel;
  const temperature = edits.temperature ?? storedTemperature;
  const modelOff = definition !== null && !models.some((item) => item.id === model);
  const secret = findSecrets(prompt).length > 0;
  const dirty = definition !== null && (prompt !== storedPrompt || model !== storedModel);
  const isDraft = source.kind === 'draft';
  const publishedVersion = version ? publishedVersionOf(version) : null;
  const canEdit = me.can.create_agent || me.is_admin;

  /** The first block that applies: what is on screen, then what the server answered. */
  const shown: Block | { kind: 'secret' } | null = secret
    ? { kind: 'secret' }
    : modelOff
      ? { kind: 'model', reason: 'off' }
      : block;
  // The skills of the version could not be read (a 503): it says so, and the next test may work.
  const canRun = version !== null && (shown === null || shown.kind === 'skills');

  const overrides: Column['overrides'] = {
    ...(prompt !== storedPrompt ? { systemPrompt: prompt } : {}),
    ...(model !== storedModel ? { model } : {}),
    ...(temperature !== storedTemperature ? { temperature } : {}),
  };
  const otherModels = models.filter((item) => item.id !== model);
  const secondModel =
    modelB !== null && otherModels.some((item) => item.id === modelB)
      ? modelB
      : (otherModels[0]?.id ?? null);

  const columns = (): Column[] => {
    if (!version) return [];
    const current: Column = {
      label: null,
      version: version.version,
      revision: isDraft ? version.revision : null,
      model,
      overrides,
    };
    if (compare === 'model' && secondModel) {
      return [
        { ...current, label: { key: 'model', model: modelName(context.models, model) } },
        {
          ...current,
          label: { key: 'model', model: modelName(context.models, secondModel) },
          model: secondModel,
          overrides: { ...overrides, model: secondModel },
        },
      ];
    }
    if (compare === 'published' && publishedVersion !== null) {
      const publishedModel = (isDraft ? version.base?.model : definition?.model) ?? model;
      return [
        {
          label: { key: 'published' },
          version: publishedVersion,
          revision: null,
          model: publishedModel,
          overrides: {},
        },
        { ...current, label: { key: isDraft ? 'draft' : 'changes' } },
      ];
    }
    return [current];
  };

  const runOne = (text: string) => {
    const question = text.trim();
    if (!question || !canRun) return;
    if (block?.kind === 'skills') setBlock(null);
    start(question, columns());
  };
  const samples = SAMPLE_KEYS.map((key) => t(`playground.samples.${key}`));
  const attack = t('playground.attack');

  // --- Save and submit (design `saveDraft` / `submit`; the API validates both) ------------------

  const changed = definition ? withChanges(definition, prompt, model) : null;
  const persist = async (): Promise<Version> => {
    if (!version || !changed) throw new Error('no version');
    let target = version;
    if (!isDraft) {
      const open = version.agent.open_version;
      target =
        open !== null && open !== version.version
          ? await api.call('readVersion', { path: { agent_id: source.agentId, version: open } })
          : await api.call('postVersion', { path: { agent_id: source.agentId }, body: {} });
    }
    const input = toInput(
      withChanges(target.definition, prompt, model),
      context,
      target.definition.description,
    );
    return api.call('putVersion', {
      path: { agent_id: target.agent_id, version: target.version },
      body: { revision: target.revision, definition: input },
    });
  };

  const failText = (error: unknown) => problemText(t, problemOfError(error, null), context.models);

  const save = async () => {
    setBusy('save');
    try {
      const saved = await persist();
      notify(
        isDraft
          ? t('playground.toasts.draftUpdated')
          : t('playground.toasts.savedAsDraft', { name: source.name }),
      );
      await onWritten(draftKey(saved.agent_id, saved.version));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') setConflict(true);
      else notify(failText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const modelOffText = t('playground.model.offProblem', {
    model: modelName(context.models, storedModel),
  });
  /** Design «Antes de enviar»: the Builder's checks, with the design's line for the model. */
  const beforeSubmit = (submitting: boolean): string[] => {
    if (!changed) return [];
    const found = precheck(changed, context, { submitting })
      .filter(
        (item) =>
          !modelOff ||
          !['modelNotEnabled', 'modelRequired', 'modelWithoutTools'].includes(item.key),
      )
      .map((item) => problemText(t, item, context.models));
    return modelOff ? [...found, modelOffText] : found;
  };
  const problems = isDraft ? beforeSubmit(false) : [];

  const submit = async () => {
    if (!version) return;
    const local = beforeSubmit(true);
    if (local.length > 0) {
      notify(local[0] ?? '', 'error');
      return;
    }
    setBusy('submit');
    try {
      const saved = dirty ? await persist() : version;
      await api.call('submitVersion', {
        path: { agent_id: saved.agent_id, version: saved.version },
        body: { revision: saved.revision },
      });
      notify(t('playground.toasts.submitted'));
      await onWritten(null);
    } catch (error) {
      const violation = error instanceof ApiError ? error.violations?.[0] : undefined;
      if (violation) {
        notify(problemText(t, problemOfViolation(violation), context.models), 'error');
      } else if (error instanceof ApiError && error.code === 'version_conflict') {
        setConflict(true);
      } else {
        notify(failText(error), 'error');
      }
    } finally {
      setBusy(null);
    }
  };

  const toggleTrace = useCallback((key: string) => {
    setOpenTrace((current) => ({ ...current, [key]: !current[key] }));
  }, []);
  const vote = useCallback((key: string, value: Vote) => {
    setVotes((current) => ({ ...current, [key]: value }));
  }, []);
  const up = Object.values(votes).filter((value) => value === 'up').length;
  const down = Object.values(votes).filter((value) => value === 'down').length;
  const questions = samples.length + 1;
  const name = definition?.name ?? source.name;

  return (
    <>
      <Topbar
        crumbs={[t('playground.crumbRoot'), t('playground.crumb')]}
        actions={
          canEdit && (
            <>
              {dirty && <span className="badge badge-amber">{t('playground.unsaved')}</span>}
              <button
                type="button"
                className="btn btn-sm"
                disabled={!dirty || version === null || busy !== null}
                title={!dirty ? t('playground.noChanges') : undefined}
                onClick={() => void save()}
              >
                {isDraft ? t('playground.saveDraft') : t('playground.saveAsDraft')}
              </button>
              {isDraft && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={problems.length > 0 || version === null || busy !== null}
                  title={problems[0]}
                  onClick={() => void submit()}
                >
                  {t('playground.submit')}
                </button>
              )}
            </>
          )
        }
      />
      <div className="pg-grid">
        <SidePanel
          source={source}
          data={data}
          version={versionState.kind === 'ready' ? versionState.version : null}
          versionFailed={versionState.kind === 'error'}
          onRetryVersion={() => {
            setVersionState({ kind: 'loading' });
            setAttempt((value) => value + 1);
          }}
          conflict={conflict}
          onReload={onReload}
          onSelect={(key) => {
            clear();
            onSelect(key);
          }}
          models={models}
          model={model}
          modelOff={modelOff}
          onModel={(value) => {
            setEdits((current) => ({ ...current, model: value }));
            setBlock((current) => (current?.kind === 'model' ? null : current));
          }}
          prompt={prompt}
          secret={secret}
          onPrompt={(value) => {
            setEdits((current) => ({ ...current, prompt: value }));
          }}
          temperature={temperature}
          onTemperature={(value) => {
            setEdits((current) => ({ ...current, temperature: value }));
          }}
          compare={compare}
          onCompare={setCompare}
          canComparePublished={publishedVersion !== null}
          modelB={secondModel}
          otherModels={otherModels}
          onModelB={setModelB}
          problems={problems}
          offSkills={shown?.kind === 'skill' ? shown.refs : NO_SKILLS}
        />
        <div className="pg-main">
          <div className="pg-head">
            <div className="pg-chips">
              {samples.map((sample) => (
                <button
                  key={sample}
                  type="button"
                  className="tk-chip"
                  disabled={!canRun}
                  onClick={() => {
                    runOne(sample);
                  }}
                >
                  {sample}
                </button>
              ))}
              <button
                type="button"
                className="tk-chip"
                disabled={!canRun}
                title={t('playground.attackTitle')}
                onClick={() => {
                  runOne(attack);
                }}
              >
                <ShieldIcon size={11} />
                {t('playground.attackLabel')}
              </button>
            </div>
            <div className="pg-head-actions">
              {up + down > 0 && (
                <span className="mk-meta" title={t('playground.votesTitle')}>
                  {t('playground.votes', { up, down })}
                </span>
              )}
              <button
                type="button"
                className="btn btn-sm"
                disabled={!canRun}
                title={
                  compare === 'none'
                    ? t('playground.runAllTitle', { count: questions })
                    : t('playground.runAllTitleCompare', { count: questions, tests: questions * 2 })
                }
                onClick={() => {
                  for (const question of [...samples, attack]) runOne(question);
                }}
              >
                <PlayIcon size={11} />
                {t('playground.runAll')}
              </button>
              {runs.length > 0 && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    clear();
                    setVotes({});
                  }}
                >
                  {t('playground.clear')}
                </button>
              )}
            </div>
          </div>
          {shown && version && (
            <div className="pg-block">
              <BlockBanner
                block={shown}
                name={name}
                model={modelName(context.models, model)}
                now={now}
                skillNames={data.skillNames}
                builderPath={builderPath(source)}
              />
            </div>
          )}
          <div className="pg-runs">
            {runs.length === 0 && (
              <div className="pg-start">
                <PlayIcon size={20} />
                <div className="pg-start-t">{t('playground.emptyRuns.title')}</div>
                <div className="pg-start-b">{t('playground.emptyRuns.body')}</div>
              </div>
            )}
            {runs.map((run) => (
              <div key={run.id} className="pg-run">
                <div className="pg-q">{run.input}</div>
                <div className={run.entries.length > 1 ? 'pg-cols is-two' : 'pg-cols'}>
                  {run.entries.map((entry) => (
                    <RunCard
                      key={entry.key}
                      entry={entry}
                      modelName={modelName(context.models, entry.column.model)}
                      input={run.input}
                      canRun={canRun}
                      traceOpen={openTrace[entry.key] === true}
                      vote={votes[entry.key] ?? null}
                      onToggleTrace={toggleTrace}
                      onVote={vote}
                      onRetry={runOne}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="pg-compose">
            <label htmlFor="pg-input" className="sr-only">
              {t('playground.input.label')}
            </label>
            <input
              id="pg-input"
              className="input"
              value={input}
              maxLength={MESSAGE_MAX_LENGTH}
              placeholder={t('playground.input.placeholder', { name })}
              onChange={(event) => {
                setInput(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && canRun) {
                  runOne(input);
                  setInput('');
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!input.trim() || !canRun}
              onClick={() => {
                runOne(input);
                setInput('');
              }}
            >
              <PlayIcon size={11} />
              {t('playground.input.run')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** The notice over the answers while tests cannot run (design `block`). */
function BlockBanner({
  block,
  name,
  model,
  now,
  skillNames,
  builderPath,
}: {
  block: Exclude<Block, { kind: 'unavailable' }> | { kind: 'secret' };
  name: string;
  model: string;
  now: number;
  skillNames: ReadonlyMap<string, string> | null;
  builderPath: string;
}) {
  const { t } = useTranslation();
  switch (block.kind) {
    case 'secret':
      return (
        <Banner tone="error" title={t('playground.block.secret.title')}>
          {t('playground.block.secret.body')}
        </Banner>
      );
    case 'model':
      return (
        <Banner tone="warn" title={t('playground.block.model.title')}>
          {block.reason === 'off'
            ? t('playground.block.model.body', { model })
            : t('playground.block.model.noTools', { model })}
        </Banner>
      );
    case 'budgetUser':
      return (
        <Banner tone="error" title={t('playground.block.budgetUser.title')}>
          {t('playground.block.budgetUser.body')}
        </Banner>
      );
    case 'budgetAgent':
      return (
        <Banner tone="error" title={t('playground.block.budgetAgent.title', { name })}>
          {t('playground.block.budgetAgent.body')}
        </Banner>
      );
    case 'rate':
      return (
        <Banner tone="warn" title={t('playground.block.rate.title')}>
          {t('playground.block.rate.body', {
            seconds: Math.max(1, Math.ceil((block.until - now) / 1000)),
          })}
        </Banner>
      );
    case 'skills':
      return (
        <Banner tone="warn" title={t('playground.block.skills.title')}>
          {t('playground.block.skills.body')}
        </Banner>
      );
    case 'skill': {
      // Names as text (written by their authors), with the version the server named.
      const skills = new Intl.ListFormat('es', { type: 'conjunction' }).format(
        block.refs.map((ref) => {
          const [id = ref, version = ''] = ref.split('@');
          return t('playground.block.skill.skillVersion', {
            name: skillNames?.get(id) ?? id,
            version,
          });
        }),
      );
      return (
        <Banner tone="error" title={t('playground.block.skill.title')}>
          {block.refs.length > 0
            ? t('playground.block.skill.named', { count: block.refs.length, skills })
            : t('playground.block.skill.body')}
          <div className="mt-2">
            <Link className="btn btn-sm" to={builderPath}>
              {t('playground.block.skill.open')}
            </Link>
          </div>
        </Banner>
      );
    }
    case 'notTestable':
    case 'retired':
      return (
        <Banner tone="error" title={t(`playground.block.${block.kind}.title`)}>
          {t(`playground.block.${block.kind}.body`)}
        </Banner>
      );
  }
}
