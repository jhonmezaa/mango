import { SandboxError } from '@mango/ui-sandbox/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionValue, testConfig } from '../../../test/fixtures';
import { TestProviders } from '../../../test/TestProviders';
import { CanvasPreview } from './CanvasPreview';

const host = vi.hoisted(() => ({ openSandbox: vi.fn() }));
vi.mock('../../../sandbox/sandboxHost', () => host);

const ORIGIN = 'https://d123.cloudfront.net';

function session(run: () => Promise<{ ok: boolean; durationMs: number }>) {
  const destroy = vi.fn();
  const value = {
    iframe: document.createElement('iframe'),
    run: vi.fn(run),
    stop: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    destroy,
  };
  return value;
}

function show(kind: 'code/python' | 'code/react' | 'code/html' = 'code/python') {
  return render(
    <TestProviders session={sessionValue({ config: { ...testConfig, sandboxOrigin: ORIGIN } })}>
      <CanvasPreview kind={kind} code="print(1)" />
    </TestProviders>,
  );
}

describe('CanvasPreview (design round 41, D123)', () => {
  beforeEach(() => {
    host.openSandbox.mockReset();
  });

  it('runs only the code in the second origin and says it is ready from the end of run()', async () => {
    const opened = session(() => Promise.resolve({ ok: true, durationMs: 10 }));
    host.openSandbox.mockResolvedValue(opened);
    const { unmount } = show();
    expect(screen.getByText('Preparando Python…')).toBeInTheDocument();
    expect(await screen.findByText('Lista')).toBeInTheDocument();
    const [options] = host.openSandbox.mock.calls[0] as [{ origin: string; title: string }];
    expect(options.origin).toBe(ORIGIN);
    expect(opened.run).toHaveBeenCalledWith(
      { kind: 'python', source: 'print(1)' },
      expect.anything(),
    );
    // The label is Mango's, outside the frame.
    expect(
      screen.getByText('Vista previa · contenido del agente, no de Mango'),
    ).toBeInTheDocument();
    unmount();
    expect(opened.destroy).toHaveBeenCalled();
  });

  it('says the code failed, with what Python has', async () => {
    host.openSandbox.mockResolvedValue(
      session(() => Promise.resolve({ ok: false, durationMs: 5 })),
    );
    show();
    expect(await screen.findByText('Error en el código')).toBeInTheDocument();
    expect(
      screen.getByText('Solo hay numpy, pandas y matplotlib. No se instalan paquetes.'),
    ).toBeInTheDocument();
  });

  it('tells a runner that did not start from a run that took too long', async () => {
    host.openSandbox.mockRejectedValueOnce(new SandboxError('TimeoutError', 'late'));
    show('code/react');
    expect(await screen.findByText('La vista previa no arrancó en 20 s.')).toBeInTheDocument();
    host.openSandbox.mockResolvedValue(
      session(() => Promise.reject(new SandboxError('TimeoutError', 'late'))),
    );
    await userEvent.click(screen.getByRole('button', { name: /Ejecutar de nuevo/ }));
    expect(
      await screen.findByText('La ejecución pasó su tope de 50 s y se detuvo.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(host.openSandbox).toHaveBeenCalledTimes(2);
    });
  });
});
