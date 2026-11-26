import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import {
  checkAiRateLimit,
  getAiUsageSummary,
  recordAiRateLimitHit,
} from '../utils/aiUsageTracker.ts';
import {
  DeepSeekClientError,
  getDeepSeekStatus,
} from '../utils/deepseekClient.ts';
import {
  EmailGeneratorValidationError,
  generateCtaSuggestions,
  generatePersonalizedEmail,
  generateSubjectLineSuggestions,
  rewriteEmailDraft,
} from '../utils/emailGenerator.ts';

export const aiRouter = Router();

aiRouter.use(requireAuth);

function enforceAiRateLimit(_req: Request, res: Response, next: NextFunction): void {
  const status = checkAiRateLimit();
  if (!status.allowed) {
    res.setHeader('Retry-After', String(status.retryAfterSeconds));
    res.status(429).json({
      error: `AI generation rate limit reached. Please wait ${status.retryAfterSeconds} seconds before trying again.`,
      code: 'AI_RATE_LIMITED',
      retryAfterSeconds: status.retryAfterSeconds,
    });
    return;
  }
  recordAiRateLimitHit();
  next();
}

function handleAiError(res: Response, err: unknown): void {
  if (err instanceof EmailGeneratorValidationError) {
    res.status(err.httpStatus).json({
      error: err.message,
      code: err.code,
    });
    return;
  }

  if (err instanceof DeepSeekClientError) {
    if (err.retryAfterSeconds) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }
    res.status(err.httpStatus).json({
      error: err.message,
      code: err.code,
      ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    });
    return;
  }

  console.error('[Outreach Desk] Unexpected AI route error:', err instanceof Error ? err.message : 'Unknown error');
  res.status(500).json({
    error: 'Unable to complete AI request due to an unexpected server error.',
    code: 'AI_INTERNAL_ERROR',
  });
}

aiRouter.get('/status', async (req, res) => {
  const probe = req.query.probe === 'true';
  try {
    const [status, usageToday] = await Promise.all([
      getDeepSeekStatus({ probe }),
      getAiUsageSummary().catch(() => null),
    ]);
    res.json({
      ...status,
      usageToday,
    });
  } catch (err) {
    handleAiError(res, err);
  }
});

aiRouter.post('/email/generate', enforceAiRateLimit, async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const draft = await generatePersonalizedEmail(req.body, {
      signal: controller.signal,
    });
    res.json({ ok: true, draft });
  } catch (err) {
    handleAiError(res, err);
  }
});

aiRouter.post('/email/rewrite', enforceAiRateLimit, async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const draft = await rewriteEmailDraft(req.body, {
      signal: controller.signal,
    });
    res.json({ ok: true, draft });
  } catch (err) {
    handleAiError(res, err);
  }
});

aiRouter.post('/email/subject-lines', enforceAiRateLimit, async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const result = await generateSubjectLineSuggestions(req.body, {
      signal: controller.signal,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    handleAiError(res, err);
  }
});

aiRouter.post('/email/cta', enforceAiRateLimit, async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const result = await generateCtaSuggestions(req.body, {
      signal: controller.signal,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    handleAiError(res, err);
  }
});
