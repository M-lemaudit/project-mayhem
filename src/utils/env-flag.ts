/**
 * Parse boolean-like environment flags in a tolerant way.
 * Accepts true/1/yes/on (case-insensitive), with or without quotes.
 */
export function isEnvFlagEnabled(raw: string | undefined): boolean {
  if (raw == null) return false;
  const normalized = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

