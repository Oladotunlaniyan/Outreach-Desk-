import mongoose, { Schema, type Document, type Model } from 'mongoose';

export const CAMPAIGN_STATUSES = [
  'Draft',
  'Approved',
  'Sending',
  'Paused',
  'Completed',
  'Cancelled',
  'Failed',
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface CampaignSendConfig {
  batchSize: number;
  delayMs: number;
  concurrency: number;
  dailySendCap?: number | null;
  threadFollowUps: boolean;
}

export interface CampaignWorkerLease {
  workerId?: string;
  acquiredAt?: Date;
  expiresAt?: Date;
}

export interface CampaignDocument extends Document {
  name: string;
  description: string;
  status: CampaignStatus;
  mailboxId: string;
  replyTo: string;
  subjectTemplate: string;
  bodyHtmlTemplate: string;
  bodyTextTemplate: string;
  sendConfig: CampaignSendConfig;
  lease?: CampaignWorkerLease;
  manualApproval: {
    approved: boolean;
    approvedAt?: Date;
  };
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  repliedCount: number;
  bouncedCount: number;
  lastError: string;
  startedAt?: Date;
  pausedAt?: Date;
  cancelledAt?: Date;
  completedAt?: Date;
  lastBatchAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignSchema = new Schema<CampaignDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: CAMPAIGN_STATUSES,
      default: 'Draft',
      index: true,
    },
    mailboxId: { type: String, required: true, trim: true, index: true },
    replyTo: { type: String, default: '', lowercase: true, trim: true, maxlength: 254 },
    subjectTemplate: { type: String, default: '', trim: true, maxlength: 300 },
    bodyHtmlTemplate: { type: String, default: '' },
    bodyTextTemplate: { type: String, default: '' },
    sendConfig: {
      batchSize: { type: Number, default: 8, min: 1, max: 50 },
      delayMs: { type: Number, default: 1500, min: 250, max: 30000 },
      concurrency: { type: Number, default: 1, min: 1, max: 3 },
      dailySendCap: { type: Number, default: null, min: 1, max: 10000 },
      threadFollowUps: { type: Boolean, default: true },
    },
    lease: {
      workerId: { type: String, trim: true },
      acquiredAt: { type: Date },
      expiresAt: { type: Date },
    },
    manualApproval: {
      approved: { type: Boolean, default: false },
      approvedAt: { type: Date },
    },
    totalRecipients: { type: Number, default: 0, min: 0 },
    sentCount: { type: Number, default: 0, min: 0 },
    failedCount: { type: Number, default: 0, min: 0 },
    repliedCount: { type: Number, default: 0, min: 0 },
    bouncedCount: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: '', trim: true, maxlength: 500 },
    startedAt: { type: Date },
    pausedAt: { type: Date },
    cancelledAt: { type: Date },
    completedAt: { type: Date },
    lastBatchAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

CampaignSchema.index({ status: 1, updatedAt: -1 });
CampaignSchema.index({ status: 1, 'lease.expiresAt': 1 });

export const Campaign: Model<CampaignDocument> =
  mongoose.models.Campaign || mongoose.model<CampaignDocument>('Campaign', CampaignSchema);
