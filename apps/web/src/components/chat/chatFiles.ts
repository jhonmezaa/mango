import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import type { ChatFileStatus } from '../../api/codeSchemas';
import { ApiError } from '../../api/errors';
import type { OperationOutput } from '../../api/operations';
import { useSession } from '../../auth/useSession';
import { isAllowedOrigin, parseExternalHttpUrl } from '../../security/safeUrl';

/**
 * The files of a conversation in the chat (C4, D116): the generated files of the «Analizando»
 * block and its file cards. Everything is asked of the API by id; the person never sees a key
 * or a link: the link of 5 minutes is asked on click and opened at once (design round 40).
 */
export interface ChatFilesScope {
  conversationId: string | null;
  /** «de {agente}» on a card (text from the API, rendered escaped). */
  agentName: string;
  /** «· {conversación}» on a card; empty for a conversation without a title yet. */
  threadTitle: string;
  /** Design round 40: «Descargando {nombre}» once the download started. */
  onDownload?: (name: string) => void;
  /** Design round 40: «Datos copiados. Pégalos en Excel o en una hoja de cálculo.». */
  onCopied?: () => void;
}

const Scope = createContext<ChatFilesScope>({
  conversationId: null,
  agentName: '',
  threadTitle: '',
});

export const ChatFilesProvider = Scope.Provider;

export function useChatFilesScope(): ChatFilesScope {
  return useContext(Scope);
}

/** What a card shows of a file while it is checked (`scan`), and after. */
export type FileView = 'scan' | 'ready' | 'blocked' | 'gone';

const POLL_FIRST_MS = 1500;
const POLL_MAX_MS = 10_000;
const POLL_FACTOR = 1.5;
/** About 35 minutes: past the server's own 30 for a scan (then the file is `failed`). */
const POLL_ATTEMPTS = 220;

function viewOf(status: ChatFileStatus): FileView {
  if (status.gone) return 'gone';
  if (status.status === 'ready') return 'ready';
  if (status.status === 'uploading' || status.status === 'scanning') return 'scan';
  // `failed` (its scan never came) or any other end: it is not delivered.
  return 'blocked';
}

/**
 * Where a file of the conversation is, asked of the API until its scan says (`scan` meanwhile).
 * `gone` from the history is final and asks nothing. A status that cannot be read leaves the
 * file `ready`: the download route decides again, and says why it does not deliver it.
 */
export function useFileView(fileId: string, gone: boolean): FileView {
  const { api } = useSession();
  const { conversationId } = useChatFilesScope();
  const [view, setView] = useState<FileView>(gone ? 'gone' : 'scan');
  useEffect(() => {
    if (gone || !conversationId) return undefined;
    let stopped = false;
    let timer: number | undefined;
    let wait = POLL_FIRST_MS;
    let attempts = 0;
    const ask = () => {
      attempts += 1;
      api.getChatFile(conversationId, fileId).then(
        (status) => {
          if (stopped) return;
          const next = viewOf(status);
          setView(next);
          if (next === 'scan' && attempts < POLL_ATTEMPTS) {
            timer = window.setTimeout(ask, wait);
            wait = Math.min(wait * POLL_FACTOR, POLL_MAX_MS);
          }
        },
        () => {
          if (!stopped) setView('ready');
        },
      );
    };
    ask();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [api, conversationId, fileId, gone]);
  return view;
}

/** How a download ended: `rate` carries the minutes until the next one may be asked. */
export type DownloadFailure =
  { kind: 'error' } | { kind: 'rate'; minutes: number } | { kind: 'blocked' } | { kind: 'gone' };

/**
 * The download of a file: a new link of 5 minutes, opened at once as a download. The link is
 * checked before it is used (absolute https, no credentials; http only on loopback for the dev
 * mock) and never kept, shown or copied.
 */
export function useDownload(): (file: {
  file_id: string;
  name: string;
}) => Promise<DownloadFailure | null> {
  const { api } = useSession();
  const { conversationId, onDownload } = useChatFilesScope();
  return useCallback(
    async ({ file_id: fileId, name }: { file_id: string; name: string }) => {
      if (!conversationId) return { kind: 'error' };
      try {
        const link = await api.chatFileLink(conversationId, fileId);
        const url = parseExternalHttpUrl(link.url);
        if (!url || !isAllowedOrigin(url)) return { kind: 'error' };
        const anchor = document.createElement('a');
        anchor.href = url.href;
        anchor.rel = 'noopener noreferrer';
        anchor.download = '';
        anchor.click();
        onDownload?.(name);
        return null;
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 429) {
            return { kind: 'rate', minutes: Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60)) };
          }
          if (error.code === 'file_blocked') return { kind: 'blocked' };
          if (error.code === 'file_gone') return { kind: 'gone' };
        }
        return { kind: 'error' };
      }
    },
    [api, conversationId, onDownload],
  );
}

