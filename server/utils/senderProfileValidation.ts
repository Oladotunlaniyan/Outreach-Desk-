import { z } from 'zod';
import {
  SENDER_FORMALITY_LEVELS,
  SENDER_LENGTH_OPTIONS,
  SENDER_TONE_OPTIONS,
  WRITING_SAMPLE_CATEGORIES,
  type SenderFormalityLevel,
  type SenderPreferredLength,
  type SenderPreferredTone,
  type SenderProfileDocument,
  type WritingSample,
  type WritingSampleCategory,
} from '../models/SenderProfile.ts';

export const MAX_WRITING_SAMPLES = 25;

const SINGLE_EMAIL_REGEX = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function sanitizeStringArray(items: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLen);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function stringListSchema(maxItems: number, maxLen: number) {
  return z
    .array(z.string().trim().max(maxLen))
    .max(maxItems * 2)
    .transform((items) => sanitizeStringArray(items, maxItems, maxLen));
}

function normalizeOptionalWebsite(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const optionalWebsiteSchema = z
  .string()
  .trim()
  .max(250, 'Website URL cannot exceed 250 characters.')
  .transform((val) => (val ? normalizeOptionalWebsite(val) : ''))
  .refine(
    (val) => {
      if (!val) return true;
      try {
        const parsed = new URL(val);
        return (
          (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
          Boolean(parsed.hostname) &&
          parsed.hostname.includes('.')
        );
      } catch {
        return false;
      }
    },
    { message: 'Enter a valid website URL (e.g. https://example.com).' }
  );

const optionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email address cannot exceed 254 characters.')
  .refine((val) => !val || SINGLE_EMAIL_REGEX.test(val), {
    message: 'Enter a valid professional email address.',
  });

export const updateSenderProfileSchema = z.object({
  // Identity
  fullName: z.string().trim().max(120, 'Full name cannot exceed 120 characters.').optional(),
  professionalTitle: z
    .string()
    .trim()
    .max(120, 'Professional title cannot exceed 120 characters.')
    .optional(),
  organizationName: z
    .string()
    .trim()
    .max(160, 'Organization name cannot exceed 160 characters.')
    .optional(),
  website: optionalWebsiteSchema.optional(),
  professionalEmail: optionalEmailSchema.optional(),
  shortIntro: z
    .string()
    .trim()
    .max(800, 'Short introduction cannot exceed 800 characters.')
    .optional(),
  // What I do
  workDescription: z
    .string()
    .trim()
    .max(2000, 'Work description cannot exceed 2,000 characters.')
    .optional(),
  offerings: z
    .string()
    .trim()
    .max(2000, 'Offerings cannot exceed 2,000 characters.')
    .optional(),
  primaryAudience: z
    .string()
    .trim()
    .max(1000, 'Primary audience cannot exceed 1,000 characters.')
    .optional(),
  problemsSolved: z
    .string()
    .trim()
    .max(1500, 'Problems solved cannot exceed 1,500 characters.')
    .optional(),
  outreachObjectives: z
    .string()
    .trim()
    .max(1500, 'Outreach objectives cannot exceed 1,500 characters.')
    .optional(),
  // Credibility and proof
  verifiedAchievements: stringListSchema(20, 300).optional(),
  relevantExperience: z
    .string()
    .trim()
    .max(1500, 'Relevant experience cannot exceed 1,500 characters.')
    .optional(),
  caseStudies: stringListSchema(15, 400).optional(),
  approvedMetrics: stringListSchema(15, 300).optional(),
  relevantPartnerships: stringListSchema(15, 300).optional(),
  // Communication preferences
  preferredTone: z.enum(SENDER_TONE_OPTIONS).optional(),
  formalityLevel: z.enum(SENDER_FORMALITY_LEVELS).optional(),
  preferredLength: z.enum(SENDER_LENGTH_OPTIONS).optional(),
  sentenceStyle: z
    .string()
    .trim()
    .max(400, 'Sentence style preference cannot exceed 400 characters.')
    .optional(),
  commonPhrases: stringListSchema(30, 120).optional(),
  dislikedPhrases: stringListSchema(40, 120).optional(),
  habitsToAvoid: stringListSchema(25, 200).optional(),
  // Email preferences
  defaultSignOff: z
    .string()
    .trim()
    .max(120, 'Default sign-off cannot exceed 120 characters.')
    .optional(),
  emailSignature: z
    .string()
    .trim()
    .max(800, 'Email signature cannot exceed 800 characters.')
    .optional(),
  preferredCtaStyle: z
    .string()
    .trim()
    .max(300, 'Preferred CTA style cannot exceed 300 characters.')
    .optional(),
  includeRoleAndOrgInIntro: z.boolean().optional(),
  otherOutreachInstructions: z
    .string()
    .trim()
    .max(1500, 'Other outreach instructions cannot exceed 1,500 characters.')
    .optional(),
});

export const writingSampleInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Sample title is required.')
    .max(140, 'Sample title cannot exceed 140 characters.'),
  category: z.enum(WRITING_SAMPLE_CATEGORIES).default('emails'),
  content: z
    .string()
    .trim()
    .min(10, 'Writing sample content should be at least 10 characters.')
    .max(4000, 'Writing sample content cannot exceed 4,000 characters.'),
  description: z
    .string()
    .trim()
    .max(400, 'Sample description cannot exceed 400 characters.')
    .optional()
    .default(''),
});

