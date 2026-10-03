import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { MfaReset } from '../../api/mfaResetSchemas';
import { baseMe } from '../../test/fixtures';
import { MfaResetBlock } from './MfaResetBlock';

const me = { ...baseMe, user_id: 'admin-1', email: 'admin1@empresa.com', is_admin: true };

function reset(overrides: Partial<MfaReset> = {}): MfaReset {
  return {
    change_id: 'a'.repeat(32),
    status: 'pending',
    target_user: 'target-sub',
    target_email: 'usuario3@empresa.com',
    proposed_by: 'admin-2',
    proposed_by_email: 'admin2@empresa.com',
    reason: 'Cambió de teléfono',
    identity_verified: true,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    note: null,
    ...overrides,
  };
}

function setup(items: MfaReset[] = [], api: Partial<ApiClient> = {}, exampleDomain?: string) {
  const fake = {
    listMfaResets: vi.fn(() => Promise.resolve(items)),
    proposeMfaReset: vi.fn(() => Promise.resolve({ change_id: 'b'.repeat(32) })),
    approveMfaReset: vi.fn(() => Promise.resolve([reset({ status: 'approved' })])),
    rejectMfaReset: vi.fn(() => Promise.resolve([])),
    withdrawMfaReset: vi.fn(() => Promise.resolve([])),
    ...api,
  };
  const notify = vi.fn();
  render(
    <MfaResetBlock
      api={fake as unknown as ApiClient}
      me={me}
      notify={notify}
      exampleDomain={exampleDomain}
    />,
  );
  return { fake, notify, user: userEvent.setup() };
}

