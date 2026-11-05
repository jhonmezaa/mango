import type { ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import '../../i18n';
import { OpsState, type OpsView } from './OpsState';

function renderState(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const VIEWS: OpsView[] = ['costs', 'observability', 'evals', 'tickets'];

describe('OpsState · design round 37', () => {
  it('announces the loading of each view', () => {
    const expected = {
      costs: 'Cargando costos…',
      observability: 'Cargando observabilidad…',
      evals: 'Cargando evals…',
      tickets: 'Cargando tickets…',
    };
    for (const view of VIEWS) {
      const { unmount } = renderState(<OpsState view={view} kind="loading" />);
      expect(screen.getByRole('status')).toHaveTextContent(expected[view]);
      unmount();
    }
  });

  it('shows the error as an alert with «Reintentar»', () => {
    const onRetry = vi.fn();
    renderState(<OpsState view="costs" kind="error" onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('No se pudo cargar Costos.');
    expect(alert).toHaveTextContent('Inténtalo de nuevo en unos segundos.');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('says who sees each view on a 403 and links to the chat', () => {
    const expected = {
      costs:
        'Costos es para administradores y para FinOps central. Un admin de Mango puede darte acceso.',
      observability: 'Observabilidad es solo para administradores de Mango.',
      evals: 'Evals es para administradores, para FinOps central y para quien edita un agente.',
      tickets:
        'Ves los tickets que creaste, los que tienes asignados y los de los agentes que puedes usar.',
    };
    for (const view of VIEWS) {
      const { unmount } = renderState(<OpsState view={view} kind="denied" />);
      expect(screen.getByText(expected[view])).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Ir al chat' })).toHaveAttribute('href', '/');
      unmount();
    }
    renderState(<OpsState view="observability" kind="denied" />);
    expect(screen.getByText('No tienes acceso a Observabilidad')).toBeInTheDocument();
  });

  it('shows the empty text of each view and its action', () => {
    const titles = {
      costs: 'Todavía no hay gasto este mes',
      observability: 'No hay trazas en este rango',
      evals: 'Todavía no hay suites',
      tickets: 'No hay tickets',
    };
    for (const view of VIEWS) {
      const { unmount } = renderState(<OpsState view={view} kind="empty" />);
      expect(screen.getByText(titles[view])).toBeInTheDocument();
      unmount();
    }
    renderState(
      <OpsState
        view="tickets"
        kind="empty"
        action={
          <button type="button" className="btn btn-sm btn-primary">
            Nuevo ticket
          </button>
        }
      />,
    );
    expect(
      screen.getByText(
        'Los agentes los crean dentro de una conversación o de una tarea. También puedes crear uno.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nuevo ticket' })).toBeInTheDocument();
  });
});
