import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Alert } from './Alert';
import { Badge } from './Badge';
import { WarnIcon } from './icons';
import { SidePanel } from './SidePanel';

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Ver detalle
      </button>
      {open ? (
        <SidePanel
          title="Anomalías <b>Retail</b>"
          lead={<span data-testid="lead" />}
          meta={<Badge tone="green">En línea</Badge>}
          width={520}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        >
          <p>Explica las anomalías de gasto.</p>
          <button type="button">Abrir chat</button>
        </SidePanel>
      ) : null}
    </>
  );
}

async function open(onClose = vi.fn()) {
  render(<Harness onClose={onClose} />);
  await userEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
  return { onClose, dialog: screen.getByRole('dialog') };
}

describe('SidePanel', () => {
  it('is a modal dialog named by its title, with the design structure', async () => {
    const { dialog } = await open();
    // The title is text: markup in an agent name is not interpreted.
    expect(dialog).toHaveAccessibleName('Anomalías <b>Retail</b>');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('mk-drawer');
    expect(dialog).toHaveStyle({ width: '520px' });
    expect(dialog.parentElement).toHaveClass('mk-scrim');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    const head = dialog.querySelector('.mk-drawer-h');
    expect(head).toContainElement(screen.getByTestId('lead'));
    expect(within(dialog).getByText('En línea')).toHaveClass('badge', 'badge-green');
    expect(dialog.querySelector('.mk-drawer-b')).toHaveTextContent('Explica las anomalías');
  });

  it('moves focus inside and returns it to the opener when closed', async () => {
    const { onClose, dialog } = await open();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ver detalle' })).toHaveFocus();
  });

  it('closes with Escape and with the backdrop, not with a click inside', async () => {
    const { onClose, dialog } = await open();
    await userEvent.click(within(dialog).getByText('Explica las anomalías de gasto.'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;
    await userEvent.pointer({ keys: '[MouseLeft>]', target: scrim });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Badge', () => {
  it('maps the tone to the design classes', () => {
    render(
      <>
        <Badge>Lectura</Badge>
        <Badge tone="amber" title="Confirmación o aprobación">
          Escritura
        </Badge>
        <Badge tone="violet">Datos de cuentas</Badge>
      </>,
    );
    expect(screen.getByText('Lectura').className).toBe('badge');
    expect(screen.getByText('Escritura')).toHaveClass('badge', 'badge-amber');
    expect(screen.getByText('Escritura')).toHaveAttribute('title', 'Confirmación o aprobación');
    expect(screen.getByText('Datos de cuentas')).toHaveClass('badge-violet');
  });
});

describe('Alert', () => {
  it('renders the design notice with its tone and icon', () => {
    render(
      <Alert tone="amber" icon={<WarnIcon size={14} />}>
        Hay tools de <b>Datos de cuentas</b>.
      </Alert>,
    );
    const alert = screen.getByText(/Hay tools de/).parentElement as HTMLElement;
    expect(alert).toHaveClass('mc-alert', 'amber');
    expect(alert).not.toHaveClass('mc-alert-block');
    expect(alert.firstElementChild?.tagName).toBe('svg');
    expect(alert).not.toHaveAttribute('role');
  });

  it('takes the whole width without an icon and announces errors only when asked', () => {
    render(
      <>
        <Alert tone="red" role="alert">
          {'<script>alert(1)</script> No se pudo enviar.'}
        </Alert>
        <Alert>Estás editando un borrador.</Alert>
      </>,
    );
    const error = screen.getByRole('alert');
    expect(error).toHaveClass('mc-alert', 'red', 'mc-alert-block');
    expect(error).toHaveTextContent('<script>alert(1)</script> No se pudo enviar.');
    expect(error.querySelector('script')).toBeNull();
    expect(screen.getByText('Estás editando un borrador.').parentElement?.className).toBe(
      'mc-alert mc-alert-block',
    );
  });
});
