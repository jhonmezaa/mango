import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Me } from '../api/schemas';
import { authValue, baseMe, sessionValue } from '../test/fixtures';
import { TestProviders } from '../test/TestProviders';
import { UserMenu } from './UserMenu';

const accountName = /Cuenta de ana\.perez@example\.com/;

function CurrentPath() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

function renderMenu(auth = authValue(), isAdmin = true) {
  const onNavigate = vi.fn();
  render(
    <TestProviders auth={auth} session={sessionValue({ me: { ...baseMe, is_admin: isAdmin } })}>
      <UserMenu collapsed={false} onNavigate={onNavigate} />
      <button type="button">outside</button>
      <CurrentPath />
    </TestProviders>,
  );
  return { auth, onNavigate };
}

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('UserMenu', () => {
  it('shows the identity and role from the session', () => {
    renderMenu();
    const button = screen.getByRole('button', { name: accountName });
    expect(button).toHaveTextContent('ana.perez@example.com');
    expect(button).toHaveTextContent('Admin');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    // The aria-label replaces the visible text, so the role is exposed as the description.
    expect(button).toHaveAccessibleDescription('Admin');
  });

  it('shows the role label and the language row in the menu (v9)', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: accountName }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Admin')).toHaveClass('sb-menu-role');
    expect(screen.getByRole('menuitem', { name: 'Idioma, próximamente' })).toHaveTextContent(
      'Idioma · Español',
    );
  });

  it('shows the email between the name and the role (design shell.jsx)', async () => {
    const user = userEvent.setup();
    render(
      <TestProviders session={sessionValue({ me: { ...baseMe, name: 'Usuario 1' } })}>
        <UserMenu collapsed={false} />
      </TestProviders>,
    );
    await user.click(screen.getByRole('button', { name: /Cuenta de Usuario 1/ }));
    const head = screen.getByRole('menu').querySelector('.sb-menu-head') as HTMLElement;
    expect([...head.children].map((line) => line.textContent)).toEqual([
      'Usuario 1',
      'ana.perez@example.com',
      'Usuario',
      'Grupos:finops-central',
    ]);
  });

  it('does not repeat the email when it already is the display name', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: accountName }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByText('ana.perez@example.com')).toHaveLength(1);
    expect(menu.querySelector('.sb-menu-email')).toBeNull();
  });

  it('explains password and MFA changes without self-service (v10)', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: accountName }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Contraseña y MFA')).toBeInTheDocument();
    const hint =
      'Para cambiar tu contraseña usa «Olvidé mi contraseña» al iniciar sesión. Para restablecer tu MFA, pídeselo a un admin.';
    expect(menu).toHaveAccessibleDescription(`Grupos: finops-central Contraseña y MFA ${hint}`);
    // Informational only: it is not a menu item.
    expect(within(menu).queryByRole('menuitem', { name: /Contraseña/ })).toBeNull();
  });

  const ACCOUNTS: [string, Partial<Me>][] = [
    ['Admin', { is_admin: true, can: { create_agent: true }, groups: ['mango-admin'] }],
    [
      'Creador de agentes',
      { role: null, can: { create_agent: true }, groups: ['mango-agent-creator', 'people'] },
    ],
    ['Usuario', { role: 'bu-lead', business_unit: 'finanzas', groups: ['bu-lead', 'bu-finanzas'] }],
    ['Usuario', { role: 'finops-central' }],
  ];
  it.each(ACCOUNTS)(
    'labels the account «%s» from what the API reports (design ROLES)',
    (label, me) => {
      render(
        <TestProviders session={sessionValue({ me: { ...baseMe, ...me } })}>
          <UserMenu collapsed={false} />
        </TestProviders>,
      );
      const button = screen.getByRole('button', { name: accountName });
      expect(button).toHaveAccessibleDescription(label);
      expect(button.querySelector('.sb-user-role')).toHaveTextContent(label);
    },
  );

  it('lists the groups of the account under the role, as text', async () => {
    const user = userEvent.setup();
    const groups = ['mango-agent-creator', 'people'];
    render(
      <TestProviders
        session={sessionValue({
          me: { ...baseMe, role: null, groups, can: { create_agent: true } },
        })}
      >
        <UserMenu collapsed={false} />
      </TestProviders>,
    );
    await user.click(screen.getByRole('button', { name: accountName }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Creador de agentes')).toBeInTheDocument();
    const badges = [...menu.querySelectorAll('.sb-menu-groups .badge')];
    expect(badges.map((badge) => badge.textContent)).toEqual(groups);
    for (const badge of badges) expect(badge).toHaveClass('mono');
  });

  it('shows no group list for an account without groups', async () => {
    const user = userEvent.setup();
    render(
      <TestProviders session={sessionValue({ me: { ...baseMe, role: null, groups: [] } })}>
        <UserMenu collapsed={false} />
      </TestProviders>,
    );
    await user.click(screen.getByRole('button', { name: accountName }));
    expect(screen.getByRole('menu').querySelector('.sb-menu-groups')).toBeNull();
  });

  it('falls back to the user id when the token has no email', () => {
    render(
      <TestProviders session={sessionValue({ me: { ...baseMe, email: null } })}>
        <UserMenu collapsed={false} />
      </TestProviders>,
    );
    expect(screen.getByRole('button', { name: new RegExp(baseMe.user_id) })).toHaveTextContent(
      baseMe.user_id,
    );
  });

  it('prefers the display name chosen at sign-up (D20)', () => {
    render(
      <TestProviders session={sessionValue({ me: { ...baseMe, name: 'Usuario 1' } })}>
        <UserMenu collapsed={false} />
      </TestProviders>,
    );
    expect(screen.getByRole('button', { name: /Cuenta de Usuario 1/ })).toHaveTextContent('U1');
  });

  it('announces the role in the collapsed rail too', () => {
    render(
      <TestProviders session={sessionValue({ me: { ...baseMe, is_admin: false } })}>
        <UserMenu collapsed />
      </TestProviders>,
    );
    expect(screen.getByRole('button', { name: accountName })).toHaveAccessibleDescription(
      'Usuario',
    );
  });

  it('opens with the keyboard, moves focus with arrows and closes with Escape', async () => {
    const user = userEvent.setup();
    renderMenu();
    const button = screen.getByRole('button', { name: accountName });
    button.focus();
    await user.keyboard('{Enter}');

    const menu = screen.getByRole('menu');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('aria-label') ?? item.textContent)).toEqual([
      'Idioma, próximamente',
      expect.stringContaining('Cambiar tema'),
      'Primeros pasos, próximamente',
      expect.stringContaining('Ajustes'),
      expect.stringContaining('Cerrar sesión'),
    ]);
    expect(items[0]).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(items[4]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[4]).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(menu).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens with ArrowDown and closes on outside click', async () => {
    const user = userEvent.setup();
    renderMenu();
    screen.getByRole('button', { name: accountName }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('toggles the theme and signs out', async () => {
    const user = userEvent.setup();
    const { auth } = renderMenu();
    await user.click(screen.getByRole('button', { name: accountName }));
    await user.click(screen.getByRole('menuitem', { name: /Cambiar tema/ }));
    expect(document.documentElement.dataset.theme).toBe('dark');

    await user.click(screen.getByRole('button', { name: accountName }));
    await user.click(screen.getByRole('menuitem', { name: /Cerrar sesión/ }));
    expect(auth.logout).toHaveBeenCalledOnce();
  });

  it('shows language and the tour as "Próximamente" and has no role switcher', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: accountName }));
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    expect(screen.queryByText(/Ver como/)).toBeNull();
    for (const name of ['Idioma, próximamente', 'Primeros pasos, próximamente']) {
      const item = screen.getByRole('menuitem', { name });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      await user.click(item);
      expect(screen.getByRole('menu')).toBeInTheDocument();
    }
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });

  it('opens Ajustes from the menu for admins', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderMenu();
    await user.click(screen.getByRole('button', { name: accountName }));
    await user.click(screen.getByRole('menuitem', { name: 'Ajustes' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/settings');
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('has no Ajustes entry for non-admins', async () => {
    const user = userEvent.setup();
    renderMenu(authValue(), false);
    await user.click(screen.getByRole('button', { name: accountName }));
    expect(screen.queryByRole('menuitem', { name: 'Ajustes' })).toBeNull();
  });
});
