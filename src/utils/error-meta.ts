export interface ErrorDetails {
  errorName: string;
  errorMessage: string;
  errorStack: string;
  causeMessage?: string;
  causeStack?: string;
}

/**
 * Extract HTTP status code from different error shapes.
 * - prefer `err.response.statusCode` / `err.response.status`
 * - fallback: parse message like "status code 502"
 */
export function extractHttpStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err == null) return undefined;

  const maybeResponse = (err as { response?: { statusCode?: unknown; status?: unknown } }).response;
  const maybeStatusCode = maybeResponse?.statusCode;
  if (typeof maybeStatusCode === 'number' && Number.isFinite(maybeStatusCode)) return maybeStatusCode;

  const maybeStatus = maybeResponse?.status;
  if (typeof maybeStatus === 'number' && Number.isFinite(maybeStatus)) return maybeStatus;

  const message =
    typeof (err as { message?: unknown }).message === 'string' ? String((err as { message?: unknown }).message) : String(err);

  const match =
    message.match(/status code\s+(\d{3})/i) ||
    message.match(/\b(\d{3})\s*\(.*\)\s*$/i); // best-effort fallback

  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asError(value: unknown): Error | undefined {
  if (value instanceof Error) return value;
  return undefined;
}

export function toErrorDetails(err: unknown): ErrorDetails {
  const e = asError(err);
  const baseMessage = e?.message?.trim() || String(err);
  const baseStack =
    (e?.stack && e.stack.trim()) ||
    `${e?.name ?? 'Error'}: ${baseMessage}`;

  const cause = e && 'cause' in e ? (e as Error & { cause?: unknown }).cause : undefined;
  const causeError = asError(cause);
  const causeMessage = causeError?.message?.trim() || (cause != null ? String(cause) : undefined);
  const causeStack =
    causeError?.stack?.trim() ||
    (causeMessage ? `${causeError?.name ?? 'Error'}: ${causeMessage}` : undefined);

  return {
    errorName: e?.name ?? 'Error',
    errorMessage: baseMessage,
    errorStack: baseStack,
    ...(causeMessage ? { causeMessage } : {}),
    ...(causeStack ? { causeStack } : {}),
  };
}

export function isLikelyDatabaseDown(err: unknown): boolean {
  const details = toErrorDetails(err);
  const text = `${details.errorMessage}\n${details.errorStack}\n${details.causeMessage ?? ''}\n${details.causeStack ?? ''}`.toLowerCase();

  const markers = [
    'econnrefused',
    'etimedout',
    'connect timeout',
    'und_err_connect_timeout',
    'fetch failed',
    'enotfound',
    'eai_again',
    'socket hang up',
    'request was aborted',
    'networkerror',
    'connection terminated',
    'connect ehostunreach',
    'tls',
  ];

  return markers.some((marker) => text.includes(marker));
}