export const updateWritingSampleSchema = writingSampleInputSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'Provide at least one field to update.' }
);

export interface SerializedWritingSample {
  id: string;
  title: string;
  category: WritingSampleCategory;
  content: string;
  description: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface SenderProfileCompletion {
  percentage: number;
  completedFields: number;
  totalFields: number;
  hasMeaningfulProfile: boolean;
  sections: {
    identity: boolean;
    work: boolean;
    credibility: boolean;
    writingPreferences: boolean;
    emailPreferences: boolean;
    writingSamples: boolean;
  };
}

export interface SerializedSenderProfile {
  exists: boolean;
  id: string | null;
  fullName: string;
  professionalTitle: string;
  organizationName: string;
  website: string;
  professionalEmail: string;
  shortIntro: string;
  workDescription: string;
  offerings: string;
  primaryAudience: string;
  problemsSolved: string;
  outreachObjectives: string;
  verifiedAchievements: string[];
  relevantExperience: string;
  caseStudies: string[];
  approvedMetrics: string[];
  relevantPartnerships: string[];
  preferredTone: SenderPreferredTone;
  formalityLevel: SenderFormalityLevel;
  preferredLength: SenderPreferredLength;
  sentenceStyle: string;
  commonPhrases: string[];
  dislikedPhrases: string[];
  habitsToAvoid: string[];
  defaultSignOff: string;
  emailSignature: string;
  preferredCtaStyle: string;
  includeRoleAndOrgInIntro: boolean;
  otherOutreachInstructions: string;
  writingSamples: SerializedWritingSample[];
  completion: SenderProfileCompletion;
  updatedAt: string | null;
}

export interface SenderProfileDataShape {
  fullName?: string;
  professionalTitle?: string;
  organizationName?: string;
  website?: string;
  professionalEmail?: string;
  shortIntro?: string;
  workDescription?: string;
  offerings?: string;
  primaryAudience?: string;
  problemsSolved?: string;
  outreachObjectives?: string;
  verifiedAchievements?: string[];
  relevantExperience?: string;
  caseStudies?: string[];
  approvedMetrics?: string[];
  relevantPartnerships?: string[];
  preferredTone?: SenderPreferredTone;
  formalityLevel?: SenderFormalityLevel;
  preferredLength?: SenderPreferredLength;
  sentenceStyle?: string;
  commonPhrases?: string[];
  dislikedPhrases?: string[];
  habitsToAvoid?: string[];
  defaultSignOff?: string;
  emailSignature?: string;
  preferredCtaStyle?: string;
  includeRoleAndOrgInIntro?: boolean;
  otherOutreachInstructions?: string;
  writingSamples?: Array<{
    _id?: unknown;
    id?: string;
    title: string;
    category: WritingSampleCategory;
    content: string;
    description?: string;
    createdAt?: Date | string;
    updatedAt?: Date | string | null;
  }>;
}

export function computeSenderProfileCompletion(
  profile: SenderProfileDataShape | null | undefined
): SenderProfileCompletion {
  const p = profile || {};
  const checks = [
    Boolean(p.fullName?.trim()),
    Boolean(p.professionalTitle?.trim()),
    Boolean(p.organizationName?.trim()),
    Boolean(p.website?.trim()),
    Boolean(p.professionalEmail?.trim()),
    Boolean(p.shortIntro?.trim()),
    Boolean(p.workDescription?.trim()),
    Boolean(p.offerings?.trim()),
    Boolean(p.primaryAudience?.trim()),
    Boolean(p.problemsSolved?.trim()),
    Boolean(p.outreachObjectives?.trim()),
    Boolean(
      (p.verifiedAchievements && p.verifiedAchievements.length > 0) ||
        p.relevantExperience?.trim() ||
        (p.caseStudies && p.caseStudies.length > 0) ||
        (p.approvedMetrics && p.approvedMetrics.length > 0) ||
        (p.relevantPartnerships && p.relevantPartnerships.length > 0)
    ),
    Boolean(
      p.preferredTone ||
        p.formalityLevel ||
        p.preferredLength ||
        p.sentenceStyle?.trim() ||
        (p.commonPhrases && p.commonPhrases.length > 0) ||
        (p.dislikedPhrases && p.dislikedPhrases.length > 0) ||
        (p.habitsToAvoid && p.habitsToAvoid.length > 0)
    ),
    Boolean(
      p.defaultSignOff?.trim() ||
        p.emailSignature?.trim() ||
        p.preferredCtaStyle?.trim() ||
        p.otherOutreachInstructions?.trim()
    ),
    Boolean(p.writingSamples && p.writingSamples.length > 0),
  ];

  const completedFields = checks.filter(Boolean).length;
  const totalFields = checks.length;
  const percentage = Math.round((completedFields / totalFields) * 100);

  const identity = Boolean(
    p.fullName?.trim() || p.organizationName?.trim() || p.shortIntro?.trim()
  );
  const work = Boolean(
    p.workDescription?.trim() || p.offerings?.trim() || p.problemsSolved?.trim()
  );
  const credibility = Boolean(
    (p.verifiedAchievements && p.verifiedAchievements.length > 0) ||
      p.relevantExperience?.trim() ||
      (p.caseStudies && p.caseStudies.length > 0) ||
      (p.approvedMetrics && p.approvedMetrics.length > 0) ||
      (p.relevantPartnerships && p.relevantPartnerships.length > 0)
  );
  const writingPreferences = Boolean(
    p.preferredTone ||
      p.formalityLevel ||
      p.preferredLength ||
      p.sentenceStyle?.trim() ||
      (p.commonPhrases && p.commonPhrases.length > 0) ||
      (p.dislikedPhrases && p.dislikedPhrases.length > 0) ||
      (p.habitsToAvoid && p.habitsToAvoid.length > 0)
  );
  const emailPreferences = Boolean(
    p.defaultSignOff?.trim() ||
      p.emailSignature?.trim() ||
      p.preferredCtaStyle?.trim() ||
      p.otherOutreachInstructions?.trim()
  );
  const writingSamples = Boolean(p.writingSamples && p.writingSamples.length > 0);

  const hasMeaningfulProfile =
    identity ||
    work ||
    credibility ||
    writingPreferences ||
    emailPreferences ||
    writingSamples;

  return {
    percentage,
    completedFields,
    totalFields,
    hasMeaningfulProfile,
    sections: {
      identity,
      work,
      credibility,
      writingPreferences,
      emailPreferences,
      writingSamples,
    },
  };
}

export function serializeWritingSample(sample: WritingSample): SerializedWritingSample {
  return {
    id: sample._id ? String(sample._id) : '',
    title: sample.title || '',
    category: sample.category || 'emails',
    content: sample.content || '',
    description: sample.description || '',
    createdAt: sample.createdAt
      ? new Date(sample.createdAt).toISOString()
      : new Date().toISOString(),
    updatedAt: sample.updatedAt ? new Date(sample.updatedAt).toISOString() : null,
  };
}

export function createEmptySerializedSenderProfile(): SerializedSenderProfile {
  const empty: SenderProfileDataShape = { includeRoleAndOrgInIntro: true };
  return {
    exists: false,
    id: null,
    fullName: '',
    professionalTitle: '',
    organizationName: '',
    website: '',
    professionalEmail: '',
    shortIntro: '',
    workDescription: '',
    offerings: '',
    primaryAudience: '',
    problemsSolved: '',
    outreachObjectives: '',
    verifiedAchievements: [],
    relevantExperience: '',
    caseStudies: [],
    approvedMetrics: [],
    relevantPartnerships: [],
    preferredTone: '',
    formalityLevel: '',
    preferredLength: '',
    sentenceStyle: '',
    commonPhrases: [],
    dislikedPhrases: [],
    habitsToAvoid: [],
    defaultSignOff: '',
    emailSignature: '',
    preferredCtaStyle: '',
    includeRoleAndOrgInIntro: true,
    otherOutreachInstructions: '',
    writingSamples: [],
    completion: computeSenderProfileCompletion(empty),
    updatedAt: null,
  };
}

export function serializeSenderProfile(
  doc: SenderProfileDocument | (Record<string, unknown> & { _id?: unknown }) | null
): SerializedSenderProfile {
  if (!doc) {
    return createEmptySerializedSenderProfile();
  }

  const d = doc as SenderProfileDocument;
  const rawSamples = Array.isArray(d.writingSamples) ? d.writingSamples : [];
  const writingSamples = rawSamples
    .map((s) => serializeWritingSample(s))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const serialized: SerializedSenderProfile = {
    exists: true,
    id: d._id ? String(d._id) : null,
    fullName: d.fullName || '',
    professionalTitle: d.professionalTitle || '',
    organizationName: d.organizationName || '',
    website: d.website || '',
    professionalEmail: d.professionalEmail || '',
    shortIntro: d.shortIntro || '',
    workDescription: d.workDescription || '',
    offerings: d.offerings || '',
    primaryAudience: d.primaryAudience || '',
    problemsSolved: d.problemsSolved || '',
    outreachObjectives: d.outreachObjectives || '',
    verifiedAchievements: Array.isArray(d.verifiedAchievements) ? d.verifiedAchievements : [],
    relevantExperience: d.relevantExperience || '',
    caseStudies: Array.isArray(d.caseStudies) ? d.caseStudies : [],
    approvedMetrics: Array.isArray(d.approvedMetrics) ? d.approvedMetrics : [],
    relevantPartnerships: Array.isArray(d.relevantPartnerships) ? d.relevantPartnerships : [],
    preferredTone: (d.preferredTone || '') as SenderPreferredTone,
    formalityLevel: (d.formalityLevel || '') as SenderFormalityLevel,
    preferredLength: (d.preferredLength || '') as SenderPreferredLength,
    sentenceStyle: d.sentenceStyle || '',
    commonPhrases: Array.isArray(d.commonPhrases) ? d.commonPhrases : [],
    dislikedPhrases: Array.isArray(d.dislikedPhrases) ? d.dislikedPhrases : [],
    habitsToAvoid: Array.isArray(d.habitsToAvoid) ? d.habitsToAvoid : [],
    defaultSignOff: d.defaultSignOff || '',
    emailSignature: d.emailSignature || '',
    preferredCtaStyle: d.preferredCtaStyle || '',
    includeRoleAndOrgInIntro:
      typeof d.includeRoleAndOrgInIntro === 'boolean' ? d.includeRoleAndOrgInIntro : true,
    otherOutreachInstructions: d.otherOutreachInstructions || '',
    writingSamples,
    completion: computeSenderProfileCompletion(d),
    updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
  };

  return serialized;
}
