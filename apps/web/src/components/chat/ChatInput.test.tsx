import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '../../i18n';
import type { ComposerAttachment } from './attachments';
import { ChatInput, type ComposerFiles } from './ChatInput';

function attachment(overrides: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: 'a1',
    name: 'cur_octubre_2026.csv',
    size: 18.4 * 1_048_576,
    status: 'ready',
    percent: 100,
    fileId: '01HZZZZZZZZZZZZZZZZZZZZZ01',
    ...overrides,
  };
}

function files(overrides: Partial<ComposerFiles> = {}): ComposerFiles {
  return {
    items: [],
    overflow: 0,
    gate: null,
    add: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

function renderInput(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
  const onSend = vi.fn();
  render(
    <ChatInput
      agentName="FinOps"
      isStreaming={false}
      onSend={onSend}
      onStop={vi.fn()}
      canAttach
      files={files()}
      {...props}
    />,
  );
  return { onSend };
}

describe('ChatInput attachments (design round 40, D116)', () => {
  it('picks files with «Adjuntar archivos»', async () => {
    const add = vi.fn();
    renderInput({ files: files({ add }) });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('multiple');
    await userEvent.upload(input as HTMLInputElement, [new File(['a'], 'a.csv')]);
    expect(add).toHaveBeenCalledWith([expect.any(File)]);
    expect(screen.getByRole('button', { name: 'Adjuntar archivos' })).toBeEnabled();
  });

  it('an agent that cannot read files keeps «Adjuntar» visible, disabled, with its reason', async () => {
    renderInput({ canAttach: false, files: null });
    const button = screen.getByRole('button', { name: 'Adjuntar archivos (no disponible)' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute(
      'title',
      'FinOps no puede leer archivos: su versión no tiene «Ejecutar código».',
    );
    expect(document.querySelector('input[type="file"]')).toBeNull();
    await userEvent.click(button);
    expect(screen.getByRole('status')).toHaveTextContent(
      'FinOps no puede leer archivos: su versión no tiene «Ejecutar código». Quien lo administra puede activarlo en el Builder.',
    );
    expect(button).toHaveAttribute('aria-describedby', 'chat-input-why');
  });

  it('shows where each file is, and «Enviar» waits while one uploads or is scanned', () => {
    renderInput({
      files: files({
        gate: 'busy',
        items: [
          attachment({ id: 'a', status: 'uploading', percent: 45, name: 'a.csv' }),
          attachment({ id: 'b', status: 'scanning', name: 'b.csv' }),
          attachment({ id: 'c', name: 'c.csv' }),
        ],
      }),
    });
    expect(screen.getByText('Subiendo · 45 %')).toBeInTheDocument();
    expect(screen.getByText('Revisando el archivo…')).toBeInTheDocument();
    expect(screen.getByText('18,4 MB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(
      screen.getByText('Enviar se activa cuando terminen de subirse y revisarse los archivos.'),
    ).toBeInTheDocument();
  });

  it('a file with a problem must go before the message; a failed upload can be retried', async () => {
    const retry = vi.fn();
    const remove = vi.fn();
    renderInput({
      files: files({
        gate: 'bad',
        retry,
        remove,
        items: [
          attachment({ id: 'x', status: 'failed', name: 'x.csv' }),
          attachment({ id: 'b', status: 'blocked', name: 'b.csv' }),
          attachment({ id: 't', status: 'unsupported', name: 't.html' }),
          attachment({ id: 'm', status: 'mismatch', name: 'm.pdf' }),
          attachment({ id: 'g', status: 'too_large', name: 'g.csv' }),
        ],
      }),
    });
    for (const text of [
      'No se pudo subir',
      'Bloqueado por el escaneo',
      'Tipo no permitido',
      'El contenido no es del tipo que dice',
      'Supera 100 MB',
      'Quita los archivos con problemas para enviar el mensaje.',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(retry).toHaveBeenCalledWith('x');
    await userEvent.click(screen.getByRole('button', { name: 'Quitar b.csv' }));
    expect(remove).toHaveBeenCalledWith('b');
  });

  it('says how many files were left out past 20', () => {
    renderInput({ files: files({ overflow: 3 }) });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Puedes adjuntar hasta 20 archivos por mensaje. 3 se quedaron fuera.',
    );
  });

  it('a message may be only its ready files', async () => {
    const { onSend } = renderInput({ files: files({ items: [attachment()] }) });
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onSend).toHaveBeenCalledWith('');
  });
});
