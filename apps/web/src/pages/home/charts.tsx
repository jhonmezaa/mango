import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { usd } from '../../components/admin/govFormat';
import { CheckIcon, ChevronDownIcon, InfoIcon, ShareIcon, X2Icon } from '../../components/icons';
import { axisOf, countedOf, deltaOf, fmtCompact, fmtDate, fmtDay, sum, type Series } from './model';

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
  /** `counted_since`: the days before it have no value, drawn as a hatched zone. */
  since: string | null;
}

/** Design `LineChart`: the period in the accent colour, the one before dashed, a tooltip. */
export function LineChart({ series, money, compare, label, since }: LineChartProps) {
  const { t } = useTranslation();
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
  const peak = Math.max(0, ...countedOf(cur), ...(compare ? countedOf(prev) : []));
  const { max, ticks, decimals } = axisOf(peak * 1.05, money);
  const last = Math.max(1, cur.length - 1);
  const x = (i: number) => (i / last) * (plotW - 4) + 2;
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const path = (values: readonly (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const fmt = (v: number) => (money ? usd(v) : num(v));
  const first = cur.findIndex((v) => v !== null);
  const points = countedOf(cur).length;
  const gapW = first > 0 ? x(first) : first < 0 ? plotW : 0;
  const firstValue = cur[first] ?? null;
  const point = hover === null ? null : { i: hover, c: cur[hover] ?? null, p: prev[hover] ?? null };
  const delta = point && point.c !== null && point.p ? deltaOf(point.c, point.p) : null;
  const right = point ? x(point.i) > plotW * 0.55 : false;
  const hatch = `hatch-${label.replace(/\W/g, '')}`;
  const sinceDate = since ? fmtDate(since) : '';
  return (
    <div ref={wrap} className="hm-chart">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={since && first !== 0 ? t('home.chartSince', { label, date: sinceDate }) : label}
        className="hm-chart-svg"
      >
        <defs>
          <pattern
            id={hatch}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" strokeWidth="2" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={0} x2={plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={width} y={y(t) + 4} textAnchor="end" className="hm-tick">
              {fmtCompact(t, money, decimals)}
            </text>
          </g>
        ))}
        {gapW > 0 ? (
          <g aria-hidden="true">
            <rect
              x={0}
              y={PAD_T}
              width={gapW}
              height={plotH}
              fill={`url(#${hatch})`}
              opacity="0.8"
            />
            {first > 0 ? (
              <line
                x1={x(first)}
                x2={x(first)}
                y1={PAD_T}
                y2={PAD_T + plotH}
                stroke="var(--text-muted)"
                strokeDasharray="3 3"
              />
            ) : null}
            {gapW > 72 ? (
              <text x={gapW / 2} y={PAD_T + plotH / 2 + 4} textAnchor="middle" className="hm-gap">
                {t('home.noData')}
              </text>
            ) : null}
          </g>
        ) : null}
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
        {points === 1 && firstValue !== null ? (
          <circle cx={x(first)} cy={y(firstValue)} r="3.5" fill="var(--accent)" />
        ) : null}
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
            {compare && point.p !== null ? (
              <circle
                cx={x(point.i)}
                cy={y(point.p)}
                r="4"
                fill="var(--chart-muted)"
                stroke="var(--card)"
                strokeWidth="2"
              />
            ) : null}
            {point.c !== null ? (
              <circle
                cx={x(point.i)}
                cy={y(point.c)}
                r="4.5"
                fill="var(--accent)"
                stroke="var(--card)"
                strokeWidth="2"
              />
            ) : null}
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
            top: Math.max(
              0,
              Math.min((point.c !== null ? y(point.c) : PAD_T + plotH / 2) - 20, HEIGHT - 110),
            ),
            ...(right ? { right: width - x(point.i) + 14 } : { left: x(point.i) + 14 }),
          }}
        >
          <div className="hm-tip-row hm-tip-head">
            <span className="hm-tip-label">{label}</span>
            {compare && delta !== null ? (
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
            <TipValue value={point.c} fmt={fmt} />
          </div>
          {compare ? (
            <div className="hm-tip-row hm-tip-prev">
              <span className="hm-tip-key">
                <span className="hm-swatch hm-swatch-prev" />
                <span className="hm-muted">{fmtDay(prevDates[point.i] ?? '')}</span>
              </span>
              <TipValue value={point.p} fmt={fmt} />
            </div>
          ) : null}
          {since && (point.c === null || (compare && point.p === null)) ? (
            <div className="hm-tip-note">{t('home.sinceTip', { date: sinceDate })}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TipValue({ value, fmt }: { value: number | null; fmt: (value: number) => string }) {
  const { t } = useTranslation();
  return value === null ? (
    <span className="hm-num hm-muted">{t('home.noData')}</span>
  ) : (
    <span className="hm-num">{fmt(value)}</span>
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
  since: string | null;
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
  since,
  onExport,
}: MetricCardProps) {
  const { t } = useTranslation();
  const cur = countedOf(series.cur);
  const total = sum(cur);
  const previous = sum(countedOf(series.prev));
  // Without a whole period before there is nothing to compare with (design round 28).
  const canCompare = compare && series.prevWhole;
  const canPct = canCompare && previous > 0 && cur.length > 0;
  const partial = !series.curWhole || (compare && !series.prevWhole);
  const delta = canPct ? deltaOf(total, previous) : 0;
  const good = goodWhen === 'up' ? delta >= 0 : delta <= 0;
  const show = (value: number) => (money ? moneyShort(value) : num(value));
  return (
    <section className="card metric-card">
      <div className="hm-head">
        <div className="hm-head-text">
          <h2 className="hm-title">
            {title}
            <InfoDot text={info} />
          </h2>
          <div className="hm-total-row">
            <span className="hm-total" title={money && cur.length ? usd(total) : undefined}>
              {cur.length ? show(total) : '—'}
            </span>
            {canPct ? (
              <span className={good ? 'hm-delta hm-up' : 'hm-delta hm-down'}>
                {delta >= 0 ? '+' : ''}
                {pct(delta)}%
              </span>
            ) : null}
          </div>
          {canCompare ? (
            <div className="hm-prev">{t('home.previous', { value: show(previous) })}</div>
          ) : null}
          {partial && since ? (
            <div
              className="dash-since"
              title={compare && !series.prevWhole ? t('home.sinceNoCompare') : undefined}
            >
              {t('home.since', { date: fmtDate(since) })}
            </div>
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
        <LineChart series={series} money={money} compare={compare} label={title} since={since} />
      </div>
      <CardFooter updated={updated} />
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
  more?: ReactNode;
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
  const main = (
    <>
      {label ? (
        <>
          <span>{label}</span>
          <span className="filter-pill-sep" />
        </>
      ) : null}
      <span className="hm-pill-value">{current ? current[1] : '—'}</span>
      <ChevronDownIcon size={12} className="hm-pill-chevron" />
    </>
  );
  const toggle = {
    'aria-haspopup': 'listbox',
    'aria-expanded': open,
    onClick: () => {
      setOpen((v) => !v);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    },
  } as const;
  return (
    <div className="hm-pill-wrap">
      {onRemove ? (
        <div className="filter-pill filter-pill-split">
          <button
            type="button"
            className="fp-x"
            aria-label={removeLabel}
            title={removeLabel}
            onClick={onRemove}
          >
            <X2Icon size={13} />
          </button>
          <button type="button" className="fp-main" {...toggle}>
            {main}
          </button>
        </div>
      ) : (
        <button type="button" className="filter-pill" {...toggle}>
          {main}
        </button>
      )}
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
