import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { RemoteLinkDialog } from '../security/RemoteLinkDialog';
import { classifyRemoteLink, type RemoteLinkSource } from '../security/remoteLinks';
import { markdownUrlTransform, parseExternalHttpUrl } from '../security/safeUrl';
import { ExternalLinkDialog } from './ExternalLinkDialog';
import { ShieldIcon } from './icons';
import { rehypeNumericColumns } from './markdownTables';

/** The remote services the answer read (D93): its links go through the reinforced dialog. */
const RemoteSources = createContext<readonly RemoteLinkSource[]>([]);
/**
 * Set in a turn with the «Conectar» card (design round 25): the services whose organizations keep
 * their links. Null when the turn asked for no connection.
 */
const StripSources = createContext<readonly RemoteLinkSource[] | null>(null);

function ExternalLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<URL | null>(null);
  const remote = useContext(RemoteSources);
  const strip = useContext(StripSources);
  const url = href ? parseExternalHttpUrl(href) : null;
  if (!url) {
    // Unsafe or relative target: keep the text, drop the link.
    return <span>{children}</span>;
  }
  if (strip !== null) {
    // The agent never gets the real URL to connect an account: a link to «authorize» is invented
    // or comes from content (TM-001). Only an organization the person may use keeps its link.
    const kept = classifyRemoteLink(url, strip);
    if (kept.kind !== 'own') {
      return (
        <span className="rm-nolink" title={t('connections.stripped.title', { host: kept.label })}>
          {children}
        </span>
      );
    }
  }
  // Design remote-core.jsx: a link of a remote answer shows where it goes when it is not the
  // company's organization of that service (A1).
  const link = remote.length > 0 ? classifyRemoteLink(url, remote) : null;
  const close = () => {
    setPending(null);
  };
  return (
    <>
      <button
        type="button"
        className="md-link"
        title={url.href}
        data-host={link?.label}
        data-host-kind={link ? (link.kind === 'own' ? 'service' : 'other') : undefined}
        onClick={() => {
          setPending(url);
        }}
      >
        {children}
      </button>
      {pending &&
        // Portaled: the link sits inside markdown paragraphs, where a dialog cannot be nested.
        createPortal(
          remote.length > 0 ? (
            <RemoteLinkDialog url={pending} sources={remote} onClose={close} />
          ) : (
            <ExternalLinkDialog url={pending} onClose={close} />
          ),
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
  /** Remote services the answer read: links are classified and confirmed with their dialog. */
  remote?: readonly RemoteLinkSource[];
  /**
   * Set when the turn asked to connect an account: links outside these services' organizations
   * are shown struck through, without a link, with a note under the text (design round 25).
   */
  strip?: readonly RemoteLinkSource[] | null;
}

const NO_REMOTE: readonly RemoteLinkSource[] = [];

/**
 * Renders untrusted LLM markdown (TM-012):
 * - raw HTML is dropped (`skipHtml`, no rehype-raw), so no element or attribute from the model
 *   reaches the DOM as markup;
 * - URLs are limited to http(s) and every link needs explicit confirmation;
 * - images are replaced by a placeholder;
 * - the only rehype plugin is ours and only adds a class to table cells (no raw HTML);
 * - no Mermaid, KaTeX or other plugins that execute or inject content.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  remote = NO_REMOTE,
  strip = null,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [stripped, setStripped] = useState(0);
  // The links Mango took out, counted once they are on screen.
  useEffect(() => {
    setStripped(strip !== null ? (ref.current?.querySelectorAll('.rm-nolink').length ?? 0) : 0);
  }, [children, strip]);
  const classes = ['md'];
  if (streaming) classes.push('md-streaming');
  if (remote.length > 0) classes.push('rm-md');
  return (
    <RemoteSources value={remote}>
      <StripSources value={strip}>
        <div ref={ref} className={classes.join(' ')}>
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
        {stripped > 0 && (
          <div className="rm-nolink-note">
            <ShieldIcon size={12} />
            <span>{t('connections.stripped.note', { count: stripped })}</span>
          </div>
        )}
      </StripSources>
    </RemoteSources>
  );
});
