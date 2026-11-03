import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { CognitoAuth } from './auth/cognito/flows';
import { testConfig } from './test/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App: opening the application while the session renewal does not answer', () => {
  it('says Mango could not open with «Reintentar», not the sign-in form', async () => {
    // A 429 is not retried on its own, so the error is there at once.
    const answers = [
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x' } }), {
        status: 429,
        headers: { 'Retry-After': '2' },
      }),
      // The retry gets a real answer: there is no session.
      new Response(null, { status: 204 }),
    ];
    const fetchMock = vi.fn((url: string) => {
      if (url !== '/api/session/refresh') return Promise.reject(new Error(`unexpected ${url}`));
      return Promise.resolve(answers.shift() ?? new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App config={testConfig} cognito={{} as CognitoAuth} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo abrir Mango');
    expect(screen.queryByLabelText('Correo')).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();

    // Design round 34 `RateWait`: the wait of the 429, and «Reintentar» only once it is over.
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Puedes volver a intentarlo en unos segundos/,
    );
    expect(screen.getByRole('button', { name: /^Reintentar en \d s$/ })).toBeDisabled();
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }, { timeout: 4000 }));
    // Only now, with the answer that says so, the sign-in form.
    expect(await screen.findByLabelText('Correo')).toBeInTheDocument();
    expect(screen.queryByText('No se pudo abrir Mango')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
