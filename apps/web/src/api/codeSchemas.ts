import { z } from 'zod';

/**
 * A cell of the code sandbox as the API shows it (C4, `code_blocks.CodeCellOut`): the
 * `aggregate_result` of its result message in the `v1` stream and the `code` of a stored answer.
 *
 * Everything in it came from the model and from the sandbox through the API, after the guardrail
 * (TM-CI5): it is shown as text only (React escapes it), never interpreted. The caps mirror the
 * server's; a value over them makes the cell invalid, and an invalid cell is left out.
 */
export const CODE_OUTPUT_CHARS = 20_000;
const CODE_CHARS = 100_000;

/** A file id of the API (ULID, `knowledge.ID_PATTERN`). */
export const chatFileIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const codeFileSchema = z.object({
  file_id: chatFileIdSchema,
  name: z.string().min(1).max(255),
  kind: z.string().max(8),
  size_bytes: z.number().int().min(0),
  image: z.boolean(),
  gone: z.boolean().optional(),
});
export type CodeFile = z.infer<typeof codeFileSchema>;

export const codeCellSchema = z.object({
  run_id: z.string().regex(/^[0-9a-f]{1,64}$/),
  status: z.enum(['completed', 'error', 'timeout']),
  blocked: z.boolean(),
  code: z.string().max(CODE_CHARS).default(''),
  stdout: z.string().max(CODE_OUTPUT_CHARS).default(''),
  stderr: z.string().max(CODE_OUTPUT_CHARS).default(''),
  stdout_truncated: z.boolean().default(false),
  stderr_truncated: z.boolean().default(false),
  exception: z
    .object({ name: z.string().max(200), message: z.string().max(2000) })
    .nullable()
    .optional(),
  seconds: z.number().int().min(0).nullable().optional(),
  files: z.array(codeFileSchema).max(20).default([]),
});
export type CodeCell = z.infer<typeof codeCellSchema>;

/** The cells of a stored answer; one that does not parse is left out, never shown raw. */
export function parseCells(raw: readonly unknown[] | undefined): CodeCell[] {
  return (raw ?? []).flatMap((item) => {
    const parsed = codeCellSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Where a file of the conversation is (`GET /api/conversations/{id}/files/{file}`). */
export const chatFileStatusSchema = z.object({
  file_id: chatFileIdSchema,
  status: z.enum([
    'uploading',
    'scanning',
    'ready',
    'blocked',
    'type_mismatch',
    'too_large',
    'failed',
  ]),
  gone: z.boolean(),
});
export type ChatFileStatus = z.infer<typeof chatFileStatusSchema>;

/** A link of 5 minutes to download a file (`POST …/files/{file}/download`). */
export const chatFileLinkSchema = z.object({ url: z.string().max(4096), file: z.string() });
