const LOCALE = 'es';

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto', style: 'short' });
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const seconds = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

function parse(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "hace 5 min", "ayer"… Unparseable input is returned unchanged (it is rendered as text). */
export function formatRelative(value: string, now: number = Date.now()): string {
  const date = parse(value);
  if (!date) return value;
  const diffSeconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return relative.format(0, 'second');
  if (abs < 3600) return relative.format(Math.round(diffSeconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(diffSeconds / 3600), 'hour');
  if (abs < 30 * 86_400) return relative.format(Math.round(diffSeconds / 86_400), 'day');
  return dateTime.format(date);
}

export function formatDateTime(value: string): string {
  const date = parse(value);
  return date ? dateTime.format(date) : value;
}

/** Client-measured tool duration: "820 ms" or "1,2 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))} ms`;
  return `${seconds.format(ms / 1000)} s`;
}

/** Two-letter avatar from the user identifier (rendered as text). */
export function initialsFor(userId: string): string {
  const local = userId.split('@')[0] ?? userId;
  const parts = local.split(/[._\-\s]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : local.slice(0, 2);
  return letters.toUpperCase() || '?';
}

const usd = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "USD 1.234,50" from the API's decimal string. Unparseable input is returned unchanged. */
export function formatUsd(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value) ? `USD ${usd.format(value)}` : amount;
}

/** Spent / limit as an integer percentage (0 when there is no limit). */
export function budgetPercent(spent: string, limit: string): number {
  const used = Number(spent);
  const cap = Number(limit);
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.round((used / cap) * 100);
}

export type BudgetTone = 'ok' | 'warn' | 'over';

/** Same thresholds as the budget alerts: 80 % warns, 100 % is exhausted. */
export function budgetTone(percent: number): BudgetTone {
  if (percent >= 100) return 'over';
  if (percent >= 80) return 'warn';
  return 'ok';
}
