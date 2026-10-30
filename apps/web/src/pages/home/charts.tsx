import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { usd } from '../../components/admin/govFormat';
import { CheckIcon, ChevronDownIcon, InfoIcon, ShareIcon, X2Icon } from '../../components/icons';
import { deltaOf, fmtCompact, fmtDay, niceMax, sum, type Series } from './model';

// Analytics primitives of the design (charts.jsx: LineChart, MetricCard, ListCard, FilterPills),
// fed with the series of GET /api/home instead of the design's seeded ones.

const AXIS_W = 48;
const PAD_T = 8;
const PAD_B = 24;
const HEIGHT = 200;

const num = (value: number) => value.toLocaleString('es-ES', { maximumFractionDigits: 0 });
const pct = (value: number) => value.toLocaleString('es-ES', { maximumFractionDigits: 1 });

/** Design: `USD 12,3k` from 10.000 up, `usd()` below. */
function moneyShort(value: number): string {
  return value >= 10000
    ? `USD ${(value / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}k`
    : usd(value);
}

interface LineChartProps {
  series: Series;
  money: boolean;
  compare: boolean;
  label: string;
}

/** Design `LineChart`: the period in the accent colour, the one before dashed, a tooltip. */
export function LineChart({ series, money, compare, label }: LineChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = wrap.current;
    if (!node) return;
    setWidth(Math.max(200, node.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(200, entry.contentRect.width));
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  const { cur, prev, dates, prevDates } = series;
  const plotW = width - AXIS_W;
  const plotH = HEIGHT - PAD_T - PAD_B;
  const max = niceMax(Math.max(0, ...cur, ...(compare ? prev : [])) * 1.05);
  const last = Math.max(1, cur.length - 1);
  const x = (i: number) => (i / last) * (plotW - 4) + 2;
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const path = (values: readonly number[]) =>
    values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const fmt = (v: number) => (money ? usd(v) : num(v));
  const point = hover === null ? null : { i: hover, c: cur[hover] ?? 0, p: prev[hover] ?? 0 };
  const delta = point ? deltaOf(point.c, point.p) : 0;
  const right = point ? x(point.i) > plotW * 0.55 : false;
  return (
    <div ref={wrap} className="hm-chart">
      <svg width={width} height={HEIGHT} role="img" aria-label={label} className="hm-chart-svg">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={0} x2={plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={width} y={y(t) + 4} textAnchor="end" className="hm-tick">
              {fmtCompact(t, money)}
            </text>
          </g>
        ))}
        {compare ? (
          <path
            d={path(prev)}
            fill="none"
            stroke="var(--chart-muted)"
            strokeWidth="1.5"
            strokeDasharray="2 4"
            strokeLinecap="round"
          />
        ) : null}
        <path
          d={path(cur)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        {point ? (
          <>
            <line
              x1={x(point.i)}
              x2={x(point.i)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="var(--text-muted)"
              strokeDasharray="2 3"
            />
            {compare ? (
              <circle
                cx={x(point.i)}
                cy={y(point.p)}
                r="4"
                fill="var(--chart-muted)"
                stroke="var(--card)"
                strokeWidth="2"
              />
            ) : null}
            <circle
              cx={x(point.i)}
              cy={y(point.c)}
              r="4.5"
              fill="var(--accent)"
              stroke="var(--card)"
              strokeWidth="2"
            />
          </>
        ) : null}
        <text x={2} y={HEIGHT - 4} className="hm-tick">
          {dates[0] ? fmtDay(dates[0]) : ''}
        </text>
        <text x={plotW - 2} y={HEIGHT - 4} textAnchor="end" className="hm-tick">
          {dates.length ? fmtDay(dates[dates.length - 1] ?? '') : ''}
        </text>
        <rect
          x={0}
          y={0}
          width={plotW}
          height={PAD_T + plotH}
          fill="transparent"
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const i = Math.round(((event.clientX - rect.left - 2) / (plotW - 4)) * last);
            setHover(Math.max(0, Math.min(cur.length - 1, i)));
          }}
          onMouseLeave={() => {
            setHover(null);
          }}
        />
      </svg>
      {point ? (
        <div
          role="tooltip"
          className="hm-tip"
          style={{
            top: Math.max(0, Math.min(y(point.c) - 20, HEIGHT - 110)),
            ...(right ? { right: width - x(point.i) + 14 } : { left: x(point.i) + 14 }),
          }}
        >
          <div className="hm-tip-row hm-tip-head">
            <span className="hm-tip-label">{label}</span>
            {compare ? (
              <span className={delta >= 0 ? 'hm-up' : 'hm-down'}>
                {delta >= 0 ? '+' : ''}
                {delta.toFixed(1)}%
              </span>
            ) : null}
          </div>
          <div className="hm-tip-row">
            <span className="hm-tip-key">
              <span className="hm-swatch hm-swatch-cur" />
              <span className="hm-muted">{fmtDay(dates[point.i] ?? '')}</span>
            </span>
            <span className="hm-num">{fmt(point.c)}</span>
          </div>
          {compare ? (
            <div className="hm-tip-row hm-tip-prev">
              <span className="hm-tip-key">
                <span className="hm-swatch hm-swatch-prev" />
                <span className="hm-muted">{fmtDay(prevDates[point.i] ?? '')}</span>
              </span>
              <span className="hm-num">{fmt(point.p)}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Design `InfoDot`. */
export function InfoDot({ text }: { text: string }) {
  return (
    <span title={text} aria-label={text} role="img" className="hm-info">
      <InfoIcon size={13} />
    </span>
  );
}

/** Design `CardFooter`; `more` is a ready control (a link button or a «Próximamente»). */
export function CardFooter({ updated, more }: { updated: string; more?: ReactNode }) {
  return (
    <div className="hm-foot">
      <span>{updated}</span>
      {more}
    </div>
  );
}

interface MetricCardProps {
  title: string;
  info: string;
  series: Series;
  money?: boolean;
  compare: boolean;
  goodWhen?: 'up' | 'down';
  updated: string;
  more: ReactNode;
  onExport: () => void;
}

/** Design `MetricCard`: the total of the period, its change and the chart. */
export function MetricCard({
  title,
  info,
  series,
  money = false,
  compare,
  goodWhen = 'up',
  updated,
  more,
  onExport,
}: MetricCardProps) {
  const { t } = useTranslation();
  const total = sum(series.cur);
  const previous = sum(series.prev);
  const delta = deltaOf(total, previous);
  const good = goodWhen === 'up' ? delta >= 0 : delta <= 0;
  const show = (value: number) => (money ? moneyShort(value) : num(value));
  return (
    <section className="card metric-card">
      <div className="hm-head">
        <div>
          <h2 className="hm-title">
            {title}
            <InfoDot text={info} />
          </h2>
          <div className="hm-total-row">
            <span className="hm-total" title={money ? usd(total) : undefined}>
              {show(total)}
            </span>
            {compare ? (
              <span className={good ? 'hm-delta hm-up' : 'hm-delta hm-down'}>
                {delta >= 0 ? '+' : ''}
                {pct(delta)}%
              </span>
            ) : null}
          </div>
          {compare ? (
            <div className="hm-prev">{t('home.previous', { value: show(previous) })}</div>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={t('home.exportOf', { title })}
          title={t('home.export')}
          onClick={onExport}
        >
          <ShareIcon size={13} />
        </button>
      </div>
      <div className="hm-chart-gap">
        <LineChart series={series} money={money} compare={compare} label={title} />
      </div>
      <CardFooter updated={updated} more={more} />
    </section>
  );
}

export interface ListRow {
  key: string;
  label: string;
  sub?: string;
  value: string;
  color?: string;
  tone?: string;
}

/** Design `ListCard`: rows of a label and a value. */
export function ListCard({
  title,
  info,
  rows,
  updated,
  more,
}: {
  title: string;
  info?: string;
  rows: readonly ListRow[];
  updated: string;
  more: ReactNode;
}) {
  return (
    <section className="card metric-card">
      <h2 className="hm-title hm-title-list">
        {title}
        {info ? <InfoDot text={info} /> : null}
      </h2>
      <div>
        {rows.map((row) => (
          <div key={row.key} className="hm-list-row">
            <span className="hm-list-label">
              {row.color ? (
                <span aria-hidden="true" className="hm-dot" style={{ background: row.color }} />
              ) : null}
              <span className="hm-ellipsis">{row.label}</span>
              {row.sub ? <span className="hm-list-sub">{row.sub}</span> : null}
            </span>
            <span
              className="hm-num hm-list-value"
              style={row.tone ? { color: row.tone } : undefined}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
      <CardFooter updated={updated} more={more} />
    </section>
  );
}

interface PillProps<K extends string> {
  label?: string;
  value: K;
  options: readonly (readonly [K, string])[];
  onChange: (value: K) => void;
  onRemove?: () => void;
  removeLabel?: string;
}

/** Design `Pill`: a filter with a list of options. */
export function Pill<K extends string>({
  label,
  value,
  options,
  onChange,
  onRemove,
  removeLabel,
}: PillProps<K>) {
  const [open, setOpen] = useState(false);
  const current = options.find(([key]) => key === value);
  return (
    <div className="hm-pill-wrap">
      {onRemove ? (
        <button
          type="button"
          className="hm-pill-remove"
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <X2Icon size={13} />
        </button>
      ) : null}
      <button
        type="button"
        className={onRemove ? 'filter-pill hm-pill-removable' : 'filter-pill'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        {label ? (
          <>
            <span>{label}</span>
            <span className="filter-pill-sep" />
          </>
        ) : null}
        <span className="hm-pill-value">{current ? current[1] : '—'}</span>
        <ChevronDownIcon size={12} className="hm-pill-chevron" />
      </button>
      {open ? (
        <>
          <div
            className="hm-pill-overlay"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div role="listbox" aria-label={label} className="card hm-pill-list">
            {options.map(([key, text]) => (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={key === value}
                className={key === value ? 'hm-option is-on' : 'hm-option'}
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setOpen(false);
                }}
              >
                {text}
                {key === value ? <CheckIcon size={12} className="hm-pill-chevron" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
