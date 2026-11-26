import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface LoginAttemptDocument extends Document {
  ip: string;
  failures: number;
  firstFailureAt: Date;
  lockedUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LoginAttemptSchema = new Schema<LoginAttemptDocument>(
  {
    ip: { type: String, required: true, unique: true, trim: true, maxlength: 128 },
    failures: { type: Number, required: true, default: 0, min: 0 },
    firstFailureAt: { type: Date, required: true, default: Date.now },
    lockedUntil: { type: Date },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  {
    timestamps: true,
  }
);

export const LoginAttempt: Model<LoginAttemptDocument> =
  mongoose.models.LoginAttempt ||
  mongoose.model<LoginAttemptDocument>('LoginAttempt', LoginAttemptSchema);
