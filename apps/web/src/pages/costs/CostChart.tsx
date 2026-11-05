import { useMemo, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cumulative, kmoney, money, num, type Costs } from './model';

const W = 720;
const H = 200;
const PL = 8;
const PR = 8;
const PT = 14;
const PB = 22;
const GRID = [0.25, 0.5, 0.75] as const;

/**
 * «Gasto acumulado del mes» (design round 37 `CostChart`): this month day by day, the month
 * before and, from the fifth day, the projection at the current pace. Both curves are the
 * organization's day counter (`DAY#ORG`), real spend of each day.
 */
export function CostChart({ data }: { data: Costs }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const days = data.days_in_month;
  const day = data.elapsed_days;
  const total = num(data.spent_usd);
  const projected = data.projected_usd === null ? null : num(data.projected_usd);
  const { current, previous } = useMemo(() => {
    const before = cumulative(data.previous_days);
    // The month before, on this month's days (a shorter month keeps its last total).
    const last = before.at(-1) ?? 0;
    return {
      current: cumulative(data.days),
      previous: Array.from({ length: days }, (_, i) => before[i] ?? last),
    };
  }, [data.days, data.previous_days, days]);
  const top = Math.max(total, projected ?? 0, previous.at(-1) ?? 0, 0.01) * 1.08;
  const x = (i: number) => PL + (i / Math.max(1, days - 1)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - v / top) * (H - PT - PB);
  const path = (points: [number, number][]) =>
    points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const last = day - 1;
  const actual = current.map((v, i): [number, number] => [x(i), y(v)]);
  const lastValue = current[last] ?? 0;
  const projection: [number, number][] | null =
    projected === null
      ? null
      : [
          [x(last), y(lastValue)],
          [x(days - 1), y(projected)],
        ];
  const area = actual.length
    ? `${path(actual)} L${x(last).toFixed(1)} ${String(y(0))} L${String(x(0))} ${String(y(0))} Z`
    : '';
  const at = hover ?? last;
  const value =
    at <= last
      ? (current[at] ?? 0)
      : projected === null
        ? null
        : lastValue + ((projected - lastValue) * (at - last)) / Math.max(1, days - 1 - last);
  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const index = Math.round(((px - PL) / (W - PL - PR)) * (days - 1));
    setHover(Math.max(0, Math.min(days - 1, index)));
  };
  return (
    <div className="card co-chart">
      <div className="co-chart-h">
        <div>
          <div className="mk-sec-t co-flush">{t('costs.chart.title')}</div>
          <div className="co-chart-v">
            <b className="mono">{value === null ? '—' : money(value)}</b>{' '}
            <span className="mk-meta">
              {at <= last
                ? t('costs.chart.atDay', { day: at + 1 })
                : t('costs.chart.projectedAt', { day: at + 1 })}{' '}
              · {t('costs.chart.previous', { amount: money(previous[at] ?? 0) })}
            </span>
          </div>
        </div>
        <div className="co-legend">
          <span>
            <i className="co-i-accent" />
            {t('costs.chart.thisMonth')}
          </span>
          {projected !== null && (
            <span>
              <i className="dash" />
              {t('costs.chart.projection')}
            </span>
          )}
          <span>
            <i className="co-i-prev" />
            {t('costs.chart.previousMonth')}
          </span>
        </div>
      </div>
      <div className="co-plot">
        {GRID.map((f) => (
          <span key={f} className="co-ylab" style={{ top: `${String((y(top * f) / H) * 100)}%` }}>
            {kmoney(top * f)}
          </span>
        ))}
        <svg
          viewBox={`0 0 ${String(W)} ${String(H)}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          onMouseMove={onMove}
          onMouseLeave={() => {
            setHover(null);
          }}
          role="img"
          aria-label={t('costs.chart.label', {
            amount: money(total),
            day,
            projection: projected === null ? t('costs.chart.noProjection') : money(projected),
          })}
          className="co-svg"
        >
          <defs>
            <linearGradient id="co-g" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity=".18" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {GRID.map((f) => (
            <line
              key={f}
              x1={PL}
              x2={W - PR}
              y1={y(top * f)}
              y2={y(top * f)}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={PL}
            x2={W - PR}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--border-strong)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path(previous.map((v, i) => [x(i), y(v)]))}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          {area && <path d={area} fill="url(#co-g)" />}
          {actual.length > 0 && (
            <path
              d={path(actual)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2.2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {projection && (
            <path
              d={path(projection)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeDasharray="5 5"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <line
            x1={x(at)}
            x2={x(at)}
            y1={PT}
            y2={y(0)}
            stroke="var(--text-dim)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            opacity=".5"
          />
          {value !== null && (
            <circle
              cx={x(at)}
              cy={y(value)}
              r="4"
              fill="var(--card)"
              stroke="var(--accent)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
      <div className="co-xlab mk-meta">
        <span className="co-x-start">{t('costs.chart.day1')}</span>
        {day > 3 && day < days - 2 && (
          <span className="co-x-mid" style={{ left: `${String((x(last) / W) * 100)}%` }}>
            {t('costs.chart.today')}
          </span>
        )}
        <span className="co-x-end">
          {day >= days - 2
            ? t('costs.chart.todayOf', { day, days })
            : t('costs.chart.lastDay', { day: days })}
        </span>
      </div>
      {projected !== null && (
        <div className="mk-meta co-close">
          {t('costs.chart.projectedClose')} <b className="mono">{kmoney(projected)}</b>
        </div>
      )}
    </div>
  );
}
