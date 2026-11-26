import { z } from 'zod';
import {
  LEAD_SOURCES,
  LEAD_STATUSES,
  type LeadDocument,
  type LeadHistoryEntry,
  type LeadNote,
  type LeadSource,
  type LeadStatus,
} from '../models/index.ts';

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

export function normalizeOptionalUrl(value: string): { ok: true; value: string } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: '' };

  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return { ok: false };
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false };
    }
    if (!parsed.hostname.includes('.')) {
      return { ok: false };
    }
    return { ok: true, value: parsed.toString() };
  } catch {
    return { ok: false };
  }
}

export const optionalUrlSchema = z
  .string()
  .max(500)
  .optional()
  .default('')
  .transform((val, ctx) => {
    const res = normalizeOptionalUrl(val);
    if (!res.ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be a valid http(s) URL (e.g. https://example.com).',
      });
      return z.NEVER;
    }
    return res.value;
  });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Please provide a valid email address.')
  .max(254);

export const createLeadSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required.').max(160),
  email: emailSchema,
  company: z.string().trim().max(160).optional().default(''),
  role: z.string().trim().max(160).optional().default(''),
  website: optionalUrlSchema,
  linkedinUrl: optionalUrlSchema,
  location: z.string().trim().max(160).optional().default(''),
  source: z.enum(LEAD_SOURCES).optional().default('manual'),
  status: z.enum(LEAD_STATUSES).optional().default('New'),
  initialNote: z.string().trim().max(4000).optional().default(''),
});

export const updateLeadSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name cannot be empty.').max(160).optional(),
  email: emailSchema.optional(),
  company: z.string().trim().max(160).optional(),
  role: z.string().trim().max(160).optional(),
  website: z
    .string()
    .max(500)
    .optional()
    .transform((val, ctx) => {
      if (val === undefined) return undefined;
      const res = normalizeOptionalUrl(val);
      if (!res.ok) {
        ctx.addIssue({
          code: 'custom',
          message: 'Website must be a valid http(s) URL.',
        });
        return z.NEVER;
      }
      return res.value;
    }),
  linkedinUrl: z
    .string()
    .max(500)
    .optional()
    .transform((val, ctx) => {
      if (val === undefined) return undefined;
      const res = normalizeOptionalUrl(val);
      if (!res.ok) {
        ctx.addIssue({
          code: 'custom',
          message: 'LinkedIn URL must be a valid http(s) URL.',
        });
        return z.NEVER;
      }
      return res.value;
    }),
  location: z.string().trim().max(160).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
});

export function normalizeCsvSource(raw: string): LeadSource | null {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return 'csv';
  if (normalized === 'csv') return 'csv';
  if (normalized === 'manual') return 'manual';
  if (normalized === 'ai_research' || normalized === 'ai') return 'ai_research';
  return null;
}

export function normalizeCsvStatus(raw: string): LeadStatus | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return 'New';
  const match = LEAD_STATUSES.find((status) => status.toLowerCase() === normalized);
  return match ?? null;
}

export function serializeNote(note: LeadNote) {
  return {
    id: note._id ? String(note._id) : '',
    content: note.content,
    createdAt:
      note.createdAt instanceof Date ? note.createdAt.toISOString() : String(note.createdAt),
    updatedAt: note.updatedAt
      ? note.updatedAt instanceof Date
        ? note.updatedAt.toISOString()
        : String(note.updatedAt)
      : null,
  };
}

export function serializeLead(lead: LeadDocument | (Record<string, unknown> & { _id: unknown })) {
  const doc = lead as unknown as {
    _id: unknown;
    email: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    company?: string;
    role?: string;
    website?: string;
    linkedinUrl?: string;
    location?: string;
    industry?: string;
    status: LeadDocument['status'];
    source: LeadDocument['source'];
    tags?: string[];
    notes?: LeadNote[];
    customFields?: Map<string, string> | Record<string, string>;
    optedOut?: boolean;
    optedOutAt?: Date;
    bounced?: boolean;
    bouncedAt?: Date;
    bounceReason?: string;
    emailCount?: number;
    lastSenderId?: string;
    lastContactedAt?: Date;
    lastRepliedAt?: Date;
    meetingBookedAt?: Date;
    history?: LeadHistoryEntry[];
    createdAt: Date;
    updatedAt: Date;
  };

  const notes = Array.isArray(doc.notes) ? doc.notes.map(serializeNote) : [];
  const sortedNotes = [...notes].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const customFields: Record<string, string> = {};
  if (doc.customFields instanceof Map) {
    for (const [k, v] of doc.customFields.entries()) {
      customFields[String(k)] = String(v ?? '');
    }
  } else if (doc.customFields && typeof doc.customFields === 'object') {
    for (const [k, v] of Object.entries(doc.customFields)) {
      customFields[k] = String(v ?? '');
    }
  }

  const history = Array.isArray(doc.history)
    ? [...doc.history]
        .map((entry) => ({
          id: entry._id ? String(entry._id) : '',
          status: entry.status,
          at: entry.at instanceof Date ? entry.at.toISOString() : String(entry.at),
          note: entry.note || '',
        }))
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    : [];

  return {
    id: String(doc._id),
    email: doc.email,
    firstName: doc.firstName || '',
    lastName: doc.lastName || '',
    fullName:
      doc.fullName ||
      [doc.firstName, doc.lastName].filter(Boolean).join(' ').trim() ||
      doc.email,
    company: doc.company || '',
    role: doc.role || '',
    website: doc.website || '',
    linkedinUrl: doc.linkedinUrl || '',
    location: doc.location || '',
    industry: doc.industry || '',
    status: doc.status,
    source: doc.source,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    notes: sortedNotes,
    notesCount: sortedNotes.length,
    customFields,
    optedOut: Boolean(doc.optedOut),
    optedOutAt: doc.optedOutAt ? new Date(doc.optedOutAt).toISOString() : null,
    bounced: Boolean(doc.bounced),
    bouncedAt: doc.bouncedAt ? new Date(doc.bouncedAt).toISOString() : null,
    bounceReason: doc.bounceReason || '',
    emailCount: typeof doc.emailCount === 'number' ? doc.emailCount : 0,
    lastSenderId: doc.lastSenderId || '',
    lastContactedAt: doc.lastContactedAt ? new Date(doc.lastContactedAt).toISOString() : null,
    lastRepliedAt: doc.lastRepliedAt ? new Date(doc.lastRepliedAt).toISOString() : null,
    meetingBookedAt: doc.meetingBookedAt ? new Date(doc.meetingBookedAt).toISOString() : null,
    history,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; cause?: unknown };
  if (candidate.code === 11000 || candidate.code === 11001) {
    return true;
  }
  if (typeof candidate.cause === 'object' && candidate.cause !== null) {
    const causeCode = (candidate.cause as { code?: unknown }).code;
    if (causeCode === 11000 || causeCode === 11001) {
      return true;
    }
  }
  return false;
}
