import { z } from 'zod';

import { isAllowedOrigin } from '../security/safeUrl';

const originUrl = z
  .url()
  .refine((value) => isAllowedOrigin(new URL(value)), 'must be https (http only on localhost)')
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * Runtime configuration published by the IaC as /config.json (docs/specs/poc-api-contract.md).
 * It contains no secrets: everything here is public by design (REACT-CONFIG-001).
 */
export const runtimeConfigSchema = z.object({
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  cognitoDomain: originUrl,
  userPoolId: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/),
  clientId: z.string().regex(/^[A-Za-z0-9]+$/),
  // Same-origin path only: the bearer token must never be sent to another origin (REACT-NET-001).
  apiBasePath: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/)
    .refine((value) => !value.startsWith('//'), 'must be a same-origin path')
    .transform((value) => value.replace(/\/+$/, '')),
  /**
   * Company email domains allowed to self-register (D20). Shown in the sign-up form only: the
   * pre sign-up Lambda enforces the list on the server (TM-L4).
   */
  signUpDomains: z
    .array(
      z
        .string()
        .max(253)
        .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    )
    .min(1)
    .max(20),
  /**
   * Optional installation parameter: the company's AI use policy. When present, sign-up asks the
   * user to accept it. `https:` only, so a `javascript:`/`data:` URL can never reach an `href`.
   */
  aiPolicyUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine((value) => {
      // Refinements also run after a failed format check: never throw on an unparsable value.
      const url = URL.canParse(value) ? new URL(value) : null;
      return url !== null && !url.username && !url.password;
    }, 'must not contain credentials')
    .optional(),
  /**
   * Authentication policy set by the installation (infra `edge.ts`), shown read-only in Ajustes ›
   * Autenticación. Display only: Cognito and the installation enforce it.
   */
  auth: z.object({
    /** `customer` installations always require MFA (it is shown as fixed). */
    installationType: z.enum(['customer', 'lab']),
    mfa: z.enum(['required', 'off']),
    /** Refresh token validity of the web client, in hours. */
    sessionHours: z.number().int().min(1).max(24),
  }),
  /** Cognito identity provider name of the customer's IdP; "Continuar con SSO" only if set. */
  ssoProvider: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,32}$/)
    .optional(),
  // Optional: override the issuer (only the local mock uses it; Cognito derives it from the pool).
  issuer: originUrl.optional(),
  // Optional: override the Cognito API endpoint (only the local mock uses it).
  cognitoIdpEndpoint: originUrl.optional(),
});

/** Public Cognito user pool API endpoint used by the own login (allowed by the CSP). */
export function cognitoIdpEndpoint(config: RuntimeConfig): string {
  return config.cognitoIdpEndpoint ?? `https://cognito-idp.${config.region}.amazonaws.com/`;
}

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export class RuntimeConfigError extends Error {
  override name = 'RuntimeConfigError';
}

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  const response = await fetchImpl('/config.json', {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new RuntimeConfigError(`config.json unavailable (HTTP ${response.status})`);
  }
  const parsed = runtimeConfigSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new RuntimeConfigError('config.json is invalid');
  }
  return parsed.data;
}
