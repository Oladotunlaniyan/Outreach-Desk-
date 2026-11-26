import { Router, type Request, type Response } from 'express';
import { getDatabaseStatus } from '../config/db.ts';
import { UnsubscribeToken } from '../models/index.ts';
import { logEvent } from '../utils/logger.ts';
import { hashUnsubscribeToken, suppressEmail } from '../utils/suppression.ts';

export const unsubscribeRouter = Router();

function renderUnsubscribeHtml(params: {
  title: string;
  heading: string;
  body: string;
  statusOk: boolean;
}): string {
  const accent = params.statusOk ? '#2563eb' : '#64748b';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${params.title}</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #f8fafc;
        color: #0f172a;
        display: flex;
        min-height: 100vh;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        max-width: 460px;
        width: 100%;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 28px;
      }
      .bar {
        width: 36px;
        height: 4px;
        border-radius: 999px;
        background: ${accent};
        margin-bottom: 16px;
      }
      h1 {
        font-size: 18px;
        margin: 0 0 10px 0;
      }
      p {
        font-size: 14px;
        line-height: 1.55;
        color: #475569;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="bar"></div>
      <h1>${params.heading}</h1>
      <p>${params.body}</p>
    </main>
  </body>
</html>`;
}

async function handleUnsubscribeLookup(
  token: string,
  method: 'GET' | 'POST'
): Promise<{
  status: number;
  found: boolean;
  email?: string;
  error?: string;
}> {
  const db = getDatabaseStatus();
  if (!db.connected) {
    return {
      status: 503,
      found: false,
      error: 'Service temporarily unavailable.',
    };
  }

  const cleanedToken = token.trim();
  if (!cleanedToken || cleanedToken.length < 16 || cleanedToken.length > 200) {
    return { status: 404, found: false, error: 'Invalid unsubscribe link.' };
  }

  const tokenHash = hashUnsubscribeToken(cleanedToken);
  const tokenDoc = await UnsubscribeToken.findOne({ tokenHash });
  if (!tokenDoc) {
    return {
      status: 404,
      found: false,
      error: 'This unsubscribe link is invalid or has expired.',
    };
  }

  const now = new Date();
  if (!tokenDoc.usedAt) {
    tokenDoc.usedAt = now;
    tokenDoc.usedMethod = method;
    await tokenDoc.save();
  }

  await suppressEmail({
    email: tokenDoc.email,
    reason: 'unsubscribe',
    source: method === 'POST' ? 'one_click_post' : 'unsubscribe_link',
    detail:
      method === 'POST'
        ? 'RFC 8058 one-click unsubscribe'
        : 'Unsubscribed via confirmation link',
    ...(tokenDoc.leadId ? { leadId: tokenDoc.leadId } : {}),
    ...(tokenDoc.campaignId ? { campaignId: tokenDoc.campaignId } : {}),
    ...(tokenDoc.emailMessageId ? { emailMessageId: tokenDoc.emailMessageId } : {}),
  });

  logEvent('info', 'unsubscribe.completed', {
    method,
    email: tokenDoc.email,
    campaignId: tokenDoc.campaignId ? String(tokenDoc.campaignId) : undefined,
    leadId: tokenDoc.leadId ? String(tokenDoc.leadId) : undefined,
  });

  return {
    status: 200,
    found: true,
    email: tokenDoc.email,
  };
}

unsubscribeRouter.get('/:token', async (req: Request, res: Response) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const result = await handleUnsubscribeLookup(req.params.token, 'GET');
    if (result.status === 503) {
      res
        .status(503)
        .type('html')
        .send(
          renderUnsubscribeHtml({
            title: 'Temporarily Unavailable',
            heading: 'Service temporarily unavailable',
            body: 'Please retry this unsubscribe link in a moment.',
            statusOk: false,
          })
        );
      return;
    }

    if (!result.found) {
      res
        .status(404)
        .type('html')
        .send(
          renderUnsubscribeHtml({
            title: 'Invalid Unsubscribe Link',
            heading: 'Unsubscribe link not found',
            body: 'This unsubscribe link is invalid or no longer active.',
            statusOk: false,
          })
        );
      return;
    }

    res
      .status(200)
      .type('html')
      .send(
        renderUnsubscribeHtml({
          title: 'Unsubscribed',
          heading: 'You have been unsubscribed',
          body: 'Your email address has been removed from future outreach campaigns.',
          statusOk: true,
        })
      );
  } catch (err) {
    console.error('[Outreach Desk] GET /api/unsubscribe error:', err);
    res
      .status(500)
      .type('html')
      .send(
        renderUnsubscribeHtml({
          title: 'Unsubscribe Error',
          heading: 'Unable to process request',
          body: 'An unexpected error occurred while processing your request.',
          statusOk: false,
        })
      );
  }
});

unsubscribeRouter.post('/:token', async (req: Request, res: Response) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const result = await handleUnsubscribeLookup(req.params.token, 'POST');
    if (result.status === 503) {
      res.status(503).json({ error: result.error, code: 'DB_UNAVAILABLE' });
      return;
    }
    if (!result.found) {
      res.status(404).json({ error: result.error, code: 'INVALID_TOKEN' });
      return;
    }

    res.status(200).json({ ok: true, unsubscribed: true });
  } catch (err) {
    console.error('[Outreach Desk] POST /api/unsubscribe error:', err);
    res.status(500).json({
      error: 'Failed to process one-click unsubscribe request.',
      code: 'UNSUBSCRIBE_FAILED',
    });
  }
});
