import mongoose, { Schema, type Document, type Model } from 'mongoose';

export const CAMPAIGN_RECIPIENT_STATUSES = [
  'pending',
  'queued',
  'sending',
  'sent',
  'failed',
  'bounced',
  'ambiguous',
  'skipped_suppressed',
  'cancelled',
] as const;

export type CampaignRecipientStatus = (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

export interface CampaignRecipientDocument extends Document {
  campaignId: mongoose.Types.ObjectId;
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
  customFields: Map<string, string> | Record<string, string>;
  customSubject: string;
  customBodyHtml: string;
  customBodyText: string;
  renderedSubject: string;
  renderedHtml: string;
  renderedText: string;
  missingPlaceholders: string[];
  status: CampaignRecipientStatus;
  skipReason: string;
  emailMessageId?: mongoose.Types.ObjectId;
  smtpMessageId?: string;
  threadId?: string;
  inReplyTo?: string;
  references: string[];
  attempts: number;
  lastError: string;
  lastErrorCode: string;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignRecipientSchema = new Schema<CampaignRecipientDocument>(
  {
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
      index: true,
    },
    leadId: {
      type: Schema.Types.ObjectId,
      ref: 'Lead',
      required: false,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    firstName: { type: String, default: '', trim: true, maxlength: 120 },
    lastName: { type: String, default: '', trim: true, maxlength: 120 },
    fullName: { type: String, default: '', trim: true, maxlength: 160 },
    company: { type: String, default: '', trim: true, maxlength: 160 },
    role: { type: String, default: '', trim: true, maxlength: 160 },
    website: { type: String, default: '', trim: true, maxlength: 500 },
    location: { type: String, default: '', trim: true, maxlength: 160 },
    industry: { type: String, default: '', trim: true, maxlength: 160 },
    customFields: { type: Map, of: String, default: {} },
    customSubject: { type: String, default: '', trim: true, maxlength: 300 },
    customBodyHtml: { type: String, default: '' },
    customBodyText: { type: String, default: '' },
    renderedSubject: { type: String, default: '', trim: true, maxlength: 300 },
    renderedHtml: { type: String, default: '' },
    renderedText: { type: String, default: '' },
    missingPlaceholders: { type: [String], default: [] },
    status: {
      type: String,
      enum: CAMPAIGN_RECIPIENT_STATUSES,
      default: 'pending',
      index: true,
    },
    skipReason: { type: String, default: '', trim: true, maxlength: 300 },
    emailMessageId: { type: Schema.Types.ObjectId, ref: 'EmailMessage' },
    smtpMessageId: { type: String, trim: true },
    threadId: { type: String, trim: true },
    inReplyTo: { type: String, trim: true },
    references: { type: [String], default: [] },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: '', trim: true, maxlength: 500 },
    lastErrorCode: { type: String, default: '', trim: true, maxlength: 80 },
    leaseOwner: { type: String, trim: true },
    leaseExpiresAt: { type: Date },
    sentAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

CampaignRecipientSchema.index({ campaignId: 1, email: 1 }, { unique: true });
CampaignRecipientSchema.index({ campaignId: 1, status: 1, createdAt: 1 });
CampaignRecipientSchema.index({ campaignId: 1, status: 1, updatedAt: 1 });
CampaignRecipientSchema.index({ campaignId: 1, status: 1, leaseExpiresAt: 1 });

export const CampaignRecipient: Model<CampaignRecipientDocument> =
  mongoose.models.CampaignRecipient ||
  mongoose.model<CampaignRecipientDocument>('CampaignRecipient', CampaignRecipientSchema);
