import { z } from 'zod';
import type { EmailMessageDocument } from '../models/index.ts';

const HEADER_INJECTION_REGEX = /[\r\n\0]/;
const SINGLE_EMAIL_REGEX = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function hasHeaderInjection(value: string): boolean {
  return HEADER_INJECTION_REGEX.test(value);
}

const singleAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Recipient email address is required.')
  .max(254, 'Email address cannot exceed 254 characters.')
  .refine((val) => !hasHeaderInjection(val), 'Invalid characters in email address.')
  .refine(
    (val) => SINGLE_EMAIL_REGEX.test(val) && z.string().email().safeParse(val).success,
    'Please provide a single valid email address.'
  );

export const sendEmailSchema = z
  .object({
    mailboxId: z.string().trim().min(1, 'Sender mailbox is required.'),
    to: singleAddressSchema,
    subject: z
      .string()
      .trim()
      .min(1, 'Email subject is required.')
      .max(250, 'Subject cannot exceed 250 characters.')
      .refine((val) => !hasHeaderInjection(val), 'Invalid line breaks in email subject.'),
    text: z.string().max(100000, 'Plain text body is too large.').optional().default(''),
    html: z.string().max(250000, 'HTML body is too large.').optional().default(''),
    replyTo: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, 'Reply-to address cannot exceed 254 characters.')
      .optional()
      .default('')
      .refine((val) => !val || !hasHeaderInjection(val), 'Invalid characters in reply-to address.')
      .refine(
        (val) =>
          !val ||
          (SINGLE_EMAIL_REGEX.test(val) && z.string().email().safeParse(val).success),
        'Reply-to must be a valid email address.'
      ),
    idempotencyKey: z
      .string()
      .trim()
      .max(128, 'Idempotency key cannot exceed 128 characters.')
      .optional()
      .default('')
      .refine((val) => !val || !hasHeaderInjection(val), 'Invalid idempotency key.'),
    leadId: z.string().trim().max(64).optional(),
    threadWithPrevious: z.boolean().optional().default(false),
    inReplyTo: z
      .string()
      .trim()
      .max(500)
      .optional()
      .refine((val) => !val || !hasHeaderInjection(val), 'Invalid In-Reply-To header.'),
  })
  .superRefine((data, ctx) => {
    const hasText = data.text.trim().length > 0;
    const hasHtml = stripHtmlTags(data.html).trim().length > 0;
    if (!hasText && !hasHtml) {
      ctx.addIssue({
        code: 'custom',
        message: 'Email body is required (provide plain text or HTML content).',
        path: ['text'],
      });
    }
  });

export function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeHeaderDisplayName(value: string): string {
  return value.replace(/[\r\n\0"]/g, ' ').replace(/\s+/g, ' ').trim();
}

export type NormalizedEmailStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'bounced'
  | 'cancelled';

export function normalizeEmailStatus(raw: string): NormalizedEmailStatus {
  const lower = raw.trim().toLowerCase();
  switch (lower) {
    case 'queued':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    case 'bounced':
      return 'bounced';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export interface SerializedEmailHistoryItem {
  id: string;
  mailboxId: string;
  mailboxName: string;
  leadId: string | null;
  campaignId: string | null;
  campaignRecipientId: string | null;
  direction: 'outbound' | 'inbound';
  status: NormalizedEmailStatus;
  toEmail: string;
  fromEmail: string;
  replyTo: string | null;
  subject: string;
  hasHtml: boolean;
  hasText: boolean;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadId: string;
  bounceType: 'hard' | 'soft' | 'unknown' | null;
  attempts: number;
  error: string | null;
  errorCode: string | null;
  attemptMeta: {
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    smtpResponseCode: number | null;
    acceptedCount: number | null;
    rejectedCount: number | null;
    ambiguous: boolean;
  } | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeEmailHistoryItem(
  doc: EmailMessageDocument | (Record<string, unknown> & { _id: unknown }),
  mailboxNameLookup?: Map<string, string>
): SerializedEmailHistoryItem {
  const m = doc as unknown as {
    _id: unknown;
    mailboxId: string;
    mailboxName?: string;
    leadId?: unknown;
    campaignId?: unknown;
    campaignRecipientId?: unknown;
    direction: 'outbound' | 'inbound';
    status: string;
    toEmail: string;
    fromEmail: string;
    replyTo?: string;
    subject: string;
    bodyHtml?: string;
    bodyText?: string;
    hasHtml?: boolean;
    hasText?: boolean;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    threadId: string;
    bounceType?: 'hard' | 'soft' | 'unknown';
    attempts?: number;
    error?: string;
    errorCode?: string;
    attemptMeta?: {
      startedAt?: Date;
      completedAt?: Date;
      durationMs?: number;
      smtpResponseCode?: number;
      acceptedCount?: number;
      rejectedCount?: number;
      ambiguous?: boolean;
    };
    sentAt?: Date;
    createdAt: Date;
    updatedAt?: Date;
  };

  const resolvedMailboxName =
    m.mailboxName || mailboxNameLookup?.get(m.mailboxId) || m.fromEmail || m.mailboxId;

  return {
    id: String(m._id),
    mailboxId: m.mailboxId,
    mailboxName: resolvedMailboxName,
    leadId: m.leadId ? String(m.leadId) : null,
    campaignId: m.campaignId ? String(m.campaignId) : null,
    campaignRecipientId: m.campaignRecipientId ? String(m.campaignRecipientId) : null,
    direction: m.direction,
    status: normalizeEmailStatus(m.status),
    toEmail: m.toEmail,
    fromEmail: m.fromEmail,
    replyTo: m.replyTo || null,
    subject: m.subject,
    hasHtml: Boolean(m.hasHtml || m.bodyHtml),
    hasText: Boolean(m.hasText || m.bodyText),
    messageId: m.messageId || null,
    inReplyTo: m.inReplyTo || null,
    references: Array.isArray(m.references) ? m.references : [],
    threadId: m.threadId,
    bounceType: m.bounceType ?? null,
    attempts: m.attempts ?? 1,
    error: m.error || null,
    errorCode: m.errorCode || null,
    attemptMeta: m.attemptMeta
      ? {
          startedAt: m.attemptMeta.startedAt
            ? new Date(m.attemptMeta.startedAt).toISOString()
            : null,
          completedAt: m.attemptMeta.completedAt
            ? new Date(m.attemptMeta.completedAt).toISOString()
            : null,
          durationMs:
            typeof m.attemptMeta.durationMs === 'number' ? m.attemptMeta.durationMs : null,
          smtpResponseCode:
            typeof m.attemptMeta.smtpResponseCode === 'number'
              ? m.attemptMeta.smtpResponseCode
              : null,
          acceptedCount:
            typeof m.attemptMeta.acceptedCount === 'number'
              ? m.attemptMeta.acceptedCount
              : null,
          rejectedCount:
            typeof m.attemptMeta.rejectedCount === 'number'
              ? m.attemptMeta.rejectedCount
              : null,
          ambiguous: Boolean(m.attemptMeta.ambiguous),
        }
      : null,
    sentAt: m.sentAt ? new Date(m.sentAt).toISOString() : null,
    createdAt: new Date(m.createdAt).toISOString(),
    updatedAt: m.updatedAt
      ? new Date(m.updatedAt).toISOString()
      : new Date(m.createdAt).toISOString(),
  };
}
