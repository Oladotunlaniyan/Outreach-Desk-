import mongoose, { Schema, type Document, type Model } from 'mongoose';

export const WRITING_SAMPLE_CATEGORIES = [
  'emails',
  'professional_messages',
  'partnership_pitches',
  'follow_ups',
  'general_writing',
] as const;

export type WritingSampleCategory = (typeof WRITING_SAMPLE_CATEGORIES)[number];

export const SENDER_TONE_OPTIONS = [
  '',
  'professional',
  'conversational',
  'direct',
  'persuasive',
  'friendly',
  'formal',
] as const;

export type SenderPreferredTone = (typeof SENDER_TONE_OPTIONS)[number];

export const SENDER_FORMALITY_LEVELS = [
  '',
  'casual',
  'balanced',
  'formal',
] as const;

export type SenderFormalityLevel = (typeof SENDER_FORMALITY_LEVELS)[number];

export const SENDER_LENGTH_OPTIONS = ['', 'short', 'medium', 'detailed'] as const;

export type SenderPreferredLength = (typeof SENDER_LENGTH_OPTIONS)[number];

export interface WritingSample {
  _id?: mongoose.Types.ObjectId;
  title: string;
  category: WritingSampleCategory;
  content: string;
  description: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface SenderProfileDocument extends Document {
  profileKey: string;
  // Identity
  fullName: string;
  professionalTitle: string;
  organizationName: string;
  website: string;
  professionalEmail: string;
  shortIntro: string;
  // What I do
  workDescription: string;
  offerings: string;
  primaryAudience: string;
  problemsSolved: string;
  outreachObjectives: string;
  // Credibility and proof
  verifiedAchievements: string[];
  relevantExperience: string;
  caseStudies: string[];
  approvedMetrics: string[];
  relevantPartnerships: string[];
  // Communication preferences
  preferredTone: SenderPreferredTone;
  formalityLevel: SenderFormalityLevel;
  preferredLength: SenderPreferredLength;
  sentenceStyle: string;
  commonPhrases: string[];
  dislikedPhrases: string[];
  habitsToAvoid: string[];
  // Email preferences
  defaultSignOff: string;
  emailSignature: string;
  preferredCtaStyle: string;
  includeRoleAndOrgInIntro: boolean;
  otherOutreachInstructions: string;
  // Writing samples
  writingSamples: WritingSample[];
  createdAt: Date;
  updatedAt: Date;
}

const WritingSampleSchema = new Schema<WritingSample>(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    category: {
      type: String,
      enum: WRITING_SAMPLE_CATEGORIES,
      default: 'emails',
      required: true,
    },
    content: { type: String, required: true, trim: true, maxlength: 4000 },
    description: { type: String, default: '', trim: true, maxlength: 400 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  { _id: true }
);

const SenderProfileSchema = new Schema<SenderProfileDocument>(
  {
    profileKey: {
      type: String,
      default: 'default',
      required: true,
      unique: true,
      trim: true,
    },
    // Identity
    fullName: { type: String, default: '', trim: true, maxlength: 120 },
    professionalTitle: { type: String, default: '', trim: true, maxlength: 120 },
    organizationName: { type: String, default: '', trim: true, maxlength: 160 },
    website: { type: String, default: '', trim: true, maxlength: 250 },
    professionalEmail: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    shortIntro: { type: String, default: '', trim: true, maxlength: 800 },
    // What I do
    workDescription: { type: String, default: '', trim: true, maxlength: 2000 },
    offerings: { type: String, default: '', trim: true, maxlength: 2000 },
    primaryAudience: { type: String, default: '', trim: true, maxlength: 1000 },
    problemsSolved: { type: String, default: '', trim: true, maxlength: 1500 },
    outreachObjectives: { type: String, default: '', trim: true, maxlength: 1500 },
    // Credibility and proof
    verifiedAchievements: { type: [String], default: [] },
    relevantExperience: { type: String, default: '', trim: true, maxlength: 1500 },
    caseStudies: { type: [String], default: [] },
    approvedMetrics: { type: [String], default: [] },
    relevantPartnerships: { type: [String], default: [] },
    // Communication preferences
    preferredTone: {
      type: String,
      enum: SENDER_TONE_OPTIONS,
      default: '',
    },
    formalityLevel: {
      type: String,
      enum: SENDER_FORMALITY_LEVELS,
      default: '',
    },
    preferredLength: {
      type: String,
      enum: SENDER_LENGTH_OPTIONS,
      default: '',
    },
    sentenceStyle: { type: String, default: '', trim: true, maxlength: 400 },
    commonPhrases: { type: [String], default: [] },
    dislikedPhrases: { type: [String], default: [] },
    habitsToAvoid: { type: [String], default: [] },
    // Email preferences
    defaultSignOff: { type: String, default: '', trim: true, maxlength: 120 },
    emailSignature: { type: String, default: '', trim: true, maxlength: 800 },
    preferredCtaStyle: { type: String, default: '', trim: true, maxlength: 300 },
    includeRoleAndOrgInIntro: { type: Boolean, default: true },
    otherOutreachInstructions: { type: String, default: '', trim: true, maxlength: 1500 },
    // Writing samples
    writingSamples: { type: [WritingSampleSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

export const SenderProfile: Model<SenderProfileDocument> =
  mongoose.models.SenderProfile ||
  mongoose.model<SenderProfileDocument>('SenderProfile', SenderProfileSchema);