describe('MfaResetBlock (design settings.jsx)', () => {
  it('refuses the own account before calling the API', async () => {
    const { fake, user } = setup();
    await user.type(screen.getByLabelText('Correo del usuario'), 'ADMIN1@empresa.com');
    expect(
      screen.getByText('Es tu propia cuenta: otro admin debe restablecer tu MFA.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Motivo'), 'x');
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No puedes restablecer tu propio MFA: pídeselo a otro admin',
    );
    expect(fake.proposeMfaReset).not.toHaveBeenCalled();
  });

  it('proposes and maps server errors to the design messages', async () => {
    const { fake, notify, user } = setup([], {
      proposeMfaReset: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(404, 'user_not_found', 'x'))
        .mockResolvedValueOnce({ change_id: 'b'.repeat(32) }),
    });
    await user.type(screen.getByLabelText('Correo del usuario'), 'nadie@empresa.com');
    await user.type(screen.getByLabelText('Motivo'), 'Perdió el teléfono');
    await user.click(screen.getByRole('checkbox', { name: /Verifiqué la identidad/ }));
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ese correo no está en el directorio',
    );
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(fake.proposeMfaReset).toHaveBeenLastCalledWith(
      'nadie@empresa.com',
      'Perdió el teléfono',
      true,
    );
    expect(notify).toHaveBeenCalledWith('Solicitud enviada · la debe aprobar otro admin');
  });

  it('requires a valid email and the out-of-band identity check before calling the API', async () => {
    const { fake, user } = setup();
    expect(screen.getByText(/Si nadie la aprueba en 72 h, vence\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe el correo del usuario');
    await user.type(screen.getByLabelText('Correo del usuario'), 'usuario3');
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe un correo válido');
    await user.type(screen.getByLabelText('Correo del usuario'), '@empresa.com');
    await user.type(screen.getByLabelText('Motivo'), 'Cambió de teléfono');
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Confirma que verificaste la identidad del usuario por otro canal',
    );
    expect(fake.proposeMfaReset).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: /Verifiqué la identidad/ }));
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(fake.proposeMfaReset).toHaveBeenCalledWith(
      'usuario3@empresa.com',
      'Cambió de teléfono',
      true,
    );
  });

  it('clears whatever error is showing when the email is edited', async () => {
    const { user } = setup([], {
      proposeMfaReset: vi.fn(() => Promise.reject(new ApiError(404, 'user_not_found', 'x'))),
    });
    const email = screen.getByLabelText('Correo del usuario');
    // A validation error that is not about the email.
    await user.type(email, 'admin1@empresa.co');
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe el motivo');
    await user.type(email, 'm');
    expect(screen.queryByRole('alert')).toBeNull();
    // Design: without an error showing, the own account gets its hint back.
    expect(
      screen.getByText('Es tu propia cuenta: otro admin debe restablecer tu MFA.'),
    ).toBeInTheDocument();
    // Editing another field keeps the error.
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    await user.type(screen.getByLabelText('Motivo'), 'x');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No puedes restablecer tu propio MFA: pídeselo a otro admin',
    );
    // An error of the request itself.
    await user.clear(email);
    await user.type(email, 'nadie@empresa.com');
    await user.click(screen.getByRole('checkbox', { name: /Verifiqué la identidad/ }));
    await user.click(screen.getByRole('button', { name: 'Proponer restablecimiento' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ese correo no está en el directorio',
    );
    await user.type(email, 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables every button of a request while its action is in flight', async () => {
    let fail: (error: unknown) => void = () => undefined;
    const { user } = setup([reset(), reset({ change_id: 'f'.repeat(32) })], {
      rejectMfaReset: vi.fn(
        () =>
          new Promise<MfaReset[]>((_, reject) => {
            fail = reject;
          }),
      ),
    });
    const [first] = await screen.findAllByRole('article');
    if (!first) throw new Error('no request');
    const inFirst = within(first);
    await user.click(inFirst.getByRole('button', { name: 'Rechazar' }));
    await user.type(inFirst.getByLabelText('Motivo del rechazo'), 'No verificado');
    await user.click(inFirst.getAllByRole('button', { name: 'Rechazar' }).at(-1) as HTMLElement);
    for (const button of inFirst.getAllByRole('button')) expect(button).toBeDisabled();
    expect(inFirst.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    // Only that request: the other one stays usable.
    expect(screen.getAllByRole('button', { name: 'Aprobar' }).at(-1)).toBeEnabled();
    fail(new ApiError(502, 'upstream_error', 'x'));
    await screen.findByRole('alert');
    expect(inFirst.getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  });

  it('keeps a single reject note open in the list', async () => {
    const { user } = setup([reset(), reset({ change_id: 'f'.repeat(32) })]);
    const [first, second] = await screen.findAllByRole('article');
    if (!first || !second) throw new Error('no requests');
    await user.click(within(first).getByRole('button', { name: 'Rechazar' }));
    await user.type(within(first).getByLabelText('Motivo del rechazo'), 'No verificado');
    await user.click(within(second).getByRole('button', { name: 'Rechazar' }));
    expect(within(first).queryByLabelText('Motivo del rechazo')).toBeNull();
    expect(within(second).getByLabelText('Motivo del rechazo')).toHaveValue('');
    expect(within(second).getByLabelText('Motivo del rechazo')).toHaveFocus();
    // Reopening the first one starts from an empty note.
    await user.click(within(first).getByRole('button', { name: 'Rechazar' }));
    expect(within(first).getByLabelText('Motivo del rechazo')).toHaveValue('');
    await user.click(within(first).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByLabelText('Motivo del rechazo')).toBeNull();
  });

  it('shows the design error under the list title when the requests cannot load', async () => {
    setup([], { listMfaResets: vi.fn(() => Promise.reject(new ApiError(500, 'x', 'x'))) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se pudo completar la acción. Inténtalo de nuevo.');
    const section = alert.closest('section') as HTMLElement;
    expect(section).toHaveClass('mfa-reset-list');
    expect(section).toHaveTextContent('Restablecimientos de MFA');
    // The form stays usable: only the list failed.
    expect(screen.getByRole('button', { name: 'Proponer restablecimiento' })).toBeEnabled();
  });

  it('keeps withdrawn and expired requests in the list with their design texts', async () => {
    setup([
      reset({ status: 'withdrawn' }),
      reset({ change_id: 'e'.repeat(32), status: 'expired', target_email: 'otro@empresa.com' }),
    ]);
    expect(await screen.findByText('Retirado')).toBeInTheDocument();
    expect(screen.getByText('La retiró admin2@empresa.com')).toBeInTheDocument();
    expect(screen.getByText('Vencido')).toBeInTheDocument();
    expect(screen.getByText('Nadie la aprobó en 72 h')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
    expect(
      screen.getAllByText(
        'Borra su MFA y cierra todas sus sesiones · identidad verificada por otro canal',
      ),
    ).toHaveLength(2);
  });

  it('lets another admin approve, never the proposer or the target', async () => {
    const { fake, user } = setup([
      reset(),
      reset({ change_id: 'c'.repeat(32), proposed_by: 'admin-1', proposed_by_email: null }),
      reset({
        change_id: 'd'.repeat(32),
        target_user: 'admin-1',
        target_email: 'admin1@empresa.com',
      }),
    ]);
    expect(await screen.findByText('Otro admin debe aprobarla')).toBeInTheDocument();
    expect(screen.getByText('Es sobre tu cuenta: la debe aprobar otro admin')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Aprobar' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Aprobar' }));
    expect(fake.approveMfaReset).toHaveBeenCalledWith('a'.repeat(32));
    expect(await screen.findByText('Aprobado')).toBeInTheDocument();
  });

  it('says the request is no longer pending when another admin decided it first', async () => {
    const { user } = setup([reset()], {
      approveMfaReset: vi.fn(() => Promise.reject(new ApiError(409, 'version_conflict', 'x'))),
      withdrawMfaReset: vi.fn(() => Promise.reject(new ApiError(410, 'expired', 'x'))),
      rejectMfaReset: vi.fn(() => Promise.reject(new ApiError(502, 'upstream_error', 'x'))),
    });
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'La solicitud ya no está pendiente: otro admin la decidió o venció.',
    );
    // Design: between the form and the list.
    expect(alert).toHaveClass('g-err', 'mfa-reset-action-error');
    expect(alert.previousElementSibling).toHaveClass('mfa-reset-card');
    expect(alert.nextElementSibling).toHaveClass('mfa-reset-list');

    // Any other failure keeps the generic text.
    await user.click(screen.getByRole('button', { name: 'Rechazar' }));
    await user.type(screen.getByLabelText('Motivo del rechazo'), 'No verificado');
    await user.click(screen.getAllByRole('button', { name: 'Rechazar' }).at(-1) as HTMLElement);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudo completar la acción. Inténtalo de nuevo.',
    );
    // Design `ChangeList`: the failed reject keeps its note open, with the text, to try again.
    expect(screen.getByLabelText('Motivo del rechazo')).toHaveValue('No verificado');
  });

  it('closes the reject note once the request is rejected', async () => {
    const { user } = setup([reset()], {
      rejectMfaReset: vi.fn(() =>
        Promise.resolve([reset({ status: 'rejected', note: 'No verificado' })]),
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    await user.type(screen.getByLabelText('Motivo del rechazo'), 'No verificado');
    await user.click(screen.getAllByRole('button', { name: 'Rechazar' }).at(-1) as HTMLElement);
    expect(await screen.findByText('Rechazado')).toBeInTheDocument();
    expect(screen.queryByLabelText('Motivo del rechazo')).toBeNull();
  });

  it('maps an expired request to the same text when withdrawing it', async () => {
    const { user } = setup([reset({ proposed_by: 'admin-1' })], {
      withdrawMfaReset: vi.fn(() => Promise.reject(new ApiError(410, 'expired', 'x'))),
    });
    await user.click(await screen.findByRole('button', { name: 'Retirar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La solicitud ya no está pendiente: otro admin la decidió o venció.',
    );
  });

  it('shows the design example in the email placeholder when the company domain is known', () => {
    setup([], {}, 'empresa.com');
    expect(screen.getByLabelText('Correo del usuario')).toHaveAttribute(
      'placeholder',
      'Correo del usuario · usuario3@empresa.com',
    );
  });

  it('keeps a plain email placeholder without a company domain', () => {
    setup();
    expect(screen.getByLabelText('Correo del usuario')).toHaveAttribute(
      'placeholder',
      'Correo del usuario',
    );
  });

  it('requires a note to reject', async () => {
    const { fake, user } = setup([reset()]);
    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    const confirm = screen.getAllByRole('button', { name: 'Rechazar' }).at(-1);
    expect(confirm).toBeDisabled();
    // Design `ChangeList`: the note takes the focus when it opens.
    expect(screen.getByLabelText('Motivo del rechazo')).toHaveFocus();
    await user.type(screen.getByLabelText('Motivo del rechazo'), 'No verificado');
    if (!confirm) throw new Error('no confirm');
    await user.click(confirm);
    expect(fake.rejectMfaReset).toHaveBeenCalledWith('a'.repeat(32), 'No verificado');
  });
});
