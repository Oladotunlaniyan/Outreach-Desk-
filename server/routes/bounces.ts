import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import { EmailMessage } from '../models/index.ts';
import { processHardBounce } from '../utils/bounceProcessor.ts';
import { logEvent } from '../utils/logger.ts';

export const bouncesRouter = Router();

const bounceEventSchema = z.object({
  email: z.string().trim().toLowerCase().email('Valid email is required.').max(254),
  bounceType: z.enum(['hard', 'soft']).default('hard'),
  reason: z.string().trim().max(500).optional().default('Hard bounce reported'),
  messageId: z.string().trim().max(500).optional(),
  emailMessageId: z.string().trim().max(64).optional(),
  source: z.enum(['webhook', 'manual', 'smtp_5xx']).optional().default('webhook'),
});

const bounceRequestSchema = z.union([
  bounceEventSchema,
  z.object({
    events: z.array(bounceEventSchema).min(1).max(200),
  }),
]);

export function authenticateBounceRequest(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  const configuredSecret = (process.env.BOUNCE_WEBHOOK_SECRET || '').trim();
  const providedSecret = (req.header('x-bounce-secret') || '').trim();

  if (providedSecret) {
    if (!configuredSecret) {
      logEvent('warn', 'bounce.webhook_unconfigured');
      res.status(403).json({
        error: 'Bounce webhook endpoint is not configured for shared-secret requests (BOUNCE_WEBHOOK_SECRET unset).',
        code: 'WEBHOOK_UNCONFIGURED',
      });
      return;
    }

    const a = Buffer.from(configuredSecret);
    const b = Buffer.from(providedSecret);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      next();
      return;
    }
    logEvent('warn', 'bounce.webhook_unauthorized');
    res.status(401).json({ error: 'Invalid bounce webhook secret.', code: 'UNAUTHORIZED' });
    return;
  }

  requireAuth(req, res, next);
}

bouncesRouter.use(authenticateBounceRequest);
bouncesRouter.use((_req: Request, res: Response, next: NextFunction) => {
  const db = getDatabaseStatus();
  if (!db.connected) {
    res.status(503).json({
      error: db.lastError || 'MongoDB Atlas is not connected.',
      code: 'DB_UNAVAILABLE',
    });
    return;
  }
  next();
});

bouncesRouter.post('/process', async (req, res) => {
  const parsed = bounceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid bounce payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const events = 'events' in parsed.data ? parsed.data.events : [parsed.data];

  try {
    const results: Array<{
      email: string;
      bounceType: 'hard' | 'soft';
      suppressed: boolean;
      skippedRecipientsCount: number;
    }> = [];

    let hardCount = 0;
    let softCount = 0;

    for (const evt of events) {
      if (evt.bounceType === 'hard') {
        hardCount += 1;
        const resHard = await processHardBounce({
          email: evt.email,
          reason: evt.reason,
          source: evt.source,
          emailMessageId: evt.emailMessageId,
          smtpMessageId: evt.messageId,
        });
        results.push({
          email: resHard.email,
          bounceType: 'hard',
          suppressed: resHard.suppressed,
          skippedRecipientsCount: resHard.skippedRecipientsCount,
        });
      } else {
        softCount += 1;
        if (evt.messageId) {
          await EmailMessage.updateOne(
            { messageId: evt.messageId },
            {
              $set: {
                bounceType: 'soft',
                error: evt.reason,
              },
            }
          );
        }
        results.push({
          email: evt.email,
          bounceType: 'soft',
          suppressed: false,
          skippedRecipientsCount: 0,
        });
      }
    }

    logEvent('info', 'bounce.processed', {
      processedCount: results.length,
      hardCount,
      softCount,
    });

    res.json({
      ok: true,
      processedCount: results.length,
      results,
    });
  } catch (err) {
    logEvent('error', 'bounce.process_failed', { error: err });
    res.status(500).json({
      error: 'Failed to process bounce notification.',
      code: 'BOUNCE_PROCESS_FAILED',
    });
  }
});
