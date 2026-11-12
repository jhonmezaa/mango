import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  cutLabel,
  formatTick,
  formatValue,
  niceScale,
  scaleTicks,
  xLabelOf,
  type ChartSpec,
  type ChartValue,
} from './chartSpec';

/**
 * The drawing of a chart (design round 41 `ChatChart`, D118 (3) and (10)): SVG drawn by React,
 * loaded on demand. Every text of the spec reaches the page as a React text child, escaped; no
 * `innerHTML`, no `<style>`. The only styles written are a few properties of elements (the
 * tooltip's position, a swatch's color), through the CSSOM, which the CSP of the SPA allows
 * (`style-src 'self'`, Trusted Types).
 *
 * Pointer, touch and keyboard share one active point. The marks of every series are memoized:
 * moving over the chart only redraws what shows the active point (the band, the guide, the
 * active marks and the tooltip), so a chart of thousands of categories stays fluid.
 */

type Series = ChartSpec['series'][number];
type Row = ChartSpec['data'][number];
type Via = 'mouse' | 'touch' | 'kb';
/** The active point: a row, the position among the visible series (null in a pie), and how. */
interface Active {
  i: number;
  s: number | null;
  via: Via;
}
/** A visible series and its index among all of them (its color does not move, design). */
interface Visible {
  series: Series;
  si: number;
}

