import crypto from 'node:crypto';

export interface SmtpMailboxConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  dailyLimit: number;
}

export interface PublicMailboxSummary {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  fromName: string;
  fromEmail: string;
  dailyLimit: number;
  configured: boolean;
}

const fallbackJwtSecret = crypto.randomBytes(32).toString('hex');
let warnedMissingJwtSecret = false;

function cleanEnv(value: string | undefined): string {
  const trimmed = value?.trim() || '';
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function getEnvConfig() {
  const jwtSecret = cleanEnv(process.env.JWT_SECRET);
  const nodeEnv = cleanEnv(process.env.NODE_ENV) || 'development';
  if (!jwtSecret && !warnedMissingJwtSecret) {
    warnedMissingJwtSecret = true;
    console.warn(
      '[Outreach Desk] JWT_SECRET is not set. Using an ephemeral runtime secret; tokens will reset on server restart.'
    );
  }

  const rawDeepseekBaseUrl = cleanEnv(process.env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com';
  const deepseekBaseUrl = rawDeepseekBaseUrl.replace(/\/+$/, '');
  const rawTimeout = Number(cleanEnv(process.env.DEEPSEEK_TIMEOUT_MS));
  const deepseekTimeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= 5000 && rawTimeout <= 60000
      ? Math.round(rawTimeout)
      : 25000;

  return {
    nodeEnv,
    port: Number(cleanEnv(process.env.PORT)) || 3000,
    mongodbUri: cleanEnv(process.env.MONGODB_URI),
    accessCode: cleanEnv(process.env.ACCESS_CODE),
    jwtSecret: jwtSecret || fallbackJwtSecret,
    hasPersistentJwtSecret: Boolean(jwtSecret),
    mailboxEncryptionKey: cleanEnv(process.env.MAILBOX_ENCRYPTION_KEY),
    bounceWebhookSecret: cleanEnv(process.env.BOUNCE_WEBHOOK_SECRET),
    geminiApiKey: cleanEnv(process.env.GEMINI_API_KEY),
    deepseekApiKey:
      cleanEnv(process.env.DEEPSEEK_API_KEY) ||
      cleanEnv(process.env.DEEPSEEK_KEY) ||
      cleanEnv(process.env.DEEPSEEK_API) ||
      cleanEnv(process.env.VITE_DEEPSEEK_API_KEY),
    deepseekModel: cleanEnv(process.env.DEEPSEEK_MODEL) || 'deepseek-chat',
    deepseekBaseUrl,
    deepseekTimeoutMs,
    appUrl: cleanEnv(process.env.APP_URL) || 'http://localhost:3000',
    hasExplicitAppUrl: Boolean(cleanEnv(process.env.APP_URL)),
  };
}

export interface ProductionReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  severity: 'required' | 'recommended';
  message: string;
}

export interface ProductionReadinessReport {
  nodeEnv: string;
  readyForProduction: boolean;
  checks: ProductionReadinessCheck[];
}

export function isValidHttpsPublicUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isValidBase64Aes256Key(rawKey: string): boolean {
  if (!rawKey.trim()) return false;
  try {
    return Buffer.from(rawKey.trim(), 'base64').length === 32;
  } catch {
    return false;
  }
}

export function getProductionReadinessReport(
  overrides?: Partial<{
    nodeEnv: string;
    mongodbUri: string;
    accessCode: string;
    hasPersistentJwtSecret: boolean;
    jwtSecretLength: number;
    mailboxEncryptionKey: string;
    appUrl: string;
    bounceWebhookSecret: string;
  }>
): ProductionReadinessReport {
  const env = getEnvConfig();
  const nodeEnv = overrides?.nodeEnv ?? env.nodeEnv;
  const mongodbUri = overrides?.mongodbUri ?? env.mongodbUri;
  const accessCode = overrides?.accessCode ?? env.accessCode;
  const hasPersistentJwtSecret =
    overrides?.hasPersistentJwtSecret ?? env.hasPersistentJwtSecret;
  const jwtSecretLength = overrides?.jwtSecretLength ?? (process.env.JWT_SECRET?.trim().length || 0);
  const mailboxEncryptionKey = overrides?.mailboxEncryptionKey ?? env.mailboxEncryptionKey;
  const appUrl = overrides?.appUrl ?? env.appUrl;
  const bounceWebhookSecret = overrides?.bounceWebhookSecret ?? env.bounceWebhookSecret;

  const mongoValid = /^mongodb(\+srv)?:\/\//i.test(mongodbUri);
  const accessCodeValid = accessCode.length >= 8;
  const jwtValid = hasPersistentJwtSecret && jwtSecretLength >= 32;
  const encryptionValid = isValidBase64Aes256Key(mailboxEncryptionKey);
  const appUrlHttpsValid = isValidHttpsPublicUrl(appUrl);
  const bounceSecretValid = bounceWebhookSecret.length >= 16;

  const checks: ProductionReadinessCheck[] = [
    {
      key: 'MONGODB_URI',
      label: 'MongoDB Atlas URI',
      ok: mongoValid,
      severity: 'required',
      message: mongoValid
        ? 'Configured with valid MongoDB URI scheme.'
        : 'MONGODB_URI is missing or does not start with mongodb:// or mongodb+srv://.',
    },
    {
      key: 'ACCESS_CODE',
      label: 'Owner access code',
      ok: accessCodeValid,
      severity: 'required',
      message: accessCodeValid
        ? 'Configured (8+ characters).'
        : 'ACCESS_CODE is missing or shorter than 8 characters.',
    },
    {
      key: 'JWT_SECRET',
      label: 'Persistent JWT signing secret',
      ok: jwtValid,
      severity: 'required',
      message: jwtValid
        ? 'Persistent JWT_SECRET configured (32+ chars).'
        : 'JWT_SECRET must be persistently configured (32+ chars); ephemeral secrets fail closed in production.',
    },
    {
      key: 'MAILBOX_ENCRYPTION_KEY',
      label: 'AES-256-GCM mailbox encryption key',
      ok: encryptionValid,
      severity: 'required',
      message: encryptionValid
        ? 'Valid 32-byte Base64 key configured.'
        : 'MAILBOX_ENCRYPTION_KEY is missing or is not a valid 32-byte Base64 secret.',
    },
    {
      key: 'APP_URL',
      label: 'Public HTTPS APP_URL (List-Unsubscribe)',
      ok: appUrlHttpsValid,
      severity: 'required',
      message: appUrlHttpsValid
        ? 'Valid public HTTPS origin configured.'
        : 'APP_URL must be a public https:// origin (not localhost/http) in production for RFC 8058 unsubscribe headers.',
    },
    {
      key: 'BOUNCE_WEBHOOK_SECRET',
      label: 'Bounce webhook shared secret',
      ok: bounceSecretValid,
      severity: 'recommended',
      message: bounceSecretValid
        ? 'Configured for authenticated x-bounce-secret webhook calls.'
        : 'Optional unless external ESP webhooks call /api/bounces/process; session auth still works.',
    },
  ];

  const readyForProduction = checks
    .filter((c) => c.severity === 'required')
    .every((c) => c.ok);

  return {
    nodeEnv,
    readyForProduction,
    checks,
  };
}

export function getMailboxConfigs(): SmtpMailboxConfig[] {
  const mailboxes: SmtpMailboxConfig[] = [];

  for (let i = 1; i <= 10; i += 1) {
    const prefix = `SMTP_MAILBOX_${i}_`;
    const host = process.env[`${prefix}HOST`]?.trim();
    const user = process.env[`${prefix}USER`]?.trim();
    const pass = process.env[`${prefix}PASS`]?.trim();
    const fromEmail = process.env[`${prefix}FROM_EMAIL`]?.trim();

    if (!host && !user && !fromEmail) {
      continue;
    }

    const id = process.env[`${prefix}ID`]?.trim() || `mailbox-${i}`;
    const label = process.env[`${prefix}LABEL`]?.trim() || `Mailbox ${i}`;
    const port = Number(process.env[`${prefix}PORT`]) || 587;
    const secure = process.env[`${prefix}SECURE`]?.trim().toLowerCase() === 'true' || port === 465;
    const fromName = process.env[`${prefix}FROM_NAME`]?.trim() || label;
    const dailyLimitRaw = Number(process.env[`${prefix}DAILY_LIMIT`]);
    const dailyLimit = Number.isFinite(dailyLimitRaw) && dailyLimitRaw > 0 ? dailyLimitRaw : 50;

    mailboxes.push({
      id,
      label,
      host: host || '',
      port,
      secure,
      user: user || '',
      pass: pass || '',
      fromName,
      fromEmail: fromEmail || user || '',
      dailyLimit,
    });
  }

  return mailboxes;
}

export function getPublicMailboxSummaries(): PublicMailboxSummary[] {
  return getMailboxConfigs().map((m) => ({
    id: m.id,
    label: m.label,
    host: m.host,
    port: m.port,
    secure: m.secure,
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    dailyLimit: m.dailyLimit,
    configured: Boolean(m.host && m.user && m.pass && m.fromEmail),
  }));
}
