import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  Campaign,
  Lead,
  Mailbox,
  type LeadSource,
  type LeadStatus,
} from '../models/index.ts';
import { insertRecipientsForCampaign } from './campaigns.ts';
import {
  campaignSendConfigSchema,
  recomputeCampaignStats,
  serializeCampaign,
} from '../utils/campaignValidation.ts';
import { triggerCampaignWorker } from '../utils/campaignWorker.ts';
import { sanitizeEmailHtml } from '../utils/htmlSanitizer.ts';
import {
  emailSchema,
  normalizeCsvSource,
  normalizeCsvStatus,
  normalizeOptionalUrl,
  splitFullName,
} from '../utils/leadValidation.ts';
import { renderCampaignMessageForRecipient } from '../utils/placeholderEngine.ts';
import { getSuppressedEmailMap } from '../utils/suppression.ts';

export const leadsImportRouter = Router();

leadsImportRouter.use(requireAuth);
leadsImportRouter.use((_req: Request, res: Response, next: NextFunction) => {
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

const MAX_IMPORT_ROWS = 5000;
const INSERT_CHUNK_SIZE = 500;
const HEADER_INJECTION_REGEX = /[\r\n\0]/;

const stringCell = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined ? '' : String(v).trim()));

const customFieldsSchema = z
  .record(z.string(), stringCell)
  .optional()
  .default({})
  .transform((record) => {
    const cleaned: Record<string, string> = {};
    for (const [key, val] of Object.entries(record)) {
      const k = key.trim().slice(0, 64);
      if (k && val) {
        cleaned[k] = val.slice(0, 1000);
      }
    }
    return cleaned;
  });

const rawImportRowSchema = z.object({
  rowNumber: z.coerce.number().int().min(1).max(100000),
  fullName: stringCell,
  email: stringCell,
  company: stringCell,
  role: stringCell,
  website: stringCell,
  linkedinUrl: stringCell,
  location: stringCell,
  source: stringCell,
  status: stringCell,
  notes: stringCell,
  tags: stringCell.optional().default(''),
  subject: stringCell.optional().default(''),
  bodyText: stringCell.optional().default(''),
  bodyHtml: stringCell.optional().default(''),
  customFields: customFieldsSchema,
});

const campaignTemplatePreviewSchema = z
  .object({
    subjectTemplate: z.string().max(300).optional().default(''),
    bodyTextTemplate: z.string().max(100000).optional().default(''),
    bodyHtmlTemplate: z.string().max(250000).optional().default(''),
  })
  .optional();

const importPreviewRequestSchema = z.object({
  rows: z
    .array(rawImportRowSchema)
    .min(1, 'At least one CSV row is required.')
    .max(
      MAX_IMPORT_ROWS,
      `A maximum of ${MAX_IMPORT_ROWS.toLocaleString()} rows can be imported at once.`
    ),
  templatePreview: campaignTemplatePreviewSchema,
});

const importCommitRequestSchema = z.object({
  rows: z
    .array(rawImportRowSchema)
    .min(1, 'At least one CSV row is required.')
    .max(
      MAX_IMPORT_ROWS,
      `A maximum of ${MAX_IMPORT_ROWS.toLocaleString()} rows can be imported at once.`
    ),
  mode: z.enum(['leads_only', 'leads_and_campaign']).optional().default('leads_only'),
  campaign: z
    .object({
      name: z.string().trim().min(1, 'Campaign name is required.').max(160),
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
          (v) => !v || z.string().email().safeParse(v).success,
          'Reply-To must be a valid email address.'
        ),
      subjectTemplate: z
        .string()
        .trim()
        .max(300)
        .optional()
        .default('')
        .refine((v) => !HEADER_INJECTION_REGEX.test(v), 'Invalid line breaks in subject template.'),
      bodyTextTemplate: z.string().max(100000).optional().default(''),
      bodyHtmlTemplate: z.string().max(250000).optional().default(''),
      includeExistingLeadsInCampaign: z.boolean().optional().default(true),
      launchImmediately: z.boolean().optional().default(false),
      sendConfig: campaignSendConfigSchema.optional(),
    })
    .optional(),
});

type RawImportRow = z.infer<typeof rawImportRowSchema>;

export type ImportRowClassification =
  | 'ready'
  | 'invalid'
  | 'existing_in_db'
  | 'duplicate_in_csv'
  | 'suppressed';

