import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { originOf, sendError, sendJson, type ApiHandler } from './http.ts';

/** A run id as the connector makes it (`secrets.token_hex(16)`). */
const runId = (): string => randomBytes(16).toString('hex');

/**
 * The code sandbox in the dev mock (C4, design round 40 «Ejecuta código»): the cells a turn ran
 * as the API shows them, and the files they wrote behind the files routes of the API (status,
 * a download link, the bytes of an image). The demo variants are picked by words of the message:
 *
 * - block: «recortad» (output cut), «excepción» (error), «tope» (300 s), «bloquea» (guardrail);
 * - figure: «figura lenta» (loads slowly), «figura falla» (first load fails, «Reintentar» works);
 * - file: «revisando» (a long scan), «malware» (blocked), «ya no está» (gone),
 *   «descarga falla» (download error), «60 descargas» (the hourly limit);
 * - chart and table (D118, G1 and T1): «línea», «tarta», «dispersión» (the chart's type; bars
 *   otherwise), «gráfica inválida» (cannot be drawn), «gráfica retenida» (the guardrail),
 *   «gráfica falla» (the first read fails, «Reintentar» works), «gráfica en el texto» (a
 *   ```` ```mango-chart ```` block in the answer instead of a chart file).
 */

export interface DemoCell {
  run_id: string;
  status: 'completed' | 'error' | 'timeout';
  blocked: boolean;
  code: string;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  exception: { name: string; message: string } | null;
  seconds: number | null;
  files: {
    file_id: string;
    name: string;
    kind: string;
    role: 'file' | 'figure' | 'chart' | 'table';
    size_bytes: number;
    image: boolean;
  }[];
}

interface DemoFile {
  conversationId: string;
  name: string;
  kind: string;
  size: number;
  /** Client clock (ms) when its scan says. */
  readyAt: number;
  end: 'ready' | 'blocked' | 'gone';
  download: 'ok' | 'error' | 'rate';
  /** Image loads that still fail («figura falla»), or ms they take («figura lenta»). */
  failLoads: number;
  slowMs: number;
  /** A chart or a table: what `…/output` answers (`mango_api.chat_outputs`). */
  output?: { status: number; body: unknown } | undefined;
}

const files = new Map<string, DemoFile>();
/** A bar chart of six months by service (PNG, 600 × 300), as a cell's `savefig` writes one. */
const FIGURE = Buffer.from(
  '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',
  'base64',
);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A file id as the API makes it (ULID). */
function fileId(): string {
  let out = '';
  for (let i = 0; i < 26; i++) out += CROCKFORD.charAt(Math.floor(Math.random() * 32));
  return out;
}

const CELL_1 = [
  'import pandas as pd',
  "df = pd.read_parquet('/mnt/data/cur_2026.parquet')",
  "mes = df.groupby(['mes', 'servicio'])['costo_usd'].sum().unstack()",
  'print(mes.tail(6).round(0))',
].join('\n');
const OUT_1 = [
  'servicio      EC2     RDS      S3',
  'mes',
  '2026-05   41200    9800   12800',
  '2026-06   42900    9650   13100',
  '2026-07   44100    9900   12950',
  '2026-08   51800   10100   13300',
  '2026-09   55600   10050   13400',
  '2026-10   58300   10200   13600',
].join('\n');
const CELL_2 = [
  'import matplotlib.pyplot as plt',
  "ax = mes.tail(6).plot(kind='bar', figsize=(10, 5))",
  "ax.set_ylabel('USD')",
  "plt.savefig('/mnt/data/costo_por_servicio.png', dpi=120)",
  "cuentas = df.pivot_table(index=['cuenta', 'servicio', 'region'], values='costo_usd', aggfunc='sum')",
  "cuentas.to_csv('/mnt/data/costo_por_cuenta.csv')",
  "cuentas.to_excel('/mnt/data/detalle_costos.xlsx')",
].join('\n');

/** Design round 40 `CR_MONTHS` and `crDemoSpec`: the specs as the API returns them. */
const MONTHS = (
  [
    ['may', 41200, 9800, 12800],
    ['jun', 42900, 9650, 13100],
    ['jul', 44100, 9900, 12950],
    ['ago', 51800, 10100, 13300],
    ['sep', 55600, 10050, 13400],
    ['oct', 58300, 10200, 13600],
  ] as const
).map(([mes, EC2, RDS, S3]) => ({ mes, EC2, RDS, S3 }));

