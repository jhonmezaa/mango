import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { ChartCard, ChartBlock, DATA_SHOWN_ROWS } from './ChatChart';
import { MAX_ROWS, MAX_SERIES, normalizeChart, type ChartSpec } from './chartSpec';
import { ChatFilesProvider } from './chatFiles';

// Design round 41 (D118 (10)): the interactive chart of an answer, its legend, its keyboard,
// «Ver datos» and «Copiar datos». The drawing is SVG drawn by React, so jsdom renders it.

const MONTHS = [
  ['may', 41200, 9800, 12800],
  ['jun', 42900, 9650, 13100],
  ['jul', 44100, 9900, 12950],
  ['ago', 51800, 10100, 13300],
  ['sep', 55600, 10050, 13400],
  ['oct', 58300, 10200, 13600],
].map(([mes, EC2, RDS, S3]) => ({ mes, EC2, RDS, S3 }));

function spec(raw: Record<string, unknown>): ChartSpec {
  const parsed = normalizeChart(raw);
  if (!parsed) throw new Error('the spec must parse');
  return parsed;
}

const BARS = spec({
  chartType: 'bar',
  xKey: 'mes',
  valueFormat: 'currency',
  currency: 'USD',
  series: [
    { key: 'EC2', label: 'EC2' },
    { key: 'RDS', label: 'RDS' },
    { key: 'S3', label: 'S3' },
  ],
  meta: { title: 'Costo mensual por servicio', subtitle: 'May – oct 2026 · Valores en USD' },
  axes: { y: { label: 'USD' } },
  data: MONTHS,
});

const usd = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

function wrap(children: ReactNode, onCopied = vi.fn()) {
  return (
    <TestProviders session={sessionValue({ api: {} as ApiClient })}>
      <ChatFilesProvider
        value={{ conversationId: 'c'.repeat(32), agentName: 'FinOps', threadTitle: '', onCopied }}
      >
        {children}
      </ChatFilesProvider>
    </TestProviders>
  );
}

async function plot(name = /^Costo mensual por servicio\./) {
  return screen.findByRole('application', { name });
}

/** The words the screen reader hears for the active point (`.cr-hover`, `aria-live`). */
function live(): string {
  return document.querySelector('.cr-hover')?.textContent ?? '';
}

/** The ticks of the value axis, as drawn. */
function ticks(container: HTMLElement): string[] {
  return [...container.querySelectorAll('svg.cr-svg text[text-anchor="end"]')].map(
    (n) => n.textContent,
  );
}

