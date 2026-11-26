import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getDatabaseStatus } from '../config/db.ts';
import { getEnvConfig } from '../config/env.ts';
import { LoginAttempt } from '../models/index.ts';

export interface AuthPayload {
  sub: string;
  role: 'owner';
  iat: number;
  exp: number;
  jti: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthPayload;
}

interface AttemptRecord {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number | null;
}

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

const attemptStore = new Map<string, AttemptRecord>();

const MAX_TRACKED_IPS = 5000;

export function getClientIp(req: Request): string {
  // Rely on Express req.ip (configured via app.set('trust proxy', 1)) so raw X-Forwarded-For cannot be spoofed
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function pruneStaleAttempts(now: number): void {
  for (const [ip, record] of attemptStore.entries()) {
    const expiredLock = record.lockedUntil !== null && record.lockedUntil <= now;
    const expiredWindow = record.lockedUntil === null && now - record.firstFailureAt > WINDOW_MS;
    if (expiredLock || expiredWindow) {
      attemptStore.delete(ip);
    }
  }
  while (attemptStore.size >= MAX_TRACKED_IPS) {
    const oldestKey = attemptStore.keys().next().value;
    if (!oldestKey) break;
    attemptStore.delete(oldestKey);
  }
}

export function checkLoginRateLimit(ip: string): {
  allowed: boolean;
  retryAfterSeconds: number;
  remainingAttempts: number;
} {
  const now = Date.now();
  pruneStaleAttempts(now);

  const record = attemptStore.get(ip);
  if (!record) {
    return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_FAILED_ATTEMPTS };
  }

  if (record.lockedUntil !== null && record.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, retryAfterSeconds, remainingAttempts: 0 };
  }

  if (now - record.firstFailureAt > WINDOW_MS) {
    attemptStore.delete(ip);
    return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_FAILED_ATTEMPTS };
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
    remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - record.failures),
  };
}

export function recordFailedLogin(ip: string): {
  locked: boolean;
  retryAfterSeconds: number;
  remainingAttempts: number;
} {
  const now = Date.now();
  const existing = attemptStore.get(ip);

  if (!existing || now - existing.firstFailureAt > WINDOW_MS) {
    attemptStore.set(ip, {
      failures: 1,
      firstFailureAt: now,
      lockedUntil: null,
    });
    return {
      locked: false,
      retryAfterSeconds: 0,
      remainingAttempts: MAX_FAILED_ATTEMPTS - 1,
    };
  }

  const failures = existing.failures + 1;
  const locked = failures >= MAX_FAILED_ATTEMPTS;
  const lockedUntil = locked ? now + LOCKOUT_MS : null;

  attemptStore.set(ip, {
    failures,
    firstFailureAt: existing.firstFailureAt,
    lockedUntil,
  });

  return {
    locked,
    retryAfterSeconds: locked ? Math.ceil(LOCKOUT_MS / 1000) : 0,
    remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - failures),
  };
}

export function resetLoginAttempts(ip: string): void {
  attemptStore.delete(ip);
}

export async function checkLoginRateLimitDb(ip: string): Promise<{
  allowed: boolean;
  retryAfterSeconds: number;
  remainingAttempts: number;
}> {
  if (!getDatabaseStatus().connected) {
    return checkLoginRateLimit(ip);
  }
  try {
    const now = Date.now();
    const record = await LoginAttempt.findOne({ ip }).lean();
    if (!record) {
      return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_FAILED_ATTEMPTS };
    }
    if (record.lockedUntil && record.lockedUntil.getTime() > now) {
      const retryAfterSeconds = Math.ceil((record.lockedUntil.getTime() - now) / 1000);
      return { allowed: false, retryAfterSeconds, remainingAttempts: 0 };
    }
    if (now - record.firstFailureAt.getTime() > WINDOW_MS) {
      await LoginAttempt.deleteOne({ ip }).catch(() => {});
      return { allowed: true, retryAfterSeconds: 0, remainingAttempts: MAX_FAILED_ATTEMPTS };
    }
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - record.failures),
    };
  } catch {
    return checkLoginRateLimit(ip);
  }
}

