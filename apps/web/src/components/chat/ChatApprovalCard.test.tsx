import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../i18n';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { ChatApproval } from '../../api/schemas';
import { NOW, XSS, approval, selfApproval } from '../../pages/approvals/testFixtures';
import { baseMe } from '../../test/fixtures';
import { ChatApprovalCard } from './ChatApprovalCard';

function renderCard(item: ChatApproval, answers: Record<string, ChatApproval | Error> = {}) {
  const call = vi.fn((operation: string) => {
    const answer = answers[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  const onUpdated = vi.fn();
  const notify = vi.fn();
  const view = render(
    <MemoryRouter>
      <ChatApprovalCard
        api={{ call } as unknown as ApiClient}
        me={baseMe}
        approval={item}
        onUpdated={onUpdated}
        notify={notify}
      />
    </MemoryRouter>,
  );
  return { call, onUpdated, notify, ...view };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatApprovalCard · confirmación propia', () => {
  it('asks to run the stored call, shown as text', () => {
    const item = selfApproval({ arguments: { name: XSS, amount_usd: 100 } });
    renderCard(item);
    const card = screen.getByRole('group', { name: 'Confirmar acción' });
    expect(card).toHaveTextContent('¿Ejecutar esta acción?');
    expect(card).toHaveTextContent('Escritura');
    // What the tool does comes from the release; the call is the one the API stored.
    expect(card).toHaveTextContent('Crear un presupuesto mensual de costo en AWS Budgets');
    expect(card).toHaveTextContent(`aws-budgets.create_budget · name=${XSS}, amount_usd=100`);
    expect(card).toHaveTextContent(
      'Política: Hasta USD 500,00 · confirma quien la pide. Tu confirmación queda registrada en Auditoría.',
    );
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('confirms and reports the result', async () => {
    const user = userEvent.setup();
    const item = selfApproval();
    const done = selfApproval({
      status: 'executed',
      decided_by: baseMe.user_id,
      decided_by_email: 'yo@example.com',
    });
    const { call, onUpdated, notify } = renderCard(item, { confirmApproval: done });
    await user.click(screen.getByRole('button', { name: 'Ejecutar' }));
    expect(call).toHaveBeenCalledWith('confirmApproval', {
      path: { approval_id: item.approval_id },
      body: {},
    });
    expect(onUpdated).toHaveBeenCalledWith(done);
    expect(notify).toHaveBeenCalledWith('APR-F0E1D2C3 ejecutada', 'success');
  });

  it('cancels without running anything', async () => {
    const user = userEvent.setup();
    const item = selfApproval();
    const cancelled = selfApproval({ status: 'cancelled' });
    const { call, notify } = renderCard(item, { cancelApproval: cancelled });
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(call.mock.calls.map(([operation]) => operation)).toEqual(['cancelApproval']);
    expect(notify).toHaveBeenCalledWith('APR-F0E1D2C3 cancelada', 'info');
  });

  it.each([
    [
      selfApproval({ status: 'executed', decided_by_email: 'yo@example.com' }),
      'Confirmada',
      'La acción se ejecutó.',
    ],
    [selfApproval({ status: 'cancelled' }), 'Cancelada', 'Política:'],
    [
      selfApproval({ status: 'failed', error: 'already_exists' }),
      'Confirmada',
      'no se completó (already_exists)',
    ],
    [selfApproval({ status: 'expired' }), 'Vencida', 'Política:'],
  ])('shows how it ended and offers nothing else', (item, badge, text) => {
    renderCard(item);
    const card = screen.getByRole('group', { name: 'Confirmar acción' });
    expect(card).toHaveTextContent(badge);
    expect(card).toHaveTextContent(text);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lets a call that did not start be run again', async () => {
    const user = userEvent.setup();
    const stuck = selfApproval({ status: 'approved', error: 'gateway_refused' });
    const { call } = renderCard(stuck, { executeApproval: selfApproval({ status: 'executed' }) });
    expect(screen.getByRole('status')).toHaveTextContent('La acción no llegó a iniciarse');
    await user.click(screen.getByRole('button', { name: 'Ejecutar' }));
    expect(call.mock.calls.map(([operation]) => operation)).toEqual(['executeApproval']);
  });

  it('shows its own message when the API refuses, never the server text', async () => {
    const user = userEvent.setup();
    renderCard(selfApproval(), {
      confirmApproval: new ApiError(409, 'tool_unavailable', '<b>server</b>'),
      getApproval: selfApproval(),
    });
    await user.click(screen.getByRole('button', { name: 'Ejecutar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El agente ya no tiene esta herramienta: no se puede ejecutar.',
    );
    expect(screen.queryByText(/server/)).toBeNull();
  });
});

describe('ChatApprovalCard · requiere aprobación', () => {
  const own = (overrides: Partial<ChatApproval> = {}) =>
    approval({ mine: true, can_sign: false, conversation_id: 'c'.repeat(32), ...overrides });

  it('shows the request and that other people decide', () => {
    renderCard(own());
    const card = screen.getByRole('group', { name: 'Aprobación APR-A1B2C3D4' });
    expect(card).toHaveTextContent('Requiere aprobación');
    expect(card).toHaveTextContent(
      'aws-budgets.create_budget · name=team-a, amount_usd=1200 · Más de USD 500,00 · 2 aprobadores distintos de quien la pide',
    );
    expect(card).toHaveTextContent(
      'Tú la pediste: la aprueba otra persona. Cuando esté aprobada, la ejecutas tú.',
    );
    // Nothing is signed from the chat: the card belongs to who asked.
    expect(screen.queryByRole('button', { name: /Firmar|Aprobar/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancelar solicitud' })).toBeEnabled();
  });

  it('lets who asked run it once it is approved', async () => {
    const user = userEvent.setup();
    const approved = own({ status: 'approved' });
    const { call, notify } = renderCard(approved, { executeApproval: own({ status: 'executed' }) });
    const card = screen.getByRole('group', { name: 'Aprobación APR-A1B2C3D4' });
    // The head of the card follows the state of the request (design `ApprovalCard`).
    expect(card).toHaveTextContent('Aprobada · sin ejecutar');
    expect(card).not.toHaveTextContent('Requiere aprobación');
    expect(card).toHaveClass('is-run');
    expect(card).toHaveTextContent(/Ejecútala antes de que venza · vence en \d+ h/);
    await user.click(screen.getByRole('button', { name: 'Ejecutar' }));
    expect(call).toHaveBeenCalledWith('executeApproval', {
      path: { approval_id: approved.approval_id },
      body: {},
    });
    expect(notify).toHaveBeenCalledWith('APR-A1B2C3D4 ejecutada', 'success');
  });

  it('reads the request again while other people decide', async () => {
    vi.useFakeTimers({ now: NOW });
    const approved = own({ status: 'approved' });
    const { call, onUpdated } = renderCard(own(), { getApproval: approved });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(call).toHaveBeenCalledWith(
      'getApproval',
      { path: { approval_id: approved.approval_id } },
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    );
    expect(onUpdated).toHaveBeenCalledWith(approved);
  });

  it('does not poll a request that is closed', async () => {
    vi.useFakeTimers({ now: NOW });
    const { call } = renderCard(own({ status: 'rejected', note: 'no' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('group')).toHaveTextContent('Rechazada');
  });
});
