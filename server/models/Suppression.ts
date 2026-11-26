import mongoose, { Schema, type Document, type Model } from 'mongoose';

export const SUPPRESSION_REASONS = ['unsubscribe', 'hard_bounce', 'manual'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SUPPRESSION_SOURCES = [
  'one_click_post',
  'unsubscribe_link',
  'smtp_5xx',
  'webhook',
  'manual',
] as const;
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];

export interface SuppressionDocument extends Document {
  email: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  detail: string;
  leadId?: mongoose.Types.ObjectId;
  campaignId?: mongoose.Types.ObjectId;
  emailMessageId?: mongoose.Types.ObjectId;
  suppressedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SuppressionSchema = new Schema<SuppressionDocument>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      index: true,
    },
    reason: {
      type: String,
      enum: SUPPRESSION_REASONS,
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: SUPPRESSION_SOURCES,
      required: true,
      default: 'manual',
    },
    detail: { type: String, default: '', trim: true, maxlength: 500 },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    emailMessageId: { type: Schema.Types.ObjectId, ref: 'EmailMessage' },
    suppressedAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
  }
);

export const Suppression: Model<SuppressionDocument> =
  mongoose.models.Suppression ||
  mongoose.model<SuppressionDocument>('Suppression', SuppressionSchema);