/** Design round 40 `CR_COLORS`: the tokens of the theme, in this order. */
const COLORS = [
  'var(--accent)',
  'var(--blue)',
  'var(--violet)',
  'var(--green)',
  'var(--amber)',
  'var(--red)',
];
const color = (index: number): string => COLORS[index % COLORS.length] ?? 'var(--accent)';
/** In a line chart, the points are drawn up to this many categories (design round 41). */
const MAX_DOTS = 60;
/** The categories' labels of a horizontal bar chart are cut to this (the tooltip has it all). */
const HORIZONTAL_LABEL = 30;
const NAV_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
const RAW = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
const SHARE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** The smallest and the largest of some numbers, with 0 in the range (no spread: 100,000 values). */
function extent(values: Iterable<number>): [number, number] {
  let min = 0;
  let max = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** A «round» scale (`niceScale`) over a range that may go below 0. */
function range(values: Iterable<number>): { lo: number; top: number; step: number } {
  const [min, max] = extent(values);
  const { step } = niceScale(max - min);
  const lo = min < 0 ? Math.floor(min / step) * step : 0;
  return { lo, top: Math.max(lo + step, Math.ceil(max / step) * step), step };
}

const num = (value: ChartValue | undefined): number | null =>
  typeof value === 'number' ? value : null;
const text = (value: ChartValue | undefined): string =>
  value === null || value === undefined ? '' : String(value);

function fmt(spec: ChartSpec, series: Series, value: ChartValue | undefined): string {
  return formatValue(value, series.valueFormat, series, spec.currency);
}

// --- The tooltip --------------------------------------------------------------------------

interface TipRow {
  color?: string;
  label: string;
  value: string;
  on?: boolean;
}

/** Design round 41 `.cr-tip`: next to the point, to its left in the last 40 % of the width. */
function Tip({
  x,
  y,
  left,
  head,
  rows,
  foot,
}: {
  x: number;
  y: number;
  left: boolean;
  head: string;
  rows: TipRow[];
  foot?: string | null;
}) {
  return (
    <div
      className={`cr-tip ${left ? 'is-l' : 'is-r'}`}
      style={{ left: `${String(x)}%`, top: `${String(y)}%` }}
      aria-hidden="true"
    >
      <div className="cr-tip-h">{head}</div>
      {rows.map((row, j) => (
        <div key={j} className={`cr-tip-r${row.on ? ' is-on' : ''}`}>
          {row.color ? <i style={{ background: row.color }} /> : null}
          <span>{row.label}</span>
          <b className="mono">{row.value}</b>
        </div>
      ))}
      {foot ? <div className="cr-tip-f">{foot}</div> : null}
    </div>
  );
}

// --- Shared behavior: the active point ----------------------------------------------------

interface Props {
  spec: ChartSpec;
  /** Keys of the hidden series; in a pie, the indices of the hidden slices. */
  hidden: readonly string[];
  onToggle: (key: string) => void;
  onShowAll: () => void;
}

function useActivePoint() {
  const [active, setActive] = useState<Active | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const clear = useCallback(() => {
    setActive(null);
    setHighlight(null);
  }, []);
  // Touch pins the tooltip; touching outside the card closes it (design round 41).
  const pinned = active?.via === 'touch';
  useEffect(() => {
    if (!pinned) return undefined;
    const onDown = (event: globalThis.PointerEvent) => {
      const card = plotRef.current?.closest('.cr-chart') ?? plotRef.current;
      if (!(event.target instanceof Node) || !card?.contains(event.target)) clear();
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
    };
  }, [pinned, clear]);
  return { active, setActive, highlight, setHighlight, clear, plotRef };
}

/**
 * The keyboard of the drawing (design round 41): arrows by category and by series (the other
 * way round in horizontal bars), Home/End, PageUp/PageDown by 10 %, Escape lets go.
 */
function nextPoint(
  key: string,
  current: Active | null,
  order: readonly number[],
  seriesCount: number,
  mode: 'pie' | 'scatter' | 'horizontal' | 'vertical',
): { i: number; s: number } | null {
  const n = order.length;
  if (n === 0) return null;
  const start = current ?? { i: order[0] ?? 0, s: 0 };
  let p = Math.max(0, order.indexOf(start.i));
  let s = Math.min(start.s ?? 0, Math.max(0, seriesCount - 1));
  if (current) {
    const bySeries = mode === 'pie' || (mode === 'scatter' && seriesCount <= 1) ? null : mode;
    const back =
      bySeries === null
        ? ['ArrowLeft', 'ArrowUp']
        : mode === 'horizontal'
          ? ['ArrowUp']
          : ['ArrowLeft'];
    const forward =
      bySeries === null
        ? ['ArrowRight', 'ArrowDown']
        : mode === 'horizontal'
          ? ['ArrowDown']
          : ['ArrowRight'];
    const seriesKeys =
      bySeries === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const page = Math.max(1, Math.round(n / 10));
    if (back.includes(key)) p = Math.max(0, p - 1);
    else if (forward.includes(key)) p = Math.min(n - 1, p + 1);
    else if (key === 'Home') p = 0;
    else if (key === 'End') p = n - 1;
    else if (key === 'PageUp') p = Math.max(0, p - page);
    else if (key === 'PageDown') p = Math.min(n - 1, p + page);
    else if (bySeries && key === seriesKeys[0]) s = Math.max(0, s - 1);
    else if (bySeries && key === seriesKeys[1]) s = Math.min(seriesCount - 1, s + 1);
  }
  return { i: order[p] ?? 0, s };
}

function isFocusVisible(event: FocusEvent<HTMLElement>): boolean {
  try {
    return event.currentTarget.matches(':focus-visible');
  } catch {
    return true;
  }
}

// --- The legend ---------------------------------------------------------------------------

function LegendButton({
  label,
  swatch,
  off,
  last,
  lastText,
  on,
  onToggle,
  onEnter,
  onLeave,
  children,
}: {
  label: string;
  swatch: string;
  off: boolean;
  last: boolean;
  lastText: string;
  on: boolean;
  onToggle: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`cr-leg${off ? ' is-off' : ''}${on ? ' is-hi' : ''}`}
      aria-pressed={!off}
      aria-disabled={last || undefined}
      title={
        last
          ? lastText
          : off
            ? t('chat.chart.show', { name: label })
            : t('chat.chart.hide', { name: label })
      }
      onClick={() => {
        if (!last) onToggle();
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse' && !off) onEnter?.();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') onLeave?.();
      }}
      onFocus={() => {
        if (!off) onEnter?.();
      }}
      onBlur={() => onLeave?.()}
    >
      {/* The swatch's color is a token of the theme (CSSOM, allowed by the CSP). */}
      <i style={{ background: off ? 'transparent' : swatch, borderColor: swatch }} />
      {children ?? label}
    </button>
  );
}

// --- Pie ----------------------------------------------------------------------------------

function polar(angle: number, radius: number): [number, number] {
  return [120 + radius * Math.cos(angle), 120 + radius * Math.sin(angle)];
}