describe('the legend shows and hides series (design round 41)', () => {
  it('hides a series, keeps its color, rescales the axes and shows it again', async () => {
    const user = userEvent.setup();
    const { container } = render(wrap(<ChartCard spec={BARS} />));
    await plot();
    const legend = screen.getByRole('list', { name: 'Series' });
    const ec2 = within(legend).getByRole('button', { name: 'EC2' });
    expect(ec2).toHaveAttribute('aria-pressed', 'true');
    expect(ticks(container).at(-1)).toBe(usd(60000));
    expect(container.querySelectorAll('svg.cr-svg rect[rx="2"]')).toHaveLength(18);
    await user.click(ec2);
    expect(ec2).toHaveAttribute('aria-pressed', 'false');
    expect(ec2).toHaveClass('is-off');
    // The axes fit what is visible; the series keep their colors.
    expect(ticks(container).at(-1)).toBe(usd(15000));
    expect(container.querySelectorAll('svg.cr-svg rect[rx="2"]')).toHaveLength(12);
    const fills = new Set(
      [...container.querySelectorAll('svg.cr-svg rect[rx="2"]')].map((n) => n.getAttribute('fill')),
    );
    expect(fills).toEqual(new Set(['var(--blue)', 'var(--violet)']));
    await user.click(screen.getByRole('button', { name: 'Mostrar todas' }));
    expect(ec2).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Mostrar todas' })).not.toBeInTheDocument();
  });

  it('never hides the last series', async () => {
    const user = userEvent.setup();
    render(wrap(<ChartCard spec={BARS} />));
    await plot();
    await user.click(screen.getByRole('button', { name: 'EC2' }));
    await user.click(screen.getByRole('button', { name: 'RDS' }));
    const s3 = screen.getByRole('button', { name: 'S3' });
    expect(s3).toHaveAttribute('aria-disabled', 'true');
    expect(s3).toHaveAttribute('title', 'Tiene que quedar al menos una serie a la vista');
    await user.click(s3);
    expect(s3).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the keyboard walks the points (design round 41)', () => {
  it('goes by category and by series, jumps, and lets go with Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(wrap(<ChartCard spec={BARS} />));
    const drawing = await plot();
    act(() => {
      drawing.focus();
    });
    await user.keyboard('{ArrowRight}');
    // The first key takes the first point and its first series.
    expect(live()).toBe(`may · EC2 ${usd(41200)} · 1 de 6`);
    await user.keyboard('{ArrowRight}');
    expect(live()).toContain('jun');
    // Up and down by series: only that series is said.
    await user.keyboard('{ArrowDown}');
    expect(live()).toBe(`jun · RDS ${usd(9650)} · 2 de 6`);
    await user.keyboard('{End}');
    expect(live()).toBe(`oct · RDS ${usd(10200)} · 6 de 6`);
    await user.keyboard('{Home}');
    expect(live()).toContain('1 de 6');
    await user.keyboard('{PageDown}');
    expect(live()).toContain('2 de 6');
    // The tooltip: the category, each series with its value, the active one in bold.
    const tip = container.querySelector('.cr-tip');
    expect(tip).toHaveTextContent('jun');
    expect(tip?.querySelector('.cr-tip-r.is-on')).toHaveTextContent(`RDS${usd(9650)}`);
    await user.keyboard('{Escape}');
    expect(live()).toBe('');
    expect(container.querySelector('.cr-tip')).toBeNull();
    expect(drawing).toHaveFocus();
  });

  it('walks a horizontal bar chart up and down, and says how many series are hidden', async () => {
    const user = userEvent.setup();
    const long = 'Amazon Relational Database Service';
    const horizontal = spec({
      chartType: 'bar',
      layout: 'vertical',
      xKey: 'servicio',
      series: [
        { key: 'oct', label: 'Octubre' },
        { key: 'nov', label: 'Noviembre' },
      ],
      meta: { title: 'Costo por servicio de AWS' },
      data: [
        { servicio: 'Amazon Elastic Compute Cloud', oct: 5310, nov: 5820 },
        { servicio: long, oct: 2050, nov: 2140 },
      ],
    });
    const { container } = render(wrap(<ChartCard spec={horizontal} />));
    const drawing = await plot(/^Costo por servicio de AWS\./);
    // Labels on the left, cut to 30 characters; the tooltip has the whole name.
    expect(screen.getByText('Amazon Relational Database Se…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Octubre' }));
    act(() => {
      drawing.focus();
    });
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(live()).toContain(long);
    const tip = container.querySelector('.cr-tip');
    expect(tip).toHaveTextContent(long);
    expect(tip?.querySelector('.cr-tip-f')).toHaveTextContent('1 serie oculta');
  });

  it('draws no points in a line of more than 60 categories, only the active one', async () => {
    const user = userEvent.setup();
    const days = spec({
      chartType: 'line',
      xKey: 'dia',
      series: [{ key: 'EC2' }],
      meta: { title: 'Costo diario' },
      data: Array.from({ length: 120 }, (_, i) => ({ dia: `d${String(i)}`, EC2: 1300 + i })),
    });
    const { container } = render(wrap(<ChartCard spec={days} />));
    const drawing = await plot(/^Costo diario\./);
    expect(container.querySelectorAll('svg.cr-svg circle')).toHaveLength(0);
    // The axis labels are spaced so that they never overlap.
    expect(container.querySelectorAll('svg.cr-svg text[text-anchor="middle"]').length).toBeLessThan(
      15,
    );
    act(() => {
      drawing.focus();
    });
    await user.keyboard('{ArrowRight}{PageDown}');
    expect(live()).toContain('13 de 120');
    expect(container.querySelectorAll('svg.cr-svg circle').length).toBeGreaterThan(0);
  });
});

