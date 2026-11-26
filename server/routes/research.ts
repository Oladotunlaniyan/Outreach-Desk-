import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import { LeadResearchJob } from '../models/index.ts';
import { textToBasicEmailHtml } from '../utils/htmlSanitizer.ts';
import {
  annotateProspectDuplicates,
  createLeadResearchJob,
  createResearchJobSchema,
  generateResearchDraftEmails,
  importApprovedResearchProspects,
  recomputeJobCounts,
  serializeResearchJob,
  triggerResearchJobWorker,
  updateProspectSchema,
} from '../utils/leadResearcher.ts';

export const researchRouter = Router();

researchRouter.use(requireAuth);
researchRouter.use((_req: Request, res: Response, next: NextFunction) => {
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

researchRouter.get('/jobs', async (_req, res) => {
  try {
    const jobs = await LeadResearchJob.find({})
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({
      jobs: jobs.map((job) => serializeResearchJob(job)),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to list research jobs:', err);
    res.status(500).json({
      error: 'Failed to load AI lead research jobs.',
      code: 'RESEARCH_LIST_FAILED',
    });
  }
});

researchRouter.post('/jobs', async (req, res) => {
  const parsed = createResearchJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid lead research query.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const job = await createLeadResearchJob(parsed.data);
    res.status(201).json({
      job: serializeResearchJob(job),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to start research job:', err);
    res.status(500).json({
      error: 'Failed to create AI lead research job.',
      code: 'RESEARCH_CREATE_FAILED',
    });
  }
});

researchRouter.get('/jobs/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid research job ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const job = await LeadResearchJob.findById(id);
    if (!job) {
      res.status(404).json({ error: 'Research job not found.', code: 'NOT_FOUND' });
      return;
    }

    res.json({
      job: serializeResearchJob(job),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to load research job:', err);
    res.status(500).json({
      error: 'Failed to load research job.',
      code: 'RESEARCH_FETCH_FAILED',
    });
  }
});

researchRouter.post('/jobs/:id/pause', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid research job ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const job = await LeadResearchJob.findById(id);
    if (!job) {
      res.status(404).json({ error: 'Research job not found.', code: 'NOT_FOUND' });
      return;
    }

    if (job.status === 'Running' || job.status === 'Pending') {
      job.status = 'Paused';
      job.pausedAt = new Date();
      job.progress.lastStepMessage = 'Paused by user — progress saved. Click Resume to continue.';
      await job.save();
    }

    res.json({ job: serializeResearchJob(job) });
  } catch (err) {
    console.error('[Outreach Desk] Failed to pause research job:', err);
    res.status(500).json({ error: 'Failed to pause research job.', code: 'RESEARCH_PAUSE_FAILED' });
  }
});

researchRouter.post('/jobs/:id/resume', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid research job ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const job = await LeadResearchJob.findById(id);
    if (!job) {
      res.status(404).json({ error: 'Research job not found.', code: 'NOT_FOUND' });
      return;
    }

    if (job.status === 'Completed' || job.status === 'Cancelled') {
      res.status(400).json({
        error: `Cannot resume a job with status "${job.status}".`,
        code: 'INVALID_STATE',
      });
      return;
    }

    if (job.status !== 'Running') {
      job.status = 'Pending';
      job.lastError = null;
      job.resumeAfter = null;
      job.workerLease = undefined;
      job.progress.lastStepMessage = 'Resuming from saved checkpoint...';
      await job.save();
    }

    triggerResearchJobWorker(String(job._id));
    res.json({ job: serializeResearchJob(job) });
  } catch (err) {
    console.error('[Outreach Desk] Failed to resume research job:', err);
    res.status(500).json({ error: 'Failed to resume research job.', code: 'RESEARCH_RESUME_FAILED' });
  }
});

researchRouter.post('/jobs/:id/cancel', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid research job ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const job = await LeadResearchJob.findById(id);
    if (!job) {
      res.status(404).json({ error: 'Research job not found.', code: 'NOT_FOUND' });
      return;
    }

    if (job.status !== 'Completed') {
      job.status = 'Cancelled';
      job.workerLease = undefined;
      job.progress.lastStepMessage = 'Cancelled by user.';
      await job.save();
    }

    res.json({ job: serializeResearchJob(job) });
  } catch (err) {
    console.error('[Outreach Desk] Failed to cancel research job:', err);
    res.status(500).json({ error: 'Failed to cancel research job.', code: 'RESEARCH_CANCEL_FAILED' });
  }
});