function PieView({ spec, hidden, onToggle }: Props) {
  const { t } = useTranslation();
  const liveId = useId();
  const { active, setActive, clear, plotRef } = useActivePoint();
  const [first] = spec.series;
  const key = first?.key ?? '';
  const value = useCallback((row: Row | undefined) => Math.max(0, num(row?.[key]) ?? 0), [key]);
  const visible = useMemo(
    () => spec.data.map((_, i) => i).filter((i) => !hidden.includes(String(i))),
    [spec.data, hidden],
  );
  const total = useMemo(
    () => visible.reduce((sum, i) => sum + value(spec.data[i]), 0),
    [visible, spec.data, value],
  );
  const arcs = useMemo(() => {
    const out: { i: number; d: string; mx: number; my: number }[] = [];
    let a0 = -Math.PI / 2;
    for (const i of visible) {
      const share = total > 0 ? value(spec.data[i]) / total : 0;
      const a1 = a0 + share * Math.PI * 2;
      const [x0, y0] = polar(a0, 92);
      const [x1, y1] = polar(a1, 92);
      const d =
        visible.length === 1 && share > 0
          ? 'M120 28 A92 92 0 1 1 119.99 28Z'
          : `M120 120 L${String(x0)} ${String(y0)} A92 92 0 ${a1 - a0 > Math.PI ? '1' : '0'} 1 ${String(x1)} ${String(y1)}Z`;
      const [mx, my] = polar((a0 + a1) / 2, 58);
      a0 = a1;
      out.push({ i, d, mx, my });
    }
    return out;
  }, [visible, total, spec.data, value]);
  const share = (i: number) =>
    `${SHARE.format(total > 0 ? Math.round((value(spec.data[i]) / total) * 1000) / 10 : 0)} %`;
  const point = (i: number, via: Via) => {
    if (active && active.i === i && active.via === via) return;
    setActive({ i, s: null, via });
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (active) {
        event.preventDefault();
        clear();
      }
      return;
    }
    if (!NAV_KEYS.has(event.key)) return;
    event.preventDefault();
    const next = nextPoint(event.key, active, visible, 1, 'pie');
    if (next) point(next.i, 'kb');
  };
  const pin = (i: number, event: PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    if (active?.via === 'touch' && active.i === i) clear();
    else point(i, 'touch');
  };
  const on = active && visible.includes(active.i) ? active : null;
  const onArc = on ? arcs.find((a) => a.i === on.i) : undefined;
  const onRow = on ? spec.data[on.i] : undefined;
  let live = '';
  if (on && onRow && first) {
    live = [
      text(onRow[spec.xKey]),
      fmt(spec, first, onRow[key]),
      share(on.i),
      ...(on.via === 'kb'
        ? [t('chat.chart.position', { p: visible.indexOf(on.i) + 1, n: visible.length })]
        : []),
    ].join(' · ');
  }
  const title = spec.meta.title ?? t('chat.chart.chart');
  return (
    <>
      <div className="cr-pie">
        <div
          ref={plotRef}
          className="cr-plot is-pie"
          tabIndex={0}
          role="application"
          aria-roledescription={t('chat.chart.roleDescription')}
          aria-label={`${title}. ${t('chat.chart.hint')}`}
          aria-describedby={liveId}
          onKeyDown={onKey}
          onFocus={(event) => {
            if (!active && isFocusVisible(event) && visible[0] !== undefined) {
              point(visible[0], 'kb');
            }
          }}
          onBlur={() => {
            if (active?.via === 'kb') clear();
          }}
        >
          <svg viewBox="0 0 240 240" aria-hidden="true">
            {arcs.map((a) => (
              <path
                key={a.i}
                d={a.d}
                fill={color(a.i)}
                stroke="var(--card)"
                strokeWidth={2}
                opacity={!on || on.i === a.i ? 1 : 0.4}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') point(a.i, 'mouse');
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === 'mouse' && active?.via === 'mouse') clear();
                }}
                onPointerDown={(event) => {
                  pin(a.i, event);
                }}
              />
            ))}
            {on?.via === 'kb' && onArc ? (
              <path d={onArc.d} fill="none" stroke="var(--text-strong)" strokeWidth={2} />
            ) : null}
          </svg>
          {on && onArc && onRow && first ? (
            <Tip
              x={(onArc.mx / 240) * 100}
              y={(onArc.my / 240) * 100}
              left={false}
              head={text(onRow[spec.xKey])}
              rows={[
                { color: color(on.i), label: first.label, value: fmt(spec, first, onRow[key]) },
                {
                  label: hidden.length ? t('chat.chart.ofVisible') : t('chat.chart.ofTotal'),
                  value: share(on.i),
                },
              ]}
            />
          ) : null}
        </div>
        <ul className="cr-legend is-col" aria-label={t('chat.chart.slices')}>
          {spec.data.map((row, i) => {
            const off = hidden.includes(String(i));
            const name = text(row[spec.xKey]);
            return (
              <li key={i}>
                <LegendButton
                  label={name}
                  swatch={color(i)}
                  off={off}
                  last={!off && visible.length === 1}
                  lastText={t('chat.chart.keepOneSlice')}
                  on={on?.i === i}
                  onToggle={() => {
                    onToggle(String(i));
                    clear();
                  }}
                  onEnter={() => {
                    point(i, 'mouse');
                  }}
                  onLeave={() => {
                    if (active?.via === 'mouse') clear();
                  }}
                >
                  <span className="cr-leg-n">{name}</span>
                  <b className="mono">{first ? fmt(spec, first, row[key]) : ''}</b>
                  <span className="mono">
                    {off || total <= 0
                      ? '–'
                      : `${SHARE.format(Math.round((value(row) / total) * 100))} %`}
                  </span>
                </LegendButton>
              </li>
            );
          })}
        </ul>
      </div>
      <div id={liveId} className="cr-hover sr-only" aria-live="polite">
        {live}
      </div>
    </>
  );
}

