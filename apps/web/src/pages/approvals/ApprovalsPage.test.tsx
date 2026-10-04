import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { ApprovalsPage } from './ApprovalsPage';
import type { Approval, ApprovalList, Policies } from './model';
import { NOW, XSS, approval, policies, policyChange, toolPolicy } from './testFixtures';

type Answer = unknown;
type Handler = (input: {
  path?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}) => Answer;

/** An API that answers each operation from `handlers`; anything else fails the test. */
function apiWith(handlers: Record<string, Handler>) {
  return vi.fn((operation: string, input: Parameters<Handler>[0] = {}) => {
    const handler = handlers[operation];
    if (!handler) return Promise.reject(new Error(`unexpected ${operation}`));
    const answer = handler(input);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

function lists(pending: Approval[], resolved: Approval[] = [], canDecide = true): Handler {
  return ({ query }) =>
    ({
      items: query?.view === 'resolved' ? resolved : pending,
      can_decide: canDecide,
    }) satisfies ApprovalList;
}

function renderPage(call: ReturnType<typeof vi.fn>, path = '/approvals', isAdmin = false) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders
      session={sessionValue({ api, me: { ...baseMe, is_admin: isAdmin } })}
      path={path}
    >
      <Routes>
        <Route path="approvals/*" element={<ApprovalsPage />} />
        <Route path="c/:id" element={<p>chat</p>} />
      </Routes>
    </TestProviders>,
  );
}

function writes(call: ReturnType<typeof vi.fn>) {
  return call.mock.calls.filter(
    ([operation]) => !String(operation).startsWith('list') && !String(operation).startsWith('get'),
  );
}

/** Rows of the queue (the filters' <option>s share the role). */
const queue = () => within(screen.getByRole('listbox', { name: 'Solicitudes' }));
const findQueue = async () => within(await screen.findByRole('listbox', { name: 'Solicitudes' }));

let wide = true;

beforeEach(() => {
  wide = true;
  // Only the clock: "vence en…" is read against the fixtures' time.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width') ? !wide : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ApprovalsPage', () => {
  it('lists what waits, with the first request open and what the API stored as text', async () => {
    const item = approval({ arguments: { name: XSS, amount_usd: 1200 }, requested_by_email: XSS });
    renderPage(apiWith({ listApprovals: lists([item]) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Aprobaciones' })).toBeVisible();
    const row = (await findQueue()).getByRole('option', { selected: true });
    expect(within(row).getByText('APR-A1B2C3D4')).toBeVisible();
    expect(row).toHaveTextContent(`FinOps · pidió ${XSS} · hace 30 min`);
    expect(within(row).getByText('0/2 firmas')).toBeVisible();
    expect(within(row).getByText('vence en 4 h')).toBeVisible();
    expect(within(row).getByRole('img', { name: 'Espera tu firma' })).toBeVisible();
    const detail = screen.getByRole('region', { name: 'Detalle de la solicitud' });
    // The title is the tool's description from the release, not anything the model wrote.
    expect(
      within(detail).getByRole('heading', {
        level: 2,
        name: 'Crear un presupuesto mensual de costo en AWS Budgets, sin notificaciones.',
      }),
    ).toBeVisible();
    expect(within(detail).getByText('aws-budgets.create_budget')).toBeVisible();
    expect(within(detail).getByText('1200')).toBeVisible();
    expect(
      within(detail).getByText('Más de USD 500,00 · 2 aprobadores distintos de quien la pide'),
    ).toBeVisible();
    expect(within(detail).getByText('0 de 2 · deben ser personas distintas')).toBeVisible();
    // Untrusted values are text: no element is created from them.
    expect(within(detail).getAllByText(XSS).length).toBeGreaterThan(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(
      within(detail).getByText('vence en 4 h · si nadie la aprueba antes, se cierra'),
    ).toBeVisible();
    // No risk level exists in the API: the design shows no risk filter, badge or view.
    expect(screen.queryByRole('combobox', { name: 'Riesgo' })).toBeNull();
    expect(screen.getByRole('button', { name: /Listas para ejecutar/ })).toHaveTextContent('0');
  });

  it('signs with an optional note and tells whether more signatures are missing', async () => {
    const user = userEvent.setup();
    const item = approval();
    const signed = approval({
      can_sign: false,
      signatures: [
        { user_id: baseMe.user_id, email: baseMe.email ?? null, at: item.created_at, note: 'ok' },
      ],
    });
    const call = apiWith({ listApprovals: lists([item]), approveApproval: () => signed });
    renderPage(call);
    await user.click(await screen.findByRole('button', { name: 'Firmar' }));
    await user.type(screen.getByLabelText(/^Nota/), 'ok');
    await user.click(screen.getByRole('button', { name: 'Confirmar firma' }));
    expect(writes(call)).toEqual([
      ['approveApproval', { path: { approval_id: item.approval_id }, body: { note: 'ok' } }],
    ]);
    expect(await screen.findByText('Firma registrada · falta otra aprobación')).toBeVisible();
    expect(await screen.findByText('Ya firmaste. Falta 1 firma de otra persona.')).toBeVisible();
    expect(screen.getByText('1 de 2 · deben ser personas distintas')).toBeVisible();
  });

  it('needs a reason to reject, and offers the usual ones', async () => {
    const user = userEvent.setup();
    const item = approval({ approvals_needed: 1 });
    const rejected = approval({
      status: 'rejected',
      can_sign: false,
      note: 'Necesita más contexto',
      decided_by: 'x',
      decided_by_email: 'yo@example.com',
      decided_at: item.created_at,
    });
    const call = apiWith({ listApprovals: lists([item]), rejectApproval: () => rejected });
    renderPage(call);
    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe o elige un motivo');
    expect(writes(call)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Necesita más contexto' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect(writes(call)).toEqual([
      [
        'rejectApproval',
        { path: { approval_id: item.approval_id }, body: { reason: 'Necesita más contexto' } },
      ],
    ]);
    expect(await screen.findByText('APR-A1B2C3D4 rechazada')).toBeVisible();
  });

  it('never lets who asked sign, only cancel', async () => {
    const user = userEvent.setup();
    const own = approval({ mine: true, can_sign: false, conversation_id: 'c'.repeat(32) });
    const call = apiWith({
      listApprovals: lists([own]),
      cancelApproval: () => approval({ ...own, status: 'cancelled' }),
    });
    renderPage(call);
    expect(
      await screen.findByText(
        'Tú la pediste: la aprueba otra persona. Cuando esté aprobada, la ejecutas tú.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Firmar|Aprobar/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Ver conversación de origen' })).toHaveAttribute(
      'href',
      `/c/${'c'.repeat(32)}`,
    );
    await user.click(screen.getByRole('button', { name: 'Cancelar solicitud' }));
    expect(writes(call)).toEqual([
      ['cancelApproval', { path: { approval_id: own.approval_id }, body: {} }],
    ]);
    expect(await screen.findByText('APR-A1B2C3D4 cancelada')).toBeVisible();
  });

  it('shows an account that cannot decide only its own requests, with the note of the design', async () => {
    const own = approval({ mine: true, can_sign: false });
    renderPage(apiWith({ listApprovals: lists([own], [], false) }));
    expect(
      await screen.findByText('Ves tus solicitudes y su estado. Las aprueba FinOps central.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Firmar|Aprobar/ })).toBeNull();
    expect(
      screen.getByText(
        'Tú la pediste: la aprueba otra persona. Cuando esté aprobada, la ejecutas tú.',
      ),
    ).toBeVisible();
  });

  it('lets who asked run an approved request from the pending list, and shows how it ended', async () => {
    const user = userEvent.setup();
    const signatures = [
      { user_id: 'u1', email: 'firma@example.com', at: approval().created_at, note: null },
      { user_id: 'u2', email: 'aprueba@example.com', at: approval().created_at, note: null },
    ];
    const approved = approval({
      status: 'approved',
      mine: true,
      can_sign: false,
      signatures,
      decided_at: approval().created_at,
      decided_by: 'u2',
      decided_by_email: 'aprueba@example.com',
    });
    const call = apiWith({
      listApprovals: lists([approved]),
      executeApproval: () =>
        approval({ ...approved, status: 'executed', executed_at: approval().created_at }),
    });
    renderPage(call);
    const row = (await findQueue()).getByRole('option', { selected: true });
    expect(within(row).getByText('Aprobada · sin ejecutar')).toBeVisible();
    expect(within(row).getByRole('img', { name: 'Lista para que la ejecutes' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Listas para ejecutar/ })).toHaveTextContent('1');
    const detail = screen.getByRole('region', { name: 'Detalle de la solicitud' });
    expect(
      within(detail).getByText('vence en 4 h · si no se ejecuta antes, se cierra'),
    ).toBeVisible();
    // The signature that completes the approval reads «aprobó»; the one before, «firmó».
    expect(detail).toHaveTextContent('firma@example.com firmó la aprobación');
    expect(detail).toHaveTextContent('aprueba@example.com aprobó · falta que la ejecutes');
    expect(within(detail).getByText('Ejecútala antes de que venza · vence en 4 h')).toBeVisible();

    await user.click(within(detail).getByRole('button', { name: 'Ejecutar' }));
    expect(writes(call)).toEqual([
      ['executeApproval', { path: { approval_id: approved.approval_id }, body: {} }],
    ]);
    expect(await screen.findByText('APR-A1B2C3D4 ejecutada')).toBeVisible();
    expect(await within(detail).findByText(/la ejecutó/)).toBeVisible();
    expect(within(detail).queryByRole('button', { name: 'Ejecutar' })).toBeNull();
  });

  it('tells an approver who has to run an approved request, and how a closed one ended', async () => {
    const user = userEvent.setup();
    const approved = approval({
      status: 'approved',
      can_sign: false,
      signatures: [
        { user_id: 'u1', email: 'firma@example.com', at: approval().created_at, note: null },
        { user_id: 'u2', email: 'aprueba@example.com', at: approval().created_at, note: null },
      ],
    });
    const failed = approval({
      approval_id: 'b'.repeat(32),
      status: 'failed',
      can_sign: false,
      error: 'already_exists',
      executed_at: approval().created_at,
    });
    const expired = approval({ approval_id: 'c'.repeat(32), status: 'expired', can_sign: false });
    const call = apiWith({ listApprovals: lists([approved], [failed, expired]) });
    renderPage(call);
    expect(
      await screen.findByText('Aprobada. Falta que pide@example.com la ejecute · vence en 4 h.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Ejecutar' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Resueltas' }));
    const detail = await screen.findByRole('region', { name: 'Detalle de la solicitud' });
    expect(within(detail).getByRole('alert')).toHaveTextContent('already_exists');
    expect(
      within(detail).getByText(
        'La acción se inició y falló. Si hace falta, pide la acción otra vez en el chat.',
      ),
    ).toBeVisible();
    await user.click(queue().getAllByRole('option')[1] as HTMLElement);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Detalle de la solicitud' })).toHaveTextContent(
        'Nadie la aprobó antes del vencimiento. El agente puede volver a pedirla.',
      );
    });
    expect(screen.getByRole('region', { name: 'Detalle de la solicitud' })).toHaveTextContent(
      'Sistema la cerró: venció sin respuesta',
    );
  });

  it('shows its own message for a refusal and reads the request again when it is stale', async () => {
    const user = userEvent.setup();
    const item = approval({ approvals_needed: 1 });
    const gone = approval({ ...item, status: 'rejected', can_sign: false });
    const call = apiWith({
      listApprovals: lists([item]),
      approveApproval: () => new ApiError(409, 'version_conflict', '<script>server text</script>'),
      getApproval: () => gone,
    });
    renderPage(call);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar aprobación' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La solicitud cambió: otra persona la decidió. Se recargó.',
    );
    expect(screen.queryByText(/server text/)).toBeNull();
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('getApproval', { path: { approval_id: item.approval_id } });
    });
  });

  it('filters the list and says so when nothing matches', async () => {
    const user = userEvent.setup();
    const other = approval({
      approval_id: 'b'.repeat(32),
      agent_id: 'sales',
      agent_name: 'Ventas',
      can_sign: false,
    });
    renderPage(apiWith({ listApprovals: lists([approval(), other]) }));
    expect((await findQueue()).getAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /Esperan tu firma/ }));
    expect(queue().getAllByRole('option')).toHaveLength(1);
    await user.type(screen.getByRole('textbox', { name: 'Buscar aprobaciones' }), 'zzz');
    expect(screen.getByText('Nada coincide con los filtros')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(queue().getAllByRole('option')).toHaveLength(2);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agente' }), 'sales');
    expect(queue().getAllByRole('option', { name: /Ventas/ })).toHaveLength(1);
  });

  it('moves between requests with the keyboard', async () => {
    const user = userEvent.setup();
    const second = approval({
      approval_id: 'b'.repeat(32),
      expires_at: new Date(Date.parse(approval().expires_at) + 60_000).toISOString(),
    });
    renderPage(apiWith({ listApprovals: lists([approval(), second]) }));
    const [first] = (await findQueue()).getAllByRole('option');
    first?.focus();
    await user.keyboard('j');
    expect(queue().getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(queue().getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('on a narrow screen opens the detail over the list and goes back', async () => {
    wide = false;
    const user = userEvent.setup();
    renderPage(apiWith({ listApprovals: lists([approval()]) }));
    const row = (await findQueue()).getByRole('option');
    expect(screen.queryByRole('region', { name: 'Detalle de la solicitud' })).toBeNull();
    await user.click(row);
    expect(await screen.findByRole('region', { name: 'Detalle de la solicitud' })).toBeVisible();
    expect(screen.queryByRole('listbox', { name: 'Solicitudes' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Volver a la lista' }));
    expect((await findQueue()).getByRole('option')).toBeVisible();
  });

  it('shows the empty and the error states, and retries', async () => {
    const user = userEvent.setup();
    let fail = true;
    const call = apiWith({
      listApprovals: (input) => {
        if (fail) return new ApiError(503, 'approvals_unavailable', 'x');
        return lists([])(input);
      },
    });
    renderPage(call);
    expect(await screen.findByText('No se pudieron cargar las aprobaciones')).toBeVisible();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Nada pendiente')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Resueltas' }));
    expect(await screen.findByText('Aún no hay decisiones')).toBeVisible();
  });
});

describe('Políticas', () => {
  function policiesApi(initial: Policies, more: Record<string, Handler> = {}) {
    let current = initial;
    return apiWith({
      getToolPolicies: () => current,
      ...Object.fromEntries(
        Object.entries(more).map(([name, handler]) => [
          name,
          (input: Parameters<Handler>[0]) => {
            const answer = handler(input);
            if (answer && typeof answer === 'object' && 'tools' in answer)
              current = answer as Policies;
            return answer;
          },
        ]),
      ),
    });
  }

  it('explains the rule and lists each write tool with its policy', async () => {
    renderPage(policiesApi(policies()), '/approvals/policies');
    expect(
      await screen.findByText(/Ninguna tool de escritura se ejecuta sin confirmación/),
    ).toBeVisible();
    expect(screen.getByText('aws-budgets.create_budget')).toBeVisible();
    expect(screen.getByText('Siempre: aprobación')).toBeVisible();
    expect(screen.getByText('24 h · luego vence')).toBeVisible();
    // Only administrators propose changes (the API enforces it).
    expect(screen.queryByRole('button', { name: /Editar política/ })).toBeNull();
  });

  it('lets an administrator propose a change, offering only what the tool reports', async () => {
    const user = userEvent.setup();
    const pending = policies({
      tools: [toolPolicy({ pending_change_id: '9'.repeat(32) })],
      changes: [policyChange({ proposed_by: baseMe.user_id })],
    });
    const call = apiWith({
      getToolPolicies: vi.fn().mockReturnValueOnce(policies()).mockReturnValue(pending),
      proposeToolPolicy: () => ({ change_id: '9'.repeat(32) }),
    });
    renderPage(call, '/approvals/policies', true);
    await user.click(
      await screen.findByRole('button', { name: 'Editar política de aws-budgets.create_budget' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Política de aprobación' });
    expect(
      within(dialog).getByRole('button', { name: 'Según cantidad de recursos' }),
    ).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Según entorno' })).toBeDisabled();
    expect(
      within(dialog).getByText(
        'Las opciones deshabilitadas dependen de datos que esta tool no informa.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Enviar propuesta' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Según monto' }));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar propuesta' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Escribe un monto mayor que 0');
    await user.type(within(dialog).getByLabelText('Monto'), '500');
    await user.click(within(dialog).getByRole('button', { name: '2' }));
    await user.click(within(dialog).getByRole('button', { name: '4 h' }));
    await user.type(within(dialog).getByLabelText('Motivo'), 'Presupuestos chicos');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar propuesta' }));
    expect(writes(call)).toEqual([
      [
        'proposeToolPolicy',
        {
          path: { tool: 'aws-budgets.create_budget' },
          body: {
            condition: 'amount',
            amount_usd: '500',
            approvers: 2,
            expires_hours: 4,
            base_version: 0,
            reason: 'Presupuestos chicos',
          },
        },
      ],
    ]);
    expect(await screen.findByText('Propuesta enviada · la debe aprobar otro admin')).toBeVisible();
    expect(await screen.findByText('Cambio pendiente')).toBeVisible();
    // Whoever proposes cannot approve: only withdraw.
    expect(screen.getByText('La debe aprobar otro admin.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Editar política de aws-budgets.create_budget' }),
    ).toBeDisabled();
  });

  it('lets another administrator approve or reject a proposal', async () => {
    const user = userEvent.setup();
    const before = policies({
      tools: [toolPolicy({ pending_change_id: '9'.repeat(32) })],
      changes: [policyChange({ reason: XSS })],
    });
    const after = policies({
      tools: [toolPolicy({ version: 1, policy: policyChange().after })],
      changes: [
        policyChange({
          status: 'approved',
          decided_by: baseMe.user_id,
          decided_by_email: baseMe.email ?? null,
        }),
      ],
    });
    const call = policiesApi(before, { approveToolPolicy: () => after });
    renderPage(call, '/approvals/policies', true);
    expect(await screen.findByText('Propuesto por otro.admin@example.com')).toBeVisible();
    expect(
      screen.getByText(
        'Siempre: 1 aprobador · vence en 24 h → Hasta USD 500,00: confirma el usuario · Más de USD 500,00: 2 aprobadores · vence en 24 h',
      ),
    ).toBeVisible();
    expect(screen.getByText(XSS)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Aprobar' }));
    expect(writes(call)).toEqual([
      ['approveToolPolicy', { path: { change_id: '9'.repeat(32) }, body: {} }],
    ]);
    expect(await screen.findByText('Política actualizada')).toBeVisible();
    expect(await screen.findByText('Hasta USD 500,00: confirma el usuario')).toBeVisible();
  });

  it('shows why a decision was not applied', async () => {
    const user = userEvent.setup();
    const before = policies({ changes: [policyChange()] });
    const call = policiesApi(before, {
      rejectToolPolicy: () => new ApiError(403, 'same_approver', 'x'),
    });
    renderPage(call, '/approvals/policies', true);
    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    await user.type(screen.getByRole('textbox', { name: 'Motivo del rechazo:' }), 'no');
    const [, confirm] = screen.getAllByRole('button', { name: 'Rechazar' });
    if (!confirm) throw new Error('no confirm button');
    await user.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Otro admin debe decidir sobre tu propuesta.',
    );
  });
});
