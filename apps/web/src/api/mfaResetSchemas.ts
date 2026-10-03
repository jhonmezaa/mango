import { z } from 'zod';

// MFA reset with dual approval (D20), docs/specs/poc-api-contract.md. Emails and reasons come
// from other admins and are rendered as text only.

export const mfaResetIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const mfaResetSchema = z.object({
  change_id: mfaResetIdSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'expired']),
  target_user: z.string().max(128),
  target_email: z.string().max(254).nullable(),
  proposed_by: z.string().max(128),
  proposed_by_email: z.string().max(254).nullable(),
  reason: z.string().max(500),
  identity_verified: z.boolean(),
  created_at: z.string().max(40),
  expires_at: z.string().max(40),
  decided_by: z.string().max(128).nullable(),
  decided_by_email: z.string().max(254).nullable(),
  decided_at: z.string().max(40).nullable(),
  note: z.string().max(500).nullable(),
});
export type MfaReset = z.infer<typeof mfaResetSchema>;

export const mfaResetListSchema = z.object({ items: z.array(mfaResetSchema).max(500) });
export const mfaResetCreatedSchema = z.object({ change_id: mfaResetIdSchema });
