import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import type { CodeFile } from '../../api/codeSchemas';
import { ApiError } from '../../api/errors';
import { codeFileCards, codeOutputs } from '../../hooks/codeBlock';
import { sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { ChartCard, ChartBlock, ChatChartFile } from './ChatChart';
import { normalizeChart } from './chartSpec';
import { ChatFilesProvider } from './chatFiles';
import { ChatTableFile, TableCard } from './DataTable';

vi.mock('./ChartView', () => ({
  // Recharts measures its container, which jsdom does not lay out: the drawing is checked in
  // the browser (e2e/chatCode.spec.ts); here, that the card mounts it with the spec.
  default: ({ spec }: { spec: { chartType: string } }) => (
    <div data-testid="chart-view">{spec.chartType}</div>
  ),
}));

const CONVERSATION = 'c'.repeat(32);
const CHART_ID = '01' + 'C'.repeat(24);
const TABLE_ID = '01' + 'D'.repeat(24);
const CSV_ID = '01' + 'E'.repeat(24);

const file = (id: string, name: string, role: CodeFile['role'], kind = 'json'): CodeFile => ({
  file_id: id,
  name,
  kind,
  role,
  size_bytes: 2048,
  image: false,
});

const parsed = normalizeChart({
  chartType: 'bar',
  xKey: 'mes',
  series: [{ key: 'EC2' }],
  meta: { title: 'Costo mensual', subtitle: 'may – oct 2026 · USD' },
  data: [{ mes: '=may', EC2: 41200 }],
});
if (!parsed) throw new Error('the demo spec must parse');
const SPEC = parsed;

function fakeApi(call: ReturnType<typeof vi.fn>) {
  return {
    call,
    getChatFile: vi.fn((_c: string, fileId: string) =>
      Promise.resolve({ file_id: fileId, status: 'ready', gone: false }),
    ),
    chatFileLink: vi.fn(),
    chatFileImage: vi.fn(),
  };
}

function wrap(api: unknown, children: ReactNode, onCopied = vi.fn()) {
  return (
    <TestProviders session={sessionValue({ api: api as ApiClient })}>
      <ChatFilesProvider
        value={{ conversationId: CONVERSATION, agentName: 'FinOps', threadTitle: '', onCopied }}
      >
        {children}
      </ChatFilesProvider>
    </TestProviders>
  );
}

describe('ChatChart (design round 40, D118)', () => {
  it('shows its title, its subtitle and copies its data as TSV with formulas defused', async () => {
    const user = userEvent.setup();
    const onCopied = vi.fn();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(wrap(fakeApi(vi.fn()), <ChartCard spec={SPEC} />, onCopied));
    expect(screen.getByText('Costo mensual')).toBeInTheDocument();
    expect(screen.getByText('may – oct 2026 · USD')).toBeInTheDocument();
    expect(await screen.findByTestId('chart-view')).toHaveTextContent('bar');
    await user.click(screen.getByRole('button', { name: 'Copiar datos' }));
    expect(writeText).toHaveBeenCalledWith("mes\tEC2\n'=may\t41200");
    await waitFor(() => {
      expect(onCopied).toHaveBeenCalled();
    });
  });

  it('reads a chart of a cell from the API once its scan let it be read', async () => {
    const call = vi.fn(() => Promise.resolve({ kind: 'chart', chart: SPEC, table: null }));
    render(wrap(fakeApi(call), <ChatChartFile file={file(CHART_ID, 'c.chart.json', 'chart')} />));
    expect(screen.getByRole('status', { name: 'Cargando la gráfica' })).toHaveTextContent(
      'Cargando la gráfica…',
    );
    expect(await screen.findByTestId('chart-view')).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith(
      'chatFileOutput',
      { path: { conversation_id: CONVERSATION, file_id: CHART_ID } },
      expect.anything(),
    );
  });

  it('says a chart cannot be drawn with the design`s words', async () => {
    const call = vi.fn(() =>
      Promise.reject(new ApiError(422, 'invalid_output', 'this chart or table cannot be drawn')),
    );
    render(wrap(fakeApi(call), <ChatChartFile file={file(CHART_ID, 'c.chart.json', 'chart')} />));
    expect(await screen.findByText('No se pudo dibujar esta gráfica.')).toBeInTheDocument();
    expect(
      screen.getByText(/Pídele que la vuelva a generar o que te los dé en una tabla\./),
    ).toBeInTheDocument();
  });

  it('shows nothing of a chart the guardrail withheld', async () => {
    const call = vi.fn(() =>
      Promise.reject(new ApiError(409, 'output_withheld', 'this chart or table is not shown')),
    );
    render(wrap(fakeApi(call), <ChatChartFile file={file(CHART_ID, 'c.chart.json', 'chart')} />));
    expect(
      await screen.findByText('Mango no muestra esta gráfica: infringía una regla de seguridad.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
  });

  it('asks again after «Reintentar» when the read failed', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'files_unavailable', 'please try again'))
      .mockResolvedValue({ kind: 'chart', chart: SPEC, table: null });
    render(wrap(fakeApi(call), <ChatChartFile file={file(CHART_ID, 'c.chart.json', 'chart')} />));
    await user.click(await screen.findByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByTestId('chart-view')).toBeInTheDocument();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('draws a ```mango-chart``` block, waits while it streams and is invalid once it ended', () => {
    const { rerender } = render(
      wrap(fakeApi(vi.fn()), <ChartBlock body='{"chartType": "bar", "da' streaming />),
    );
    expect(screen.getByRole('status', { name: 'Cargando la gráfica' })).toBeInTheDocument();
    rerender(
      wrap(fakeApi(vi.fn()), <ChartBlock body='{"chartType": "bar", "da' streaming={false} />),
    );
    expect(screen.getByText('No se pudo dibujar esta gráfica.')).toBeInTheDocument();
  });
});

describe('DataTable (design round 40, D118 (5))', () => {
  const table = {
    name: 'costo_por_cuenta',
    columns: ['cuenta', 'costo_usd'],
    rows: Array.from({ length: 200 }, (_, i) => [`1111222233${String(i % 10)}3`, 1000 + i]),
    total_rows: 1248,
    csv: 'costo_por_cuenta.csv',
  };

  it('shows its size, at most 200 rows, the note and the card of its CSV', () => {
    const csv = file(CSV_ID, 'costo_por_cuenta.csv', 'file', 'csv');
    render(wrap(fakeApi(vi.fn()), <TableCard table={table} csv={csv} />));
    const number = new Intl.NumberFormat();
    expect(screen.getByText(`${number.format(1248)} filas · 2 columnas`)).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'costo_por_cuenta' });
    expect(within(region).getAllByRole('row')).toHaveLength(201);
    expect(
      screen.getByText(
        `Se muestran ${number.format(200)} de ${number.format(1248)} filas. Descarga el CSV para verlas todas.`,
      ),
    ).toBeInTheDocument();
    // Numbers to the right, in mono; texts as text.
    expect(within(region).getByText(number.format(1000))).toHaveClass('num', 'mono');
    expect(within(region).getByRole('columnheader', { name: 'costo_usd' })).toHaveClass('num');
    expect(screen.getByText('costo_por_cuenta.csv')).toBeInTheDocument();
  });

  it('has no note when every row is shown', () => {
    render(
      wrap(
        fakeApi(vi.fn()),
        <TableCard table={{ ...table, rows: table.rows.slice(0, 3), total_rows: 3 }} />,
      ),
    );
    expect(screen.getByText('3 filas · 2 columnas')).toBeInTheDocument();
    expect(screen.queryByText(/Se muestran/)).not.toBeInTheDocument();
  });

  it('reads a table of a cell from the API', async () => {
    const call = vi.fn(() => Promise.resolve({ kind: 'table', chart: null, table }));
    render(
      wrap(
        fakeApi(call),
        <ChatTableFile file={file(TABLE_ID, 'costo_por_cuenta.table.json', 'table')} />,
      ),
    );
    expect(await screen.findByRole('region', { name: 'costo_por_cuenta' })).toBeInTheDocument();
  });
});

describe('the outputs of an answer (bloque → texto → gráfica → tabla → archivos)', () => {
  it('pairs a table with its CSV, which is not a card of its own', () => {
    const cell = {
      run_id: 'a1',
      status: 'completed' as const,
      blocked: false,
      code: '',
      stdout: '',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
      exception: null,
      seconds: 1,
      files: [
        file(CHART_ID, 'costo.chart.json', 'chart'),
        file(TABLE_ID, 'costos.table.json', 'table'),
        file(CSV_ID, 'costos-table.csv', 'file', 'csv'),
        file('01' + 'F'.repeat(24), 'costos.csv', 'file', 'csv'),
      ],
    };
    const block = { cells: [cell], pending: 0 };
    const outputs = codeOutputs(block);
    expect(outputs.charts.map((f) => f.name)).toEqual(['costo.chart.json']);
    expect(outputs.tables.map((t) => [t.file.name, t.csv?.name])).toEqual([
      ['costos.table.json', 'costos-table.csv'],
    ]);
    // The model's own CSV stays a card; the specs and the table's CSV do not.
    expect(codeFileCards(block).map((f) => f.name)).toEqual(['costos.csv']);
  });
});
