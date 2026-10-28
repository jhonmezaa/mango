import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Badge } from '../../components/Badge';
import { ArrowRightIcon, ChevronLeftIcon, ExternalIcon } from '../../components/icons';
import { formatRelative } from '../../lib/format';
import { REMOTE_KEY_PREFIX, type RemoteInboxItem } from './inboxItems';
import { remotePath } from './model';

function useTexts(item: RemoteInboxItem) {
  const { t } = useTranslation();
  const request = item.row.request;
  const title = t('remoteMcp.inbox.title', {
    name: item.profile.name,
    organization: request?.organization ?? item.row.registration.organization,
  });
  const body =
    (request?.kind === 'params'
      ? t('remoteMcp.inbox.params')
      : request?.kind === 'replace_app'
        ? t('remoteMcp.inbox.replace')
        : '') +
    t('remoteMcp.inbox.body', {
      toolsets: request?.toolsets.length ?? 0,
      groups: (request?.groups ?? []).join(', '),
    });
  return { title, body, at: request?.created_at ?? '' };
}

export function RemoteInboxRow({
  item,
  active,
  now,
  onOpen,
}: {
  item: RemoteInboxItem;
  active: boolean;
  now: number;
  onOpen: (key: string) => void;
}) {
  const { title, body, at } = useTexts(item);
  return (
    <button
      type="button"
      id={`inbox-row-remote-${item.key.slice(REMOTE_KEY_PREFIX.length)}`}
      role="option"
      aria-selected={active}
      className={active ? 'inbox-row on' : 'inbox-row'}
      onClick={() => {
        onOpen(item.key);
      }}
    >
      <span className="inbox-dot" />
      <span className="inbox-ic is-amber">
        <ExternalIcon size={15} />
      </span>
      <span className="inbox-row-main">
        <span className="inbox-row-t">{title}</span>
        <span className="inbox-row-s">{body}</span>
      </span>
      <span className="inbox-row-time">{at ? formatRelative(at, now) : ''}</span>
    </button>
  );
}

export function RemoteInboxDetail({
  item,
  now,
  titleRef,
  onBack,
}: {
  item: RemoteInboxItem;
  now: number;
  titleRef: Ref<HTMLHeadingElement>;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { title, body, at } = useTexts(item);
  return (
    <div>
      <button type="button" className="btn btn-sm btn-ghost inbox-back" onClick={onBack}>
        <ChevronLeftIcon size={12} /> {t('inbox.backToList')}
      </button>
      <div className="inbox-detail-h">
        <Badge>{t('remoteMcp.inbox.type')}</Badge>
      </div>
      <h2 className="inbox-detail-t" ref={titleRef} tabIndex={-1}>
        {title}
      </h2>
      <div className="inbox-detail-m">
        {t('remoteMcp.inbox.meta')} · {at ? formatRelative(at, now) : ''}
      </div>
      <p className="inbox-detail-b">{body}</p>
      <div className="inbox-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            void navigate(remotePath(item.profile.id, item.row));
          }}
        >
          {t('remoteMcp.inbox.review')} <ArrowRightIcon size={11} />
        </button>
      </div>
    </div>
  );
}