interface NormalizedLeadRowData {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  role: string;
  website: string;
  linkedinUrl: string;
  location: string;
  source: LeadSource;
  status: LeadStatus;
  notes: string;
  tags: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  customFields: Record<string, string>;
}

interface ClassifiedImportRow {
  rowNumber: number;
  classification: ImportRowClassification;
  errors: string[];
  existingEmailCount?: number;
  suppressionReason?: string;
  renderedPreview?: {
    subject: string;
    text: string;
    html: string;
    missingPlaceholders: string[];
  };
  data: {
    fullName: string;
    email: string;
    company: string;
    role: string;
    website: string;
    linkedinUrl: string;
    location: string;
    source: string;
    status: string;
    notes: string;
    tags: string[];
    subject: string;
    bodyText: string;
    bodyHtml: string;
    customFields: Record<string, string>;
  };
  normalized?: NormalizedLeadRowData;
}

function parseTagsCell(rawTags: string): string[] {
  if (!rawTags.trim()) return [];
  const items = rawTags
    .split(/[;|]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  return Array.from(new Set(items));
}

function validateAndNormalizeRow(raw: RawImportRow): {
  valid: boolean;
  errors: string[];
  normalizedEmail: string;
  normalized?: NormalizedLeadRowData;
} {
  const errors: string[] = [];
  const normalizedEmail = raw.email.trim().toLowerCase();

  if (!normalizedEmail) {
    errors.push('Email address is required.');
  } else {
    const emailCheck = emailSchema.safeParse(normalizedEmail);
    if (!emailCheck.success) {
      errors.push('Invalid email address format.');
    }
  }

  if (raw.fullName.length > 160) errors.push('Full name exceeds 160 characters.');
  if (raw.company.length > 160) errors.push('Company exceeds 160 characters.');
  if (raw.role.length > 160) errors.push('Job title exceeds 160 characters.');
  if (raw.location.length > 160) errors.push('Location exceeds 160 characters.');
  if (raw.notes.length > 4000) errors.push('Notes exceed 4,000 characters.');
  if (raw.subject.length > 300) errors.push('Subject exceeds 300 characters.');
  if (HEADER_INJECTION_REGEX.test(raw.subject)) {
    errors.push('Subject contains invalid line break characters.');
  }

  const websiteRes = normalizeOptionalUrl(raw.website);
  if (!websiteRes.ok) errors.push('Website must be a valid http(s) URL.');

  const linkedinRes = normalizeOptionalUrl(raw.linkedinUrl);
  if (!linkedinRes.ok) errors.push('LinkedIn URL must be a valid http(s) URL.');

  const source = normalizeCsvSource(raw.source);
  if (!source) errors.push(`Unsupported source "${raw.source}".`);

  const status = normalizeCsvStatus(raw.status);
  if (!status) errors.push(`Unsupported pipeline status "${raw.status}".`);

  if (errors.length > 0 || !websiteRes.ok || !linkedinRes.ok || !source || !status) {
    return { valid: false, errors, normalizedEmail };
  }

  const { firstName, lastName } = splitFullName(raw.fullName);
  const tags = parseTagsCell(raw.tags || '');
  const sanitizedBodyHtml = raw.bodyHtml ? sanitizeEmailHtml(raw.bodyHtml) : '';

  return {
    valid: true,
    errors: [],
    normalizedEmail,
    normalized: {
      fullName: raw.fullName,
      firstName,
      lastName,
      email: normalizedEmail,
      company: raw.company,
      role: raw.role,
      website: websiteRes.value,
      linkedinUrl: linkedinRes.value,
      location: raw.location,
      source,
      status,
      notes: raw.notes,
      tags,
      subject: raw.subject.trim(),
      bodyText: raw.bodyText,
      bodyHtml: sanitizedBodyHtml,
      customFields: raw.customFields || {},
    },
  };
}

export async function classifyImportRows(
  rawRows: RawImportRow[],
  templatePreview?: {
    subjectTemplate?: string;
    bodyTextTemplate?: string;
    bodyHtmlTemplate?: string;
  }
): Promise<{
  classifiedRows: ClassifiedImportRow[];
  existingLeadIdByEmail: Map<string, mongoose.Types.ObjectId>;
  summary: {
    totalRows: number;
    validRowsCount: number;
    readyCount: number;
    invalidCount: number;
    existingInDbCount: number;
    duplicateInCsvCount: number;
    suppressedCount: number;
    totalDuplicatesCount: number;
    missingPlaceholdersCount: number;
  };
}> {
  const preValidated = rawRows.map((raw) => ({
    raw,
    check: validateAndNormalizeRow(raw),
  }));

  const uniqueValidEmails = Array.from(
    new Set(
      preValidated
        .filter((item) => item.check.valid && item.check.normalizedEmail)
        .map((item) => item.check.normalizedEmail)
    )
  );

  const existingLeadMap = new Map<
    string,
    { id: mongoose.Types.ObjectId; emailCount: number }
  >();
  const existingLeadIdByEmail = new Map<string, mongoose.Types.ObjectId>();

  const [existingDocs, suppressedMap] = await Promise.all([
    uniqueValidEmails.length > 0
      ? Lead.find({ email: { $in: uniqueValidEmails } })
          .select('_id email emailCount')
          .lean()
      : Promise.resolve([]),
    getSuppressedEmailMap(uniqueValidEmails),
  ]);

  for (const doc of existingDocs) {
    if (doc.email) {
      const lower = doc.email.toLowerCase();
      const id = doc._id as mongoose.Types.ObjectId;
      existingLeadMap.set(lower, {
        id,
        emailCount: typeof doc.emailCount === 'number' ? doc.emailCount : 0,
      });
      existingLeadIdByEmail.set(lower, id);
    }
  }

  const seenInCsv = new Set<string>();
  let readyCount = 0;
  let invalidCount = 0;
  let existingInDbCount = 0;
  let duplicateInCsvCount = 0;
  let suppressedCount = 0;
  let missingPlaceholdersCount = 0;

  const hasPreviewTemplate = Boolean(
    templatePreview?.subjectTemplate?.trim() ||
      templatePreview?.bodyTextTemplate?.trim() ||
      templatePreview?.bodyHtmlTemplate?.trim()
  );

  const classifiedRows: ClassifiedImportRow[] = preValidated.map(({ raw, check }) => {
    if (!check.valid || !check.normalized) {
      invalidCount += 1;
      return {
        rowNumber: raw.rowNumber,
        classification: 'invalid',
        errors: check.errors,
        data: {
          fullName: raw.fullName,
          email: check.normalizedEmail || raw.email,
          company: raw.company,
          role: raw.role,
          website: raw.website,
          linkedinUrl: raw.linkedinUrl,
          location: raw.location,
          source: raw.source || 'csv',
          status: raw.status || 'New',
          notes: raw.notes,
          tags: parseTagsCell(raw.tags || ''),
          subject: raw.subject,
          bodyText: raw.bodyText,
          bodyHtml: raw.bodyHtml,
          customFields: raw.customFields || {},
        },
      };
    }

    const email = check.normalized.email;
    let classification: ImportRowClassification;
    const reasons: string[] = [];
    let existingEmailCount: number | undefined;
    let suppressionReason: string | undefined;

    if (seenInCsv.has(email)) {
      classification = 'duplicate_in_csv';
      duplicateInCsvCount += 1;
      reasons.push('Duplicate email within this CSV file.');
    } else {
      seenInCsv.add(email);
      const suppressed = suppressedMap.get(email);
      const existingLead = existingLeadMap.get(email);
      if (existingLead) {
        existingEmailCount = existingLead.emailCount;
      }

      if (suppressed) {
        classification = 'suppressed';
        suppressedCount += 1;
        suppressionReason = suppressed.detail;
        reasons.push(`Suppressed (${suppressed.detail}).`);
      } else if (existingLead) {
        classification = 'existing_in_db';
        existingInDbCount += 1;
        reasons.push(
          existingLead.emailCount > 0
            ? `Lead already in database (emailed ${existingLead.emailCount} time${existingLead.emailCount === 1 ? '' : 's'}).`
            : 'Lead with this email already exists in database.'
        );
      } else {
        classification = 'ready';
        readyCount += 1;
      }
    }

    let renderedPreview: ClassifiedImportRow['renderedPreview'];
    if (
      hasPreviewTemplate ||
      check.normalized.subject ||
      check.normalized.bodyText ||
      check.normalized.bodyHtml
    ) {
      const rendered = renderCampaignMessageForRecipient({
        subjectTemplate: templatePreview?.subjectTemplate || '',
        bodyTextTemplate: templatePreview?.bodyTextTemplate || '',
        bodyHtmlTemplate: templatePreview?.bodyHtmlTemplate || '',
        customSubject: check.normalized.subject,
        customBodyText: check.normalized.bodyText,
        customBodyHtml: check.normalized.bodyHtml,
        recipient: check.normalized,
      });
      if (rendered.missingPlaceholders.length > 0) {
        missingPlaceholdersCount += 1;
      }
      renderedPreview = rendered;
    }

    return {
      rowNumber: raw.rowNumber,
      classification,
      errors: reasons,
      ...(existingEmailCount !== undefined ? { existingEmailCount } : {}),
      ...(suppressionReason ? { suppressionReason } : {}),
      ...(renderedPreview ? { renderedPreview } : {}),
      data: {
        fullName: check.normalized.fullName,
        email: check.normalized.email,
        company: check.normalized.company,
        role: check.normalized.role,
        website: check.normalized.website,
        linkedinUrl: check.normalized.linkedinUrl,
        location: check.normalized.location,
        source: check.normalized.source,
        status: check.normalized.status,
        notes: check.normalized.notes,
        tags: check.normalized.tags,
        subject: check.normalized.subject,
        bodyText: check.normalized.bodyText,
        bodyHtml: check.normalized.bodyHtml,
        customFields: check.normalized.customFields,
      },
      normalized: check.normalized,
    };
  });

  const totalDuplicatesCount = existingInDbCount + duplicateInCsvCount;

  return {
    classifiedRows,
    existingLeadIdByEmail,
    summary: {
      totalRows: rawRows.length,
      validRowsCount: readyCount + totalDuplicatesCount,
      readyCount,
      invalidCount,
      existingInDbCount,
      duplicateInCsvCount,
      suppressedCount,
      totalDuplicatesCount,
      missingPlaceholdersCount,
    },
  };
}

leadsImportRouter.get('/template', (_req, res) => {
  const csv = [
    'fullName,email,company,role,website,linkedinUrl,location,tags,subject,bodyText,notes,plan_tier',
    '"Alex Morgan","alex@northstar.example","Northstar Labs","Head of Growth","https://northstar.example","","Austin, TX","saas;q2","Quick question for {{first_name}} at {{company}}","Hi {{first_name}},\n\nNoticed {{company}} is scaling on {{plan_tier}} — open to a quick 10-minute chat this week?\n\nBest,","Met at SaaStr","Growth"',
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="outreach-desk-import-template.csv"'
  );
  res.send(csv);
});

leadsImportRouter.post('/preview', async (req, res) => {
  const parsed = importPreviewRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid CSV preview payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const { classifiedRows, summary } = await classifyImportRows(
      parsed.data.rows,
      parsed.data.templatePreview
    );

    res.json({
      summary,
      rows: classifiedRows.map(({ normalized: _omit, ...publicRow }) => publicRow),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Preview failed';
    console.error('[Outreach Desk] CSV import preview error:', msg);
    res.status(500).json({
      error: 'Failed to validate CSV rows against database.',
      code: 'IMPORT_PREVIEW_FAILED',
    });
  }
});

leadsImportRouter.post('/', async (req, res) => {
  const parsed = importCommitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid CSV import payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  if (parsed.data.mode === 'leads_and_campaign' && !parsed.data.campaign) {
    res.status(400).json({
      error: 'Campaign configuration is required when importing into a campaign.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  if (
    parsed.data.mode === 'leads_and_campaign' &&
    parsed.data.campaign &&
    !mongoose.isValidObjectId(parsed.data.campaign.mailboxId)
  ) {
    res.status(400).json({
      error: 'Invalid campaign mailbox ID.',
      code: 'INVALID_MAILBOX_ID',
    });
    return;
  }

  try {
    const templatePreview = parsed.data.campaign
      ? {
          subjectTemplate: parsed.data.campaign.subjectTemplate,
          bodyTextTemplate: parsed.data.campaign.bodyTextTemplate,
          bodyHtmlTemplate: parsed.data.campaign.bodyHtmlTemplate,
        }
      : undefined;

    const { classifiedRows, existingLeadIdByEmail } = await classifyImportRows(
      parsed.data.rows,
      templatePreview
    );

    const readyRows = classifiedRows.filter(
      (row): row is ClassifiedImportRow & { normalized: NormalizedLeadRowData } =>
        row.classification === 'ready' && Boolean(row.normalized)
    );
    const existingRows = classifiedRows.filter(
      (row): row is ClassifiedImportRow & { normalized: NormalizedLeadRowData } =>
        row.classification === 'existing_in_db' && Boolean(row.normalized)
    );
    const invalidRows = classifiedRows
      .filter((row) => row.classification === 'invalid')
      .map((row) => ({
        rowNumber: row.rowNumber,
        email: row.data.email,
        reason: row.errors.join(' '),
      }));
    const duplicateRows = classifiedRows
      .filter(
        (row) =>
          row.classification === 'existing_in_db' ||
          row.classification === 'duplicate_in_csv' ||
          row.classification === 'suppressed'
      )
      .map((row) => ({
        rowNumber: row.rowNumber,
        email: row.data.email,
        classification: row.classification,
        reason: row.errors.join(' '),
      }));

    let importedCount = 0;
    let skippedExistingCount = existingRows.length;
    const skippedCsvDuplicateCount = classifiedRows.filter(
      (row) => row.classification === 'duplicate_in_csv'
    ).length;
    const skippedSuppressedCount = classifiedRows.filter(
      (row) => row.classification === 'suppressed'
    ).length;
    const failedRows: Array<{ rowNumber: number; email: string; reason: string }> = [];

    const now = new Date();
    const insertedLeadIdByEmail = new Map<string, mongoose.Types.ObjectId>();

    for (let offset = 0; offset < readyRows.length; offset += INSERT_CHUNK_SIZE) {
      const chunkRows = readyRows.slice(offset, offset + INSERT_CHUNK_SIZE);
      const docs = chunkRows.map((row) => {
        const d = row.normalized;
        return {
          fullName: d.fullName,
          firstName: d.firstName,
          lastName: d.lastName,
          email: d.email,
          company: d.company,
          role: d.role,
          website: d.website,
          linkedinUrl: d.linkedinUrl,
          location: d.location,
          source: d.source,
          status: d.status,
          tags: d.tags,
          customFields: d.customFields,
          notes: d.notes ? [{ content: d.notes, createdAt: now, updatedAt: now }] : [],
          ...(d.status === 'Meeting' ? { meetingBookedAt: now } : {}),
        };
      });

      try {
        const inserted = await Lead.insertMany(docs, { ordered: false });
        importedCount += inserted.length;
        for (const doc of inserted) {
          if (doc.email && doc._id) {
            insertedLeadIdByEmail.set(
              doc.email.toLowerCase(),
              doc._id as mongoose.Types.ObjectId
            );
          }
        }
      } catch (err) {
        const bulkErr = err as {
          insertedDocs?: Array<{ _id?: unknown; email?: string }>;
          writeErrors?: Array<{ index?: number; code?: number; errmsg?: string }>;
        };

        if (Array.isArray(bulkErr.insertedDocs)) {
          for (const doc of bulkErr.insertedDocs) {
            if (doc.email && doc._id) {
              insertedLeadIdByEmail.set(
                String(doc.email).toLowerCase(),
                doc._id as mongoose.Types.ObjectId
              );
            }
          }
        }

        const writeErrors = Array.isArray(bulkErr.writeErrors) ? bulkErr.writeErrors : [];
        if (writeErrors.length === 0) {
          for (const row of chunkRows) {
            failedRows.push({
              rowNumber: row.rowNumber,
              email: row.normalized.email,
              reason: 'Database write failed.',
            });
          }
          continue;
        }

        const erroredIndices = new Set<number>();
        for (const we of writeErrors) {
          const idx = typeof we.index === 'number' ? we.index : -1;
          if (idx >= 0 && idx < chunkRows.length) {
            erroredIndices.add(idx);
            const row = chunkRows[idx];
            if (we.code === 11000) {
              skippedExistingCount += 1;
              duplicateRows.push({
                rowNumber: row.rowNumber,
                email: row.normalized.email,
                classification: 'existing_in_db',
                reason: 'Email already exists in database.',
              });
            } else {
              failedRows.push({
                rowNumber: row.rowNumber,
                email: row.normalized.email,
                reason: we.errmsg || 'Database validation failed.',
              });
            }
          }
        }

        const chunkInsertedCount = Array.isArray(bulkErr.insertedDocs)
          ? bulkErr.insertedDocs.length
          : Math.max(0, chunkRows.length - erroredIndices.size);
        importedCount += chunkInsertedCount;
      }
    }

    let createdCampaignPayload: Record<string, unknown> | undefined;
    let campaignLaunchWarning: string | undefined;

    if (parsed.data.mode === 'leads_and_campaign' && parsed.data.campaign) {
      const campInput = parsed.data.campaign;
      const mailbox = await Mailbox.findById(campInput.mailboxId)
        .select('name senderEmail replyTo enabled archived verificationStatus')
        .lean();

      if (!mailbox || mailbox.archived) {
        campaignLaunchWarning = 'Selected campaign mailbox was not found or is archived.';
      } else {
        const eligibleRows = campInput.includeExistingLeadsInCampaign
          ? [...readyRows, ...existingRows]
          : readyRows;

        const campaignDoc = await Campaign.create({
          name: campInput.name,
          description: campInput.description,
          status: 'Draft',
          mailboxId: String(mailbox._id),
          replyTo: campInput.replyTo || mailbox.replyTo || '',
          subjectTemplate: campInput.subjectTemplate,
          bodyTextTemplate: campInput.bodyTextTemplate,
          bodyHtmlTemplate: campInput.bodyHtmlTemplate,
          sendConfig: {
            batchSize: campInput.sendConfig?.batchSize ?? 8,
            delayMs: campInput.sendConfig?.delayMs ?? 1500,
            concurrency: campInput.sendConfig?.concurrency ?? 1,
            dailySendCap: campInput.sendConfig?.dailySendCap ?? null,
            threadFollowUps: campInput.sendConfig?.threadFollowUps ?? true,
          },
          manualApproval: { approved: false },
        });

        const candidates = eligibleRows.map((row) => {
          const d = row.normalized;
          const leadId =
            insertedLeadIdByEmail.get(d.email) ?? existingLeadIdByEmail.get(d.email);
          return {
            ...(leadId ? { leadId } : {}),
            email: d.email,
            firstName: d.firstName,
            lastName: d.lastName,
            fullName: d.fullName,
            company: d.company,
            role: d.role,
            website: d.website,
            location: d.location,
            industry: '',
            customFields: d.customFields,
            customSubject: d.subject,
            customBodyText: d.bodyText,
            customBodyHtml: d.bodyHtml,
          };
        });

        const wantImmediateLaunch = Boolean(campInput.launchImmediately);
        const canImmediateLaunch =
          wantImmediateLaunch &&
          mailbox.enabled &&
          mailbox.verificationStatus === 'verified' &&
          candidates.length > 0;

        await insertRecipientsForCampaign({
          campaignId: campaignDoc._id as mongoose.Types.ObjectId,
          subjectTemplate: campaignDoc.subjectTemplate,
          bodyTextTemplate: campaignDoc.bodyTextTemplate,
          bodyHtmlTemplate: campaignDoc.bodyHtmlTemplate,
          candidates,
          initialEligibleStatus: canImmediateLaunch ? 'queued' : 'pending',
        });

        if (wantImmediateLaunch && !canImmediateLaunch) {
          campaignLaunchWarning =
            'Campaign saved as Draft because the mailbox must be enabled and SMTP-verified before immediate launch.';
        } else if (canImmediateLaunch) {
          const launchNow = new Date();
          campaignDoc.status = 'Sending';
          campaignDoc.manualApproval = { approved: true, approvedAt: launchNow };
          campaignDoc.startedAt = launchNow;
          await campaignDoc.save();
          triggerCampaignWorker(String(campaignDoc._id));
        }

        const counts = await recomputeCampaignStats(
          campaignDoc._id as mongoose.Types.ObjectId
        );
        const refreshed = await Campaign.findById(campaignDoc._id).lean();
        createdCampaignPayload = serializeCampaign(refreshed || campaignDoc, {
          counts,
          mailboxName: mailbox.name,
          mailboxEmail: mailbox.senderEmail,
          mailboxVerified: mailbox.verificationStatus === 'verified',
          mailboxEnabled: Boolean(mailbox.enabled && !mailbox.archived),
        });
      }
    }

    const totalLeads = await Lead.countDocuments({});

    res.status(200).json({
      summary: {
        totalRows: parsed.data.rows.length,
        importedCount,
        skippedExistingCount,
        skippedCsvDuplicateCount,
        skippedSuppressedCount,
        skippedDuplicatesTotal: skippedExistingCount + skippedCsvDuplicateCount,
        invalidCount: invalidRows.length,
        failedCount: failedRows.length,
        totalLeads,
      },
      invalidRows,
      duplicateRows,
      failedRows,
      ...(createdCampaignPayload ? { campaign: createdCampaignPayload } : {}),
      ...(campaignLaunchWarning ? { campaignLaunchWarning } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Import failed';
    console.error('[Outreach Desk] CSV import commit error:', msg);
    res.status(500).json({
      error: 'Failed to commit CSV lead import.',
      code: 'IMPORT_COMMIT_FAILED',
    });
  }
});