describe('a pie (design round 41)', () => {
  const PIE = spec({
    chartType: 'pie',
    xKey: 'servicio',
    valueFormat: 'currency',
    series: [{ key: 'costo', label: 'Costo' }],
    meta: { title: 'Reparto del costo de octubre' },
    data: [
      { servicio: 'EC2', costo: 60 },
      { servicio: 'S3', costo: 30 },
      { servicio: 'RDS', costo: 10 },
    ],
  });

  it('hides slices and says the share of what is visible', async () => {
    const user = userEvent.setup();
    const { container } = render(wrap(<ChartCard spec={PIE} />));
    const drawing = await plot(/^Reparto del costo de octubre\./);
    const slices = screen.getByRole('list', { name: 'Porciones' });
    expect(within(slices).getAllByRole('button')[0]).toHaveTextContent('60 %');
    act(() => {
      drawing.focus();
    });
    await user.keyboard('{ArrowRight}');
    expect(container.querySelector('.cr-tip')).toHaveTextContent('Del total');
    await user.click(within(slices).getByRole('button', { name: /^S3/ }));
    expect(container.querySelectorAll('.cr-plot svg path')).toHaveLength(2);
    expect(within(slices).getAllByRole('button')[0]).toHaveTextContent('86 %');
    act(() => {
      drawing.focus();
    });
    await user.keyboard('{ArrowRight}');
    expect(container.querySelector('.cr-tip')).toHaveTextContent('De lo visible');
    expect(container.querySelector('.cr-tip')).toHaveTextContent(
      '85,7 %'.replace(',', new Intl.NumberFormat().format(0.5).charAt(1)),
    );
  });
});

