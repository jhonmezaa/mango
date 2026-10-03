// Formatting helpers of the governance screens (design: gov/kit.jsx). Amounts arrive from the API
// as decimal strings; they are only converted to numbers for display and percentages.

export type BudgetStatus = 'ok' | 'warn' | 'out';

/** Same thresholds as the budget alerts: 80 % warns, 100 % is exhausted. */
export const WARN_PERCENT = 80;

/** "1.234,50": dot thousands and comma decimals, always 2 decimals (design `fmtNum`). */
export function fmtNum(value: number): string {
  const [int = '0', dec = '00'] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

/** "USD 1.234,50" from a number or the API's decimal string. */
export function usd(amount: number | string): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(value) ? `USD ${fmtNum(value)}` : String(amount);
}

/** Value for a money input: "150,00". */
export function toInput(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value) ? value.toFixed(2).replace('.', ',') : amount;
}

export const toNumber = (amount: string): number => {
  const value = Number(amount);
  return Number.isFinite(value) ? value : 0;
};

/**
 * "septiembre de 2026, día 30 de 30". The API period is the UTC month (budget.current_period), so
 * the day and the month length are UTC too: near midnight a local date would describe another month.
 */
export function periodInfo(period: string | undefined, now: Date) {
  const [year, month] = (period ?? '').split('-').map(Number);
  const valid = Boolean(year && month && month >= 1 && month <= 12);
  const y = valid && year ? year : now.getUTCFullYear();
  const m = valid && month ? month - 1 : now.getUTCMonth();
  return {
    label: new Date(y, m, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }),
    day: now.getUTCDate(),
    days: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
  };
}

export function pctOf(spent: number, limit: number): number {
  return limit > 0 ? (spent / limit) * 100 : 0;
}

/** "99 %" never rounds up to 100 before the limit is really reached. */
export function pctLabel(percent: number): string {
  return `${String(percent >= 100 ? Math.round(percent) : Math.min(99, Math.round(percent)))} %`;
}

export function statusOf(percent: number): BudgetStatus {
  if (percent >= 100) return 'out';
  if (percent >= WARN_PERCENT) return 'warn';
  return 'ok';
}

export const STATUS_BADGE: Record<BudgetStatus, string> = {
  ok: 'badge-green',
  warn: 'badge-amber',
  out: 'badge-red',
};

export const STATUS_COLOR: Record<BudgetStatus, string> = {
  ok: 'var(--green)',
  warn: 'var(--amber)',
  out: 'var(--red)',
};

/** First block of a UUID-like id, for users without an email (design `shortId`). */
export function shortId(id: string): string {
  return (id.split('-')[0] ?? id).slice(0, 8);
}

const dateFormat = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "29 sept 2026, 14:30". Unparseable input is returned unchanged (rendered as text). */
export function fmtDate(value: string | number | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateFormat.format(date);
}

type Translate = (key: RelKey, options: { n: number }) => string;
type RelKey =
  'gov.rel.now' | 'gov.rel.minutes' | 'gov.rel.hours' | 'gov.rel.yesterday' | 'gov.rel.days';

/** "ahora", "hace 5 min", "hace 3 h", "ayer", "hace 4 días" (design `rel`). */
export function rel(value: string, t: Translate, now: number = Date.now()): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return t('gov.rel.now', { n: 0 });
  if (minutes < 60) return t('gov.rel.minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('gov.rel.hours', { n: hours });
  const days = Math.round(hours / 24);
  return days === 1 ? t('gov.rel.yesterday', { n: 1 }) : t('gov.rel.days', { n: days });
}
