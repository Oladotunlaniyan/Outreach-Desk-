import mongoose from 'mongoose';
import { z } from 'zod';
import {
  CAMPAIGN_RECIPIENT_STATUSES,
  CAMPAIGN_STATUSES,
  Campaign,
  CampaignRecipient,
  type CampaignDocument,
  type CampaignRecipientDocument,
  type CampaignRecipientStatus,
  type CampaignStatus,
} from '../models/index.ts';

const HEADER_INJECTION_REGEX = /[\r\n\0]/;

export const campaignSendConfigSchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(50).default(8),
  delayMs: z.coerce.number().int().min(250).max(30000).default(1500),
  concurrency: z.coerce.number().int().min(1).max(3).default(1),
  dailySendCap: z
    .union([z.coerce.number().int().min(1).max(10000), z.null(), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  threadFollowUps: z.boolean().optional().default(true),
});

export const campaignRecipientInputSchema = z.object({
  leadId: z.string().trim().max(64).optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Recipient email must be valid.')
    .max(254),
  firstName: z.string().trim().max(120).optional().default(''),
  lastName: z.string().trim().max(120).optional().default(''),
  fullName: z.string().trim().max(160).optional().default(''),
  company: z.string().trim().max(160).optional().default(''),
  role: z.string().trim().max(160).optional().default(''),
  website: z.string().trim().max(500).optional().default(''),
  location: z.string().trim().max(160).optional().default(''),
  industry: z.string().trim().max(160).optional().default(''),
  customFields: z.record(z.string(), z.string().max(1000)).optional().default({}),
  customSubject: z
    .string()
    .trim()
    .max(300)
    .optional()
    .default('')
    .refine((val) => !HEADER_INJECTION_REGEX.test(val), 'Invalid line breaks in subject.'),
  customBodyText: z.string().max(100000).optional().default(''),
  customBodyHtml: z.string().max(250000).optional().default(''),
});

export const createCampaignSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Campaign name is required.')
    .max(160, 'Campaign name cannot exceed 160 characters.'),
  description: z.string().trim().max(1000).optional().default(''),
  mailboxId: z.string().trim().min(1, 'Sender mailbox is required.'),
  replyTo: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .optional()
    .default('')
    .refine(
      (val) => !val || z.string().email().safeParse(val).success,
      'Reply-To must be a valid email address.'
    ),
  subjectTemplate: z
    .string()
    .trim()
    .max(300)
    .optional()
    .default('')
    .refine(
      (val) => !HEADER_INJECTION_REGEX.test(val),
      'Invalid line breaks in subject template.'
    ),
  bodyTextTemplate: z.string().max(100000).optional().default(''),
  bodyHtmlTemplate: z.string().max(250000).optional().default(''),
  sendConfig: campaignSendConfigSchema.optional(),
  leadIds: z.array(z.string().trim().max(64)).max(5000).optional(),
  recipients: z.array(campaignRecipientInputSchema).max(5000).optional(),
});

export const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).optional(),
  mailboxId: z.string().trim().min(1).optional(),
  replyTo: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .optional()
    .refine(
      (val) => val === undefined || val === '' || z.string().email().safeParse(val).success,
      'Reply-To must be a valid email address.'
    ),
  subjectTemplate: z
    .string()
    .trim()
    .max(300)
    .optional()
    .refine(
      (val) => val === undefined || !HEADER_INJECTION_REGEX.test(val),
      'Invalid line breaks in subject template.'
    ),
  bodyTextTemplate: z.string().max(100000).optional(),
  bodyHtmlTemplate: z.string().max(250000).optional(),
  sendConfig: campaignSendConfigSchema.partial().optional(),
});

export const addCampaignRecipientsSchema = z
  .object({
    leadIds: z.array(z.string().trim().max(64)).max(5000).optional(),
    recipients: z.array(campaignRecipientInputSchema).max(5000).optional(),
  })
  .refine(
    (data) =>
      (Array.isArray(data.leadIds) && data.leadIds.length > 0) ||
      (Array.isArray(data.recipients) && data.recipients.length > 0),
    'Provide at least one lead ID or recipient.'
  );

export interface CampaignRecipientCounts {
  pending: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  bounced: number;
  ambiguous: number;
  skipped_suppressed: number;
  cancelled: number;
}

