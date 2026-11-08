import { memo, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  Rectangle,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Sector,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type PieSectorShapeProps,
} from 'recharts';

import { formatValue, type ChartSpec, type ChartValue } from './chartSpec';

/**
 * The drawing of a chart (design round 40 `ChatChart`, D118 (3)), with Recharts: loaded on
 * demand, only for an answer that has a chart. Recharts draws SVG with React and writes styles
 * through the CSSOM only (no `innerHTML`, no `<style>`), which the CSP of the SPA allows
 * (`style-src 'self'`, Trusted Types); checked in a browser with that CSP. Every text of the spec
 * reaches the SVG as a React text child, escaped.
 */

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
/** Design round 40: a viewBox of 640 × 252, with the axis column 48 px wide. */
const ASPECT = 640 / 252;
const MARGIN = { top: 26, right: 12, bottom: 0, left: 0 };
const TICK = { className: 'cr-ax' };
const DIM = 0.45;
const NO_TIP = () => null;
/** The share of a slice of the pie, in the browser's locale. */
const PERCENT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

const asNumber = (value: ChartValue | undefined): number | null =>
  typeof value === 'number' ? value : null;

interface HoverState {
  activeTooltipIndex?: number | string | null | undefined;
}

function hoverIndex(state: HoverState | undefined): number | null {
  const index = state?.activeTooltipIndex;
  if (index === null || index === undefined) return null;
  const n = Number(index);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** What the footer says of the point under the pointer (design: «may · EC2 41,2 mil · …»). */
function hoverText(spec: ChartSpec, index: number | null): string {
  const row = index === null ? undefined : spec.data[index];
  if (!row) return '';
  const x = row[spec.xKey];
  if (spec.chartType === 'scatter') {
    const [first] = spec.series;
    return first
      ? `${formatValue(x, 'raw')} · ${formatValue(row[first.key], first.valueFormat, first)}`
      : '';
  }
  return [
    formatValue(x, 'raw'),
    ...spec.series.map((s) => `${s.label} ${formatValue(row[s.key], s.valueFormat, s)}`),
  ].join(' · ');
}

function Legend({ spec }: { spec: ChartSpec }) {
  return (
    <ul className="cr-legend">
      {spec.series.map((s, index) => (
        <li key={s.key}>
          {/* The swatch's color is a token of the theme (CSSOM, allowed by the CSP). */}
          <i style={{ background: color(index) }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function PieView({ spec }: { spec: ChartSpec }) {
  const [hover, setHover] = useState<number | null>(null);
  const [first] = spec.series;
  const key = first?.key ?? '';
  const total = spec.data.reduce((sum, row) => sum + Math.max(0, asNumber(row[key]) ?? 0), 0);
  return (
    <div className="cr-pie">
      <div role="img" aria-label={spec.meta.title ?? undefined}>
        <PieChart width={200} height={200}>
          <Pie
            data={spec.data}
            dataKey={key}
            nameKey={spec.xKey}
            outerRadius={77}
            startAngle={90}
            endAngle={-270}
            stroke="var(--card)"
            strokeWidth={2}
            isAnimationActive={false}
            onMouseEnter={(_data, index) => {
              setHover(index);
            }}
            onMouseLeave={() => {
              setHover(null);
            }}
            shape={(props: PieSectorShapeProps) => (
              <Sector
                cx={props.cx}
                cy={props.cy}
                innerRadius={props.innerRadius}
                outerRadius={props.outerRadius}
                startAngle={props.startAngle}
                endAngle={props.endAngle}
                stroke="var(--card)"
                strokeWidth={2}
                fill={color(props.index)}
                opacity={hover === null || hover === props.index ? 1 : DIM}
              />
            )}
          />
        </PieChart>
      </div>
      <ul className="cr-legend is-col">
        {spec.data.map((row, index) => {
          const value = asNumber(row[key]) ?? 0;
          return (
            <li
              key={`${String(row[spec.xKey])}-${String(index)}`}
              onMouseEnter={() => {
                setHover(index);
              }}
              onMouseLeave={() => {
                setHover(null);
              }}
            >
              <i style={{ background: color(index) }} />
              {formatValue(row[spec.xKey], 'raw')}
              <b className="mono">{first ? formatValue(value, first.valueFormat, first) : ''}</b>
              <span className="mono">
                {total > 0 ? `${PERCENT.format((Math.max(0, value) / total) * 100)} %` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CartesianView({ spec }: { spec: ChartSpec }) {
  const [hover, setHover] = useState<number | null>(null);
  const yTick = (value: number) => formatValue(value, 'compact');
  // Design round 40: the y axis label at the top left of the drawing (x 4, y 11).
  const yText = spec.axes.y.label;
  const yLabel = yText
    ? {
        label: {
          content: () => (
            <text x={4} y={11} className="cr-ax">
              {yText}
            </text>
          ),
        },
      }
    : {};
  const events = {
    onMouseMove: (state: HoverState) => {
      setHover(hoverIndex(state));
    },
    onMouseLeave: () => {
      setHover(null);
    },
  };
  const points = useMemo(
    () =>
      spec.chartType === 'scatter'
        ? spec.series.map((s) =>
            spec.data.flatMap((row, index) => {
              const x = asNumber(row[spec.xKey]);
              const y = asNumber(row[s.key]);
              return x === null || y === null ? [] : [{ x, y, index }];
            }),
          )
        : [],
    [spec],
  );
  let chart;
  if (spec.chartType === 'scatter') {
    chart = (
      <ScatterChart margin={MARGIN}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          type="number"
          dataKey="x"
          name={spec.axes.x.label ?? spec.xKey}
          tick={TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => formatValue(v, 'raw')}
        />
        <YAxis
          type="number"
          dataKey="y"
          width={48}
          tick={TICK}
          tickLine={false}
          axisLine={false}
          tickCount={5}
          tickFormatter={yTick}
          {...yLabel}
        />
        <Tooltip content={NO_TIP} cursor={false} isAnimationActive={false} />
        {spec.series.map((s, si) => (
          <Scatter
            key={s.key}
            name={s.label}
            data={points[si] ?? []}
            fill={color(si)}
            fillOpacity={0.75}
            isAnimationActive={false}
            onMouseEnter={(point) => {
              const index = (point.payload as { index?: unknown } | undefined)?.index;
              setHover(typeof index === 'number' ? index : null);
            }}
            onMouseLeave={() => {
              setHover(null);
            }}
          />
        ))}
      </ScatterChart>
    );
  } else if (spec.chartType === 'line') {
    chart = (
      <LineChart data={spec.data} margin={MARGIN} {...events}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey={spec.xKey} tick={TICK} tickLine={false} axisLine={false} />
        <YAxis
          width={48}
          tick={TICK}
          tickLine={false}
          axisLine={false}
          tickCount={5}
          tickFormatter={yTick}
          {...yLabel}
        />
        <Tooltip content={NO_TIP} cursor={false} isAnimationActive={false} />
        {spec.series.map((s, si) => (
          <Line
            key={s.key}
            type="linear"
            dataKey={s.key}
            name={s.label}
            stroke={color(si)}
            strokeWidth={2}
            dot={{ r: 3, fill: color(si), stroke: 'none' }}
            activeDot={{ r: 4.5, fill: color(si), stroke: 'none' }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  } else {
    const vertical = spec.layout === 'vertical';
    chart = (
      <BarChart
        data={spec.data}
        layout={vertical ? 'vertical' : 'horizontal'}
        margin={MARGIN}
        barCategoryGap="28%"
        {...events}
      >
        <CartesianGrid vertical={vertical} horizontal={!vertical} stroke="var(--border)" />
        {vertical ? (
          <>
            <XAxis
              type="number"
              tick={TICK}
              tickLine={false}
              axisLine={false}
              tickFormatter={yTick}
            />
            <YAxis
              type="category"
              dataKey={spec.xKey}
              width={88}
              tick={TICK}
              tickLine={false}
              axisLine={false}
            />
          </>
        ) : (
          <>
            <XAxis dataKey={spec.xKey} tick={TICK} tickLine={false} axisLine={false} />
            <YAxis
              width={48}
              tick={TICK}
              tickLine={false}
              axisLine={false}
              tickCount={5}
              tickFormatter={yTick}
              {...yLabel}
            />
          </>
        )}
        <Tooltip content={NO_TIP} cursor={false} isAnimationActive={false} />
        {spec.series.map((s, si) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={color(si)}
            {...(s.stack ? { stackId: s.stack } : {})}
            radius={vertical ? [0, 2, 2, 0] : [2, 2, 0, 0]}
            isAnimationActive={false}
            shape={(props: BarShapeProps) => (
              <Rectangle {...props} opacity={hover === null || hover === props.index ? 1 : DIM} />
            )}
          />
        ))}
      </BarChart>
    );
  }
  return (
    <>
      <div className="cr-svg" role="img" aria-label={spec.meta.title ?? undefined}>
        <ResponsiveContainer width="100%" aspect={ASPECT}>
          {chart}
        </ResponsiveContainer>
      </div>
      <div className="row between cr-chart-f">
        {spec.series.length > 1 ? (
          <Legend spec={spec} />
        ) : (
          <span className="cr-ax-l">{spec.axes.x.label}</span>
        )}
        <span className="cr-hover mono" aria-live="polite">
          {hoverText(spec, hover)}
        </span>
      </div>
    </>
  );
}

/** Design round 40 `ChatChart`, its drawing: bars, lines, a pie or points. */
export const ChartView = memo(function ChartView({ spec }: { spec: ChartSpec }) {
  return spec.chartType === 'pie' ? <PieView spec={spec} /> : <CartesianView spec={spec} />;
});

export default ChartView;
