import { useTranslation } from 'react-i18next';

/** Design EvSpark: the trend of the last scores (0 to 100) against the threshold. */
export function EvSpark({
  scores,
  threshold,
  width = 110,
  height = 30,
}: {
  scores: readonly number[];
  threshold: number;
  width?: number;
  height?: number;
}) {
  const { t } = useTranslation();
  if (scores.length < 2) {
    return <span className="mk-meta">{scores.length ? t('evals.oneRun') : t('evals.noRuns')}</span>;
  }
  // Design EvSpark: from 40 % to 100 %; a lower score sits on the bottom edge.
  const y = (value: number) =>
    height - ((Math.min(100, Math.max(40, value)) / 100 - 0.4) / 0.6) * height;
  const points = scores.map((value, index) => [(index / (scores.length - 1)) * width, y(value)]);
  const ty = y(threshold);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      aria-hidden="true"
    >
      <line
        x1="0"
        x2={width}
        y1={ty}
        y2={ty}
        stroke="var(--text-dim)"
        strokeDasharray="2 3"
        strokeWidth="1"
      />
      <polyline
        points={points.map((point) => point.map((n) => n.toFixed(1)).join(',')).join(' ')}
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="1.6"
      />
      {points.map(([x = 0, cy = 0], index) => (
        <circle
          key={index}
          cx={x.toFixed(1)}
          cy={cy.toFixed(1)}
          r={index === points.length - 1 ? 2.8 : 1.6}
          fill={(scores[index] ?? 0) >= threshold ? 'var(--green)' : 'var(--red)'}
        />
      ))}
    </svg>
  );
}