export function createEmptyRecipientCounts(): CampaignRecipientCounts {
  return {
    pending: 0,
    queued: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    bounced: 0,
    ambiguous: 0,
    skipped_suppressed: 0,
    cancelled: 0,
  };
}

export function serializeCampaign(
  campaign: CampaignDocument | (Record<string, unknown> & { _id: unknown }),
  options?: {
    counts?: CampaignRecipientCounts;
    mailboxName?: string;
    mailboxEmail?: string;
    mailboxVerified?: boolean;
    mailboxEnabled?: boolean;
  }
) {
  const c = campaign as unknown as {
    _id: unknown;
    name: string;
    description?: string;
    status: CampaignStatus;
    mailboxId: string;
    replyTo?: string;
    subjectTemplate?: string;
    bodyHtmlTemplate?: string;
    bodyTextTemplate?: string;
    sendConfig?: {
      batchSize?: number;
      delayMs?: number;
      concurrency?: number;
      dailySendCap?: number | null;
      threadFollowUps?: boolean;
    };
    manualApproval?: {
      approved?: boolean;
      approvedAt?: Date;
    };
    totalRecipients?: number;
    sentCount?: number;
    failedCount?: number;
    repliedCount?: number;
    bouncedCount?: number;
    lastError?: string;
    startedAt?: Date;
    pausedAt?: Date;
    cancelledAt?: Date;
    completedAt?: Date;
    lastBatchAt?: Date;
    createdAt: Date;
    updatedAt: Date;
  };

  const counts = options?.counts ?? createEmptyRecipientCounts();
  const totalFromCounts = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const totalRecipients = options?.counts ? totalFromCounts : c.totalRecipients ?? 0;
  const sentCount = options?.counts ? counts.sent : c.sentCount ?? 0;
  const failedCount = options?.counts ? counts.failed : c.failedCount ?? 0;
  const bouncedCount = options?.counts ? counts.bounced : c.bouncedCount ?? 0;

  return {
    id: String(c._id),
    name: c.name,
    description: c.description || '',
    status: c.status,
    mailboxId: c.mailboxId,
    ...(options?.mailboxName !== undefined ? { mailboxName: options.mailboxName } : {}),
    ...(options?.mailboxEmail !== undefined ? { mailboxEmail: options.mailboxEmail } : {}),
    ...(options?.mailboxVerified !== undefined
      ? { mailboxVerified: options.mailboxVerified }
      : {}),
    ...(options?.mailboxEnabled !== undefined
      ? { mailboxEnabled: options.mailboxEnabled }
      : {}),
    replyTo: c.replyTo || '',
    subjectTemplate: c.subjectTemplate || '',
    bodyHtmlTemplate: c.bodyHtmlTemplate || '',
    bodyTextTemplate: c.bodyTextTemplate || '',
    sendConfig: {
      batchSize: c.sendConfig?.batchSize ?? 8,
      delayMs: c.sendConfig?.delayMs ?? 1500,
      concurrency: c.sendConfig?.concurrency ?? 1,
      dailySendCap:
        typeof c.sendConfig?.dailySendCap === 'number' ? c.sendConfig.dailySendCap : null,
      threadFollowUps: c.sendConfig?.threadFollowUps ?? true,
    },
    approved: Boolean(c.manualApproval?.approved),
    approvedAt: c.manualApproval?.approvedAt
      ? new Date(c.manualApproval.approvedAt).toISOString()
      : null,
    totalRecipients,
    sentCount,
    failedCount,
    repliedCount: c.repliedCount ?? 0,
    bouncedCount,
    counts,
    lastError: c.lastError || '',
    startedAt: c.startedAt ? new Date(c.startedAt).toISOString() : null,
    pausedAt: c.pausedAt ? new Date(c.pausedAt).toISOString() : null,
    cancelledAt: c.cancelledAt ? new Date(c.cancelledAt).toISOString() : null,
    completedAt: c.completedAt ? new Date(c.completedAt).toISOString() : null,
    lastBatchAt: c.lastBatchAt ? new Date(c.lastBatchAt).toISOString() : null,
    createdAt: new Date(c.createdAt).toISOString(),
    updatedAt: new Date(c.updatedAt).toISOString(),
  };
}

