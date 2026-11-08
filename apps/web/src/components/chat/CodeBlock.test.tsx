import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import type { CodeCell } from '../../api/codeSchemas';
import { ApiError } from '../../api/errors';
import { codeBlockState, type CodeBlockData } from '../../hooks/codeBlock';
import { sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { ChatFilesProvider } from './chatFiles';
import { CodeBlock } from './CodeBlock';
import { FileCard } from './FileCard';

const CONVERSATION = 'c'.repeat(32);
const FIGURE_ID = '01' + 'A'.repeat(24);
const SHEET_ID = '01' + 'B'.repeat(24);

const cell = (overrides: Partial<CodeCell> = {}): CodeCell => ({
  run_id: 'a1',
  status: 'completed',
  blocked: false,
  code: "print('hola')",
  stdout: 'hola\n',
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
  exception: null,
  seconds: 2,
  files: [],
  ...overrides,
});

interface FakeApi {
  getChatFile: ReturnType<typeof vi.fn>;
  chatFileLink: ReturnType<typeof vi.fn>;
  chatFileImage: ReturnType<typeof vi.fn>;
}

function fakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  return {
    getChatFile: vi.fn((_c: string, fileId: string) =>
      Promise.resolve({ file_id: fileId, status: 'ready', gone: false }),
    ),
    chatFileLink: vi.fn(() =>
      Promise.resolve({ url: 'https://bucket.s3.amazonaws.com/x?X-Amz-Expires=300', file: 'x' }),
    ),
    chatFileImage: vi.fn(() => Promise.resolve(new Blob(['png'], { type: 'image/png' }))),
    ...overrides,
  };
}

function wrap(api: FakeApi, children: ReactNode, onDownload = vi.fn()) {
  return (
    <TestProviders session={sessionValue({ api: api as unknown as ApiClient })}>
      <ChatFilesProvider
        value={{
          conversationId: CONVERSATION,
          agentName: 'FinOps',
          threadTitle: 'Costos de octubre',
          onDownload,
        }}
      >
        {children}
      </ChatFilesProvider>
    </TestProviders>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fig'), revokeObjectURL: vi.fn() }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('codeBlockState (rea-gaps §2.4)', () => {
  const block = (cells: CodeCell[], pending = 0): CodeBlockData => ({ cells, pending });
  it('runs while a call waits for its cell, pauses when the answer stopped then', () => {
    expect(codeBlockState(block([cell()], 1), true)).toBe('running');
    expect(codeBlockState(block([cell()], 1), false)).toBe('paused');
  });
  it('is an error when a cell failed or reached its cutoff, not when the guardrail hid it', () => {
    expect(codeBlockState(block([cell({ status: 'error' })]), false)).toBe('error');
    expect(codeBlockState(block([cell({ status: 'timeout' })]), false)).toBe('error');
    expect(codeBlockState(block([cell({ blocked: true, status: 'completed' })]), false)).toBe(
      'completed',
    );
  });
});

