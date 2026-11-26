import mongoose, { Schema, type Document, type Model } from 'mongoose';

export const RESEARCH_JOB_STATUSES = [
  'Pending',
  'Running',
  'Paused',
  'Completed',
  'Failed',
  'Cancelled',
] as const;

export type ResearchJobStatus = (typeof RESEARCH_JOB_STATUSES)[number];

export const EMAIL_CONFIDENCE_LEVELS = [
  'verified_published',
  'published_generic',
  'inferred_unverified',
  'not_found',
] as const;

export type EmailConfidenceLevel = (typeof EMAIL_CONFIDENCE_LEVELS)[number];

export const PROSPECT_REVIEW_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'imported',
] as const;

export type ProspectReviewStatus = (typeof PROSPECT_REVIEW_STATUSES)[number];

export interface ResearchCandidateEntry {
  company: string;
  domain: string;
  website: string;
  title: string;
  snippet: string;
  searchSourceUrl: string;
  processed: boolean;
}

export interface ResearchProspectDraftEmail {
  subject: string;
  text: string;
  html: string;
  personalizationNotes: string[];
  missingInformation: string[];
  generatedAt?: Date;
  model?: string;
  senderProfileUsed?: boolean;
  edited: boolean;
}

export interface ResearchProspectSubdoc {
  _id?: mongoose.Types.ObjectId;
  company: string;
  domain: string;
  industry: string;
  location: string;
  website: string;
  businessSummary: string;
  fullName: string;
  firstName: string;
  lastName: string;
  role: string;
  email: string;
  emailConfidence: EmailConfidenceLevel;
  emailEvidence: {
    foundOnUrl: string;
    contactType: 'personal' | 'role_based' | 'snippet_only' | 'none';
    verificationNote: string;
  };
  sourceUrls: string[];
  linkedinUrl: string;
  relevanceNotes: string;
  duplicateStatus: {
    isDuplicate: boolean;
    matchType: 'none' | 'email' | 'website_domain' | 'company_and_location' | 'suppressed';
    existingLeadId?: string;
    existingLeadName?: string;
    existingLeadEmail?: string;
    reason: string;
  };
  reviewStatus: ProspectReviewStatus;
  importedLeadId?: mongoose.Types.ObjectId;
  draftEmail?: ResearchProspectDraftEmail | null;
}

export interface LeadResearchJobDocument extends Document {
  query: {
    industry: string;
    location: string;
    targetRoles: string[];
    desiredCount: number;
    notes: string;
  };
  status: ResearchJobStatus;
  progress: {
    totalTarget: number;
    discoveredCount: number;
    verifiedEmailCount: number;
    importedCount: number;
    searchedQueriesCount: number;
    crawledSitesCount: number;
    batchSize: number;
    currentBatch: number;
    processedCandidateCount: number;
    totalCandidatesQueued: number;
    lastStepMessage: string;
  };
  searchQueriesExecuted: string[];
  rawCandidates: ResearchCandidateEntry[];
  prospects: ResearchProspectSubdoc[];
  lastError?: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
    at: Date;
  } | null;
  resumeAfter?: Date | null;
  workerLease?: {
    owner?: string;
    expiresAt?: Date;
  };
  startedAt?: Date;
  pausedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ResearchCandidateSchema = new Schema<ResearchCandidateEntry>(
  {
    company: { type: String, default: '', trim: true },
    domain: { type: String, default: '', trim: true, lowercase: true },
    website: { type: String, default: '', trim: true },
    title: { type: String, default: '', trim: true },
    snippet: { type: String, default: '', trim: true },
    searchSourceUrl: { type: String, default: '', trim: true },
    processed: { type: Boolean, default: false },
  },
  { _id: false }
);