export function serializeCampaignRecipient(
  recipient: CampaignRecipientDocument | (Record<string, unknown> & { _id: unknown })
) {
  const r = recipient as unknown as {
    _id: unknown;
    campaignId: unknown;
    leadId?: unknown;
    email: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    company?: string;
    role?: string;
    website?: string;
    location?: string;
    industry?: string;
    customFields?: Map<string, string> | Record<string, string>;
    customSubject?: string;
    customBodyHtml?: string;
    customBodyText?: string;
    renderedSubject?: string;
    renderedHtml?: string;
    renderedText?: string;
    missingPlaceholders?: string[];
    status: CampaignRecipientStatus;
    skipReason?: string;
    emailMessageId?: unknown;
    smtpMessageId?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string[];
    attempts?: number;
    lastError?: string;
    lastErrorCode?: string;
    sentAt?: Date;
    createdAt: Date;
    updatedAt: Date;
  };

  const customFields: Record<string, string> = {};
  if (r.customFields instanceof Map) {
    for (const [k, v] of r.customFields.entries()) {
      customFields[String(k)] = String(v ?? '');
    }
  } else if (r.customFields && typeof r.customFields === 'object') {
    for (const [k, v] of Object.entries(r.customFields)) {
      customFields[k] = String(v ?? '');
    }
  }

  return {
    id: String(r._id),
    campaignId: String(r.campaignId),
    leadId: r.leadId ? String(r.leadId) : null,
    email: r.email,
    firstName: r.firstName || '',
    lastName: r.lastName || '',
    fullName: r.fullName || '',
    company: r.company || '',
    role: r.role || '',
    website: r.website || '',
    location: r.location || '',
    industry: r.industry || '',
    customFields,
    customSubject: r.customSubject || '',
    customBodyHtml: r.customBodyHtml || '',
    customBodyText: r.customBodyText || '',
    renderedSubject: r.renderedSubject || '',
    renderedHtml: r.renderedHtml || '',
    renderedText: r.renderedText || '',
    missingPlaceholders: Array.isArray(r.missingPlaceholders) ? r.missingPlaceholders : [],
    status: r.status,
    skipReason: r.skipReason || '',
    emailMessageId: r.emailMessageId ? String(r.emailMessageId) : null,
    smtpMessageId: r.smtpMessageId || null,
    threadId: r.threadId || null,
    inReplyTo: r.inReplyTo || null,
    references: Array.isArray(r.references) ? r.references : [],
    attempts: r.attempts ?? 0,
    lastError: r.lastError || '',
    lastErrorCode: r.lastErrorCode || '',
    sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function aggregateCampaignRecipientCounts(
  campaignIds: string[]
): Promise<Map<string, CampaignRecipientCounts>> {
  const result = new Map<string, CampaignRecipientCounts>();
  const validObjectIds = campaignIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  for (const id of campaignIds) {
    result.set(id, createEmptyRecipientCounts());
  }

  if (validObjectIds.length === 0) return result;

  const rows = await CampaignRecipient.aggregate<{
    _id: { campaignId: mongoose.Types.ObjectId; status: string };
    count: number;
  }>([
    { $match: { campaignId: { $in: validObjectIds } } },
    {
      $group: {
        _id: { campaignId: '$campaignId', status: '$status' },
        count: { $sum: 1 },
      },
    },
  ]);

  for (const row of rows) {
    const campaignIdStr = String(row._id.campaignId);
    const bucket = result.get(campaignIdStr) ?? createEmptyRecipientCounts();
    const status = row._id.status as CampaignRecipientStatus;
    if (CAMPAIGN_RECIPIENT_STATUSES.includes(status)) {
      bucket[status] = row.count;
    }
    result.set(campaignIdStr, bucket);
  }

  return result;
}

export async function recomputeCampaignStats(
  campaignId: string | mongoose.Types.ObjectId
): Promise<CampaignRecipientCounts> {
  const idStr = String(campaignId);
  const map = await aggregateCampaignRecipientCounts([idStr]);
  const counts = map.get(idStr) ?? createEmptyRecipientCounts();
  const totalRecipients = Object.values(counts).reduce((sum, n) => sum + n, 0);

  await Campaign.updateOne(
    { _id: campaignId },
    {
      $set: {
        totalRecipients,
        sentCount: counts.sent,
        failedCount: counts.failed,
        bouncedCount: counts.bounced,
      },
    }
  );

  return counts;
}

export { CAMPAIGN_STATUSES, CAMPAIGN_RECIPIENT_STATUSES };
