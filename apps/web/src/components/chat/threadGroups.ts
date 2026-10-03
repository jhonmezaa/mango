import type { ConversationSummary } from '../../api/schemas';

export type ThreadGroupKey = 'today' | 'yesterday' | 'week' | 'older';

export interface ThreadGroup {
  key: ThreadGroupKey;
  items: ConversationSummary[];
}

const LOCALE = 'es';
const ORDER: ThreadGroupKey[] = ['today', 'yesterday', 'week', 'older'];
const DAY_MS = 86_400_000;

const clock = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const shortDate = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });

function parse(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole calendar days (local time) between `date` and `now`; negative for future dates. */
function daysAgo(date: Date, now: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(now) - start(date)) / DAY_MS);
}

function groupOf(value: string, now: Date): ThreadGroupKey {
  const date = parse(value);
  if (!date) return 'older';
  const days = daysAgo(date, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  return 'older';
}

/**
 * Groups the history like the design (chat.jsx threadGroup): Hoy, Ayer, Esta semana and Anteriores
 * (older than a week). The API has no pinned conversations, so there is no "Fijadas" group. The API
 * already sorts by `updated_at`.
 */
export function groupThreads(
  conversations: ConversationSummary[],
  now: Date = new Date(),
): ThreadGroup[] {
  const buckets = new Map<ThreadGroupKey, ConversationSummary[]>();
  for (const conversation of conversations) {
    const key = groupOf(conversation.updated_at, now);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(conversation);
    else buckets.set(key, [conversation]);
  }
  return ORDER.flatMap((key) => {
    const items = buckets.get(key);
    return items ? [{ key, items }] : [];
  });
}

/** Row time as in the design: "12:04" today, "Ayer", "lun" this week, "12 sept" before. */
export function formatThreadTime(
  value: string,
  yesterdayLabel: string,
  now: Date = new Date(),
): string {
  const date = parse(value);
  if (!date) return value;
  switch (groupOf(value, now)) {
    case 'today':
      return clock.format(date);
    case 'yesterday':
      return yesterdayLabel;
    case 'week':
      return weekday.format(date);
    case 'older':
      return shortDate.format(date);
  }
}

/** Message time ("12:03"); unparseable input yields nothing rather than raw text. */
export function formatMessageTime(value: string | undefined): string | null {
  const date = value ? parse(value) : null;
  return date ? clock.format(date) : null;
}
