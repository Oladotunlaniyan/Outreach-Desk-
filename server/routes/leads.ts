import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  EmailMessage,
  LEAD_SOURCES,
  LEAD_STATUSES,
  Lead,
  type LeadNote,
} from '../models/index.ts';
import {
  createLeadSchema,
  escapeRegex,
  isDuplicateKeyError,
  serializeLead,
  splitFullName,
  updateLeadSchema,
} from '../utils/leadValidation.ts';
import { verifyLeadEmailIntegrity } from '../utils/leadIntegrity.ts';
import { leadsImportRouter } from './leadsImport.ts';

export const leadsRouter = Router();

leadsRouter.use(requireAuth);
leadsRouter.use('/import', leadsImportRouter);

leadsRouter.use((_req: Request, res: Response, next: NextFunction) => {
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

const statusUpdateSchema = z.object({
  status: z.enum(LEAD_STATUSES),
});

const noteSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Note content is required.')
    .max(4000, 'Note cannot exceed 4,000 characters.'),
});

const baseFilterQuerySchema = z.object({
  search: z.string().trim().max(160).optional().default(''),
  source: z.enum(['all', ...LEAD_SOURCES]).optional().default('all'),
  dateRange: z.enum(['all', 'today', '7d', '30d', '90d']).optional().default('all'),
  dateFrom: z.string().trim().optional().default(''),
  dateTo: z.string().trim().optional().default(''),
  sortBy: z.enum(['createdAt', 'fullName', 'lastContactedAt']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

const listQuerySchema = baseFilterQuerySchema.extend({
  status: z.enum(['all', ...LEAD_STATUSES]).optional().default('all'),
  page: z.coerce.number().int().min(1).max(10000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const boardQuerySchema = baseFilterQuerySchema.extend({
  limitPerColumn: z.coerce.number().int().min(1).max(50).optional().default(15),
});

function buildLeadFilterAndSort(params: z.infer<typeof baseFilterQuerySchema>) {
  const { search, source, dateRange, dateFrom, dateTo, sortBy, sortOrder } = params;
  const filter: Record<string, unknown> = {};

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      { fullName: regex },
      { email: regex },
      { company: regex },
      { role: regex },
    ];
  }

  if (source !== 'all') {
    filter.source = source;
  }

  const createdAtFilter: Record<string, Date> = {};
  if (dateRange !== 'all') {
    const now = new Date();
    let start: Date;
    if (dateRange === 'today') {
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
    } else {
      const days = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
      start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }
    createdAtFilter.$gte = start;
  } else {
    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      if (!Number.isNaN(fromDate.getTime())) {
        createdAtFilter.$gte = fromDate;
      }
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      if (!Number.isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        createdAtFilter.$lte = toDate;
      }
    }
  }

  if (Object.keys(createdAtFilter).length > 0) {
    filter.createdAt = createdAtFilter;
  }

  const direction = sortOrder === 'asc' ? 1 : -1;
  const sortSpec: Record<string, 1 | -1> =
    sortBy === 'fullName'
      ? { fullName: direction, createdAt: -1 }
      : sortBy === 'lastContactedAt'
        ? { lastContactedAt: direction, createdAt: -1 }
        : { createdAt: direction };

  return { filter, sortSpec };
}

leadsRouter.get('/integrity', async (_req, res) => {
  const report = await verifyLeadEmailIntegrity();
  res.status(report.status === 'error' ? 500 : 200).json(report);
});

leadsRouter.get('/board', async (req, res) => {
  const parsed = boardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid board filter parameters.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const { limitPerColumn } = parsed.data;
  const { filter: baseFilter, sortSpec } = buildLeadFilterAndSort(parsed.data);

  try {
    const [totalCountsAgg, filteredCountsAgg, columnLeadDocs] = await Promise.all([
      Lead.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Lead.aggregate<{ _id: string; count: number }>([
        { $match: baseFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Promise.all(
        LEAD_STATUSES.map((status) =>
          Lead.find({ ...baseFilter, status })
            .sort(sortSpec)
            .limit(limitPerColumn)
            .lean()
        )
      ),
    ]);

    const totalMap = new Map<string, number>();
    let totalLeads = 0;
    for (const item of totalCountsAgg) {
      totalMap.set(item._id, item.count);
      totalLeads += item.count;
    }

    const filteredMap = new Map<string, number>();
    let totalFiltered = 0;
    for (const item of filteredCountsAgg) {
      filteredMap.set(item._id, item.count);
      totalFiltered += item.count;
    }

    const columns = LEAD_STATUSES.map((status, index) => {
      const docs = columnLeadDocs[index] || [];
      const totalInStatus = totalMap.get(status) ?? 0;
      const filteredTotal = filteredMap.get(status) ?? 0;
      return {
        status,
        totalInStatus,
        filteredTotal,
        leads: docs.map((doc) => serializeLead(doc)),
        hasMore: docs.length < filteredTotal,
      };
    });

    res.json({
      columns,
      totalLeads,
      totalFiltered,
      limitPerColumn,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to load Kanban board:', err);
    res.status(500).json({
      error: 'Failed to load pipeline board from database.',
      code: 'BOARD_QUERY_FAILED',
    });
  }
});

leadsRouter.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid lead filter parameters.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const { status, page, limit } = parsed.data;
  const { filter, sortSpec } = buildLeadFilterAndSort(parsed.data);

  if (status !== 'all') {
    filter.status = status;
  }

  try {
    const [totalLeads, totalFiltered] = await Promise.all([
      Lead.countDocuments({}),
      Lead.countDocuments(filter),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
    const safePage = Math.min(page, totalPages);
    const skip = (safePage - 1) * limit;

    const leadDocs = await Lead.find(filter)
      .sort(sortSpec)
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      leads: leadDocs.map((doc) => serializeLead(doc)),
      pagination: {
        page: safePage,
        limit,
        totalFiltered,
        totalPages,
      },
      totalLeads,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to list leads:', err);
    res.status(500).json({
      error: 'Failed to load leads from database.',
      code: 'LEADS_QUERY_FAILED',
    });
  }
});

leadsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid lead ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const leadDoc = await Lead.findById(id).lean();
    if (!leadDoc) {
      res.status(404).json({ error: 'Lead not found.', code: 'NOT_FOUND' });
      return;
    }

    const emailDocs = await EmailMessage.find({ leadId: leadDoc._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const emailHistory = emailDocs.map((msg) => ({
      id: String(msg._id),
      direction: msg.direction,
      status: msg.status,
      toEmail: msg.toEmail,
      fromEmail: msg.fromEmail,
      subject: msg.subject,
      bodyText: msg.bodyText || '',
      bodyHtml: msg.bodyHtml || '',
      messageId: msg.messageId || null,
      threadId: msg.threadId,
      error: msg.error || null,
      scheduledFor: msg.scheduledFor ? new Date(msg.scheduledFor).toISOString() : null,
      sentAt: msg.sentAt ? new Date(msg.sentAt).toISOString() : null,
      createdAt: new Date(msg.createdAt).toISOString(),
    }));

    res.json({
      lead: serializeLead(leadDoc),
      emailHistory,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to fetch lead details:', err);
    res.status(500).json({
      error: 'Failed to load lead details.',
      code: 'LEAD_DETAIL_FAILED',
    });
  }
});

leadsRouter.post('/', async (req, res) => {
  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid lead details.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const data = parsed.data;

  try {
    const existing = await Lead.findOne({ email: data.email }).select('_id').lean();
    if (existing) {
      res.status(409).json({
        error: `A lead with email "${data.email}" already exists.`,
        code: 'DUPLICATE_EMAIL',
      });
      return;
    }

    const { firstName, lastName } = splitFullName(data.fullName);
    const notes: LeadNote[] = data.initialNote
      ? [{ content: data.initialNote, createdAt: new Date(), updatedAt: new Date() }]
      : [];

    const created = await Lead.create({
      fullName: data.fullName,
      firstName,
      lastName,
      email: data.email,
      company: data.company,
      role: data.role,
      website: data.website,
      linkedinUrl: data.linkedinUrl,
      location: data.location,
      source: data.source,
      status: data.status,
      notes,
      ...(data.status === 'Meeting' ? { meetingBookedAt: new Date() } : {}),
    });

    res.status(201).json({ lead: serializeLead(created) });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(409).json({
        error: `A lead with email "${data.email}" already exists.`,
        code: 'DUPLICATE_EMAIL',
      });
      return;
    }
    console.error('[Outreach Desk] Failed to create lead:', err);
    res.status(500).json({ error: 'Failed to create lead.', code: 'LEAD_CREATE_FAILED' });
  }
});

leadsRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid lead ID.', code: 'INVALID_ID' });
    return;
  }

  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid lead update payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No fields provided to update.', code: 'VALIDATION_ERROR' });
    return;
  }

  try {
    const existingLead = await Lead.findById(id);
    if (!existingLead) {
      res.status(404).json({ error: 'Lead not found.', code: 'NOT_FOUND' });
      return;
    }

    if (updates.email && updates.email !== existingLead.email) {
      const duplicate = await Lead.findOne({
        email: updates.email,
        _id: { $ne: existingLead._id },
      })
        .select('_id')
        .lean();

      if (duplicate) {
        res.status(409).json({
          error: `A lead with email "${updates.email}" already exists.`,
          code: 'DUPLICATE_EMAIL',
        });
        return;
      }
      existingLead.email = updates.email;
    }

    if (updates.fullName !== undefined) {
      existingLead.fullName = updates.fullName;
      const { firstName, lastName } = splitFullName(updates.fullName);
      existingLead.firstName = firstName;
      existingLead.lastName = lastName;
    }
    if (updates.company !== undefined) existingLead.company = updates.company;
    if (updates.role !== undefined) existingLead.role = updates.role;
    if (updates.website !== undefined) existingLead.website = updates.website;
    if (updates.linkedinUrl !== undefined) existingLead.linkedinUrl = updates.linkedinUrl;
    if (updates.location !== undefined) existingLead.location = updates.location;
    if (updates.source !== undefined) existingLead.source = updates.source;
    if (updates.status !== undefined) {
      existingLead.status = updates.status;
      if (updates.status === 'Meeting' && !existingLead.meetingBookedAt) {
        existingLead.meetingBookedAt = new Date();
      }
    }

    await existingLead.save();
    res.json({ lead: serializeLead(existingLead) });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(409).json({
        error: 'A lead with this email address already exists.',
        code: 'DUPLICATE_EMAIL',
      });
      return;
    }
    console.error('[Outreach Desk] Failed to update lead:', err);
    res.status(500).json({ error: 'Failed to update lead.', code: 'LEAD_UPDATE_FAILED' });
  }
});

leadsRouter.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid lead ID.', code: 'INVALID_ID' });
    return;
  }

  const parsed = statusUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid pipeline status.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const lead = await Lead.findById(id);
    if (!lead) {
      res.status(404).json({ error: 'Lead not found.', code: 'NOT_FOUND' });
      return;
    }

    lead.status = parsed.data.status;
    if (parsed.data.status === 'Meeting' && !lead.meetingBookedAt) {
      lead.meetingBookedAt = new Date();
    }

    await lead.save();
    res.json({ lead: serializeLead(lead) });
  } catch (err) {
    console.error('[Outreach Desk] Failed to update lead status:', err);
    res.status(500).json({
      error: 'Failed to update pipeline status.',
      code: 'LEAD_STATUS_FAILED',
    });
  }
});

leadsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid lead ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const deleted = await Lead.findByIdAndDelete(id).lean();
    if (!deleted) {
      res.status(404).json({ error: 'Lead not found.', code: 'NOT_FOUND' });
      return;
    }

    await EmailMessage.deleteMany({ leadId: deleted._id });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[Outreach Desk] Failed to delete lead:', err);
    res.status(500).json({ error: 'Failed to delete lead.', code: 'LEAD_DELETE_FAILED' });
  }
});

leadsRouter.post('/:id/notes', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid lead ID.', code: 'INVALID_ID' });
    return;
  }

  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid note content.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const now = new Date();
    const updated = await Lead.findByIdAndUpdate(
      id,
      {
        $push: {
          notes: {
            content: parsed.data.content,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
      { new: true }
    );

    if (!updated) {
      res.status(404).json({ error: 'Lead not found.', code: 'NOT_FOUND' });
      return;
    }

    res.status(201).json({ lead: serializeLead(updated) });
  } catch (err) {
    console.error('[Outreach Desk] Failed to add lead note:', err);
    res.status(500).json({ error: 'Failed to add note.', code: 'NOTE_CREATE_FAILED' });
  }
});

leadsRouter.patch('/:id/notes/:noteId', async (req, res) => {
  const { id, noteId } = req.params;
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(noteId)) {
    res.status(400).json({ error: 'Invalid lead or note ID.', code: 'INVALID_ID' });
    return;
  }

  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid note content.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const updated = await Lead.findOneAndUpdate(
      { _id: id, 'notes._id': noteId },
      {
        $set: {
          'notes.$.content': parsed.data.content,
          'notes.$.updatedAt': new Date(),
        },
      },
      { new: true }
    );

    if (!updated) {
      res.status(404).json({ error: 'Lead or note not found.', code: 'NOT_FOUND' });
      return;
    }

    res.json({ lead: serializeLead(updated) });
  } catch (err) {
    console.error('[Outreach Desk] Failed to edit lead note:', err);
    res.status(500).json({ error: 'Failed to update note.', code: 'NOTE_UPDATE_FAILED' });
  }
});

leadsRouter.delete('/:id/notes/:noteId', async (req, res) => {
  const { id, noteId } = req.params;
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(noteId)) {
    res.status(400).json({ error: 'Invalid lead or note ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const updated = await Lead.findOneAndUpdate(
      { _id: id, 'notes._id': noteId },
      { $pull: { notes: { _id: new mongoose.Types.ObjectId(noteId) } } },
      { new: true }
    );

    if (!updated) {
      res.status(404).json({ error: 'Lead or note not found.', code: 'NOT_FOUND' });
      return;
    }

    res.json({ lead: serializeLead(updated) });
  } catch (err) {
    console.error('[Outreach Desk] Failed to delete lead note:', err);
    res.status(500).json({ error: 'Failed to delete note.', code: 'NOTE_DELETE_FAILED' });
  }
});
