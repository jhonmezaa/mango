import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import { shortId } from './model';
import type { TicketCall } from './toolCall';

/**
 * Design round 37: the confirmation card of the chat says which ticket the tool writes.
 * «Crea el ticket «{título}»» comes from the stored arguments. For a change or a comment the
 * request only carries the ticket id, so the card reads the ticket's title (the person may see
 * it: the API decided EditTicket or CommentTicket before creating the request); when it cannot be
 * read, only the short id shows. Every value is rendered as React text.
 */
export function TicketCallTitle({ api, call }: { api: ApiClient; call: TicketCall }) {
  const { t } = useTranslation();
  const ticketId = call.op === 'create' ? null : call.ticketId;
  const [title, setTitle] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    if (ticketId === null) return undefined;
    const controller = new AbortController();
    api.call('getTicket', { path: { ticket_id: ticketId } }, { signal: controller.signal }).then(
      (ticket) => {
        setTitle({ id: ticketId, title: ticket.title });
      },
      // 404, 503…: the card keeps the id alone.
      () => undefined,
    );
    return () => {
      controller.abort();
    };
  }, [api, ticketId]);

  if (call.op === 'create') return <>{t('tickets.call.create', { title: call.title })}</>;
  const known = title?.id === call.ticketId ? title.title : null;
  const change =
    call.op === 'update' && call.changes.length > 0
      ? call.changes
          .map((item) =>
            item.field === 'status'
              ? t('tickets.call.status', { status: t(`tickets.status.${item.value}`) })
              : item.field === 'priority'
                ? t('tickets.call.priority', { priority: t(`tickets.priority.${item.value}`) })
                : t('tickets.call.assignMe'),
          )
          .join(', ')
      : null;
  return (
    <>
      {t(call.op === 'update' ? 'tickets.call.update' : 'tickets.call.comment')}{' '}
      <span className="tk-call-id">{shortId(call.ticketId)}</span>
      {known ? t('tickets.call.titled', { title: known }) : null}
      {change ? t('tickets.call.change', { change }) : null}
    </>
  );
}