export async function recordFailedLoginDb(ip: string): Promise<{
  locked: boolean;
  retryAfterSeconds: number;
  remainingAttempts: number;
}> {
  if (!getDatabaseStatus().connected) {
    return recordFailedLogin(ip);
  }
  try {
    const now = new Date();
    const existing = await LoginAttempt.findOne({ ip });
    if (!existing || now.getTime() - existing.firstFailureAt.getTime() > WINDOW_MS) {
      await LoginAttempt.findOneAndUpdate(
        { ip },
        {
          $set: {
            failures: 1,
            firstFailureAt: now,
            lockedUntil: undefined,
            expiresAt: new Date(now.getTime() + WINDOW_MS + LOCKOUT_MS),
          },
          $setOnInsert: { ip },
        },
        { upsert: true }
      );
      return {
        locked: false,
        retryAfterSeconds: 0,
        remainingAttempts: MAX_FAILED_ATTEMPTS - 1,
      };
    }

    const failures = existing.failures + 1;
    const locked = failures >= MAX_FAILED_ATTEMPTS;
    const lockedUntil = locked ? new Date(now.getTime() + LOCKOUT_MS) : undefined;
    existing.failures = failures;
    existing.lockedUntil = lockedUntil;
    existing.expiresAt = new Date(now.getTime() + WINDOW_MS + LOCKOUT_MS);
    await existing.save();

    return {
      locked,
      retryAfterSeconds: locked ? Math.ceil(LOCKOUT_MS / 1000) : 0,
      remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - failures),
    };
  } catch {
    return recordFailedLogin(ip);
  }
}

export async function resetLoginAttemptsDb(ip: string): Promise<void> {
  attemptStore.delete(ip);
  if (!getDatabaseStatus().connected) return;
  try {
    await LoginAttempt.deleteOne({ ip });
  } catch {
    // Ignore DB cleanup errors on login success
  }
}

export function verifyAccessCode(inputCode: string, configuredCode: string): boolean {
  if (!configuredCode) return false;
  const inputHash = crypto.createHash('sha256').update(inputCode, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(configuredCode, 'utf8').digest();
  return crypto.timingSafeEqual(inputHash, expectedHash);
}

export class ProductionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionConfigError';
  }
}

export function signAuthToken(): { token: string; expiresInSeconds: number } {
  const { jwtSecret, hasPersistentJwtSecret, nodeEnv } = getEnvConfig();
  if (nodeEnv === 'production' && !hasPersistentJwtSecret) {
    throw new ProductionConfigError('JWT_SECRET must be configured in production.');
  }
  const expiresInSeconds = 24 * 60 * 60;
  const token = jwt.sign(
    {
      sub: 'owner',
      role: 'owner',
    },
    jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: expiresInSeconds,
      jwtid: crypto.randomUUID(),
    }
  );
  return { token, expiresInSeconds };
}

function extractCookieToken(req: Request): string | null {
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return null;
  const parts = rawCookie.split(';');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'od_session') {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const env = getEnvConfig();
  if (env.nodeEnv === 'production' && !env.hasPersistentJwtSecret) {
    res.status(503).json({
      error: 'Authentication signing secret is not configured for production.',
      code: 'AUTH_UNCONFIGURED',
    });
    return;
  }

  const authHeader = req.headers.authorization;
  let token: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    token = extractCookieToken(req);
  }

  if (!token) {
    res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
    return;
  }

  try {
    const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] }) as AuthPayload;
    if (!decoded || decoded.role !== 'owner') {
      res.status(401).json({ error: 'Invalid authentication token.', code: 'UNAUTHORIZED' });
      return;
    }
    req.auth = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired or invalid.', code: 'UNAUTHORIZED' });
  }
}
