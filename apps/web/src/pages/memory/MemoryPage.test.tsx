import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { agentFixture, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { MemoryPage } from './MemoryPage';

const rid = (n: number) => `mem-${String(n).padStart(36, '0')}`;
const record = (n: number, overrides: Record<string, unknown> = {}) => ({
  record_id: rid(n),
  agent_id: 'finops',
  kind: 'preferences',
  text: `Recuerdo ${String(n)}`,
  truncated: false,
  created_at: `2026-11-0${String((n % 8) + 1)}T10:00:00+00:00`,
  ...overrides,
});
const memory = (records: unknown[], overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  records,
  complete: true,
  total: records.length,
  ...overrides,
});

function setup(answers: unknown[], deleteRecord = vi.fn(() => Promise.resolve())) {
  const call = vi.fn<(operation: string, input?: unknown) => Promise<unknown>>(() => {
    const answer = answers.shift();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  render(
    <TestProviders
      session={sessionValue({
        api: { call, deleteMemoryRecord: deleteRecord } as unknown as ApiClient,
        agents: [agentFixture({ id: 'finops', name: 'FinOps' })],
      })}
    >
      <MemoryPage />
    </TestProviders>,
  );
  return { call, deleteRecord, user: userEvent.setup() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoryPage (design round 41, D122)', () => {
  it('says the memory is off in the installation', async () => {
    setup([{ enabled: false, records: [], complete: true, total: 0 }]);
    expect(
      await screen.findByRole('heading', { name: 'La memoria está apagada en esta instalación' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Borrar todo/ })).not.toBeInTheDocument();
  });

  it('says no agent remembers anything', async () => {
    setup([memory([])]);
    expect(
      await screen.findByRole('heading', { name: 'Ningún agente recuerda nada de ti' }),
    ).toBeInTheDocument();
  });

  it('lists the records as plain text, by agent and kind, and filters them', async () => {
    const { user } = setup([
      memory([
        record(1, { text: 'Prefiere <b>USD</b> <img src=x onerror=alert(1)>' }),
        record(2, { kind: 'facts', agent_id: 'q5zr7mx2k4nd6wbt' }),
        record(3, { kind: 'summaries', text: 'Revisó el aumento de EC2', truncated: true }),
      ]),
    ]);
    expect(await screen.findByText(/Prefiere <b>USD<\/b>/)).toBeInTheDocument();
    expect(document.querySelector('.mm-text b, .mm-text img')).toBeNull();
    expect(screen.getByText('3 recuerdos')).toBeInTheDocument();
    expect(screen.getByText('Preferencia')).toBeInTheDocument();
    expect(screen.getByText('Hecho')).toBeInTheDocument();
    // An agent the person no longer sees is named by its id.
    expect(screen.getByText(/q5zr7mx2k4nd6wbt ·/)).toBeInTheDocument();
    // Cut text: «…» and its notice.
    expect(screen.getByText('Revisó el aumento de EC2…')).toBeInTheDocument();
    expect(
      screen.getByText('Texto recortado: el recuerdo completo es más largo.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hechos' }));
    expect(screen.getByText('1 de 3')).toBeInTheDocument();
    expect(screen.queryByText(/Prefiere/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agente' }), 'finops');
    expect(screen.getByText('Ningún recuerdo coincide')).toBeInTheDocument();
  });

  it('says when it shows only the most recent ones and «Borrar todo» counts them all', async () => {
    const { user } = setup([memory([record(1), record(2)], { complete: false, total: 412 })]);
    expect(
      await screen.findByText(
        'Se muestran tus 2 recuerdos más recientes de 412. «Borrar todo» también borra los que no se ven.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('412 recuerdos')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Borrar todo…' }));
    const dialog = screen.getByRole('dialog', { name: 'Borrar toda tu memoria' });
    expect(dialog).toHaveTextContent(
      'Todos los agentes dejarán de recordar lo que saben de ti: 412 recuerdos, también los que no se ven en la lista, y lo que guardaron tus tareas. No se puede deshacer.',
    );
  });

  it('deletes one record after confirming in its row', async () => {
    const { deleteRecord, user } = setup([memory([record(1), record(2)])]);
    await screen.findByText('Recuerdo 1');
    const [first] = screen.getAllByRole('button', { name: 'Borrar este recuerdo' });
    if (!first) throw new Error('no row');
    await user.click(first);
    const confirm = screen.getByRole('group', { name: 'Confirmar borrado' });
    expect(confirm).toHaveTextContent('FinOps dejará de recordarlo. No se puede deshacer.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancelar' }));
    expect(deleteRecord).not.toHaveBeenCalled();

    const [again] = screen.getAllByRole('button', { name: 'Borrar este recuerdo' });
    if (!again) throw new Error('no row');
    await user.click(again);
    await user.click(
      within(screen.getByRole('group', { name: 'Confirmar borrado' })).getByRole('button', {
        name: 'Borrar',
      }),
    );
    expect(deleteRecord).toHaveBeenCalledWith(rid(1));
    expect(await screen.findByText('Recuerdo borrado.')).toBeInTheDocument();
    expect(screen.queryByText('Recuerdo 1')).not.toBeInTheDocument();
    expect(screen.getByText('1 recuerdo')).toBeInTheDocument();
  });

  it('deletes everything from its own dialog and says what the API deleted', async () => {
    const { call, user } = setup([memory([record(1), record(2)]), { records: 2, events: 15 }]);
    await screen.findByText('Recuerdo 1');
    await user.click(screen.getByRole('button', { name: 'Borrar todo…' }));
    const dialog = screen.getByRole('dialog', { name: 'Borrar toda tu memoria' });
    expect(dialog).toHaveTextContent(
      'Todos los agentes dejarán de recordar lo que saben de ti: 2 recuerdos, y lo que guardaron tus tareas. No se puede deshacer.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Borrar todo' }));
    expect(call).toHaveBeenLastCalledWith('deleteMemory');
    expect(await screen.findByText('Se borraron 2 recuerdos y 15 eventos.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Ningún agente recuerda nada de ti' }),
    ).toBeInTheDocument();
  });

  it('shows a 503 with «Reintentar» and reads again', async () => {
    const { call, user } = setup([new ApiError(503, 'memory_unavailable', 'x'), memory([])]);
    expect(
      await screen.findByRole('heading', { name: 'La memoria no está disponible ahora' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(call).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole('heading', { name: 'Ningún agente recuerda nada de ti' }),
    ).toBeInTheDocument();
  });

  it('waits out a 429 with its Retry-After before trying again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup([new ApiError(429, 'rate_limited', 'x', 42), memory([])]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Demasiadas solicitudes. Puedes pedir tu memoria hasta 30 veces por minuto.',
    );
    expect(within(alert).getByRole('button', { name: /Reintentar en/ })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(43_000);
    });
    expect(within(alert).getByRole('button', { name: 'Reintentar' })).toBeEnabled();
  });
});
