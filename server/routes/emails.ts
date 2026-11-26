import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import { EmailMessage, Mailbox } from '../models/index.ts';
import { sendEmailViaMailbox } from '../utils/emailSender.ts';
import {
  sendEmailSchema,
  serializeEmailHistoryItem,
} from '../utils/emailValidation.ts';
import { escapeRegex } from '../utils/leadValidation.ts';

export const emailsRouter = Router();

emailsRouter.use(requireAuth);

emailsRouter.use((_req: Request, res: Response, next: NextFunction) => {
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

const STATUS_FILTER_MAP: Record<string, string[]> = {
  queued: ['queued', 'Queued'],
  sending: ['sending', 'Sending'],
  sent: ['sent', 'Sent'],
  failed: ['failed', 'Failed'],
  unknown: ['unknown', 'Unknown'],
  bounced: ['bounced', 'Bounced'],
  cancelled: ['cancelled', 'Cancelled'],
};

const listEmailsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .default('all')
    .refine(
      (val) => val === 'all' || val in STATUS_FILTER_MAP,
      'Invalid email status filter.'
    ),
  mailboxId: z.string().trim().max(120).optional().default(''),
  search: z.string().trim().max(200).optional().default(''),
});

emailsRouter.post('/send', async (req, res) => {
  const headerKey = req.get('idempotency-key');
  const rawBody =
    typeof req.body === 'object' && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};

  const candidatePayload = {
    ...rawBody,
    idempotencyKey:
      typeof rawBody.idempotencyKey === 'string' && rawBody.idempotencyKey.trim()
        ? rawBody.idempotencyKey
        : headerKey || '',
  };

  const parsed = sendEmailSchema.safeParse(candidatePayload);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid email send payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const protocol = forwardedProto || req.protocol || 'http';
    const host = req.get('host') || '';
    const requestOrigin = host ? `${protocol}://${host}` : undefined;

    const result = await sendEmailViaMailbox({
      ...parsed.data,
      appBaseUrl: requestOrigin,
    });
    if (result.ok) {
      res.status(result.httpStatus).json({
        ok: true,
        deduplicated: Boolean(result.deduplicated),
        email: result.email,
        quota: result.quota,
      });
      return;
    }

    res.status(result.httpStatus).json({
      error: result.error,
      code: result.code,
      ...(result.ambiguous !== undefined ? { ambiguous: result.ambiguous } : {}),
      ...(result.bounceType ? { bounceType: result.bounceType } : {}),
      ...(result.email ? { email: result.email } : {}),
      ...(result.quota ? { quota: result.quota } : {}),
    });
  } catch (err) {
    console.error('[Outreach Desk] Unexpected error sending email:', err);
    res.status(500).json({
      error: 'Unable to send email due to an unexpected server error.',
      code: 'EMAIL_SEND_FAILED',
    });
  }
});

emailsRouter.get('/', async (req, res) => {
  const parsed = listEmailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid email query parameters.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const { page, limit, status, mailboxId, search } = parsed.data;
  const filter: Record<string, unknown> = {};

  if (status !== 'all') {
    filter.status = { $in: STATUS_FILTER_MAP[status] };
  }

  if (mailboxId) {
    filter.mailboxId = mailboxId;
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ toEmail: regex }, { fromEmail: regex }, { subject: regex }];
  }

  try {
    const [totalEmails, totalFiltered, mailboxDocs] = await Promise.all([
      EmailMessage.countDocuments({}),
      EmailMessage.countDocuments(filter),
      Mailbox.find().select('_id name').lean(),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
    const safePage = Math.min(page, totalPages);
    const skip = (safePage - 1) * limit;

    const docs = await EmailMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const mailboxNameLookup = new Map<string, string>();
    for (const mb of mailboxDocs) {
      mailboxNameLookup.set(String(mb._id), mb.name);
    }

    res.json({
      emails: docs.map((doc) => serializeEmailHistoryItem(doc, mailboxNameLookup)),
      pagination: {
        page: safePage,
        limit,
        totalFiltered,
        totalPages,
      },
      totalEmails,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to list email history:', err);
    res.status(500).json({
      error: 'Failed to load email sending history.',
      code: 'EMAIL_LIST_FAILED',
    });
  }
});

emailsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid email record ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const doc = await EmailMessage.findById(id).lean();
    if (!doc) {
      res.status(404).json({ error: 'Email record not found.', code: 'NOT_FOUND' });
      return;
    }

    const mailboxNameLookup = new Map<string, string>();
    if (!doc.mailboxName && mongoose.isValidObjectId(doc.mailboxId)) {
      const mb = await Mailbox.findById(doc.mailboxId).select('name').lean();
      if (mb?.name) {
        mailboxNameLookup.set(String(mb._id), mb.name);
      }
    }

    res.json({
      email: serializeEmailHistoryItem(doc, mailboxNameLookup),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to load email metadata:', err);
    res.status(500).json({
      error: 'Failed to load email metadata.',
      code: 'EMAIL_DETAIL_FAILED',
    });
  }
});
