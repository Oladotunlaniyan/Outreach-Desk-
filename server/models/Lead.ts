import mongoose, { Schema, type Document, type Model } from 'mongoose';

export const LEAD_STATUSES = [
  'New',
  'Contacted',
  'Replied',
  'Interested',
  'Meeting',
  'Won',
  'Lost',
  'Invalid',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = ['csv', 'ai_research', 'manual'] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

export interface LeadNote {
  _id?: mongoose.Types.ObjectId;
  content: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface LeadHistoryEntry {
  _id?: mongoose.Types.ObjectId;
  status: string;
  at: Date;
  note: string;
}

export interface LeadDocument extends Document {
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  role: string;
  website: string;
  linkedinUrl: string;
  location: string;
  industry: string;
  status: LeadStatus;
  source: LeadSource;
  tags: string[];
  notes: LeadNote[];
  customFields: Record<string, string>;
  campaignId?: mongoose.Types.ObjectId;
  optedOut: boolean;
  optedOutAt?: Date;
  bounced: boolean;
  bouncedAt?: Date;
  bounceReason?: string;
  emailCount: number;
  lastSenderId: string;
  lastContactedAt?: Date;
  lastRepliedAt?: Date;
  meetingBookedAt?: Date;
  history: LeadHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const LeadNoteSchema = new Schema<LeadNote>(
  {
    content: { type: String, required: true, trim: true, maxlength: 4000 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  { _id: true }
);

const LeadHistorySchema = new Schema<LeadHistoryEntry>(
  {
    status: { type: String, required: true, trim: true, maxlength: 80 },
    at: { type: Date, default: Date.now },
    note: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { _id: true }
);

const LeadSchema = new Schema<LeadDocument>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    firstName: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    fullName: { type: String, default: '', trim: true },
    company: { type: String, default: '', trim: true, index: true },
    role: { type: String, default: '', trim: true },
    website: { type: String, default: '', trim: true },
    linkedinUrl: { type: String, default: '', trim: true },
    location: { type: String, default: '', trim: true },
    industry: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: LEAD_STATUSES,
      default: 'New',
      index: true,
    },
    source: {
      type: String,
      enum: LEAD_SOURCES,
      default: 'manual',
    },
    tags: { type: [String], default: [] },
    notes: { type: [LeadNoteSchema], default: [] },
    customFields: { type: Map, of: String, default: {} },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    optedOut: { type: Boolean, default: false, index: true },
    optedOutAt: { type: Date },
    bounced: { type: Boolean, default: false, index: true },
    bouncedAt: { type: Date },
    bounceReason: { type: String, trim: true },
    emailCount: { type: Number, default: 0, min: 0 },
    lastSenderId: { type: String, default: '', trim: true },
    lastContactedAt: { type: Date },
    lastRepliedAt: { type: Date },
    meetingBookedAt: { type: Date },
    history: { type: [LeadHistorySchema], default: [] },
  },
  {
    timestamps: true,
  }
);

LeadSchema.index({ status: 1, updatedAt: -1 });
LeadSchema.index({ company: 'text', fullName: 'text', email: 'text', role: 'text' });

export const Lead: Model<LeadDocument> =
  mongoose.models.Lead || mongoose.model<LeadDocument>('Lead', LeadSchema);
