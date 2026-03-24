export interface ErrorDetails {
  errorName: string;
  errorMessage: string;
  errorStack: string;
  causeMessage?: string;
  causeStack?: string;
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
