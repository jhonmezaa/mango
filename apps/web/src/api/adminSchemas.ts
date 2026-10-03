import { z } from 'zod';

// Admin v0 (D17) shapes from docs/specs/poc-api-contract.md. Every string here is rendered as text
// (TM-A8): OU names come from AWS Organizations and reasons/emails from other admins.

/** USD amounts travel as decimal strings ("12.50"). */
export const usdAmountSchema = z.string().regex(/^\d{1,9}(\.\d{1,6})?$/);

/** Area slug, same rule as the API and the connector (`^[a-z0-9-]{2,32}$`). */
export const AREA_PATTERN = /^[a-z0-9-]{2,32}$/;
export const areaSchema = z.string().regex(AREA_PATTERN);

/** Organizational unit ID (`ou-xxxx-yyyyyyyy`). */
export const ouIdSchema = z.string().regex(/^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$/);

/** User identifiers (Cognito `sub`) that end up in a URL path. */
export const adminUserIdSchema = z.string().regex(/^[A-Za-z0-9@._+-]{1,128}$/);

/** Change IDs: random public IDs (ULID/UUID). */
export const changeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const REASON_MAX_LENGTH = 500;
export const BUDGET_MAX_USD = 1_000_000;

export const budgetsSchema = z.object({
  period: z.string().max(16),
  version: z.number().int().nonnegative(),
  defaults: z.object({
    user_monthly_usd: usdAmountSchema,
    agent_monthly_usd: usdAmountSchema,
  }),
  agents: z.array(
    z.object({
      agent_id: z.string().max(64),
      /** Name of the published or retired agent; null when the API does not know it. */
      name: z.string().max(80).nullable().optional(),
      limit_usd: usdAmountSchema,
      spent_usd: usdAmountSchema,
    }),
  ),
  users: z.array(
    z.object({
      user_id: z.string().max(128),
      email: z.string().max(254).nullable(),
      limit_usd: usdAmountSchema,
      override: z.boolean(),
      spent_usd: usdAmountSchema,
    }),
  ),
});
export type Budgets = z.infer<typeof budgetsSchema>;
export type UserBudget = Budgets['users'][number];

/**
 * Area → OUs. Area keys are data: `constructor` is valid (matches the regex) and is handled as a
 * plain key by the UI (ADM-02). zod would silently drop an own `__proto__` key; reject it instead
 * so a malformed mapping fails loudly rather than hiding an area. The regex already rejects the
 * other prototype names (`toString`, `hasOwnProperty`, …).
 */
export const unitsSchema = z
  .unknown()
  .refine(
    (value) => !(typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__')),
    {
      message: 'Invalid area name',
    },
  )
  .pipe(z.record(areaSchema, z.array(ouIdSchema).max(200)));
export type Units = z.infer<typeof unitsSchema>;

export const pendingChangeSchema = z.object({
  change_id: changeIdSchema,
  proposed_by: z.string().max(128),
  proposed_by_email: z.string().max(254).nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  base_version: z.number().int().nonnegative(),
  units: unitsSchema,
  reason: z.string().max(REASON_MAX_LENGTH),
});
export type PendingChange = z.infer<typeof pendingChangeSchema>;

export const businessUnitsSchema = z.object({
  version: z.number().int().nonnegative(),
  units: unitsSchema,
  pending: z.array(pendingChangeSchema),
});
export type BusinessUnits = z.infer<typeof businessUnitsSchema>;

export const changeCreatedSchema = z.object({ change_id: changeIdSchema });

export const organizationSchema = z.object({
  ous: z.array(
    z.object({
      id: ouIdSchema,
      name: z.string().max(128),
      parent_id: z.string().max(80),
      path: z.array(z.string().max(128)).max(10),
    }),
  ),
});
export type Organization = z.infer<typeof organizationSchema>;
export type OrganizationalUnit = Organization['ous'][number];

export const connectivityCheckNames = ['broker', 'billing_reader', 'organizations'] as const;

export const connectivitySchema = z.object({
  checked_at: z.string(),
  checks: z.array(
    z.object({
      name: z.enum(connectivityCheckNames),
      status: z.enum(['ok', 'error']),
      detail: z.string().max(1000),
    }),
  ),
});
export type Connectivity = z.infer<typeof connectivitySchema>;

export const rejectReasonSchema = z.string().trim().min(1).max(REASON_MAX_LENGTH);

export type MoneyErrorKey =
  | 'gov.money.empty'
  | 'gov.money.format'
  | 'gov.money.decimals'
  | 'gov.money.positive'
  | 'gov.money.max';

/**
 * Parses a USD amount typed by an admin (design `parseMoney`): "150", "150,5", "1.250,00" or
 * "1200.25". Returns the API's decimal string or the reason it is not valid.
 */
export function parseMoney(raw: string): { value: string } | { error: MoneyErrorKey } {
  const text = raw.trim().replace(/\s/g, '').replace(/^usd/i, '');
  if (!text) return { error: 'gov.money.empty' };
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  if (!/^\d{1,12}(\.\d{1,12})?$/.test(normalized)) return { error: 'gov.money.format' };
  if (/\.\d{3,}$/.test(normalized)) return { error: 'gov.money.decimals' };
  const amount = Number(normalized);
  if (!(amount > 0)) return { error: 'gov.money.positive' };
  if (amount > BUDGET_MAX_USD) return { error: 'gov.money.max' };
  return { value: amount.toFixed(2) };
}
