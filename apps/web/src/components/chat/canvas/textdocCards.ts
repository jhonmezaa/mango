import { z } from 'zod';

import { chatFileIdSchema, codeFileSchema, type CodeFile } from '../../../api/codeSchemas';
import type { TextdocCard } from './canvasApi';

/**
 * The cards of the Canvas documents an answer wrote (D124), from `metadata.textdocs` of `v1` or
 * `textdocs` of a stored answer, validated one by one: one that does not parse is left out. A
 * later card of the same document replaces the earlier one (its newest version).
 */
export const textdocCardSchema = z.object({
  textdoc_id: chatFileIdSchema,
  title: z.string().min(1).max(200),
  kind: z.enum(['document', 'code/python', 'code/react', 'code/html']),
  version: z.number().int().min(1).max(1000),
});

export function parseTextdocCards(raw: readonly unknown[] | undefined): TextdocCard[] {
  const out = new Map<string, TextdocCard>();
  for (const item of (raw ?? []).slice(0, 100)) {
    const parsed = textdocCardSchema.safeParse(item);
    if (parsed.success) out.set(parsed.data.textdoc_id, parsed.data);
  }
  return [...out.values()];
}

/** The files a Canvas export added (D124 (3)): cards of their own, validated one by one. */
export function parseExportFiles(raw: readonly unknown[] | undefined): CodeFile[] {
  return (raw ?? []).slice(0, 20).flatMap((item) => {
    const parsed = codeFileSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}