researchRouter.delete('/jobs/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid research job ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const deleted = await LeadResearchJob.findByIdAndDelete(id).lean();
    if (!deleted) {
      res.status(404).json({ error: 'Research job not found.', code: 'NOT_FOUND' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[Outreach Desk] Failed to delete research job:', err);
    res.status(500).json({ error: 'Failed to delete research job.', code: 'RESEARCH_DELETE_FAILED' });
  }
});

researchRouter.patch('/jobs/:id/prospects/:prospectId', async (req, res) => {
  const { id, prospectId } = req.params;
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(prospectId)) {
    res.status(400).json({ error: 'Invalid job or prospect ID.', code: 'INVALID_ID' });
    return;
  }

  const parsed = updateProspectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid prospect update payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const job = await LeadResearchJob.findById(id);
    if (!job) {
      res.status(404).json({ error: 'Research job not found.', code: 'NOT_FOUND' });
      return;
    }

    const prospect = job.prospects.find((p) => String(p._id) === prospectId);
    if (!prospect) {
      res.status(404).json({ error: 'Prospect not found in this job.', code: 'NOT_FOUND' });
      return;
    }

    const updates = parsed.data;
    if (updates.fullName !== undefined) {
      prospect.fullName = updates.fullName;
      const parts = updates.fullName.trim().split(/\s+/).filter(Boolean);
      prospect.firstName = parts[0] || '';
      prospect.lastName = parts.slice(1).join(' ');
    }
    if (updates.role !== undefined) {
      prospect.role = updates.role;
    }
    if (updates.email !== undefined && updates.email !== prospect.email) {
      prospect.email = updates.email;
      if (!updates.email) {
        prospect.emailConfidence = 'not_found';
        prospect.emailEvidence = {
          foundOnUrl: '',
          contactType: 'none',
          verificationNote: 'Email cleared by user.',
        };
      } else {
        prospect.emailConfidence = 'inferred_unverified';
        prospect.emailEvidence = {
          foundOnUrl: prospect.website || '',
          contactType: 'snippet_only',
          verificationNote: 'Manually entered or edited by user (requires manual verification).',
        };
      }
      await annotateProspectDuplicates([prospect]);
    }
    if (updates.reviewStatus !== undefined && prospect.reviewStatus !== 'imported') {
      prospect.reviewStatus = updates.reviewStatus;
    }
    if (updates.draftSubject !== undefined || updates.draftText !== undefined) {
      const nextSubject =
        updates.draftSubject !== undefined
          ? updates.draftSubject
          : prospect.draftEmail?.subject || '';
      const nextText =
        updates.draftText !== undefined ? updates.draftText : prospect.draftEmail?.text || '';
      prospect.draftEmail = {
        subject: nextSubject,
        text: nextText,
        html: textToBasicEmailHtml(nextText),
        personalizationNotes: prospect.draftEmail?.personalizationNotes || [],
        missingInformation: prospect.draftEmail?.missingInformation || [],
        generatedAt: prospect.draftEmail?.generatedAt || new Date(),
        model: prospect.draftEmail?.model || 'manual',
        senderProfileUsed: Boolean(prospect.draftEmail?.senderProfileUsed),
        edited: true,
      };
    }

    recomputeJobCounts(job);
    await job.save();
    res.json({ job: serializeResearchJob(job) });
  } catch (err) {
    console.error('[Outreach Desk] Failed to update research prospect:', err);
    res.status(500).json({ error: 'Failed to update prospect.', code: 'PROSPECT_UPDATE_FAILED' });
  }
});

researchRouter.post('/jobs/:id/generate-emails', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid research job ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await generateResearchDraftEmails(id, req.body);
    res.json({
      ok: true,
      job: serializeResearchJob(result.job),
      generatedCount: result.generatedCount,
      skippedCount: result.skippedCount,
      pausedRateLimit: result.pausedRateLimit,
      ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to generate first-touch emails.';
    const status = message === 'Research job not found.' ? 404 : 400;
    res.status(status).json({
      error: message,
      code: status === 404 ? 'NOT_FOUND' : 'RESEARCH_DRAFT_FAILED',
    });
  }
});

researchRouter.post('/jobs/:id/import', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid research job ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const result = await importApprovedResearchProspects(id, req.body);
    res.json({
      ok: true,
      job: serializeResearchJob(result.job),
      summary: result.summary,
      ...(result.campaign ? { campaign: result.campaign } : {}),
      ...(result.campaignWarning ? { campaignWarning: result.campaignWarning } : {}),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to import approved prospects.';
    const status = message === 'Research job not found.' ? 404 : 400;
    res.status(status).json({
      error: message,
      code: status === 404 ? 'NOT_FOUND' : 'RESEARCH_IMPORT_FAILED',
    });
  }
});