const series = (key: string, label: string) => ({
  key,
  label,
  valueFormat: 'compact',
  valuePrefix: '',
  valueSuffix: '',
  stack: null,
});

export function demoChart(message: string): Record<string, unknown> {
  const meta = (title: string, subtitle: string) => ({ title, subtitle, footer: null });
  const base = { layout: 'horizontal', valueFormat: 'compact' };
  if (/tarta/i.test(message)) {
    return {
      ...base,
      chartType: 'pie',
      xKey: 'servicio',
      series: [series('costo', 'Costo')],
      axes: { x: { label: null }, y: { label: null } },
      meta: meta('Reparto del costo de octubre', 'oct 2026 · USD'),
      data: [
        { servicio: 'EC2', costo: 58300 },
        { servicio: 'S3', costo: 13600 },
        { servicio: 'RDS', costo: 10200 },
        { servicio: 'Otros', costo: 6400 },
      ],
    };
  }
  if (/dispersi[oó]n/i.test(message)) {
    return {
      ...base,
      chartType: 'scatter',
      xKey: 'cpu',
      series: [series('costo', 'Instancias EC2')],
      axes: { x: { label: 'CPU media (%)' }, y: { label: 'USD / mes' } },
      meta: meta('Uso contra costo por instancia', '42 instancias · oct 2026'),
      data: Array.from({ length: 42 }, (_, i) => ({
        cpu: Math.round(4 + ((i * 37) % 88)),
        costo: Math.round(120 + ((i * 53) % 17) * 95 + ((i * 7) % 5) * 40),
      })),
    };
  }
  return {
    ...base,
    chartType: /l[ií]nea/i.test(message) ? 'line' : 'bar',
    xKey: 'mes',
    series: [series('EC2', 'EC2'), series('RDS', 'RDS'), series('S3', 'S3')],
    axes: { x: { label: null }, y: { label: 'USD' } },
    meta: meta('Costo mensual por servicio', 'may – oct 2026 · USD'),
    data: MONTHS,
  };
}

/** Design round 40 `CR_TABLE`: 1.248 rows by account, service and region; the API sends 200. */
function demoTable(): Record<string, unknown> {
  const services = ['EC2', 'S3', 'RDS', 'Lambda', 'CloudFront', 'DynamoDB'];
  const regions = ['us-east-1', 'us-west-2', 'eu-west-1', 'sa-east-1'];
  const rows = Array.from({ length: 1248 }, (_, i) => [
    `1111111111${String(11 + (i % 9))}`,
    services[(i * 7) % 6] ?? 'EC2',
    regions[(i * 3) % 4] ?? 'us-east-1',
    ((i * 7919) % 9000) + 40,
  ]).sort((a, b) => Number(b[3]) - Number(a[3]));
  return {
    name: 'costo_por_cuenta',
    columns: ['cuenta', 'servicio', 'region', 'costo_usd'],
    rows: rows.slice(0, 200),
    total_rows: rows.length,
    csv: 'costo_por_cuenta.csv',
  };
}

function outputOf(name: string, message: string): DemoFile['output'] {
  if (name.endsWith('.table.json')) {
    return { status: 200, body: { kind: 'table', chart: null, table: demoTable() } };
  }
  if (!name.endsWith('.chart.json')) return undefined;
  if (/gr[aá]fica inv[aá]lida/i.test(message)) {
    return {
      status: 422,
      body: { error: { code: 'invalid_output', message: 'this chart or table cannot be drawn' } },
    };
  }
  if (/gr[aá]fica retenida/i.test(message)) {
    return {
      status: 409,
      body: { error: { code: 'output_withheld', message: 'this chart or table is not shown' } },
    };
  }
  return { status: 200, body: { kind: 'chart', chart: demoChart(message), table: null } };
}

export type CodeVariant = 'ok' | 'trunc' | 'error' | 'timeout' | 'blocked';

export function codeVariant(message: string): CodeVariant | null {
  if (!/c[oó]digo|analiza|python/i.test(message)) return null;
  if (/recortad/i.test(message)) return 'trunc';
  if (/excepci[oó]n/i.test(message)) return 'error';
  if (/\btope\b|300 s/i.test(message)) return 'timeout';
  if (/bloquea/i.test(message)) return 'blocked';
  return 'ok';
}

