import { z } from 'zod';
import { MAILBOX_SECURITY_MODES, type MailboxDocument } from '../models/index.ts';
import type { MailboxQuotaSnapshot } from './quotaManager.ts';
import type { SmtpSecurityMode } from './smtpSecurity.ts';

const baseMailboxSchema = {
  name: z
    .string()
    .trim()
    .min(1, 'Mailbox name is required.')
    .max(120, 'Mailbox name cannot exceed 120 characters.'),
  senderName: z
    .string()
    .trim()
    .min(1, 'Sender display name is required.')
    .max(120, 'Sender display name cannot exceed 120 characters.'),
  senderEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email('Please provide a valid sender email address.')
    .max(254, 'Sender email cannot exceed 254 characters.'),
  replyTo: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Reply-to email cannot exceed 254 characters.')
    .optional()
    .default('')
    .refine(
      (val) => !val || z.string().email().safeParse(val).success,
      'Please provide a valid reply-to email address.'
    ),
  smtpHost: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'SMTP hostname is required.')
    .max(253, 'SMTP hostname cannot exceed 253 characters.'),
  smtpPort: z.coerce
    .number()
    .int('SMTP port must be a whole number.')
    .min(1, 'SMTP port must be between 1 and 65535.')
    .max(65535, 'SMTP port must be between 1 and 65535.'),
  securityMode: z.enum(MAILBOX_SECURITY_MODES).optional(),
  smtpUsername: z
    .string()
    .trim()
    .min(1, 'SMTP username is required.')
    .max(254, 'SMTP username cannot exceed 254 characters.'),
  dailyLimit: z.coerce
    .number()
    .int('Daily sending limit must be a whole number.')
    .min(1, 'Daily sending limit must be at least 1.')
    .max(10000, 'Daily sending limit cannot exceed 10,000.')
    .optional()
    .default(50),
  enabled: z.boolean().optional().default(true),
};

export const createMailboxSchema = z.object({
  ...baseMailboxSchema,
  smtpPassword: z
    .string()
    .min(1, 'SMTP password is required.')
    .max(1024, 'SMTP password cannot exceed 1,024 characters.'),
});

export const updateMailboxSchema = z.object({
  name: baseMailboxSchema.name.optional(),
  senderName: baseMailboxSchema.senderName.optional(),
  senderEmail: baseMailboxSchema.senderEmail.optional(),
  replyTo: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Reply-to email cannot exceed 254 characters.')
    .optional()
    .refine(
      (val) => val === undefined || val === '' || z.string().email().safeParse(val).success,
      'Please provide a valid reply-to email address.'
    ),
  smtpHost: baseMailboxSchema.smtpHost.optional(),
  smtpPort: baseMailboxSchema.smtpPort.optional(),
  securityMode: z.enum(MAILBOX_SECURITY_MODES).optional(),
  smtpUsername: baseMailboxSchema.smtpUsername.optional(),
  smtpPassword: z
    .string()
    .max(1024, 'SMTP password cannot exceed 1,024 characters.')
    .optional(),
  dailyLimit: z.coerce
    .number()
    .int('Daily sending limit must be a whole number.')
    .min(1, 'Daily sending limit must be at least 1.')
    .max(10000, 'Daily sending limit cannot exceed 10,000.')
    .optional(),
  enabled: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export interface PublicMailboxItem {
  id: string;
  name: string;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  securityMode: SmtpSecurityMode;
  secure: boolean;
  dailyLimit: number;
  enabled: boolean;
  archived: boolean;
  archivedAt: string | null;
  verificationStatus: 'untested' | 'verified' | 'failed';
  lastTestedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationError: string;
  hasCredentials: boolean;
  referencedByHistory?: boolean;
  quota?: MailboxQuotaSnapshot;
  createdAt: string;
  updatedAt: string;
}

export function serializeMailbox(
  mailbox: MailboxDocument | (Record<string, unknown> & { _id: unknown }),
  options?: {
    hasCredentials?: boolean;
    referencedByHistory?: boolean;
    quota?: MailboxQuotaSnapshot;
  }
): PublicMailboxItem {
  const doc = mailbox as unknown as {
    _id: unknown;
    name: string;
    senderName: string;
    senderEmail: string;
    replyTo?: string;
    smtpHost: string;
    smtpPort: number;
    smtpUsername: string;
    securityMode?: SmtpSecurityMode;
    secure?: boolean;
    encryptedPassword?: { ciphertext?: string } | null;
    dailyLimit: number;
    enabled: boolean;
    archived?: boolean;
    archivedAt?: Date | null;
    verificationStatus?: 'untested' | 'verified' | 'failed';
    lastTestedAt?: Date | null;
    lastVerifiedAt?: Date | null;
    lastVerificationError?: string;
    createdAt: Date;
    updatedAt: Date;
  };

  const hasCredentials =
    options?.hasCredentials !== undefined
      ? options.hasCredentials
      : doc.encryptedPassword !== undefined
        ? Boolean(doc.encryptedPassword?.ciphertext)
        : true;

  return {
    id: String(doc._id),
    name: doc.name,
    senderName: doc.senderName,
    senderEmail: doc.senderEmail,
    replyTo: doc.replyTo || '',
    smtpHost: doc.smtpHost,
    smtpPort: doc.smtpPort,
    smtpUsername: doc.smtpUsername,
    securityMode: doc.securityMode ?? (doc.secure ? 'implicit_tls' : 'starttls'),
    secure: Boolean(doc.secure),
    dailyLimit: doc.dailyLimit,
    enabled: Boolean(doc.enabled),
    archived: Boolean(doc.archived),
    archivedAt: doc.archivedAt ? new Date(doc.archivedAt).toISOString() : null,
    verificationStatus: doc.verificationStatus ?? 'untested',
    lastTestedAt: doc.lastTestedAt ? new Date(doc.lastTestedAt).toISOString() : null,
    lastVerifiedAt: doc.lastVerifiedAt ? new Date(doc.lastVerifiedAt).toISOString() : null,
    lastVerificationError: doc.lastVerificationError || '',
    hasCredentials,
    ...(options?.referencedByHistory !== undefined
      ? { referencedByHistory: options.referencedByHistory }
      : {}),
    ...(options?.quota !== undefined ? { quota: options.quota } : {}),
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}
