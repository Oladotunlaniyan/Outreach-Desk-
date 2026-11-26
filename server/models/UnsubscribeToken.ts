import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface UnsubscribeTokenDocument extends Document {
  tokenHash: string;
  email: string;
  leadId?: mongoose.Types.ObjectId;
  campaignId?: mongoose.Types.ObjectId;
  emailMessageId?: mongoose.Types.ObjectId;
  usedAt?: Date;
  usedMethod?: 'GET' | 'POST';
  createdAt: Date;
  updatedAt: Date;
}

const UnsubscribeTokenSchema = new Schema<UnsubscribeTokenDocument>(
  {
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      index: true,
    },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign' },
    emailMessageId: { type: Schema.Types.ObjectId, ref: 'EmailMessage' },
    usedAt: { type: Date },
    usedMethod: { type: String, enum: ['GET', 'POST'] },
  },
  {
    timestamps: true,
  }
);

export const UnsubscribeToken: Model<UnsubscribeTokenDocument> =
  mongoose.models.UnsubscribeToken ||
  mongoose.model<UnsubscribeTokenDocument>('UnsubscribeToken', UnsubscribeTokenSchema);
