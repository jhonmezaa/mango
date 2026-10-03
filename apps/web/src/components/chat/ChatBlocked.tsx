import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { LockIcon, StoreIcon } from '../icons';

/**
 * Why there is no agent to talk to (design chat.jsx `blocked`): the user has none, the one asked
 * for is not listed for them any more, or it was retired. Derived from what GET /api/agents
 * returns; the API refuses the turn on its own.
 */
export type ChatBlockedKind = 'none' | 'unavailable' | 'retired';

/** Empty-conversation state of a chat without a usable agent (design chat.jsx `ChatBlocked`). */
export function ChatBlocked({ kind }: { kind: ChatBlockedKind }) {
  const { t } = useTranslation();
  const Icon = kind === 'none' ? StoreIcon : LockIcon;
  return (
    <div className="chat-blocked" role="status">
      <span className="chat-blocked-icon">
        <Icon size={19} />
      </span>
      <h2 className="chat-blocked-title">{t(`chat.noAgent.${kind}.title`)}</h2>
      <p className="chat-blocked-body">{t(`chat.noAgent.${kind}.body`)}</p>
      <Link className="btn btn-sm" to="/marketplace">
        {t('chat.noAgent.marketplace')}
      </Link>
    </div>
  );
}

/**
 * What takes the place of the composer when no message can be sent (design chat.jsx). The
 * design marks the whole box `aria-disabled`; here it is not, because that would also disable
 * the Marketplace link inside it for assistive technology.
 */
export function BlockedComposer({ kind }: { kind: ChatBlockedKind }) {
  const { t } = useTranslation();
  return (
    <div className="composer-blocked">
      <div className="composer-blocked-box">
        <LockIcon size={13} />
        <span>{t(`chat.noAgent.${kind}.composer`)}</span>
        <Link className="sr-link ml-auto" to="/marketplace">
          {t('chat.noAgent.marketplace')}
        </Link>
      </div>
    </div>
  );
}
