import crypto from 'node:crypto';
import { getEnvConfig } from '../config/env.ts';

export const MAILBOX_ENCRYPTION_VERSION = 'aes-256-gcm-v1' as const;
const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;

const BASE64_STRICT_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

export interface EncryptedMailboxCredential {
  version: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface MailboxEncryptionStatus {
  configured: boolean;
  valid: boolean;
  error: string | null;
}

export class MailboxEncryptionError extends Error {
  readonly code: 'KEY_NOT_CONFIGURED' | 'KEY_INVALID' | 'DECRYPT_FAILED';

  constructor(
    code: 'KEY_NOT_CONFIGURED' | 'KEY_INVALID' | 'DECRYPT_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'MailboxEncryptionError';
    this.code = code;
  }
}

export function validateMailboxEncryptionKey(
  rawKeyOverride?: string
): { valid: true; key: Buffer } | { valid: false; configured: boolean; code: 'KEY_NOT_CONFIGURED' | 'KEY_INVALID'; error: string } {
  const raw = (rawKeyOverride ?? getEnvConfig().mailboxEncryptionKey).trim();
  if (!raw) {
    return {
      valid: false,
      configured: false,
      code: 'KEY_NOT_CONFIGURED',
      error:
        'MAILBOX_ENCRYPTION_KEY is not configured. Set a Base64-encoded 32-byte key in server secrets to manage or test SMTP credentials.',
    };
  }

  if (!BASE64_STRICT_REGEX.test(raw)) {
    return {
      valid: false,
      configured: true,
      code: 'KEY_INVALID',
      error:
        'MAILBOX_ENCRYPTION_KEY must be valid Base64 encoding of exactly 32 random bytes.',
    };
  }

  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== AES_256_KEY_BYTES) {
    return {
      valid: false,
      configured: true,
      code: 'KEY_INVALID',
      error: `MAILBOX_ENCRYPTION_KEY decoded to ${decoded.length} bytes; AES-256-GCM requires exactly ${AES_256_KEY_BYTES} bytes.`,
    };
  }

  // Verify round-trip canonical base64 so trailing non-zero padding bits cannot slip through
  if (decoded.toString('base64') !== raw) {
    return {
      valid: false,
      configured: true,
      code: 'KEY_INVALID',
      error:
        'MAILBOX_ENCRYPTION_KEY is not a canonical Base64-encoded 32-byte key.',
    };
  }

  return { valid: true, key: decoded };
}

export function getMailboxEncryptionStatus(rawKeyOverride?: string): MailboxEncryptionStatus {
  const result = validateMailboxEncryptionKey(rawKeyOverride);
  if (result.valid) {
    return { configured: true, valid: true, error: null };
  }
  return {
    configured: result.configured,
    valid: false,
    error: result.error,
  };
}

function getValidatedKeyOrThrow(rawKeyOverride?: string): Buffer {
  const check = validateMailboxEncryptionKey(rawKeyOverride);
  if (!check.valid) {
    throw new MailboxEncryptionError(check.code, check.error);
  }
  return check.key;
}

export function encryptMailboxSecret(
  plaintext: string,
  aadContext: string,
  rawKeyOverride?: string
): EncryptedMailboxCredential {
  if (!plaintext) {
    throw new Error('SMTP password cannot be empty.');
  }
  const normalizedAad = aadContext.trim();
  if (!normalizedAad) {
    throw new Error('Additional authenticated data context is required.');
  }

  const key = getValidatedKeyOrThrow(rawKeyOverride);
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });

  cipher.setAAD(Buffer.from(normalizedAad, 'utf8'));

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: MAILBOX_ENCRYPTION_VERSION,
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptMailboxSecret(
  credential: EncryptedMailboxCredential,
  aadContext: string,
  rawKeyOverride?: string
): string {
  const key = getValidatedKeyOrThrow(rawKeyOverride);

  if (!credential || credential.version !== MAILBOX_ENCRYPTION_VERSION) {
    throw new MailboxEncryptionError(
      'DECRYPT_FAILED',
      'Unsupported or missing credential encryption format.'
    );
  }

  const normalizedAad = aadContext.trim();
  if (!normalizedAad) {
    throw new MailboxEncryptionError(
      'DECRYPT_FAILED',
      'Missing mailbox authentication context.'
    );
  }

  try {
    const iv = Buffer.from(credential.iv, 'base64');
    const authTag = Buffer.from(credential.authTag, 'base64');
    const ciphertext = Buffer.from(credential.ciphertext, 'base64');

    if (iv.length !== GCM_IV_BYTES || authTag.length !== GCM_AUTH_TAG_BYTES) {
      throw new MailboxEncryptionError(
        'DECRYPT_FAILED',
        'Stored SMTP credential integrity parameters are invalid.'
      );
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: GCM_AUTH_TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(normalizedAad, 'utf8'));
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    if (err instanceof MailboxEncryptionError) {
      throw err;
    }
    throw new MailboxEncryptionError(
      'DECRYPT_FAILED',
      'Unable to decrypt stored SMTP credentials. Verify MAILBOX_ENCRYPTION_KEY matches the key used to save this mailbox.'
    );
  }
}
