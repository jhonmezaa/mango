import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import type { OperationOutput } from '../../../api/operations';
import { useSession } from '../../../auth/useSession';

/**
 * The Canvas of a conversation (D124) as the API gives it: the documents, their versions and
 * comments, read by id through the generated client. Everything in them came from the model or
 * from the person: it is rendered as text or as Markdown without raw HTML.
 */
export type Textdoc = OperationOutput<'getTextdoc'>;
export type TextdocVersion = Textdoc['versions'][number];
export type TextdocKind = Textdoc['kind'];
export type TextdocExport = Textdoc['exports'][number];

/** The card of a document in an answer (`metadata.textdocs` of `v1`, `textdocs` of history). */
export interface TextdocCard {
  textdoc_id: string;
  title: string;
  kind: TextdocKind;
  version: number;
}

/** What the language of a code document is called (design: «Código · Python»). */
export const LANGUAGE: Record<TextdocKind, string> = {
  document: 'Markdown',
  'code/python': 'Python',
  'code/react': 'React',
  'code/html': 'HTML',
};

export const isCode = (kind: TextdocKind) => kind !== 'document';

/** Opening a document of the conversation in the Canvas, from a card of an answer. */
export interface CanvasOpener {
  open: (card: TextdocCard) => void;
  /** The document open now (the card says it is open), or null. */
  openId: string | null;
}

const Opener = createContext<CanvasOpener>({ open: () => undefined, openId: null });
export const CanvasProvider = Opener.Provider;
export function useCanvasOpener(): CanvasOpener {
  return useContext(Opener);
}

export type Load<T> =
  { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; status: number | null };

function statusOf(error: unknown): number | null {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status) || null
    : null;
}

/** A document of the conversation and the text of one of its versions, asked again on `key`. */
export function useTextdoc(conversationId: string, textdocId: string, key: number): Load<Textdoc> {
  const { api } = useSession();
  const [state, setState] = useState<Load<Textdoc>>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    api
      .call(
        'getTextdoc',
        { path: { conversation_id: conversationId, textdoc_id: textdocId } },
        { signal: controller.signal },
      )
      .then(
        (value) => {
          setState({ kind: 'ready', value });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setState({ kind: 'error', status: statusOf(error) });
        },
      );
    return () => {
      controller.abort();
    };
  }, [api, conversationId, textdocId, key]);
  return state;
}

/**
 * The texts of the versions read so far, by number: a version never changes. One instance per
 * document (the panel is keyed by it).
 */
export function useVersionTexts(conversationId: string, textdocId: string) {
  const { api } = useSession();
  const [texts, setTexts] = useState<ReadonlyMap<number, string>>(new Map());
  const [failed, setFailed] = useState(false);
  const want = useCallback(
    (version: number) => {
      if (texts.has(version)) return;
      setFailed(false);
      api
        .call('getTextdocVersion', {
          path: { conversation_id: conversationId, textdoc_id: textdocId, version },
        })
        .then(
          (out) => {
            setTexts((current) => new Map(current).set(out.version, out.content));
          },
          () => {
            setFailed(true);
          },
        );
    },
    [api, conversationId, textdocId, texts],
  );
  const put = useCallback((version: number, text: string) => {
    setTexts((current) => new Map(current).set(version, text));
  }, []);
  return { texts, want, put, failed };
}

/** The name of a download, as the design's `fileName`: letters, digits, `-`, `_`. */
export function fileName(title: string, extension: string): string {
  const base =
    title
      .replace(/[^\p{L}\p{N}_\- ]/gu, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 100) || 'documento';
  return `${base}.${extension}`;
}

/**
 * «Se descarga al momento» (design round 41): the text of a version as a file, built here from
 * what the API gave, as `text/plain` (never a type the browser would render or run), with a name
 * made of the title. The object URL is revoked right after.
 */
export function downloadText(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