const ResearchProspectSchema = new Schema<ResearchProspectSubdoc>(
  {
    company: { type: String, required: true, trim: true, maxlength: 160 },
    domain: { type: String, default: '', trim: true, lowercase: true, maxlength: 200 },
    industry: { type: String, default: '', trim: true, maxlength: 120 },
    location: { type: String, default: '', trim: true, maxlength: 160 },
    website: { type: String, default: '', trim: true, maxlength: 500 },
    businessSummary: { type: String, default: '', trim: true, maxlength: 1000 },
    fullName: { type: String, default: '', trim: true, maxlength: 160 },
    firstName: { type: String, default: '', trim: true, maxlength: 80 },
    lastName: { type: String, default: '', trim: true, maxlength: 80 },
    role: { type: String, default: '', trim: true, maxlength: 160 },
    email: { type: String, default: '', trim: true, lowercase: true, maxlength: 254 },
    emailConfidence: {
      type: String,
      enum: EMAIL_CONFIDENCE_LEVELS,
      default: 'not_found',
    },
    emailEvidence: {
      foundOnUrl: { type: String, default: '', trim: true },
      contactType: {
        type: String,
        enum: ['personal', 'role_based', 'snippet_only', 'none'],
        default: 'none',
      },
      verificationNote: { type: String, default: '', trim: true },
    },
    sourceUrls: { type: [String], default: [] },
    linkedinUrl: { type: String, default: '', trim: true, maxlength: 500 },
    relevanceNotes: { type: String, default: '', trim: true, maxlength: 600 },
    duplicateStatus: {
      isDuplicate: { type: Boolean, default: false },
      matchType: {
        type: String,
        enum: ['none', 'email', 'website_domain', 'company_and_location', 'suppressed'],
        default: 'none',
      },
      existingLeadId: { type: String, default: undefined },
      existingLeadName: { type: String, default: undefined },
      existingLeadEmail: { type: String, default: undefined },
      reason: { type: String, default: '' },
    },
    reviewStatus: {
      type: String,
      enum: PROSPECT_REVIEW_STATUSES,
      default: 'pending',
    },
    importedLeadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    draftEmail: {
      type: {
        subject: { type: String, default: '', trim: true, maxlength: 250 },
        text: { type: String, default: '', maxlength: 15000 },
        html: { type: String, default: '', maxlength: 30000 },
        personalizationNotes: { type: [String], default: [] },
        missingInformation: { type: [String], default: [] },
        generatedAt: { type: Date },
        model: { type: String, default: '' },
        senderProfileUsed: { type: Boolean, default: false },
        edited: { type: Boolean, default: false },
      },
      default: null,
    },
  },
  { _id: true }
);

const LeadResearchJobSchema = new Schema<LeadResearchJobDocument>(
  {
    query: {
      industry: { type: String, required: true, trim: true, maxlength: 120 },
      location: { type: String, required: true, trim: true, maxlength: 120 },
      targetRoles: { type: [String], default: [] },
      desiredCount: { type: Number, required: true, min: 1, max: 30 },
      notes: { type: String, default: '', trim: true, maxlength: 400 },
    },
    status: {
      type: String,
      enum: RESEARCH_JOB_STATUSES,
      default: 'Pending',
      index: true,
    },
    progress: {
      totalTarget: { type: Number, default: 10, min: 1 },
      discoveredCount: { type: Number, default: 0, min: 0 },
      verifiedEmailCount: { type: Number, default: 0, min: 0 },
      importedCount: { type: Number, default: 0, min: 0 },
      searchedQueriesCount: { type: Number, default: 0, min: 0 },
      crawledSitesCount: { type: Number, default: 0, min: 0 },
      batchSize: { type: Number, default: 3, min: 1 },
      currentBatch: { type: Number, default: 0, min: 0 },
      processedCandidateCount: { type: Number, default: 0, min: 0 },
      totalCandidatesQueued: { type: Number, default: 0, min: 0 },
      lastStepMessage: { type: String, default: 'Queued for research' },
    },
    searchQueriesExecuted: { type: [String], default: [] },
    rawCandidates: { type: [ResearchCandidateSchema], default: [] },
    prospects: { type: [ResearchProspectSchema], default: [] },
    lastError: {
      type: {
        code: { type: String, default: '' },
        message: { type: String, default: '' },
        retryAfterSeconds: { type: Number },
        at: { type: Date },
      },
      default: null,
    },
    resumeAfter: { type: Date, default: null },
    workerLease: {
      owner: { type: String },
      expiresAt: { type: Date },
    },
    startedAt: { type: Date },
    pausedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

LeadResearchJobSchema.index({ createdAt: -1 });
LeadResearchJobSchema.index({ status: 1, updatedAt: -1 });

export const LeadResearchJob: Model<LeadResearchJobDocument> =
  mongoose.models.LeadResearchJob ||
  mongoose.model<LeadResearchJobDocument>('LeadResearchJob', LeadResearchJobSchema);
