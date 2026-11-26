const SENSITIVE_KEY_PATTERN =
  /^(pass|password|smtpPassword|encryptedPassword|secret|bounceWebhookSecret|jwtSecret|accessCode|token|rawToken|tokenHash|encryptionKey|mailboxEncryptionKey|apiKey|deepseekApiKey|geminiApiKey|authorization|cookie|set-cookie|body|bodyHtml|bodyText|html|text|headers|auth|iv|tag|ciphertext)$/i;

function sanitizeString(value: string): string {
  return value
    .replace(/(\/api\/unsubscribe\/)[^\s?#]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1[REDACTED]');
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[MAX_DEPTH]';

  if (typeof value === 'string') {
    const cleaned = sanitizeString(value);
    return cleaned.length > 400 ? `${cleaned.slice(0, 400)}...` : cleaned;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return out;
  }

  return String(value);
}

export type LogLevel = 'info' | 'warn' | 'error';

export function logEvent(
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>
): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (sanitizeLogValue(fields) as Record<string, unknown>) : {}),
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
