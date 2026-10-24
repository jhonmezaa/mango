import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TestProviders } from '../../test/TestProviders';
import { kb } from '../knowledge/testFixtures';
import { KnowledgeSection } from './KnowledgeSection';

const ID = (n: number) => `01JC00000000000000000000${String(n).padStart(2, '0')}`;

function renderSection(props: Partial<Parameters<typeof KnowledgeSection>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <TestProviders>
      <KnowledgeSection
        selected={[]}
        knowledge={[]}
        agentGroups={['finops-central']}
        userCount={0}
        myGroups={['finops-central']}
        onChange={onChange}
        {...props}
      />
    </TestProviders>,
  );
  return { onChange, user: userEvent.setup() };
}

describe('KnowledgeSection (design KbAgentSection)', () => {
  it('offers only the ones its author may use, with their status', async () => {
    const { onChange, user } = renderSection({
      knowledge: [
        kb({ kb_id: ID(1), name: 'Políticas de RH', status: 'warn' }),
        kb({ kb_id: ID(2), name: 'Legal', groups: ['legal'] }),
        kb({ kb_id: ID(3), name: 'Borrándose', status: 'deleting' }),
      ],
    });
    expect(screen.getByRole('button', { name: /Políticas de RH/ })).toHaveTextContent('Con avisos');
    expect(screen.queryByRole('button', { name: /Legal/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Borrándose/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Políticas de RH/ }));
    expect(onChange).toHaveBeenCalledWith({ knowledge_bases: [ID(1)] });
    expect(
      screen.getByText('0 de 5 · solo aparecen las que puedes usar: estás en sus grupos'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver Knowledge Bases' })).toHaveAttribute(
      'href',
      '/knowledge',
    );
  });

  it('keeps the ones the version had and the author cannot use, and says why', async () => {
    const { onChange, user } = renderSection({
      selected: [ID(2), ID(3), ID(9)],
      knowledge: [
        kb({ kb_id: ID(2), name: 'Legal', groups: ['legal'] }),
        kb({ kb_id: ID(3), name: 'Borrándose', status: 'deleting' }),
      ],
    });
    const notice = screen.getByText(
      'Estas knowledge bases ya estaban y no puedes usarlas',
    ).parentElement;
    if (!notice) throw new Error('no notice');
    expect(within(notice).getByText('No estás en sus grupos · se conserva')).toBeVisible();
    expect(within(notice).getByText('Se está borrando')).toBeVisible();
    expect(within(notice).getByText('Ya no existe')).toBeVisible();
    await user.click(within(notice).getAllByRole('button', { name: 'Quitar' })[0] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith({ knowledge_bases: [ID(3), ID(9)] });
  });

  it('allows five, and warns about groups that would get answers without its content', () => {
    const items = [1, 2, 3, 4, 5, 6].map((n) => kb({ kb_id: ID(n), name: `KB ${String(n)}` }));
    renderSection({
      knowledge: items,
      selected: [1, 2, 3, 4, 5].map(ID),
      agentGroups: ['finops-central', 'bu-retail'],
      userCount: 2,
    });
    expect(screen.getByRole('button', { name: /KB 6/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /KB 6/ })).toHaveAttribute(
      'title',
      'Máximo 5 por agente',
    );
    expect(screen.getAllByText('bu-retail')).toHaveLength(5);
    expect(
      screen.getByText(
        'Las personas agregadas por correo reciben su contenido solo si están en sus grupos.',
      ),
    ).toBeVisible();
  });

  it('says when the list could not be read, without dropping what the version has', async () => {
    const { onChange, user } = renderSection({ knowledge: null, selected: [ID(1)] });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'No se pudieron cargar las knowledge bases. Las que ya tiene el agente se conservan.',
    );
    expect(within(alert).getByRole('button', { name: 'Reintentar' })).toBeVisible();
    expect(screen.queryByText(/ya estaba/)).toBeNull();
    // What the version has stays, by id (no names without the list), and can be taken out.
    expect(screen.getByText('Tiene 1 knowledge base · se conservan')).toBeVisible();
    expect(screen.getByText(ID(1))).toBeVisible();
    expect(screen.getByText('1 de 5')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Ver Knowledge Bases' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Quitar' }));
    expect(onChange).toHaveBeenCalledWith({ knowledge_bases: [] });
  });

  it('says when there is none to use', () => {
    renderSection({ knowledge: [kb({ groups: ['legal'] })] });
    expect(
      screen.getByText(
        'No hay knowledge bases que puedas usar: solo aparecen las de grupos en los que estás.',
      ),
    ).toBeVisible();
  });
});