function addFile(conversationId: string, name: string, size: number, message: string): string {
  const id = fileId();
  const kind = (name.split('.').pop() ?? '').toLowerCase();
  const image = kind === 'png';
  files.set(id, {
    conversationId,
    name,
    kind,
    size,
    readyAt: Date.now() + (/revisando/i.test(message) ? 12_000 : 1_600),
    end:
      !image && /malware/i.test(message)
        ? 'blocked'
        : !image && /ya no est[aá]/i.test(message)
          ? 'gone'
          : 'ready',
    download: /descarga falla/i.test(message)
      ? 'error'
      : /60 descargas/i.test(message)
        ? 'rate'
        : 'ok',
    failLoads:
      (image && /figura falla/i.test(message)) ||
      (name.endsWith('.chart.json') && /gr[aá]fica falla/i.test(message))
        ? 1
        : 0,
    slowMs: image && /figura lenta/i.test(message) ? 6000 : 400,
    output: outputOf(name, message),
  });
  return id;
}

/** The two cells of the demo, as the API shows them once the guardrail checked them. */
export function demoCells(
  conversationId: string,
  variant: CodeVariant,
  message: string,
): DemoCell[] {
  const first: DemoCell = {
    run_id: runId(),
    status: 'completed',
    blocked: false,
    code: CELL_1,
    stdout: variant === 'trunc' ? `${OUT_1}\n${'0'.repeat(19_000)}` : OUT_1,
    stderr: '',
    stdout_truncated: variant === 'trunc',
    stderr_truncated: false,
    exception: null,
    seconds: 2,
    files: [],
  };
  const base: DemoCell = {
    run_id: runId(),
    status: 'completed',
    blocked: false,
    code: CELL_2,
    stdout: '',
    stderr: "UserWarning: 14 filas sin región; se agrupan como 'sin-region'.",
    stdout_truncated: false,
    stderr_truncated: false,
    exception: null,
    seconds: 3,
    files: [],
  };
  if (variant === 'error') {
    return [
      first,
      {
        ...base,
        status: 'error',
        stderr: [
          'Traceback (most recent call last):',
          '  File "<cell>", line 5, in <module>',
          "KeyError: 'region'",
        ].join('\n'),
        exception: { name: 'KeyError', message: "'region'" },
      },
    ];
  }
  if (variant === 'timeout') {
    return [
      first,
      {
        ...base,
        status: 'timeout',
        stderr: 'The cell was stopped after 300 seconds.',
        seconds: 300,
      },
    ];
  }
  if (variant === 'blocked') {
    return [first, { ...base, blocked: true, code: '', stderr: '', seconds: 3 }];
  }
  const made = (name: string, size: number) => ({
    file_id: addFile(conversationId, name, size, message),
    name,
    kind: (name.split('.').pop() ?? '').toLowerCase(),
    role: name.endsWith('.chart.json')
      ? ('chart' as const)
      : name.endsWith('.table.json')
        ? ('table' as const)
        : name.endsWith('.png')
          ? ('figure' as const)
          : ('file' as const),
    size_bytes: size,
    image: name.endsWith('.png'),
  });
  const inText = /gr[aá]fica en el texto/i.test(message);
  return [
    first,
    {
      ...base,
      files: [
        made('costo_por_servicio.png', FIGURE.length),
        ...(inText ? [] : [made('costo_mensual.chart.json', 2_300)]),
        made('costo_por_cuenta.table.json', 41_000),
        made('costo_por_cuenta.csv', 88_400),
        made('detalle_costos.xlsx', 214_000),
      ],
    },
  ];
}