/**
 * An image of the conversation as a `blob:` URL (CSP `img-src 'self' data: blob:`), read with
 * the person's token; revoked when the figure goes or loads again. `null` while it loads.
 */
export function useImageUrl(
  fileId: string,
  enabled: boolean,
  attempt: number,
): { url: string | null; failed: boolean } {
  const { api } = useSession();
  const { conversationId } = useChatFilesScope();
  const key = `${fileId}:${String(attempt)}`;
  const [state, setState] = useState<{ key: string; url: string | null; failed: boolean }>({
    key: '',
    url: null,
    failed: false,
  });
  useEffect(() => {
    if (!enabled || !conversationId) return undefined;
    const controller = new AbortController();
    let url: string | null = null;
    api.chatFileImage(conversationId, fileId, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setState({ key, url, failed: false });
      },
      () => {
        if (!controller.signal.aborted) setState({ key, url: null, failed: true });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, conversationId, fileId, enabled, key]);
  // Another file or another attempt: loading until its own answer arrives.
  return state.key === key && enabled ? state : { url: null, failed: false };
}

/** A chart or a table as the API answers it (`mango_api.chat_outputs.ChatOutputOut`). */
export type ChatOutput = OperationOutput<'chatFileOutput'>;

/** How the read of a chart or a table of a cell ended (D118): what its card shows. */
export type OutputView =
  | { kind: 'loading' }
  | { kind: 'ready'; output: ChatOutput }
  | { kind: 'invalid' }
  | { kind: 'withheld' }
  | { kind: 'error' };

function outputFailure(error: unknown): OutputView {
  if (error instanceof ApiError) {
    // «No se pudo dibujar esta gráfica…»: the spec is not one Mango draws.
    if (error.code === 'invalid_output' || error.code === 'not_an_output') {
      return { kind: 'invalid' };
    }
    // The guardrail did not let its texts be shown (TM-CI5).
    if (error.code === 'output_withheld') return { kind: 'withheld' };
  }
  return { kind: 'error' };
}

/**
 * A chart or a table of a cell, validated by the API (`GET …/files/{file}/output`, checked
 * again with the generated schema), once its scan let it be read (`enabled`). `attempt` asks
 * again after «Reintentar».
 */
export function useChatOutput(fileId: string, enabled: boolean, attempt: number): OutputView {
  const { api } = useSession();
  const { conversationId } = useChatFilesScope();
  const key = `${fileId}:${String(attempt)}`;
  const [state, setState] = useState<{ key: string; view: OutputView }>({
    key: '',
    view: { kind: 'loading' },
  });
  useEffect(() => {
    if (!enabled || !conversationId) return undefined;
    const controller = new AbortController();
    api
      .call(
        'chatFileOutput',
        { path: { conversation_id: conversationId, file_id: fileId } },
        { signal: controller.signal },
      )
      .then(
        (output) => {
          if (!controller.signal.aborted) setState({ key, view: { kind: 'ready', output } });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setState({ key, view: outputFailure(error) });
        },
      );
    return () => {
      controller.abort();
    };
  }, [api, conversationId, fileId, enabled, key]);
  return state.key === key && enabled ? state.view : { kind: 'loading' };
}
