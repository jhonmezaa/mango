import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RestoringSession } from './RestoringSession';

describe('RestoringSession', () => {
  it('shows the sign-in frame with the status, not the form', () => {
    render(<RestoringSession />);
    expect(screen.getByRole('status')).toHaveTextContent('Recuperando tu sesión…');
    expect(screen.getByRole('main')).toHaveTextContent('Mango');
    expect(screen.queryByRole('button', { name: 'Entrar' })).toBeNull();
  });

  it('says the sign-in is being completed when coming back from the SSO', () => {
    render(<RestoringSession step="ssoReturn" />);
    expect(screen.getByRole('status')).toHaveTextContent('Completando el ingreso…');
    expect(screen.getByRole('main')).toHaveTextContent('Mango');
  });

  it('says «Entrando…» after the own sign-in form, in the same frame', () => {
    render(<RestoringSession step="signingIn" />);
    expect(screen.getByRole('status')).toHaveTextContent('Entrando…');
    expect(screen.getByRole('main')).toHaveTextContent('Mango');
    expect(screen.queryByRole('button', { name: 'Entrar' })).toBeNull();
  });
});
