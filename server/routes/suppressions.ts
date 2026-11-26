import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  Lead,
  SUPPRESSION_REASONS,
  Suppression,
  type SuppressionReason,
} from '../models/index.ts';
import { escapeRegex } from '../utils/leadValidation.ts';
import { suppressEmail } from '../utils/suppression.ts';

export const suppressionsRouter = Router();

suppressionsRouter.use(requireAuth);
suppressionsRouter.use((_req: Request, res: Response, next: NextFunction) => {
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

const createSuppressionSchema = z.object({
  email: z.string().trim().toLowerCase().email('Valid email address is required.').max(254),
  reason: z.enum(SUPPRESSION_REASONS).optional().default('manual'),
  detail: z.string().trim().max(500).optional().default('Added to suppression list'),
});

suppressionsRouter.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const reasonFilter =
    typeof req.query.reason === 'string' &&
    SUPPRESSION_REASONS.includes(req.query.reason as SuppressionReason)
      ? (req.query.reason as SuppressionReason)
      : undefined;

  try {
    const filter: Record<string, unknown> = {};
    if (reasonFilter) filter.reason = reasonFilter;
    if (search) {
      filter.email = { $regex: escapeRegex(search.toLowerCase()), $options: 'i' };
    }

    const [docs, totalFiltered, summaryAgg] = await Promise.all([
      Suppression.find(filter)
        .sort({ suppressedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Suppression.countDocuments(filter),
      Suppression.aggregate<{ _id: SuppressionReason; count: number }>([
        { $group: { _id: '$reason', count: { $sum: 1 } } },
      ]),
    ]);

    const counts: Record<SuppressionReason, number> = {
      unsubscribe: 0,
      hard_bounce: 0,
      manual: 0,
    };
    for (const row of summaryAgg) {
      if (row._id in counts) counts[row._id] = row.count;
    }

    res.json({
      suppressions: docs.map((doc) => ({
        id: String(doc._id),
        email: doc.email,
        reason: doc.reason,
        source: doc.source,
        detail: doc.detail || '',
        leadId: doc.leadId ? String(doc.leadId) : null,
        campaignId: doc.campaignId ? String(doc.campaignId) : null,
        suppressedAt: new Date(doc.suppressedAt).toISOString(),
      })),
      counts,
      totalSuppressions: counts.unsubscribe + counts.hard_bounce + counts.manual,
      pagination: {
        page,
        limit,
        totalFiltered,
        totalPages: Math.max(1, Math.ceil(totalFiltered / limit)),
      },
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to list suppressions:', err);
    res.status(500).json({
      error: 'Failed to load suppression list.',
      code: 'SUPPRESSION_LIST_FAILED',
    });
  }
});

suppressionsRouter.post('/', async (req, res) => {
  const parsed = createSuppressionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid suppression payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const result = await suppressEmail({
      email: parsed.data.email,
      reason: parsed.data.reason,
      source: 'manual',
      detail: parsed.data.detail,
    });

    const doc = await Suppression.findOne({ email: result.email }).lean();
    res.status(201).json({
      ok: true,
      skippedRecipientsCount: result.skippedRecipientsCount,
      suppression: doc
        ? {
            id: String(doc._id),
            email: doc.email,
            reason: doc.reason,
            source: doc.source,
            detail: doc.detail || '',
            leadId: doc.leadId ? String(doc.leadId) : null,
            campaignId: doc.campaignId ? String(doc.campaignId) : null,
            suppressedAt: new Date(doc.suppressedAt).toISOString(),
          }
        : null,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to create suppression:', err);
    res.status(500).json({
      error: 'Failed to add email to suppression list.',
      code: 'SUPPRESSION_CREATE_FAILED',
    });
  }
});

suppressionsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid suppression ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const doc = await Suppression.findByIdAndDelete(id).lean();
    if (!doc) {
      res.status(404).json({ error: 'Suppression entry not found.', code: 'NOT_FOUND' });
      return;
    }

    const now = new Date();
    const leadUpdate: Record<string, unknown> = {
      $push: {
        history: {
          $each: [
            {
              status: 'Unsuppressed',
              at: now,
              note: `Removed from suppression list (${doc.reason})`,
            },
          ],
          $slice: -200,
        },
      },
    };
    if (doc.reason === 'hard_bounce') {
      leadUpdate.$set = { bounced: false, bounceReason: '' };
    } else {
      leadUpdate.$set = { optedOut: false };
    }
    await Lead.updateOne({ email: doc.email }, leadUpdate);

    res.json({ ok: true, id });
  } catch (err) {
    console.error('[Outreach Desk] Failed to remove suppression:', err);
    res.status(500).json({
      error: 'Failed to remove suppression entry.',
      code: 'SUPPRESSION_DELETE_FAILED',
    });
  }
});
