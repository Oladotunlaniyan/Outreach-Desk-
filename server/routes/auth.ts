import { Router } from 'express';
import { z } from 'zod';
import { getDatabaseStatus } from '../config/db.ts';
import { getEnvConfig } from '../config/env.ts';
import {
  checkLoginRateLimitDb,
  getClientIp,
  recordFailedLoginDb,
  requireAuth,
  resetLoginAttemptsDb,
  signAuthToken,
  verifyAccessCode,
  type AuthenticatedRequest,
} from '../middleware/auth.ts';
import { logEvent } from '../utils/logger.ts';

const loginSchema = z.object({
  accessCode: z.string().min(1, 'Access code is required.').max(256),
});

export const authRouter = Router();

authRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

authRouter.get('/status', (_req, res) => {
  const env = getEnvConfig();
  const db = getDatabaseStatus();

  res.json({
    accessCodeConfigured: Boolean(env.accessCode),
    dbConfigured: db.configured,
    dbConnected: db.connected,
    dbState: db.state,
    geminiConfigured: Boolean(env.geminiApiKey),
    deepseekConfigured: Boolean(env.deepseekApiKey),
  });
});

authRouter.post('/login', async (req, res) => {
  const ip = getClientIp(req);
  const rateLimit = await checkLoginRateLimitDb(ip);

  if (!rateLimit.allowed) {
    logEvent('warn', 'auth.login_rate_limited', { ip, retryAfterSeconds: rateLimit.retryAfterSeconds });
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({
      error: `Too many failed login attempts. Try again in ${Math.ceil(rateLimit.retryAfterSeconds / 60)} minute(s).`,
      code: 'RATE_LIMITED',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const env = getEnvConfig();
  if (!env.accessCode) {
    res.status(503).json({
      error: 'ACCESS_CODE is not configured on the server.',
      code: 'AUTH_UNCONFIGURED',
    });
    return;
  }

  if (env.nodeEnv === 'production' && !env.hasPersistentJwtSecret) {
    logEvent('error', 'auth.production_jwt_missing');
    res.status(503).json({
      error: 'JWT_SECRET must be configured on the server in production.',
      code: 'AUTH_UNCONFIGURED',
    });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid login request.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const valid = verifyAccessCode(parsed.data.accessCode, env.accessCode);
  if (!valid) {
    const failureState = await recordFailedLoginDb(ip);
    if (failureState.locked) {
      logEvent('warn', 'auth.login_locked', { ip, retryAfterSeconds: failureState.retryAfterSeconds });
      res.setHeader('Retry-After', String(failureState.retryAfterSeconds));
      res.status(429).json({
        error: 'Too many failed login attempts. Access temporarily locked for 15 minutes.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: failureState.retryAfterSeconds,
      });
      return;
    }

    logEvent('warn', 'auth.login_failed', { ip, remainingAttempts: failureState.remainingAttempts });
    res.status(401).json({
      error: `Invalid access code. ${failureState.remainingAttempts} attempt(s) remaining before temporary lockout.`,
      code: 'INVALID_ACCESS_CODE',
      remainingAttempts: failureState.remainingAttempts,
    });
    return;
  }

  await resetLoginAttemptsDb(ip);
  const { token, expiresInSeconds } = signAuthToken();
  logEvent('info', 'auth.login_succeeded', { ip });

  res.cookie('od_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.nodeEnv === 'production',
    maxAge: expiresInSeconds * 1000,
    path: '/',
  });

  res.json({
    token,
    expiresInSeconds,
    role: 'owner',
  });
});

authRouter.get('/session', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({
    authenticated: true,
    role: req.auth?.role || 'owner',
    expiresAt: req.auth?.exp ? new Date(req.auth.exp * 1000).toISOString() : null,
  });
});

authRouter.post('/logout', (req, res) => {
  logEvent('info', 'auth.logout', { ip: getClientIp(req) });
  res.clearCookie('od_session', { path: '/' });
  res.json({ ok: true });
});