describe('«Ver datos» and «Copiar datos» (design round 41)', () => {
  it('switches to a table of every series, the hidden ones too, and back', async () => {
    const user = userEvent.setup();
    render(wrap(<ChartCard spec={BARS} />));
    await plot();
    await user.click(screen.getByRole('button', { name: 'EC2' }));
    await user.click(screen.getByRole('button', { name: 'Ver datos' }));
    const region = screen.getByRole('region', { name: 'Datos de Costo mensual por servicio' });
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((n) => n.textContent),
    ).toEqual(['mes', 'EC2', 'RDS', 'S3']);
    expect(within(region).getByRole('rowheader', { name: 'may' })).toBeInTheDocument();
    expect(within(region).getByText(usd(41200))).toHaveClass('num', 'mono');
    await user.click(screen.getByRole('button', { name: 'Ver gráfica' }));
    // The hidden series stay hidden.
    expect(await screen.findByRole('button', { name: 'EC2' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows 200 rows of a long chart and copies them all, with every series', async () => {
    const user = userEvent.setup();
    const onCopied = vi.fn();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const many = spec({
      chartType: 'line',
      xKey: 'dia',
      series: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      meta: { title: 'Muchos días' },
      data: Array.from({ length: 1248 }, (_, i) => ({ dia: `d${String(i)}`, a: i, b: 2 * i })),
    });
    render(wrap(<ChartCard spec={many} />, onCopied));
    await plot(/^Muchos días\./);
    await user.click(screen.getByRole('button', { name: 'A' }));
    await user.click(screen.getByRole('button', { name: 'Ver datos' }));
    const region = screen.getByRole('region', { name: 'Datos de Muchos días' });
    expect(within(region).getAllByRole('row')).toHaveLength(DATA_SHOWN_ROWS + 1);
    const number = new Intl.NumberFormat();
    expect(
      screen.getByText(
        `Se muestran ${number.format(200)} de ${number.format(1248)} filas. «Copiar datos» las copia todas.`,
      ),
    ).toBeInTheDocument();
    const copy = screen.getByRole('button', { name: 'Copiar datos' });
    expect(copy).toHaveAttribute('title', 'Copiar datos (se pegan en Excel)');
    await user.click(copy);
    const copied = String(writeText.mock.calls[0]?.[0]).split('\n');
    expect(copied).toHaveLength(1249);
    expect(copied[0]).toBe('dia\tA\tB');
    expect(copied[1248]).toBe('d1247\t1247\t2494');
    expect(onCopied).toHaveBeenCalled();
  });

  it('a chart without a title still has its actions, and no «Descargar PNG»', async () => {
    render(
      wrap(<ChartCard spec={{ ...BARS, meta: { title: null, subtitle: null, footer: null } }} />),
    );
    await screen.findByRole('application', { name: /^Gráfica\./ });
    expect(screen.getByRole('button', { name: 'Ver datos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copiar datos' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PNG/ })).not.toBeInTheDocument();
  });
});

describe('the pointer (design round 41)', () => {
  it('shows the tooltip next to the bar under the mouse and hides it when leaving', async () => {
    const { container } = render(wrap(<ChartCard spec={BARS} />));
    await plot();
    const svg = container.querySelector('svg.cr-svg');
    if (!svg) throw new Error('no drawing');
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 252 }),
    );
    // The fourth month, in the right half: the tooltip goes to its left (last 40 % of the width).
    fireEvent.pointerMove(svg, {
      pointerType: 'mouse',
      clientX: 58 + (566 / 6) * 5.5,
      clientY: 200,
    });
    const tip = container.querySelector('.cr-tip');
    expect(tip).toHaveTextContent('oct');
    expect(tip).toHaveClass('is-l');
    fireEvent.pointerMove(svg, {
      pointerType: 'mouse',
      clientX: 58 + (566 / 6) * 0.5,
      clientY: 200,
    });
    expect(container.querySelector('.cr-tip')).toHaveTextContent('may');
    expect(container.querySelector('.cr-tip')).not.toHaveClass('is-l');
    fireEvent.pointerLeave(svg, { pointerType: 'mouse' });
    expect(container.querySelector('.cr-tip')).toBeNull();
  });

  it('pins the tooltip on touch and closes it when touching outside the card', async () => {
    const { container } = render(
      wrap(
        <>
          <ChartCard spec={BARS} />
          <button type="button">fuera</button>
        </>,
      ),
    );
    await plot();
    const svg = container.querySelector('svg.cr-svg');
    if (!svg) throw new Error('no drawing');
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 252 }),
    );
    fireEvent.pointerDown(svg, { pointerType: 'touch', clientX: 100, clientY: 200 });
    expect(container.querySelector('.cr-tip')).toHaveTextContent('may');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'fuera' }), { pointerType: 'touch' });
    expect(container.querySelector('.cr-tip')).toBeNull();
  });
});

describe('the limits (design round 41)', () => {
  it('does not draw more than 5,000 rows or 20 series, nor an empty chart', () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ x: `r${String(i)}`, v: i }));
    for (const body of [
      { chartType: 'bar', data: rows },
      {
        chartType: 'bar',
        data: [{ x: 'a', v: 1 }],
        series: Array.from({ length: MAX_SERIES + 1 }, (_, i) => ({ key: `s${String(i)}` })),
      },
      { chartType: 'bar', data: [] },
    ]) {
      const { unmount } = render(
        wrap(<ChartBlock body={JSON.stringify(body)} streaming={false} />),
      );
      expect(screen.getByText('No se pudo dibujar esta gráfica.')).toBeInTheDocument();
      unmount();
    }
  });

  it('draws the limits themselves', async () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => ({ x: `r${String(i)}`, v: i }));
    render(
      wrap(
        <ChartBlock body={JSON.stringify({ chartType: 'line', data: rows })} streaming={false} />,
      ),
    );
    expect(await screen.findByRole('application', { name: /^Gráfica\./ })).toBeInTheDocument();
  });
});