// --- Bars, lines and points ---------------------------------------------------------------

const W = 640;
const R = 16;
const B = 30;

/** Everything the drawing needs that does not depend on the active point. */
interface Geometry {
  kind: 'bar' | 'line' | 'scatter';
  horizontal: boolean;
  visible: Visible[];
  H: number;
  T: number;
  L: number;
  /** The plot's width and height. */
  pw: number;
  ph: number;
  /** A category's width (vertical bars, lines) or height (horizontal bars). */
  band: number;
  /** The value scale. */
  lo: number;
  top: number;
  step: number;
  /** The x scale of a scatter chart. */
  xs: { lo: number; top: number; step: number } | null;
  /** The bar slots of a category: a stack shares one (D118 (1) `stack`). */
  slots: number;
  slotOf: number[];
  /** Where each bar of each visible series starts and ends, by row: [from, to]. */
  bars: [number, number][][];
  /** The rows in the keyboard's order (scatter: by x). */
  order: number[];
}

function geometry(spec: ChartSpec, hidden: readonly string[]): Geometry {
  const kind = spec.chartType === 'pie' ? 'bar' : spec.chartType;
  const horizontal = kind === 'bar' && spec.layout === 'vertical';
  let visible = spec.series
    .map((series, si) => ({ series, si }))
    .filter((v) => !hidden.includes(v.series.key));
  if (visible.length === 0) visible = spec.series.map((series, si) => ({ series, si }));
  const n = spec.data.length;
  // Bars: one slot per stack (or per series without one), each bar from its stack's base.
  const stacks = new Map<string, number>();
  const slotOf = visible.map((v) => {
    const id = kind === 'bar' && v.series.stack ? `s:${v.series.stack}` : `k:${v.series.key}`;
    const found = stacks.get(id);
    if (found !== undefined) return found;
    stacks.set(id, stacks.size);
    return stacks.size - 1;
  });
  const slots = Math.max(1, stacks.size);
  const bars: [number, number][][] = visible.map(() => []);
  const values: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = spec.data[i] ?? {};
    const up = new Array<number>(slots).fill(0);
    const down = new Array<number>(slots).fill(0);
    visible.forEach((v, p) => {
      const value = num(row[v.series.key]);
      if (value === null) {
        bars[p]?.push([0, 0]);
        return;
      }
      if (kind !== 'bar') {
        values.push(value);
        return;
      }
      const slot = slotOf[p] ?? 0;
      const base = value >= 0 ? (up[slot] ?? 0) : (down[slot] ?? 0);
      const end = base + value;
      if (value >= 0) up[slot] = end;
      else down[slot] = end;
      bars[p]?.push([base, end]);
      values.push(end);
    });
  }
  const { lo, top, step } = range(values);
  const xs =
    kind === 'scatter'
      ? range(spec.data.map((row) => num(row[spec.xKey])).filter((v): v is number => v !== null))
      : null;
  const T = horizontal ? 8 : 26;
  const L = horizontal ? 196 : 58;
  const rowH = horizontal ? Math.min(10 + 9 * slots, 640 / Math.max(1, n)) : 0;
  const H = horizontal ? T + n * rowH + B : 252;
  const pw = W - L - R;
  const ph = H - T - B;
  const order = spec.data.map((_, i) => i);
  if (kind === 'scatter') {
    order.sort(
      (a, b) => (num(spec.data[a]?.[spec.xKey]) ?? 0) - (num(spec.data[b]?.[spec.xKey]) ?? 0),
    );
  }
  return {
    kind,
    horizontal,
    visible,
    H,
    T,
    L,
    pw,
    ph,
    band: horizontal ? rowH : pw / Math.max(1, n),
    lo,
    top,
    step,
    xs,
    slots,
    slotOf,
    bars,
    order,
  };
}

/** Scales of a geometry: from a value to the SVG's coordinates. */
function scales(g: Geometry) {
  const span = g.top - g.lo || 1;
  return {
    vy: (v: number) => g.T + g.ph - ((v - g.lo) / span) * g.ph,
    vx: (v: number) => g.L + ((v - g.lo) / span) * g.pw,
    sx: (v: number) => {
      const xs = g.xs ?? { lo: 0, top: 1 };
      return g.L + ((v - xs.lo) / (xs.top - xs.lo || 1)) * g.pw;
    },
    cx: (i: number) => g.L + g.band * i + g.band / 2,
    cy: (i: number) => g.T + g.band * i + g.band / 2,
  };
}

