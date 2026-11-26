import mongoose, { Schema, type Document, type Model } from 'mongoose';
import type { EncryptedMailboxCredential } from '../utils/mailboxCrypto.ts';
import type { SmtpSecurityMode } from '../utils/smtpSecurity.ts';

export const MAILBOX_VERIFICATION_STATUSES = [
  'untested',
  'verified',
  'failed',
] as const;

export type MailboxVerificationStatus =
  (typeof MAILBOX_VERIFICATION_STATUSES)[number];

export const MAILBOX_SECURITY_MODES = ['implicit_tls', 'starttls'] as const;

export interface MailboxDocument extends Document {
  name: string;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  securityMode: SmtpSecurityMode;
  secure: boolean;
  encryptedPassword: EncryptedMailboxCredential;
  dailyLimit: number;
  enabled: boolean;
  archived: boolean;
  archivedAt?: Date;
  verificationStatus: MailboxVerificationStatus;
  lastTestedAt?: Date;
  lastVerifiedAt?: Date;
  lastVerificationError: string;
  createdAt: Date;
  updatedAt: Date;
}

const EncryptedPasswordSchema = new Schema<EncryptedMailboxCredential>(
  {
    version: { type: String, required: true },
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
  },
  { _id: false }
);

const MailboxSchema = new Schema<MailboxDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    senderName: { type: String, required: true, trim: true, maxlength: 120 },
    senderEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    replyTo: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    smtpHost: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 253,
    },
    smtpPort: { type: Number, required: true, min: 1, max: 65535 },
    smtpUsername: { type: String, required: true, trim: true, maxlength: 254 },
    securityMode: {
      type: String,
      enum: MAILBOX_SECURITY_MODES,
      required: true,
      default: 'starttls',
    },
    secure: { type: Boolean, required: true, default: false },
    encryptedPassword: {
      type: EncryptedPasswordSchema,
      required: true,
      select: false,
    },
    dailyLimit: { type: Number, required: true, default: 50, min: 1, max: 10000 },
    enabled: { type: Boolean, required: true, default: true, index: true },
    archived: { type: Boolean, required: true, default: false, index: true },
    archivedAt: { type: Date },
    verificationStatus: {
      type: String,
      enum: MAILBOX_VERIFICATION_STATUSES,
      required: true,
      default: 'untested',
    },
    lastTestedAt: { type: Date },
    lastVerifiedAt: { type: Date },
    lastVerificationError: { type: String, default: '', trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
  }
);

MailboxSchema.index(
  { senderEmail: 1, smtpHost: 1, smtpPort: 1 },
  {
    unique: true,
    partialFilterExpression: { archived: false },
  }
);

MailboxSchema.index(
  { name: 1 },
  {
    unique: true,
    partialFilterExpression: { archived: false },
  }
);

export const Mailbox: Model<MailboxDocument> =
  mongoose.models.Mailbox || mongoose.model<MailboxDocument>('Mailbox', MailboxSchema);
