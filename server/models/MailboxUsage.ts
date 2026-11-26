import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface MailboxUsageDocument extends Document {
  mailboxId: string;
  dateKey: string;
  sentCount: number;
  reservedCount: number;
  unknownCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const MailboxUsageSchema = new Schema<MailboxUsageDocument>(
  {
    mailboxId: { type: String, required: true, trim: true },
    dateKey: { type: String, required: true, trim: true },
    sentCount: { type: Number, default: 0, min: 0 },
    reservedCount: { type: Number, default: 0, min: 0 },
    unknownCount: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
  }
);

MailboxUsageSchema.index({ mailboxId: 1, dateKey: 1 }, { unique: true });

export const MailboxUsage: Model<MailboxUsageDocument> =
  mongoose.models.MailboxUsage ||
  mongoose.model<MailboxUsageDocument>('MailboxUsage', MailboxUsageSchema);