/** A bar's rectangle: its slot inside the category, from its start to its end. */
function barRect(g: Geometry, p: number, i: number) {
  const s = scales(g);
  const group = g.band * 0.72;
  const w = group / g.slots;
  const gap = w > 6 ? 2 : 0;
  const slot = g.slotOf[p] ?? 0;
  const [from, to] = g.bars[p]?.[i] ?? [0, 0];
  if (g.horizontal) {
    const a = s.vx(Math.min(from, to));
    const b = s.vx(Math.max(from, to));
    return {
      x: a,
      y: s.cy(i) - group / 2 + w * slot,
      width: Math.max(0, b - a),
      height: Math.max(1, w - gap),
    };
  }
  const a = s.vy(Math.max(from, to));
  const b = s.vy(Math.min(from, to));
  return {
    x: s.cx(i) - group / 2 + w * slot,
    y: a,
    width: Math.max(1, w - gap),
    height: Math.max(0, b - a),
  };
}

/** The marks of one series: memoized, so that the active point never redraws them. */
const SeriesMarks = memo(function SeriesMarks({
  spec,
  g,
  p,
}: {
  spec: ChartSpec;
  g: Geometry;
  p: number;
}) {
  const v = g.visible[p];
  if (!v) return null;
  const s = scales(g);
  const fill = color(v.si);
  if (g.kind === 'bar') {
    return (
      <>
        {spec.data.map((_, i) => {
          const rect = barRect(g, p, i);
          return <rect key={i} {...rect} rx={2} fill={fill} />;
        })}
      </>
    );
  }
  if (g.kind === 'scatter') {
    return (
      <>
        {spec.data.map((row, i) => {
          const x = num(row[spec.xKey]);
          const y = num(row[v.series.key]);
          return x === null || y === null ? null : (
            <circle key={i} cx={s.sx(x)} cy={s.vy(y)} r={4} fill={fill} fillOpacity={0.8} />
          );
        })}
      </>
    );
  }
  const points: string[] = [];
  spec.data.forEach((row, i) => {
    const y = num(row[v.series.key]);
    if (y !== null) points.push(`${String(s.cx(i))},${String(s.vy(y))}`);
  });
  return (
    <>
      <polyline
        fill="none"
        stroke={fill}
        strokeWidth={2}
        strokeLinejoin="round"
        points={points.join(' ')}
      />
      {spec.data.length <= MAX_DOTS
        ? spec.data.map((row, i) => {
            const y = num(row[v.series.key]);
            return y === null ? null : (
              <circle key={i} cx={s.cx(i)} cy={s.vy(y)} r={3} fill={fill} />
            );
          })
        : null}
    </>
  );
});

/** The last tick of a horizontal axis ends at its mark: centered, it would be cut at the edge. */
const anchor = (k: number, count: number) => (k === count - 1 ? 'end' : 'middle');

/** The grid and the value axis: memoized with the geometry. */
const Grid = memo(function Grid({ spec, g }: { spec: ChartSpec; g: Geometry }) {
  const s = scales(g);
  const money = spec.valueFormat === 'currency' || g.visible[0]?.series.valueFormat === 'currency';
  const tick = (v: number) => formatTick(v, money ? 'currency' : 'compact', spec.currency);
  const ticks = scaleTicks({ top: g.top - g.lo, step: g.step }).map((t) => t + g.lo);
  return (
    <>
      {ticks.map((t, k) =>
        g.horizontal ? (
          <g key={t}>
            <line x1={s.vx(t)} x2={s.vx(t)} y1={g.T} y2={g.T + g.ph} stroke="var(--border)" />
            <text x={s.vx(t)} y={g.H - 10} textAnchor={anchor(k, ticks.length)} className="cr-ax">
              {tick(t)}
            </text>
          </g>
        ) : (
          <g key={t}>
            <line x1={g.L} x2={W - R} y1={s.vy(t)} y2={s.vy(t)} stroke="var(--border)" />
            <text x={g.L - 6} y={s.vy(t) + 3.5} textAnchor="end" className="cr-ax">
              {tick(t)}
            </text>
          </g>
        ),
      )}
      {g.xs
        ? scaleTicks({ top: g.xs.top - g.xs.lo, step: g.xs.step }).map((t, k, all) => (
            <text
              key={`x${String(t)}`}
              x={s.sx(t + (g.xs?.lo ?? 0))}
              y={g.H - 10}
              textAnchor={anchor(k, all.length)}
              className="cr-ax"
            >
              {formatTick(t + (g.xs?.lo ?? 0), 'compact')}
            </text>
          ))
        : null}
      {!g.horizontal && spec.axes.y.label ? (
        <text x={4} y={11} className="cr-ax">
          {spec.axes.y.label}
        </text>
      ) : null}
    </>
  );
});

