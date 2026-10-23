import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminErrorKey, apiErrorCode } from '../../api/adminErrors';
import { useSession } from '../../auth/useSession';
import { CheckIcon } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { SoonTag } from '../../components/Soon';
import { GroupChips, Notice, ScheduleChips } from './parts';
import {
  DEFAULT_SCHEDULE,
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  hasSecret,
  isErrorKey,
  locationError,
  type KnowledgeBase,
  type Origin,
  type Schedule,
} from './model';

/** Errors of the API with a text of their own in this dialog. */
const OWN_ERRORS = new Set([
  'mango_bucket',
  'bucket_not_in_account',
  'bucket_not_found',
  'bucket_key_unsupported',
  'source_check_unavailable',
  'secret_in_knowledge_base',
  'group_unknown',
]);

const SOON_SOURCES = ['Confluence', 'Google Drive', 'GitHub'] as const;

interface Props {
  /** The groups to choose from; null while they load (or if they could not be read). */
  groups: readonly string[] | null;
  onClose: () => void;
  onCreated: (kb: KnowledgeBase, toast: string) => void;
}

/**
 * «Nueva knowledge base» (design `KbCreate`). A knowledge base of files is created and opened on
 * its documents; one of a bucket is created and its bucket proposed, which a different
 * administrator approves (D88 (20), (42)). The origin never changes afterwards.
 */
export function KbCreate({ groups, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [origin, setOrigin] = useState<Origin>('upload');
  const [location, setLocation] = useState('');
  const [schedule, setSchedule] = useState<Schedule>(DEFAULT_SCHEDULE);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const bucket = origin === 'bucket';
  const refError = bucket ? locationError(location) : null;
  const errors = [
    !name.trim() && t('knowledge.errors.name'),
    refError && t(`knowledge.errors.${refError}`),
    chosen.length === 0 && t('knowledge.errors.groups'),
    hasSecret(name, description, bucket ? location : '') && t('knowledge.errors.secret'),
  ].filter((error): error is string => Boolean(error));
  const mineIn = chosen.some((group) => me.groups.includes(group));

  const messageOf = (error: unknown) => {
    const code = apiErrorCode(error);
    return isErrorKey(code, OWN_ERRORS) ? t(`knowledge.errors.${code}`) : t(adminErrorKey(error));
  };

  const save = async () => {
    setTried(true);
    setServerError(null);
    if (errors.length) return;
    setSending(true);
    let created: KnowledgeBase;
    try {
      created = await api.call('createNewKnowledgeBase', {
        body: {
          name: name.trim(),
          description: description.trim(),
          origin,
          groups: [...chosen],
          ...(bucket ? { sync_schedule: schedule } : {}),
        },
      });
    } catch (error) {
      setSending(false);
      setServerError(messageOf(error));
      return;
    }
    if (!bucket) {
      onCreated(created, t('knowledge.toast.createdUpload'));
      return;
    }
    try {
      await api.call('propose', {
        path: { kb_id: created.kb_id },
        body: { location: location.trim() },
      });
      onCreated(created, t('knowledge.toast.createdBucket'));
    } catch (error) {
      // The knowledge base exists: it opens without a bucket, and says why.
      onCreated(created, `${t('knowledge.errors.createdWithoutSource')} ${messageOf(error)}`);
    }
  };

  const fieldError = serverError ?? (tried ? refError && t(`knowledge.errors.${refError}`) : null);

  return (
    <Modal
      title={t('knowledge.create.title')}
      description={t('knowledge.create.description')}
      onClose={onClose}
      busy={sending}
      wide
      footer={
        <>
          {bucket ? (
            <span className="mk-meta mr-auto self-center">
              {t('knowledge.create.approvedByOther')}
            </span>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={sending}>
            {t('knowledge.create.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={sending}
            onClick={() => {
              void save();
            }}
          >
            {sending
              ? t('knowledge.create.sending')
              : bucket
                ? t('knowledge.create.submitBucket')
                : t('knowledge.create.submitUpload')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor="kb-n" className="kb-lb">
            {t('knowledge.create.name')}
          </label>
          <input
            id="kb-n"
            className="input"
            value={name}
            maxLength={NAME_MAX_LENGTH}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div>
          <label htmlFor="kb-d" className="kb-lb">
            {t('knowledge.create.desc')}
          </label>
          <input
            id="kb-d"
            className="input"
            value={description}
            maxLength={DESCRIPTION_MAX_LENGTH}
            placeholder={t('knowledge.create.descPlaceholder')}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
        <div>
          <span className="kb-lb">{t('knowledge.create.source')}</span>
          <div className="kb-src" role="group" aria-label={t('knowledge.create.source')}>
            <button type="button" className="ab-chip is-on" aria-pressed="true">
              <CheckIcon size={10} />
              S3
            </button>
            {SOON_SOURCES.map((source) => (
              <button
                key={source}
                type="button"
                className="ab-chip"
                disabled
                title={t('knowledge.create.sourceSoon')}
              >
                {source} <SoonTag />
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="kb-lb">{t('knowledge.create.how')}</span>
          <div className="kb-origin-opts" role="radiogroup" aria-label={t('knowledge.create.how')}>
            {(['upload', 'bucket'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={origin === value}
                className={origin === value ? 'kb-opt is-on' : 'kb-opt'}
                onClick={() => {
                  setOrigin(value);
                  setServerError(null);
                }}
              >
                <b>{t(`knowledge.create.${value}`)}</b>
                <span>{t(`knowledge.create.${value}Help`)}</span>
              </button>
            ))}
          </div>
          <div className="mk-meta mt-1.5 leading-normal">{t('knowledge.create.originHelp')}</div>
        </div>
        {bucket ? (
          <div>
            <label htmlFor="kb-r" className="kb-lb">
              {t('knowledge.create.ref')}
            </label>
            <input
              id="kb-r"
              className="input mono"
              value={location}
              maxLength={600}
              placeholder={t('knowledge.access.refPlaceholder')}
              aria-invalid={Boolean(fieldError)}
              onChange={(event) => {
                setLocation(event.target.value);
                setServerError(null);
              }}
            />
            {fieldError ? (
              <div className="kb-err" role="alert">
                {fieldError}
              </div>
            ) : null}
            <div className="mk-meta mt-1.5 leading-normal">{t('knowledge.create.refHelp')}</div>
          </div>
        ) : null}
        {bucket ? (
          <div>
            <span className="kb-lb">{t('knowledge.create.sync')}</span>
            <ScheduleChips value={schedule} onChange={setSchedule} />
          </div>
        ) : null}
        <div>
          <span className="kb-lb">{t('knowledge.create.groups')}</span>
          <GroupChips options={groups ?? []} value={chosen} onChange={setChosen} />
          {chosen.length > 0 && !mineIn ? (
            <Notice tone="amber" className="mt-2">
              {t('knowledge.access.notInGroups')}
            </Notice>
          ) : null}
          <div className="mk-meta mt-1.5 leading-normal">{t('knowledge.create.groupsHelp')}</div>
        </div>
        {!bucket && serverError ? (
          <div className="kb-err" role="alert">
            {serverError}
          </div>
        ) : null}
        {tried && errors.length > 0 ? (
          <div className="kb-err" role="alert">
            {errors.join(' · ')}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
