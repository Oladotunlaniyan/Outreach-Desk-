import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  CAMPAIGN_RECIPIENT_STATUSES,
  CAMPAIGN_STATUSES,
  Campaign,
  CampaignRecipient,
  Lead,
  Mailbox,
  type CampaignRecipientStatus,
  type CampaignStatus,
} from '../models/index.ts';
import {
  addCampaignRecipientsSchema,
  aggregateCampaignRecipientCounts,
  createCampaignSchema,
  recomputeCampaignStats,
  serializeCampaign,
  serializeCampaignRecipient,
  updateCampaignSchema,
} from '../utils/campaignValidation.ts';
import { renderCampaignMessageForRecipient } from '../utils/placeholderEngine.ts';
import { getMailboxQuota } from '../utils/quotaManager.ts';
import { getSuppressedEmailMap } from '../utils/suppression.ts';

export const campaignsRouter = Router();

let campaignWorkerTrigger: ((campaignId: string) => void) | null = null;

export function registerCampaignWorkerTrigger(fn: (campaignId: string) => void): void {
  campaignWorkerTrigger = fn;
}

export function notifyCampaignWorker(campaignId: string): void {
  if (campaignWorkerTrigger) {
    campaignWorkerTrigger(campaignId);
  }
}

campaignsRouter.use(requireAuth);
campaignsRouter.use((_req: Request, res: Response, next: NextFunction) => {
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

interface PreparedRecipientCandidate {
  leadId?: mongoose.Types.ObjectId;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  role: string;
  website: string;
  location: string;
  industry: string;
  customFields: Record<string, string>;
  customSubject: string;
  customBodyText: string;
  customBodyHtml: string;
}

async function resolveCandidateRecipients(params: {
  leadIds?: string[];
  inlineRecipients?: Array<{
    leadId?: string;
    email: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    company?: string;
    role?: string;
    website?: string;
    location?: string;
    industry?: string;
    customFields?: Record<string, string>;
    customSubject?: string;
    customBodyText?: string;
    customBodyHtml?: string;
  }>;
}): Promise<PreparedRecipientCandidate[]> {
  const byEmail = new Map<string, PreparedRecipientCandidate>();

  const validLeadIds = (params.leadIds || []).filter((id) =>
    mongoose.isValidObjectId(id)
  );
  if (validLeadIds.length > 0) {
    const leads = await Lead.find({ _id: { $in: validLeadIds } }).lean();
    for (const lead of leads) {
      const email = lead.email.toLowerCase().trim();
      if (!email) continue;
      const customFields: Record<string, string> = {};
      if (lead.customFields && typeof lead.customFields === 'object') {
        for (const [k, v] of Object.entries(lead.customFields as Record<string, unknown>)) {
          customFields[k] = String(v ?? '');
        }
      }
      byEmail.set(email, {
        leadId: lead._id as mongoose.Types.ObjectId,
        email,
        firstName: lead.firstName || '',
        lastName: lead.lastName || '',
        fullName: lead.fullName || '',
        company: lead.company || '',
        role: lead.role || '',
        website: lead.website || '',
        location: lead.location || '',
        industry: lead.industry || '',
        customFields,
        customSubject: '',
        customBodyText: '',
        customBodyHtml: '',
      });
    }
  }

  if (Array.isArray(params.inlineRecipients) && params.inlineRecipients.length > 0) {
    const inlineEmails = params.inlineRecipients
      .map((r) => r.email.trim().toLowerCase())
      .filter(Boolean);
    const matchedLeads =
      inlineEmails.length > 0
        ? await Lead.find({ email: { $in: inlineEmails } })
            .select('_id email firstName lastName fullName company role website location industry customFields')
            .lean()
        : [];
    const leadByEmail = new Map(matchedLeads.map((l) => [l.email.toLowerCase(), l]));

    for (const r of params.inlineRecipients) {
      const email = r.email.trim().toLowerCase();
      if (!email) continue;
      const matched = leadByEmail.get(email);
      const customFields: Record<string, string> = {};
      if (matched?.customFields && typeof matched.customFields === 'object') {
        for (const [k, v] of Object.entries(
          matched.customFields as Record<string, unknown>
        )) {
          customFields[k] = String(v ?? '');
        }
      }
      if (r.customFields) {
        for (const [k, v] of Object.entries(r.customFields)) {
          customFields[k] = String(v ?? '');
        }
      }

      const resolvedLeadId =
        r.leadId && mongoose.isValidObjectId(r.leadId)
          ? new mongoose.Types.ObjectId(r.leadId)
          : (matched?._id as mongoose.Types.ObjectId | undefined);

      byEmail.set(email, {
        ...(resolvedLeadId ? { leadId: resolvedLeadId } : {}),
        email,
        firstName: r.firstName?.trim() || matched?.firstName || '',
        lastName: r.lastName?.trim() || matched?.lastName || '',
        fullName: r.fullName?.trim() || matched?.fullName || '',
        company: r.company?.trim() || matched?.company || '',
        role: r.role?.trim() || matched?.role || '',
        website: r.website?.trim() || matched?.website || '',
        location: r.location?.trim() || matched?.location || '',
        industry: r.industry?.trim() || matched?.industry || '',
        customFields,
        customSubject: r.customSubject?.trim() || '',
        customBodyText: r.customBodyText || '',
        customBodyHtml: r.customBodyHtml || '',
      });
    }
  }

  return Array.from(byEmail.values());
}

export async function insertRecipientsForCampaign(params: {
  campaignId: mongoose.Types.ObjectId;
  subjectTemplate: string;
  bodyTextTemplate: string;
  bodyHtmlTemplate: string;
  candidates: PreparedRecipientCandidate[];
  initialEligibleStatus: 'pending' | 'queued';
}): Promise<{
  addedCount: number;
  skippedSuppressedCount: number;
  duplicateCount: number;
}> {
  if (params.candidates.length === 0) {
    return { addedCount: 0, skippedSuppressedCount: 0, duplicateCount: 0 };
  }

  const emails = params.candidates.map((c) => c.email);
  const [existingRecipients, suppressedMap] = await Promise.all([
    CampaignRecipient.find({
      campaignId: params.campaignId,
      email: { $in: emails },
    })
      .select('email')
      .lean(),
    getSuppressedEmailMap(emails),
  ]);

  const existingSet = new Set(existingRecipients.map((r) => r.email.toLowerCase()));
  const toInsert: Array<Record<string, unknown>> = [];
  let skippedSuppressedCount = 0;
  let duplicateCount = 0;

  for (const c of params.candidates) {
    if (existingSet.has(c.email)) {
      duplicateCount += 1;
      continue;
    }
    existingSet.add(c.email);

    const suppressed = suppressedMap.get(c.email);
    const rendered = renderCampaignMessageForRecipient({
      subjectTemplate: params.subjectTemplate,
      bodyTextTemplate: params.bodyTextTemplate,
      bodyHtmlTemplate: params.bodyHtmlTemplate,
      customSubject: c.customSubject,
      customBodyText: c.customBodyText,
      customBodyHtml: c.customBodyHtml,
      recipient: c,
    });

    if (suppressed) {
      skippedSuppressedCount += 1;
    }

    toInsert.push({
      campaignId: params.campaignId,
      ...(c.leadId ? { leadId: c.leadId } : {}),
      email: c.email,
      firstName: c.firstName,
      lastName: c.lastName,
      fullName: c.fullName,
      company: c.company,
      role: c.role,
      website: c.website,
      location: c.location,
      industry: c.industry,
      customFields: c.customFields,
      customSubject: c.customSubject,
      customBodyText: c.customBodyText,
      customBodyHtml: c.customBodyHtml,
      renderedSubject: rendered.subject,
      renderedText: rendered.text,
      renderedHtml: rendered.html,
      missingPlaceholders: rendered.missingPlaceholders,
      status: suppressed ? 'skipped_suppressed' : params.initialEligibleStatus,
      skipReason: suppressed ? suppressed.detail : '',
    });
  }

  if (toInsert.length > 0) {
    await CampaignRecipient.insertMany(toInsert, { ordered: false });
  }

  return {
    addedCount: toInsert.length,
    skippedSuppressedCount,
    duplicateCount,
  };
}

async function rerenderEditableRecipients(campaign: {
  _id: mongoose.Types.ObjectId;
  subjectTemplate: string;
  bodyTextTemplate: string;
  bodyHtmlTemplate: string;
}) {
  const editable = await CampaignRecipient.find({
    campaignId: campaign._id,
    status: { $in: ['pending', 'queued'] },
  }).lean();

  if (editable.length === 0) return;

  const ops = editable.map((rec) => {
    const rendered = renderCampaignMessageForRecipient({
      subjectTemplate: campaign.subjectTemplate,
      bodyTextTemplate: campaign.bodyTextTemplate,
      bodyHtmlTemplate: campaign.bodyHtmlTemplate,
      customSubject: rec.customSubject,
      customBodyText: rec.customBodyText,
      customBodyHtml: rec.customBodyHtml,
      recipient: rec,
    });
    return {
      updateOne: {
        filter: { _id: rec._id },
        update: {
          $set: {
            renderedSubject: rendered.subject,
            renderedText: rendered.text,
            renderedHtml: rendered.html,
            missingPlaceholders: rendered.missingPlaceholders,
          },
        },
      },
    };
  });

  await CampaignRecipient.bulkWrite(ops, { ordered: false });
}

campaignsRouter.get('/', async (req, res) => {
  const statusFilter =
    typeof req.query.status === 'string' &&
    CAMPAIGN_STATUSES.includes(req.query.status as CampaignStatus)
      ? (req.query.status as CampaignStatus)
      : undefined;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

  try {
    const query = statusFilter ? { status: statusFilter } : {};
    const [campaigns, totalFiltered] = await Promise.all([
      Campaign.find(query)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Campaign.countDocuments(query),
    ]);
    const campaignIds = campaigns.map((c) => String(c._id));
    const mailboxIds = Array.from(
      new Set(
        campaigns
          .map((c) => c.mailboxId)
          .filter((id) => mongoose.isValidObjectId(id))
      )
    );

    const [countsMap, mailboxes] = await Promise.all([
      aggregateCampaignRecipientCounts(campaignIds),
      mailboxIds.length > 0
        ? Mailbox.find({ _id: { $in: mailboxIds } })
            .select('_id name senderEmail verificationStatus enabled archived')
            .lean()
        : Promise.resolve([]),
    ]);

    const mailboxMap = new Map(mailboxes.map((m) => [String(m._id), m]));

    res.json({
      campaigns: campaigns.map((c) => {
        const mb = mailboxMap.get(c.mailboxId);
        return serializeCampaign(c, {
          counts: countsMap.get(String(c._id)),
          mailboxName: mb?.name,
          mailboxEmail: mb?.senderEmail,
          mailboxVerified: mb ? mb.verificationStatus === 'verified' : false,
          mailboxEnabled: mb ? Boolean(mb.enabled && !mb.archived) : false,
        });
      }),
      pagination: {
        page,
        limit,
        totalFiltered,
        totalPages: Math.max(1, Math.ceil(totalFiltered / limit)),
      },
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to list campaigns:', err);
    res.status(500).json({
      error: 'Failed to load campaigns.',
      code: 'CAMPAIGNS_LIST_FAILED',
    });
  }
});

campaignsRouter.post('/', async (req, res) => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid campaign payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const data = parsed.data;
  if (!mongoose.isValidObjectId(data.mailboxId)) {
    res.status(400).json({ error: 'Invalid mailbox ID.', code: 'INVALID_MAILBOX_ID' });
    return;
  }

  try {
    const mailbox = await Mailbox.findById(data.mailboxId)
      .select('name senderEmail replyTo enabled archived verificationStatus')
      .lean();
    if (!mailbox || mailbox.archived) {
      res.status(404).json({
        error: 'Selected mailbox was not found or is archived.',
        code: 'MAILBOX_NOT_FOUND',
      });
      return;
    }

    const campaign = await Campaign.create({
      name: data.name,
      description: data.description,
      status: 'Draft',
      mailboxId: String(mailbox._id),
      replyTo: data.replyTo || mailbox.replyTo || '',
      subjectTemplate: data.subjectTemplate,
      bodyTextTemplate: data.bodyTextTemplate,
      bodyHtmlTemplate: data.bodyHtmlTemplate,
      sendConfig: {
        batchSize: data.sendConfig?.batchSize ?? 8,
        delayMs: data.sendConfig?.delayMs ?? 1500,
        concurrency: data.sendConfig?.concurrency ?? 1,
        dailySendCap: data.sendConfig?.dailySendCap ?? null,
        threadFollowUps: data.sendConfig?.threadFollowUps ?? true,
      },
      manualApproval: { approved: false },
    });

    const candidates = await resolveCandidateRecipients({
      leadIds: data.leadIds,
      inlineRecipients: data.recipients,
    });

    const insertSummary = await insertRecipientsForCampaign({
      campaignId: campaign._id as mongoose.Types.ObjectId,
      subjectTemplate: campaign.subjectTemplate,
      bodyTextTemplate: campaign.bodyTextTemplate,
      bodyHtmlTemplate: campaign.bodyHtmlTemplate,
      candidates,
      initialEligibleStatus: 'pending',
    });

    const counts = await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
    const refreshed = await Campaign.findById(campaign._id).lean();

    res.status(201).json({
      campaign: serializeCampaign(refreshed || campaign, {
        counts,
        mailboxName: mailbox.name,
        mailboxEmail: mailbox.senderEmail,
        mailboxVerified: mailbox.verificationStatus === 'verified',
        mailboxEnabled: Boolean(mailbox.enabled && !mailbox.archived),
      }),
      recipientSummary: insertSummary,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to create campaign:', err);
    res.status(500).json({
      error: 'Failed to create campaign.',
      code: 'CAMPAIGN_CREATE_FAILED',
    });
  }
});

campaignsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const recipientStatus =
    typeof req.query.recipientStatus === 'string' &&
    CAMPAIGN_RECIPIENT_STATUSES.includes(req.query.recipientStatus as CampaignRecipientStatus)
      ? (req.query.recipientStatus as CampaignRecipientStatus)
      : undefined;

  try {
    const campaign = await Campaign.findById(id).lean();
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    const recipientFilter: Record<string, unknown> = { campaignId: campaign._id };
    if (recipientStatus) {
      recipientFilter.status = recipientStatus;
    }

    const [countsMap, mailbox, totalFiltered, recipients] = await Promise.all([
      aggregateCampaignRecipientCounts([id]),
      mongoose.isValidObjectId(campaign.mailboxId)
        ? Mailbox.findById(campaign.mailboxId)
            .select('name senderEmail dailyLimit enabled archived verificationStatus')
            .lean()
        : Promise.resolve(null),
      CampaignRecipient.countDocuments(recipientFilter),
      CampaignRecipient.find(recipientFilter)
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const quota = mailbox
      ? await getMailboxQuota(String(mailbox._id), mailbox.dailyLimit)
      : null;

    res.json({
      campaign: serializeCampaign(campaign, {
        counts: countsMap.get(id),
        mailboxName: mailbox?.name,
        mailboxEmail: mailbox?.senderEmail,
        mailboxVerified: mailbox ? mailbox.verificationStatus === 'verified' : false,
        mailboxEnabled: mailbox ? Boolean(mailbox.enabled && !mailbox.archived) : false,
      }),
      mailboxQuota: quota,
      recipients: recipients.map(serializeCampaignRecipient),
      pagination: {
        page,
        limit,
        totalFiltered,
        totalPages: Math.max(1, Math.ceil(totalFiltered / limit)),
      },
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to load campaign detail:', err);
    res.status(500).json({
      error: 'Failed to load campaign detail.',
      code: 'CAMPAIGN_DETAIL_FAILED',
    });
  }
});

campaignsRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  const parsed = updateCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid campaign update payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const updates = parsed.data;
  try {
    const existing = await Campaign.findById(id);
    if (!existing) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    if (existing.status === 'Sending') {
      res.status(409).json({
        error: 'Pause the campaign before editing its template, mailbox, or delivery settings.',
        code: 'CAMPAIGN_ACTIVE',
      });
      return;
    }

    if (existing.status === 'Completed' || existing.status === 'Cancelled') {
      res.status(409).json({
        error: `Cannot edit a ${existing.status.toLowerCase()} campaign.`,
        code: 'CAMPAIGN_IMMUTABLE',
      });
      return;
    }

    if (updates.mailboxId !== undefined) {
      if (!mongoose.isValidObjectId(updates.mailboxId)) {
        res.status(400).json({ error: 'Invalid mailbox ID.', code: 'INVALID_MAILBOX_ID' });
        return;
      }
      const mb = await Mailbox.findById(updates.mailboxId).select('_id archived').lean();
      if (!mb || mb.archived) {
        res.status(404).json({
          error: 'Selected mailbox was not found or is archived.',
          code: 'MAILBOX_NOT_FOUND',
        });
        return;
      }
      existing.mailboxId = updates.mailboxId;
    }

    if (updates.name !== undefined) existing.name = updates.name;
    if (updates.description !== undefined) existing.description = updates.description;
    if (updates.replyTo !== undefined) existing.replyTo = updates.replyTo;

    let templateChanged = false;
    if (updates.subjectTemplate !== undefined) {
      existing.subjectTemplate = updates.subjectTemplate;
      templateChanged = true;
    }
    if (updates.bodyTextTemplate !== undefined) {
      existing.bodyTextTemplate = updates.bodyTextTemplate;
      templateChanged = true;
    }
    if (updates.bodyHtmlTemplate !== undefined) {
      existing.bodyHtmlTemplate = updates.bodyHtmlTemplate;
      templateChanged = true;
    }

    if (updates.sendConfig) {
      existing.sendConfig = {
        batchSize: updates.sendConfig.batchSize ?? existing.sendConfig.batchSize,
        delayMs: updates.sendConfig.delayMs ?? existing.sendConfig.delayMs,
        concurrency: updates.sendConfig.concurrency ?? existing.sendConfig.concurrency,
        dailySendCap:
          updates.sendConfig.dailySendCap !== undefined
            ? updates.sendConfig.dailySendCap
            : existing.sendConfig.dailySendCap,
        threadFollowUps:
          updates.sendConfig.threadFollowUps ?? existing.sendConfig.threadFollowUps,
      };
    }

    await existing.save();

    if (templateChanged) {
      await rerenderEditableRecipients({
        _id: existing._id as mongoose.Types.ObjectId,
        subjectTemplate: existing.subjectTemplate,
        bodyTextTemplate: existing.bodyTextTemplate,
        bodyHtmlTemplate: existing.bodyHtmlTemplate,
      });
    }

    const [countsMap, mailbox] = await Promise.all([
      aggregateCampaignRecipientCounts([id]),
      mongoose.isValidObjectId(existing.mailboxId)
        ? Mailbox.findById(existing.mailboxId)
            .select('name senderEmail verificationStatus enabled archived')
            .lean()
        : Promise.resolve(null),
    ]);

    res.json({
      campaign: serializeCampaign(existing, {
        counts: countsMap.get(id),
        mailboxName: mailbox?.name,
        mailboxEmail: mailbox?.senderEmail,
        mailboxVerified: mailbox ? mailbox.verificationStatus === 'verified' : false,
        mailboxEnabled: mailbox ? Boolean(mailbox.enabled && !mailbox.archived) : false,
      }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to update campaign:', err);
    res.status(500).json({
      error: 'Failed to update campaign.',
      code: 'CAMPAIGN_UPDATE_FAILED',
    });
  }
});

campaignsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const existing = await Campaign.findById(id).lean();
    if (!existing) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    if (existing.status === 'Sending') {
      res.status(409).json({
        error: 'Pause or cancel an active campaign before deleting it.',
        code: 'CAMPAIGN_ACTIVE',
      });
      return;
    }

    await Promise.all([
      CampaignRecipient.deleteMany({ campaignId: existing._id }),
      Campaign.deleteOne({ _id: existing._id }),
    ]);

    res.json({ ok: true, id });
  } catch (err) {
    console.error('[Outreach Desk] Failed to delete campaign:', err);
    res.status(500).json({
      error: 'Failed to delete campaign.',
      code: 'CAMPAIGN_DELETE_FAILED',
    });
  }
});

campaignsRouter.post('/:id/recipients', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  const parsed = addCampaignRecipientsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid recipients payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const campaign = await Campaign.findById(id).lean();
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    if (campaign.status === 'Completed' || campaign.status === 'Cancelled') {
      res.status(409).json({
        error: `Cannot add recipients to a ${campaign.status.toLowerCase()} campaign.`,
        code: 'CAMPAIGN_IMMUTABLE',
      });
      return;
    }

    const candidates = await resolveCandidateRecipients({
      leadIds: parsed.data.leadIds,
      inlineRecipients: parsed.data.recipients,
    });

    const summary = await insertRecipientsForCampaign({
      campaignId: campaign._id as mongoose.Types.ObjectId,
      subjectTemplate: campaign.subjectTemplate,
      bodyTextTemplate: campaign.bodyTextTemplate,
      bodyHtmlTemplate: campaign.bodyHtmlTemplate,
      candidates,
      initialEligibleStatus: campaign.status === 'Sending' ? 'queued' : 'pending',
    });

    const counts = await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
    res.status(200).json({
      ok: true,
      summary,
      counts,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to add campaign recipients:', err);
    res.status(500).json({
      error: 'Failed to add campaign recipients.',
      code: 'RECIPIENTS_ADD_FAILED',
    });
  }
});

campaignsRouter.delete('/:id/recipients/:recipientId', async (req, res) => {
  const { id, recipientId } = req.params;
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(recipientId)) {
    res.status(400).json({ error: 'Invalid campaign or recipient ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const recipient = await CampaignRecipient.findOne({
      _id: recipientId,
      campaignId: id,
    });
    if (!recipient) {
      res.status(404).json({ error: 'Recipient not found.', code: 'NOT_FOUND' });
      return;
    }

    if (recipient.status === 'sending' || recipient.status === 'sent' || recipient.status === 'ambiguous') {
      res.status(409).json({
        error: `Cannot remove recipient in "${recipient.status}" state.`,
        code: 'RECIPIENT_LOCKED',
      });
      return;
    }

    await CampaignRecipient.deleteOne({ _id: recipient._id });
    const counts = await recomputeCampaignStats(id);
    res.json({ ok: true, id: recipientId, counts });
  } catch (err) {
    console.error('[Outreach Desk] Failed to remove recipient:', err);
    res.status(500).json({
      error: 'Failed to remove campaign recipient.',
      code: 'RECIPIENT_REMOVE_FAILED',
    });
  }
});

campaignsRouter.post('/:id/launch', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const campaign = await Campaign.findById(id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    if (campaign.status === 'Completed' || campaign.status === 'Cancelled') {
      res.status(409).json({
        error: `Cannot launch a ${campaign.status.toLowerCase()} campaign.`,
        code: 'INVALID_TRANSITION',
      });
      return;
    }

    if (campaign.status === 'Sending') {
      const countsMap = await aggregateCampaignRecipientCounts([id]);
      res.json({
        ok: true,
        campaign: serializeCampaign(campaign, { counts: countsMap.get(id) }),
      });
      return;
    }

    if (!mongoose.isValidObjectId(campaign.mailboxId)) {
      res.status(400).json({ error: 'Campaign mailbox is invalid.', code: 'INVALID_MAILBOX_ID' });
      return;
    }

    const mailbox = await Mailbox.findById(campaign.mailboxId)
      .select('name senderEmail enabled archived verificationStatus')
      .lean();
    if (!mailbox || mailbox.archived) {
      res.status(404).json({ error: 'Selected mailbox not found.', code: 'MAILBOX_NOT_FOUND' });
      return;
    }
    if (!mailbox.enabled) {
      res.status(400).json({
        error: 'Enable the selected mailbox in Settings before launching.',
        code: 'MAILBOX_DISABLED',
      });
      return;
    }
    if (mailbox.verificationStatus !== 'verified') {
      res.status(400).json({
        error: 'Verify the selected mailbox SMTP connection in Settings before launching.',
        code: 'MAILBOX_UNVERIFIED',
      });
      return;
    }

    const recipients = await CampaignRecipient.find({
      campaignId: campaign._id,
      status: { $in: ['pending', 'queued'] },
    }).lean();

    if (recipients.length === 0) {
      res.status(400).json({
        error: 'Add at least one eligible recipient before launching this campaign.',
        code: 'NO_ELIGIBLE_RECIPIENTS',
      });
      return;
    }

    const suppressedMap = await getSuppressedEmailMap(recipients.map((r) => r.email));
    let deliverableCount = 0;
    const bulkOps: Array<{
      updateOne: { filter: { _id: mongoose.Types.ObjectId }; update: { $set: Record<string, unknown> } };
    }> = [];

    for (const rec of recipients) {
      const recId = rec._id as mongoose.Types.ObjectId;
      const suppressed = suppressedMap.get(rec.email.toLowerCase());
      if (suppressed) {
        bulkOps.push({
          updateOne: {
            filter: { _id: recId },
            update: {
              $set: {
                status: 'skipped_suppressed',
                skipReason: suppressed.detail,
              },
            },
          },
        });
        continue;
      }

      const rendered = renderCampaignMessageForRecipient({
        subjectTemplate: campaign.subjectTemplate,
        bodyTextTemplate: campaign.bodyTextTemplate,
        bodyHtmlTemplate: campaign.bodyHtmlTemplate,
        customSubject: rec.customSubject,
        customBodyText: rec.customBodyText,
        customBodyHtml: rec.customBodyHtml,
        recipient: rec,
      });

      if (!rendered.subject.trim() || (!rendered.text.trim() && !rendered.html.trim())) {
        res.status(400).json({
          error: `Recipient ${rec.email} is missing rendered subject or body content.`,
          code: 'EMPTY_RENDERED_MESSAGE',
        });
        return;
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: recId },
          update: {
            $set: {
              renderedSubject: rendered.subject,
              renderedText: rendered.text,
              renderedHtml: rendered.html,
              missingPlaceholders: rendered.missingPlaceholders,
              status: 'queued',
            },
          },
        },
      });
      deliverableCount += 1;
    }

    if (bulkOps.length > 0) {
      await CampaignRecipient.bulkWrite(bulkOps, { ordered: false });
    }

    if (deliverableCount === 0) {
      await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
      res.status(400).json({
        error: 'All recipients in this campaign are currently suppressed or opted out.',
        code: 'NO_ELIGIBLE_RECIPIENTS',
      });
      return;
    }

    const now = new Date();
    campaign.status = 'Sending';
    campaign.manualApproval = {
      approved: true,
      approvedAt: campaign.manualApproval?.approvedAt || now,
    };
    campaign.startedAt = campaign.startedAt || now;
    campaign.pausedAt = undefined;
    campaign.lastError = '';
    await campaign.save();

    const counts = await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
    notifyCampaignWorker(id);

    res.json({
      ok: true,
      campaign: serializeCampaign(campaign, {
        counts,
        mailboxName: mailbox.name,
        mailboxEmail: mailbox.senderEmail,
        mailboxVerified: true,
        mailboxEnabled: true,
      }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to launch campaign:', err);
    res.status(500).json({
      error: 'Failed to launch campaign.',
      code: 'CAMPAIGN_LAUNCH_FAILED',
    });
  }
});

campaignsRouter.post('/:id/pause', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const campaign = await Campaign.findById(id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    if (campaign.status !== 'Sending' && campaign.status !== 'Approved') {
      res.status(409).json({
        error: `Cannot pause a campaign in "${campaign.status}" state.`,
        code: 'INVALID_TRANSITION',
      });
      return;
    }

    campaign.status = 'Paused';
    campaign.pausedAt = new Date();
    campaign.lease = undefined;
    await campaign.save();

    const counts = await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
    res.json({
      ok: true,
      campaign: serializeCampaign(campaign, { counts }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to pause campaign:', err);
    res.status(500).json({
      error: 'Failed to pause campaign.',
      code: 'CAMPAIGN_PAUSE_FAILED',
    });
  }
});

campaignsRouter.post('/:id/resume', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const campaign = await Campaign.findById(id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    if (campaign.status !== 'Paused' && campaign.status !== 'Failed') {
      res.status(409).json({
        error: `Cannot resume a campaign in "${campaign.status}" state.`,
        code: 'INVALID_TRANSITION',
      });
      return;
    }

    const mailbox = await Mailbox.findById(campaign.mailboxId)
      .select('name senderEmail enabled archived verificationStatus')
      .lean();
    if (!mailbox || mailbox.archived || !mailbox.enabled || mailbox.verificationStatus !== 'verified') {
      res.status(400).json({
        error: 'Campaign mailbox must be enabled and SMTP-verified before resuming.',
        code: 'MAILBOX_NOT_READY',
      });
      return;
    }

    // Move any remaining 'pending' recipients to 'queued'
    await CampaignRecipient.updateMany(
      { campaignId: campaign._id, status: 'pending' },
      { $set: { status: 'queued' } }
    );

    const remainingQueued = await CampaignRecipient.countDocuments({
      campaignId: campaign._id,
      status: { $in: ['queued', 'sending'] },
    });

    if (remainingQueued === 0) {
      campaign.status = 'Completed';
      campaign.completedAt = campaign.completedAt || new Date();
      await campaign.save();
    } else {
      campaign.status = 'Sending';
      campaign.pausedAt = undefined;
      campaign.lastError = '';
      await campaign.save();
      notifyCampaignWorker(id);
    }

    const counts = await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
    res.json({
      ok: true,
      campaign: serializeCampaign(campaign, {
        counts,
        mailboxName: mailbox.name,
        mailboxEmail: mailbox.senderEmail,
        mailboxVerified: true,
        mailboxEnabled: true,
      }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to resume campaign:', err);
    res.status(500).json({
      error: 'Failed to resume campaign.',
      code: 'CAMPAIGN_RESUME_FAILED',
    });
  }
});

campaignsRouter.post('/:id/cancel', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const campaign = await Campaign.findById(id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    if (campaign.status === 'Completed' || campaign.status === 'Cancelled') {
      const counts = await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
      res.json({ ok: true, campaign: serializeCampaign(campaign, { counts }) });
      return;
    }

    await CampaignRecipient.updateMany(
      { campaignId: campaign._id, status: { $in: ['pending', 'queued'] } },
      { $set: { status: 'cancelled', skipReason: 'Campaign cancelled by user' } }
    );

    campaign.status = 'Cancelled';
    campaign.cancelledAt = new Date();
    campaign.lease = undefined;
    await campaign.save();

    const counts = await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
    res.json({
      ok: true,
      campaign: serializeCampaign(campaign, { counts }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to cancel campaign:', err);
    res.status(500).json({
      error: 'Failed to cancel campaign.',
      code: 'CAMPAIGN_CANCEL_FAILED',
    });
  }
});

campaignsRouter.post('/:id/retry-failed', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid campaign ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const campaign = await Campaign.findById(id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.', code: 'NOT_FOUND' });
      return;
    }

    if (campaign.status === 'Cancelled') {
      res.status(409).json({
        error: 'Cannot retry recipients on a cancelled campaign.',
        code: 'INVALID_TRANSITION',
      });
      return;
    }

    // Strictly retry 'failed' only (never 'ambiguous', 'bounced', 'skipped_suppressed', or 'sent')
    const failedDocs = await CampaignRecipient.find({
      campaignId: campaign._id,
      status: 'failed',
    }).lean();

    if (failedDocs.length === 0) {
      res.status(400).json({
        error: 'No failed recipients are eligible for retry.',
        code: 'NO_FAILED_RECIPIENTS',
      });
      return;
    }

    const suppressedMap = await getSuppressedEmailMap(failedDocs.map((r) => r.email));
    let requeuedCount = 0;

    const retryOps = failedDocs.map((rec) => {
      const suppressed = suppressedMap.get(rec.email.toLowerCase());
      if (suppressed) {
        return {
          updateOne: {
            filter: { _id: rec._id },
            update: {
              $set: {
                status: 'skipped_suppressed',
                skipReason: suppressed.detail,
              },
            },
          },
        };
      }
      requeuedCount += 1;
      return {
        updateOne: {
          filter: { _id: rec._id },
          update: {
            $set: {
              status: 'queued',
              lastError: '',
              lastErrorCode: '',
            },
          },
        },
      };
    });

    if (retryOps.length > 0) {
      await CampaignRecipient.bulkWrite(retryOps, { ordered: false });
    }

    if (requeuedCount > 0) {
      campaign.status = 'Sending';
      campaign.completedAt = undefined;
      campaign.lastError = '';
      await campaign.save();
      notifyCampaignWorker(id);
    }

    const counts = await recomputeCampaignStats(campaign._id as mongoose.Types.ObjectId);
    res.json({
      ok: true,
      requeuedCount,
      campaign: serializeCampaign(campaign, { counts }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to retry failed recipients:', err);
    res.status(500).json({
      error: 'Failed to retry failed recipients.',
      code: 'CAMPAIGN_RETRY_FAILED',
    });
  }
});