/** The labels of the categories, spaced so that they never overlap (design round 41). */
function CategoryLabels({ spec, g, on }: { spec: ChartSpec; g: Geometry; on: number | null }) {
  const s = scales(g);
  const n = spec.data.length;
  const most = Math.max(1, Math.floor(g.horizontal ? g.ph / 14 : g.pw / 46));
  const every = Math.ceil(n / most);
  const labels: ReactNode[] = [];
  for (let i = 0; i < n; i += every) {
    const value = spec.data[i]?.[spec.xKey];
    const className = `cr-ax${on === i ? ' is-on' : ''}`;
    labels.push(
      g.horizontal ? (
        <text key={i} x={g.L - 8} y={s.cy(i) + 3.5} textAnchor="end" className={className}>
          {cutLabel(value, HORIZONTAL_LABEL)}
        </text>
      ) : (
        <text key={i} x={s.cx(i)} y={g.H - 10} textAnchor="middle" className={className}>
          {cutLabel(value, Math.max(3, Math.floor((g.band * every) / 6.5)))}
        </text>
      ),
    );
  }
  return <>{labels}</>;
}

/** Which row and series the pointer is on (design round 41 `hit`), or null outside the plot. */
function hitTest(
  spec: ChartSpec,
  g: Geometry,
  x: number,
  y: number,
): { i: number; s: number | null } | null {
  if (x < g.L - 4 || x > W - R + 4 || y < g.T - 4 || y > g.T + g.ph + 4) return null;
  const s = scales(g);
  const n = spec.data.length;
  if (g.kind === 'scatter') {
    let best: { i: number; s: number } | null = null;
    let distance = 20 * 20;
    for (let p = 0; p < g.visible.length; p += 1) {
      const key = g.visible[p]?.series.key ?? '';
      for (let i = 0; i < n; i += 1) {
        const px = num(spec.data[i]?.[spec.xKey]);
        const py = num(spec.data[i]?.[key]);
        if (px === null || py === null) continue;
        const dx = s.sx(px) - x;
        const dy = s.vy(py) - y;
        const d = dx * dx + dy * dy;
        if (d < distance) {
          distance = d;
          best = { i, s: p };
        }
      }
    }
    return best;
  }
  const i = Math.max(
    0,
    Math.min(n - 1, Math.floor(g.horizontal ? (y - g.T) / g.band : (x - g.L) / g.band)),
  );
  let hit: number | null = null;
  if (g.kind === 'line') {
    let distance = 14;
    for (let p = 0; p < g.visible.length; p += 1) {
      const value = num(spec.data[i]?.[g.visible[p]?.series.key ?? '']);
      if (value === null) continue;
      const d = Math.abs(s.vy(value) - y);
      if (d < distance) {
        distance = d;
        hit = p;
      }
    }
  } else {
    // Bars: the slot under the pointer, across the whole height of its category (design).
    const group = g.band * 0.72;
    const offset = g.horizontal ? y - (s.cy(i) - group / 2) : x - (s.cx(i) - group / 2);
    if (offset >= 0 && offset < group) {
      const slot = Math.min(g.slots - 1, Math.floor(offset / (group / g.slots)));
      const inSlot = g.visible.map((_, p) => p).filter((p) => g.slotOf[p] === slot);
      // In a stack, the segment under the pointer; else the slot's only bar.
      hit =
        inSlot.find((p) => {
          const r = barRect(g, p, i);
          return g.horizontal ? x >= r.x && x <= r.x + r.width : y >= r.y && y <= r.y + r.height;
        }) ??
        inSlot[inSlot.length - 1] ??
        null;
    }
  }
  return { i, s: hit };
}

