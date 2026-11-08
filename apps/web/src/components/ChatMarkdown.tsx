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

import { useConnections } from '../pages/connections/ConnectionsContext';
import { RemoteLinkDialog } from '../security/RemoteLinkDialog';
import { classifyRemoteLink, type RemoteLinkSource } from '../security/remoteLinks';
import {
  fileLinkTarget,
  isFileLink,
  markdownUrlTransform,
  parseExternalHttpUrl,
} from '../security/safeUrl';
import { useDownload } from './chat/chatFiles';
import { ExternalLinkDialog } from './ExternalLinkDialog';
import { ShieldIcon } from './icons';
import { rehypeNumericColumns } from './markdownTables';

/** The remote services the answer read (D93): its links go through the reinforced dialog. */
const RemoteSources = createContext<readonly RemoteLinkSource[]>([]);
/**
 * Set in a turn with the «Conectar» card (design round 25): the services whose organizations keep
 * their links, 'pending' while the person's connections are read (design round 26), or 'failed'
 * when they could not be read (design round 27). Null when the turn asked for no connection.
 */
export type StripLinks = readonly RemoteLinkSource[] | 'pending' | 'failed' | null;
const StripSources = createContext<StripLinks>(null);
/** The files the server announced in this answer (C4): the only ones its links may name. */
export interface AnnouncedFile {
  file_id: string;
  name: string;
}
const AnnouncedFiles = createContext<readonly AnnouncedFile[]>([]);

/**
 * A link of the answer to one of its files (`mango-file:<id>` or `sandbox:/mnt/data/<name>`,
 * rea-gaps §2.3): a button that downloads it by id. A link to anything else stays plain text.
 */
function FileLink({ href, children }: { href: string; children: ReactNode }) {
  const files = useContext(AnnouncedFiles);
  const download = useDownload();
  const fileId = fileLinkTarget(href, files);
  const file = fileId ? files.find((f) => f.file_id === fileId) : undefined;
  if (!file) return <span>{children}</span>;
  return (
    <button
      type="button"
      className="md-link"
      title={file.name}
      onClick={() => {
        void download(file);
      }}
    >
      {children}
    </button>
  );
}

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
  if (strip === 'pending' || strip === 'failed') {
    // Not known which organizations are the person's: nothing opens, nothing is marked (it may
    // be theirs).
    return <span className="rm-linkwait">{children}</span>;
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

/** Design `StripLinks`: the note explains closed links, so it needs a link in the text. */
const LINK_IN_TEXT = /\]\(|https?:\/\//;

/** Design round 27: the person's connections could not be read, so the links stay closed. */
function RecheckNote() {
  const { t } = useTranslation();
  const { reload } = useConnections();
  return (
    <div className="rm-nolink-note">
      <ShieldIcon size={12} />
      <span>
        {t('connections.stripped.failed')}{' '}
        <button type="button" className="sr-link" onClick={reload}>
          {t('connections.stripped.recheck')}
        </button>
      </span>
    </div>
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
  a: ({ href, children }) =>
    href && isFileLink(href) ? (
      <FileLink href={href}>{children}</FileLink>
    ) : (
      <ExternalLink href={href}>{children}</ExternalLink>
    ),
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
  strip?: StripLinks;
  /** The files the server announced in this answer: its links to them download them (C4). */
  files?: readonly AnnouncedFile[];
}

const NO_REMOTE: readonly RemoteLinkSource[] = [];
const NO_FILES: readonly AnnouncedFile[] = [];

/**
 * Renders untrusted LLM markdown (TM-012):
 * - raw HTML is dropped (`skipHtml`, no rehype-raw), so no element or attribute from the model
 *   reaches the DOM as markup;
 * - URLs are limited to http(s) and every link needs explicit confirmation; a link to a file
 *   of the answer only downloads one the server announced in it, by id (C4);
 * - images are replaced by a placeholder;
 * - the only rehype plugin is ours and only adds a class to table cells (no raw HTML);
 * - no Mermaid, KaTeX or other plugins that execute or inject content.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  remote = NO_REMOTE,
  strip = null,
  files = NO_FILES,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [stripped, setStripped] = useState(0);
  // The links Mango took out, counted once they are on screen.
  useEffect(() => {
    setStripped(
      strip !== null && strip !== 'pending' && strip !== 'failed'
        ? (ref.current?.querySelectorAll('.rm-nolink').length ?? 0)
        : 0,
    );
  }, [children, strip]);
  const classes = ['md'];
  if (streaming) classes.push('md-streaming');
  if (remote.length > 0) classes.push('rm-md');
  return (
    <RemoteSources value={remote}>
      <AnnouncedFiles value={files}>
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
          {strip === 'failed' && LINK_IN_TEXT.test(children) && <RecheckNote />}
          {stripped > 0 && (
            <div className="rm-nolink-note">
              <ShieldIcon size={12} />
              <span>{t('connections.stripped.note', { count: stripped })}</span>
            </div>
          )}
        </StripSources>
      </AnnouncedFiles>
    </RemoteSources>
  );
});
