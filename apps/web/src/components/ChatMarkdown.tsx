import { memo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { markdownUrlTransform, parseExternalHttpUrl } from '../security/safeUrl';
import { ExternalLinkDialog } from './ExternalLinkDialog';
import { rehypeNumericColumns } from './markdownTables';

function ExternalLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const [pending, setPending] = useState<URL | null>(null);
  const url = href ? parseExternalHttpUrl(href) : null;
  if (!url) {
    // Unsafe or relative target: keep the text, drop the link.
    return <span>{children}</span>;
  }
  return (
    <>
      <button
        type="button"
        className="md-link"
        title={url.href}
        onClick={() => {
          setPending(url);
        }}
      >
        {children}
      </button>
      {pending &&
        // Portaled: the link sits inside markdown paragraphs, where a dialog cannot be nested.
        createPortal(
          <ExternalLinkDialog
            url={pending}
            onClose={() => {
              setPending(null);
            }}
          />,
          document.body,
        )}
    </>
  );
}

function BlockedImage() {
  const { t } = useTranslation();
  // Remote images are never fetched: an image URL can exfiltrate data in its query (TM-001).
  return (
    <span className="md-blocked" title={t('markdown.blockedImageTitle')}>
      [{t('markdown.blockedImage')}]
    </span>
  );
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeNumericColumns];

const components: Components = {
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  img: () => <BlockedImage />,
  // Design markdown.js: `####` renders as the smallest heading (h3).
  h4: ({ children }) => <h3>{children}</h3>,
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

interface Props {
  children: string;
  /** Shows the blinking cursor after the text while the response is streaming. */
  streaming?: boolean;
}

/**
 * Renders untrusted LLM markdown (TM-012):
 * - raw HTML is dropped (`skipHtml`, no rehype-raw), so no element or attribute from the model
 *   reaches the DOM as markup;
 * - URLs are limited to http(s) and every link needs explicit confirmation;
 * - images are replaced by a placeholder;
 * - the only rehype plugin is ours and only adds a class to table cells (no raw HTML);
 * - no Mermaid, KaTeX or other plugins that execute or inject content.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ children, streaming = false }: Props) {
  return (
    <div className={streaming ? 'md md-streaming' : 'md'}>
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
        urlTransform={markdownUrlTransform}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
});
