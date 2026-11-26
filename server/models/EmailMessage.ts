import mongoose, { Schema, type Document, type Model } from 'mongoose';

export const EMAIL_MESSAGE_STATUSES = [
  'queued',
  'sending',
  'sent',
  'failed',
  'unknown',
  // Preserved legacy statuses from earlier schema records
  'Queued',
  'Sending',
  'Sent',
  'Failed',
  'Bounced',
  'Cancelled',
] as const;

export type EmailMessageStatus = (typeof EMAIL_MESSAGE_STATUSES)[number];

export interface EmailAttemptMetadata {
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  smtpResponseCode?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  ambiguous?: boolean;
}

export interface EmailMessageDocument extends Document {
  leadId?: mongoose.Types.ObjectId;
  campaignId?: mongoose.Types.ObjectId;
  campaignRecipientId?: mongoose.Types.ObjectId;
  mailboxId: string;
  mailboxName: string;
  direction: 'outbound' | 'inbound';
  status: EmailMessageStatus;
  toEmail: string;
  fromEmail: string;
  replyTo?: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  hasHtml: boolean;
  hasText: boolean;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  threadId: string;
  unsubscribeTokenId?: string;
  bounceType?: 'hard' | 'soft' | 'unknown';
  attempts: number;
  error?: string;
  errorCode?: string;
  idempotencyKey?: string;
  attemptMeta?: EmailAttemptMetadata;
  scheduledFor?: Date;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailAttemptMetadataSchema = new Schema<EmailAttemptMetadata>(
  {
    startedAt: { type: Date },
    completedAt: { type: Date },
    durationMs: { type: Number, min: 0 },
    smtpResponseCode: { type: Number },
    acceptedCount: { type: Number, min: 0 },
    rejectedCount: { type: Number, min: 0 },
    ambiguous: { type: Boolean, default: false },
  },
  { _id: false }
);

const EmailMessageSchema = new Schema<EmailMessageDocument>(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: false, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    campaignRecipientId: { type: Schema.Types.ObjectId, ref: 'CampaignRecipient', index: true },
    mailboxId: { type: String, required: true, trim: true, index: true },
    mailboxName: { type: String, default: '', trim: true },
    direction: {
      type: String,
      enum: ['outbound', 'inbound'],
      default: 'outbound',
      index: true,
    },
    status: {
      type: String,
      enum: EMAIL_MESSAGE_STATUSES,
      default: 'queued',
      index: true,
    },
    toEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    fromEmail: { type: String, required: true, lowercase: true, trim: true },
    replyTo: { type: String, lowercase: true, trim: true },
    subject: { type: String, required: true, trim: true },
    bodyHtml: { type: String, default: '' },
    bodyText: { type: String, default: '' },
    hasHtml: { type: Boolean, default: false },
    hasText: { type: Boolean, default: false },
    messageId: { type: String, trim: true, index: true },
    inReplyTo: { type: String, trim: true },
    references: { type: [String], default: [] },
    threadId: { type: String, required: true, trim: true, index: true },
    unsubscribeTokenId: { type: String, trim: true },
    bounceType: { type: String, enum: ['hard', 'soft', 'unknown'] },
    attempts: { type: Number, default: 0, min: 0 },
    error: { type: String, trim: true },
    errorCode: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true },
    attemptMeta: { type: EmailAttemptMetadataSchema },
    scheduledFor: { type: Date },
    sentAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

EmailMessageSchema.index({ campaignId: 1, leadId: 1, direction: 1 });
EmailMessageSchema.index({ status: 1, scheduledFor: 1 });
EmailMessageSchema.index({ direction: 1, createdAt: -1 });
EmailMessageSchema.index({ toEmail: 1, direction: 1, status: 1, sentAt: -1 });
EmailMessageSchema.index(
  { mailboxId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }
);

export const EmailMessage: Model<EmailMessageDocument> =
  mongoose.models.EmailMessage ||
  mongoose.model<EmailMessageDocument>('EmailMessage', EmailMessageSchema);
