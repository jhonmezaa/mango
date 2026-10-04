import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '../config/runtimeConfig';
import { authValue, baseMe } from '../test/fixtures';
import { AuthContext } from './AuthContext';
import { SessionProvider } from './SessionProvider';

const config = { apiBasePath: '/api' } as RuntimeConfig;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const noGroup = () => json(403, { error: { code: 'no_group', message: 'no group assigned yet' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionProvider: account without a group (D20)', () => {
  it('shows "no access yet", rechecks with fresh tokens and signs out', async () => {
    // GET /api/me: no group twice (first load and first recheck), then the profile. The
    // conversation and agent lists load next to it.
    let profileCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (!url.endsWith('/me')) return Promise.resolve(json(200, { items: [] }));
      profileCalls += 1;
      return Promise.resolve(profileCalls <= 2 ? noGroup() : json(200, baseMe));
    });
    vi.stubGlobal('fetch', fetchMock);
    const auth = authValue({ displayEmail: 'nuevo@empresa.com' });
    const user = userEvent.setup();
    render(
      <AuthContext value={auth}>
        <SessionProvider config={config}>
          <p>app</p>
        </SessionProvider>
      </AuthContext>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Todavía no tienes acceso' }),
    ).toBeInTheDocument();
    expect(screen.getByText('nuevo@empresa.com')).toBeInTheDocument();
    expect(screen.queryByText('app')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Volver a comprobar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Aún no tienes un grupo asignado.');
    expect(auth.refreshSession).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Volver a comprobar' }));
    expect(await screen.findByText('app')).toBeInTheDocument();
  });

  it('signs out from the no-access screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(noGroup())),
    );
    const auth = authValue();
    const user = userEvent.setup();
    render(
      <AuthContext value={auth}>
        <SessionProvider config={config}>
          <p>app</p>
        </SessionProvider>
      </AuthContext>,
    );
    await user.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect(auth.logout).toHaveBeenCalledOnce();
  });
});

describe('SessionProvider: what is shown until the application is ready', () => {
  it.each([
    [{ restored: true, federated: true }, 'Recuperando tu sesión…'],
    [{ restored: true, federated: false }, 'Recuperando tu sesión…'],
    // Back from the IdP: the same frame, not the generic loading screen.
    [{ restored: false, federated: true }, 'Completando el ingreso…'],
    // After the own sign-in form: the same frame too, never the generic «Cargando…».
    [{ restored: false, federated: false }, 'Entrando…'],
  ])('%o → %s', (auth, text) => {
    // The profile never answers: the screen in between stays.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(
      <AuthContext value={authValue(auth)}>
        <SessionProvider config={config}>
          <p>app</p>
        </SessionProvider>
      </AuthContext>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.getByRole('main')).toHaveTextContent('Mango');
    expect(screen.queryByText('Cargando…')).toBeNull();
    expect(screen.queryByText('app')).toBeNull();
  });
});