/** The answer of the demo, after its cells (design round 40). */
export function demoAnswer(variant: CodeVariant, message = ''): string {
  if (variant === 'ok' && /gr[aá]fica en el texto/i.test(message)) {
    return [
      'Revisé los últimos seis meses del CUR. **EC2** explica casi todo el aumento desde agosto.',
      '',
      '```mango-chart',
      JSON.stringify({
        chartType: 'line',
        xKey: 'mes',
        series: [{ key: 'EC2', label: 'EC2' }],
        meta: { title: 'Costo de EC2', subtitle: 'may – oct 2026 · USD' },
        data: MONTHS.map(({ mes, EC2 }) => ({ mes, EC2 })),
      }),
      '```',
    ].join('\n');
  }
  if (variant === 'timeout') {
    return 'La segunda celda pasó su tope de 300 s y se detuvo, así que no llegué a generar la tabla ni el Excel. Con la primera ya se ve que **EC2** explica casi todo el aumento desde agosto. Puedo repetirlo con menos meses.';
  }
  if (variant === 'error') {
    return 'La segunda celda falló: el export no trae la columna `region` en todas las filas. Con la primera ya se ve que **EC2** explica casi todo el aumento desde agosto. Si quieres, rehago la tabla por cuenta sin la región.';
  }
  if (variant === 'blocked') {
    return 'Terminé el análisis, pero Mango ocultó una parte del código y su salida. Con lo que sí se ve: **EC2** explica casi todo el aumento desde agosto.';
  }
  return 'Revisé los últimos seis meses del CUR. **EC2** explica casi todo el aumento desde agosto (de USD 44.100 a 58.300); S3 y RDS se mantienen estables. Abajo van la gráfica y el [Excel con el detalle](sandbox:/mnt/data/detalle_costos.xlsx).';
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function fileOf(res: ServerResponse, conversationId: string, id: string): DemoFile | null {
  const file = files.get(id);
  if (!file || file.conversationId !== conversationId) {
    sendError(res, 404, 'not_found', 'not found');
    return null;
  }
  return file;
}

function statusOf(file: DemoFile): string {
  if (Date.now() < file.readyAt) return 'scanning';
  return file.end === 'blocked' ? 'blocked' : 'ready';
}

/** `/conversations/{id}/files/{file}`, `…/download` and `…/content`, as the API answers them. */
export const handleCodeFiles: ApiHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  path,
) => {
  const match =
    /^\/conversations\/([0-9a-f]{32})\/files\/([0-9A-Z]{26})(\/download|\/content|\/output)?$/.exec(
      path,
    );
  if (!match) return false;
  const [, conversationId = '', id = '', action] = match;
  const file = fileOf(res, conversationId, id);
  if (!file) return true;
  if (!action && req.method === 'GET') {
    sendJson(res, 200, {
      file_id: id,
      name: file.name,
      kind: file.kind,
      size_bytes: file.size,
      status: statusOf(file),
      origin: 'generated',
      expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      gone: file.end === 'gone' && statusOf(file) === 'ready',
    });
    return true;
  }
  if (action === '/download' && req.method === 'POST') {
    await sleep(700);
    if (file.download === 'error') {
      sendError(res, 503, 'storage_unavailable', 'please try again');
      return true;
    }
    if (file.download === 'rate') {
      res.setHeader('Retry-After', '720');
      sendError(res, 429, 'rate_limited', 'too many downloads');
      return true;
    }
    sendJson(res, 200, { url: `${originOf(req)}/mock-files/${id}`, file: file.name });
    return true;
  }
  if (action === '/output' && req.method === 'GET') {
    await sleep(500);
    if (!file.output) {
      sendError(res, 415, 'not_an_output', 'only the charts and tables of a cell are drawn');
      return true;
    }
    if (file.failLoads > 0) {
      file.failLoads -= 1;
      sendError(res, 503, 'storage_unavailable', 'please try again');
      return true;
    }
    sendJson(res, file.output.status, file.output.body);
    return true;
  }
  if (action === '/content' && req.method === 'GET') {
    await sleep(file.slowMs);
    if (file.failLoads > 0) {
      file.failLoads -= 1;
      sendError(res, 503, 'storage_unavailable', 'please try again');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.end(FIGURE);
    return true;
  }
  return false;
};

/**
 * `/mock-files/{file}`: what the presigned link of S3 serves (`attachment`, no token), outside
 * `/api`, like the bucket.
 */
export function handleMockFile(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const saved = /^\/mock-files\/([0-9A-Z]{26})$/.exec(path);
  if (!saved || req.method !== 'GET') return false;
  const file = files.get(saved[1] ?? '');
  if (!file) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${file.name}"`,
  });
  res.end(file.kind === 'png' ? FIGURE : Buffer.from(`Demo de Mango: ${file.name}\n`));
  return true;
}
