import { errorBodySchema, type ApiViolation } from './schemas';

/** Error returned by mango-api (`{"error": {"code", "message"}}`) or synthesized by the client. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds from a `Retry-After` header (429), when the API sent a usable one. */
    readonly retryAfter: number | null = null,
    /**
     * Rules the server reported with a `422 validation_failed` (codes and items, validated by
     * schema). Data to render as text; null for any other error.
     */
    readonly violations: readonly ApiViolation[] | null = null,
  ) {
    super(message);
  }
}

/** Longest wait honored from `Retry-After`; anything else is treated as absent. */
const RETRY_AFTER_MAX_S = 3600;

/** `Retry-After` in delta-seconds (the form mango-api sends); HTTP dates are ignored. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return seconds >= 1 && seconds <= RETRY_AFTER_MAX_S ? seconds : null;
}

/** Raised when there is no valid session; the UI must send the user back to login. */
export class NotAuthenticatedError extends Error {
  override name = 'NotAuthenticatedError';
}

/**
 * The session could not be renewed and nothing said it ended (outage, network, rate limit), so
 * the request was not sent. Same status and code as the answer of `POST /api/session/refresh`
 * that caused it: every screen shows the error it already has for a 503 or a 429, and the
 * person stays signed in and can retry.
 */
export function sessionUnavailableError(
  cause: { rateLimited?: boolean; retryAfter?: number | null } = {},
): ApiError {
  return cause.rateLimited
    ? new ApiError(429, 'rate_limited', 'Session renewal rate limited', cause.retryAfter ?? null)
    : new ApiError(503, 'session_unavailable', 'Session renewal unavailable');
}

export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error body (e.g. a proxy page): fall through to a generic error.
  }
  const parsed = errorBodySchema.safeParse(body);
  const retryAfter =
    response.status === 429 ? parseRetryAfter(response.headers.get('Retry-After')) : null;
  if (parsed.success) {
    return new ApiError(
      response.status,
      parsed.data.error.code,
      parsed.data.error.message,
      retryAfter,
      parsed.data.violations ?? null,
    );
  }
  return new ApiError(response.status, `http_${response.status}`, response.statusText, retryAfter);
}