describe('CodeBlock (design round 40)', () => {
  it('is folded with its cells and time, and opens on the code and its output', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        fakeApi(),
        <CodeBlock
          block={{ cells: [cell(), cell({ run_id: 'b2', stderr: 'aviso' })], pending: 0 }}
          streaming={false}
        />,
      ),
    );
    const head = screen.getByRole('button', { name: /Analizado/ });
    expect(head).toHaveTextContent('2 celdas · 4,0 s');
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText("print('hola')")).toBeNull();
    await user.click(head);
    expect(screen.getByText('Ocultar código')).toBeInTheDocument();
    expect(screen.getAllByText("print('hola')")).toHaveLength(2);
    expect(screen.getByText('Celda 2')).toBeInTheDocument();
    expect(screen.getAllByText('STDOUT')).toHaveLength(2);
    expect(screen.getByText('STDERR')).toBeInTheDocument();
  });

  it('says «Analizando…» while a cell runs', () => {
    render(wrap(fakeApi(), <CodeBlock block={{ cells: [cell()], pending: 1 }} streaming />));
    expect(screen.getByRole('status')).toHaveTextContent('Analizando…');
    expect(screen.getByText('2 celdas')).toBeInTheDocument();
  });

  it('shows the first line of the failure folded, and the exception open', async () => {
    const user = userEvent.setup();
    const failed = cell({
      status: 'error',
      stderr: 'Traceback…',
      exception: { name: 'KeyError', message: "'region'" },
    });
    render(
      wrap(fakeApi(), <CodeBlock block={{ cells: [failed], pending: 0 }} streaming={false} />),
    );
    expect(screen.getByRole('button', { name: /Error/ })).toBeInTheDocument();
    expect(screen.getByText("KeyError: 'region'")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Error/ }));
    expect(screen.getByText('EXCEPCIÓN')).toBeInTheDocument();
  });

  it('says the cutoff of 300 s without the connector’s own line', async () => {
    const user = userEvent.setup();
    const late = cell({ status: 'timeout', stderr: 'The cell was stopped after 300 seconds.' });
    render(wrap(fakeApi(), <CodeBlock block={{ cells: [late], pending: 0 }} streaming={false} />));
    await user.click(screen.getByRole('button', { name: /Error/ }));
    expect(screen.getByText('TIEMPO')).toBeInTheDocument();
    expect(
      screen.getAllByText('La celda pasó su tope de 300 s y se detuvo.').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/The cell was stopped/)).toBeNull();
  });

  it('says a cut output and a cell the guardrail hid', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        fakeApi(),
        <CodeBlock
          block={{
            cells: [
              cell({ stdout_truncated: true }),
              cell({ run_id: 'b2', blocked: true, code: '' }),
            ],
            pending: 0,
          }}
          streaming={false}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: /Analizado/ }));
    expect(
      screen.getByText('Salida recortada: se muestran los primeros 20.000 caracteres.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Mango no muestra el código ni la salida de esta celda: infringían una regla de seguridad.',
      ),
    ).toBeInTheDocument();
  });

  it('says a block left without its cell when the answer stopped', () => {
    render(wrap(fakeApi(), <CodeBlock block={{ cells: [], pending: 1 }} streaming={false} />));
    expect(screen.getByText('Pausado')).toBeInTheDocument();
    expect(
      screen.getByText('Quedó sin terminar porque la respuesta se detuvo.'),
    ).toBeInTheDocument();
  });

  it('shows a figure as a blob of the API, always, and enlarges it', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const figure = {
      file_id: FIGURE_ID,
      name: 'costo.png',
      kind: 'png',
      size_bytes: 10,
      image: true,
    };
    render(
      wrap(
        api,
        <CodeBlock block={{ cells: [cell({ files: [figure] })], pending: 0 }} streaming={false} />,
      ),
    );
    const image = await screen.findByRole('img', { name: 'costo.png' });
    expect(image).toHaveAttribute('src', 'blob:fig');
    expect(api.chatFileImage).toHaveBeenCalledWith(CONVERSATION, FIGURE_ID, expect.anything());
    const [expand] = screen.getAllByRole('button', { name: 'Ampliar costo.png' });
    if (!expand) throw new Error('no «Ampliar»');
    await user.click(expand);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', 'blob:fig');
  });

  it('says a figure did not load and loads it again with «Reintentar»', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      chatFileImage: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(503, 'storage_unavailable', 'x'))
        .mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
    });
    const figure = {
      file_id: FIGURE_ID,
      name: 'costo.png',
      kind: 'png',
      size_bytes: 10,
      image: true,
    };
    render(
      wrap(
        api,
        <CodeBlock block={{ cells: [cell({ files: [figure] })], pending: 0 }} streaming={false} />,
      ),
    );
    expect(await screen.findByText('No se pudo cargar la figura.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByRole('img', { name: 'costo.png' })).toBeInTheDocument();
  });
});

describe('FileCard (design round 40)', () => {
  const sheet = {
    file_id: SHEET_ID,
    name: 'detalle.xlsx',
    kind: 'xlsx',
    size_bytes: 214_000,
    image: false,
  };

  it('waits for the scan, then downloads by a link asked on click', async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const api = fakeApi({
      getChatFile: vi
        .fn()
        .mockResolvedValueOnce({ file_id: SHEET_ID, status: 'scanning', gone: false })
        .mockResolvedValue({ file_id: SHEET_ID, status: 'ready', gone: false }),
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(wrap(api, <FileCard file={sheet} />, onDownload));
    expect(await screen.findByText('Revisando el archivo…')).toBeInTheDocument();
    expect(screen.getByText('Excel · 209 KB · de FinOps · Costos de octubre')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    vi.useRealTimers();
    await user.click(await screen.findByRole('button', { name: /Descargar/ }));
    await waitFor(() => {
      expect(onDownload).toHaveBeenCalledWith('detalle.xlsx');
    });
    expect(api.chatFileLink).toHaveBeenCalledWith(CONVERSATION, SHEET_ID);
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it.each([
    [
      { status: 'blocked', gone: false },
      'El escaneo de malware bloqueó este archivo. No se puede descargar.',
    ],
    [
      { status: 'ready', gone: true },
      'Ya no está disponible. Los archivos se guardan 90 días y se borran con la conversación.',
    ],
  ])('says a file %o is not delivered', async (status, text) => {
    const api = fakeApi({
      getChatFile: vi.fn(() => Promise.resolve({ file_id: SHEET_ID, ...status })),
    });
    render(wrap(api, <FileCard file={sheet} />));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Descargar/ })).toBeNull();
  });

  it('says a download that failed, with «Reintentar», and the hourly limit', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      chatFileLink: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(503, 'storage_unavailable', 'x'))
        .mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'x', 720)),
    });
    render(wrap(api, <FileCard file={sheet} />));
    await user.click(await screen.findByRole('button', { name: /Descargar/ }));
    expect(
      await screen.findByText('No se pudo preparar la descarga. Inténtalo de nuevo.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(
      await screen.findByText(
        'Llegaste al máximo de 60 descargas por hora. Podrás descargar de nuevo en 12 minutos.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Descargar/ })).toBeDisabled();
  });

  it('never opens a link that is not https', async () => {
    const user = userEvent.setup();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const api = fakeApi({
      chatFileLink: vi.fn(() => Promise.resolve({ url: 'javascript:alert(1)', file: 'x' })),
    });
    render(wrap(api, <FileCard file={sheet} />));
    await user.click(await screen.findByRole('button', { name: /Descargar/ }));
    expect(
      await screen.findByText('No se pudo preparar la descarga. Inténtalo de nuevo.'),
    ).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });
});