function CartesianView({ spec, hidden, onToggle, onShowAll }: Props) {
  const { t } = useTranslation();
  const liveId = useId();
  const { active, setActive, highlight, setHighlight, clear, plotRef } = useActivePoint();
  const g = useMemo(() => geometry(spec, hidden), [spec, hidden]);
  const s = scales(g);
  const multi = g.visible.length > 1;
  const mode = g.kind === 'scatter' ? 'scatter' : g.horizontal ? 'horizontal' : 'vertical';
  const xLabel = xLabelOf(spec);
  const yLabel = spec.axes.y.label ?? spec.series[0]?.label ?? '';

  const point = (h: { i: number; s: number | null }, via: Via) => {
    if (active && active.i === h.i && active.s === h.s && active.via === via) return;
    setActive({ ...h, via });
    setHighlight(multi && h.s !== null ? (g.visible[h.s]?.si ?? null) : null);
  };
  const toView = (event: PointerEvent<SVGSVGElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      ((event.clientX - box.left) / (box.width || 1)) * W,
      ((event.clientY - box.top) / (box.height || 1)) * g.H,
    ];
  };
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'mouse') return;
    const hit = hitTest(spec, g, ...toView(event));
    if (!hit) {
      if (active?.via === 'mouse') clear();
      return;
    }
    point(hit, 'mouse');
  };
  const onDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse') return;
    const hit = hitTest(spec, g, ...toView(event));
    if (!hit || (active?.via === 'touch' && active.i === hit.i)) {
      clear();
      return;
    }
    point(hit, 'touch');
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (active) {
        event.preventDefault();
        clear();
      }
      return;
    }
    if (!NAV_KEYS.has(event.key)) return;
    event.preventDefault();
    const next = nextPoint(event.key, active, g.order, g.visible.length, mode);
    if (next) point(next, 'kb');
  };

  const row = active ? spec.data[active.i] : undefined;
  const ai = row ? (active?.i ?? null) : null;
  const ring = active?.via === 'kb';
  const dim = (si: number) => highlight !== null && highlight !== si;

  // What shows the active point: drawn over the memoized marks.
  let band: ReactNode = null;
  let overlay: ReactNode = null;
  let tip: ReactNode = null;
  let live = '';
  if (active && row && ai !== null) {
    const position = t('chat.chart.position', { p: g.order.indexOf(ai) + 1, n: g.order.length });
    const kb = active.via === 'kb';
    if (g.kind === 'scatter') {
      const v = g.visible[active.s ?? 0] ?? g.visible[0];
      const x = num(row[spec.xKey]);
      const y = v ? num(row[v.series.key]) : null;
      if (v && x !== null && y !== null) {
        const px = s.sx(x);
        const py = s.vy(y);
        overlay = (
          <circle
            cx={px}
            cy={py}
            r={6}
            fill={color(v.si)}
            fillOpacity={0.8}
            stroke={ring ? 'var(--text-strong)' : 'none'}
            strokeWidth={1.5}
          />
        );
        const yName = multi ? v.series.label : yLabel;
        tip = (
          <Tip
            x={(px / W) * 100}
            y={(Math.min(Math.max(py, g.H * 0.25), g.H * 0.75) / g.H) * 100}
            left={px > W * 0.6}
            head={v.series.label}
            rows={[
              { label: xLabel, value: RAW.format(x) },
              { label: yName, value: fmt(spec, v.series, y) },
            ]}
          />
        );
        live = [
          `${xLabel} ${RAW.format(x)}`,
          `${yName} ${fmt(spec, v.series, y)}`,
          ...(kb ? [position] : []),
        ].join(' · ');
      }
    } else {
      const rows: TipRow[] = g.visible.map((v, p) => ({
        color: color(v.si),
        label: v.series.label,
        value: fmt(spec, v.series, row[v.series.key]),
        on: multi && active.s === p,
      }));
      const ends = g.visible.map((_, p) => {
        if (g.kind === 'line') return num(row[g.visible[p]?.series.key ?? '']) ?? 0;
        const [from, to] = g.bars[p]?.[ai] ?? [0, 0];
        return Math.max(from, to);
      });
      const vmax = Math.max(0, ...ends);
      const ax = g.horizontal ? s.vx(vmax) : s.cx(ai);
      const ay = g.horizontal ? s.cy(ai) : s.vy(vmax);
      tip = (
        <Tip
          x={(ax / W) * 100}
          y={(Math.min(Math.max(ay, g.H * 0.25), g.H * 0.75) / g.H) * 100}
          left={ax > W * 0.6}
          head={text(row[spec.xKey])}
          rows={rows}
          foot={
            spec.series.length > g.visible.length
              ? t('chat.chart.hidden', { count: spec.series.length - g.visible.length })
              : null
          }
        />
      );
      const said = multi && kb && active.s !== null && rows[active.s] ? [rows[active.s]] : rows;
      live = [
        text(row[spec.xKey]),
        ...said.map((r) => `${r?.label ?? ''} ${r?.value ?? ''}`),
        ...(kb ? [position] : []),
      ].join(' · ');
      if (g.kind === 'line') {
        overlay = (
          <>
            <line
              x1={s.cx(ai)}
              x2={s.cx(ai)}
              y1={g.T}
              y2={g.T + g.ph}
              stroke="var(--text-dim)"
              strokeDasharray="3 3"
              opacity={0.7}
            />
            {g.visible.map((v, p) => {
              const y = num(row[v.series.key]);
              if (y === null) return null;
              return (
                <g key={v.series.key} opacity={dim(v.si) ? 0.25 : 1}>
                  <circle
                    cx={s.cx(ai)}
                    cy={s.vy(y)}
                    r={5}
                    fill={color(v.si)}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                  {ring && active.s === p ? (
                    <circle
                      cx={s.cx(ai)}
                      cy={s.vy(y)}
                      r={8.5}
                      fill="none"
                      stroke="var(--text-strong)"
                      strokeWidth={1.5}
                    />
                  ) : null}
                </g>
              );
            })}
          </>
        );
      } else {
        band = g.horizontal ? (
          <rect
            x={g.L}
            y={g.T + g.band * ai}
            width={g.pw}
            height={g.band}
            fill="var(--row-hover)"
          />
        ) : (
          <rect
            x={g.L + g.band * ai}
            y={g.T}
            width={g.band}
            height={g.ph}
            fill="var(--row-hover)"
          />
        );
        overlay = g.visible.map((v, p) => (
          <rect
            key={v.series.key}
            {...barRect(g, p, ai)}
            rx={2}
            fill={color(v.si)}
            opacity={dim(v.si) ? 0.35 : 1}
            stroke={ring && active.s === p ? 'var(--text-strong)' : 'none'}
            strokeWidth={1.5}
          />
        ));
      }
    }
  }

  // The memoized marks: dimmed as a whole while a category is active (bars, points), or by
  // series while one is highlighted.
  const baseDim = ai !== null && g.kind !== 'line' ? (g.kind === 'scatter' ? 0.44 : 0.35) : 1;
  const seriesDim = g.kind === 'line' ? 0.25 : 0.35;
  const title = spec.meta.title ?? t('chat.chart.chart');
  return (
    <>
      <div
        ref={plotRef}
        className="cr-plot"
        tabIndex={0}
        role="application"
        aria-roledescription={t('chat.chart.roleDescription')}
        aria-label={`${title}. ${t('chat.chart.hint')}`}
        aria-describedby={liveId}
        onKeyDown={onKey}
        onFocus={(event) => {
          if (!active && isFocusVisible(event) && g.order[0] !== undefined) {
            point({ i: g.order[0], s: 0 }, 'kb');
          }
        }}
        onBlur={() => {
          if (active?.via === 'kb') clear();
        }}
      >
        <svg
          viewBox={`0 0 ${String(W)} ${String(g.H)}`}
          className="cr-svg"
          aria-hidden="true"
          onPointerMove={onMove}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse' && active?.via === 'mouse') clear();
          }}
          onPointerDown={onDown}
        >
          <Grid spec={spec} g={g} />
          {band}
          {g.kind !== 'scatter' ? <CategoryLabels spec={spec} g={g} on={ai} /> : null}
          <g opacity={baseDim}>
            {g.visible.map((v, p) => (
              <g
                key={v.series.key}
                opacity={baseDim === 1 && dim(v.si) ? seriesDim : 1}
                className={highlight === v.si && g.kind === 'line' ? 'cr-line-on' : undefined}
              >
                <SeriesMarks spec={spec} g={g} p={p} />
              </g>
            ))}
          </g>
          {overlay}
        </svg>
        {tip}
      </div>
      <div className="row between cr-chart-f">
        {spec.series.length > 1 ? (
          <ul className="cr-legend" aria-label={t('chat.chart.series')}>
            {spec.series.map((series, si) => {
              const off = hidden.includes(series.key);
              return (
                <li key={series.key}>
                  <LegendButton
                    label={series.label}
                    swatch={color(si)}
                    off={off}
                    last={!off && g.visible.length === 1}
                    lastText={t('chat.chart.keepOne')}
                    on={highlight === si}
                    onToggle={() => {
                      onToggle(series.key);
                      clear();
                    }}
                    onEnter={() => {
                      setHighlight(si);
                    }}
                    onLeave={() => {
                      if (active?.via !== 'kb') setHighlight(null);
                    }}
                  />
                </li>
              );
            })}
            {hidden.length > 0 ? (
              <li>
                <button
                  type="button"
                  className="sr-link"
                  onClick={() => {
                    onShowAll();
                    clear();
                  }}
                >
                  {t('chat.chart.showAll')}
                </button>
              </li>
            ) : null}
          </ul>
        ) : (
          <span className="cr-ax-l">{g.kind === 'scatter' ? xLabel : spec.axes.x.label}</span>
        )}
      </div>
      <div id={liveId} className="cr-hover sr-only" aria-live="polite">
        {live}
      </div>
    </>
  );
}

/** Design round 41 `ChatChart`, its drawing: bars, lines, a pie or points. */
export const ChartView = memo(function ChartView(props: Props) {
  return props.spec.chartType === 'pie' ? <PieView {...props} /> : <CartesianView {...props} />;
});

export default ChartView;
