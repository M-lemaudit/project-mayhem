import { logger } from './logger';

export type AuthErrorWebhookReason =
  | 'gateway_persisted_after_rotation'
  | 'proxy_tunnel_failed'
  | 'invalid_credentials'
  | 'token_not_found'
  | 'playwright_navigation_failed'
  | 'unknown';

export async function triggerAuthErrorWebhook(
  userEmail: string,
  errorMessage: string,
  reason: AuthErrorWebhookReason = 'unknown',
  explanation?: string,
  errorLog?: string,
  errorLogDisplay?: string,
  errorLogLines?: string[]
): Promise<void> {
  const webhookUrl = process.env.N8N_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  try {
    const payload = {
      event: 'bot_auth_error',
      app: 'blacklane-bot',
      userEmail,
      timestamp: new Date().toISOString(),
      reason,
      explanation: explanation ?? undefined,
      errorDetails: errorMessage,
      errorLog: errorLog ?? undefined,
      errorLogDisplay: errorLogDisplay ?? undefined,
      errorLogLines: errorLogLines ?? undefined,
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      logger.warn('[WEBHOOK] Auth error webhook responded non-2xx', {
        status: res.status,
        statusText: res.statusText,
      });
    }
  } catch (err) {
    logger.warn('[WEBHOOK] Failed to trigger auth error webhook', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

