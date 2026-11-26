import mongoose, { Schema, type Document, type Model } from 'mongoose';

export const AI_GENERATION_TYPES = [
  'generate',
  'rewrite',
  'improve',
  'shorten',
  'expand',
  'change_tone',
  'subject_lines',
  'cta',
] as const;

export type AiGenerationType = (typeof AI_GENERATION_TYPES)[number];

export const AI_USAGE_STATUSES = ['success', 'error'] as const;
export type AiUsageStatus = (typeof AI_USAGE_STATUSES)[number];

export const AI_ERROR_CATEGORIES = [
  'none',
  'missing_api_key',
  'auth_error',
  'rate_limit',
  'insufficient_balance',
  'timeout',
  'cancelled',
  'model_unavailable',
  'invalid_response',
  'upstream_error',
  'validation_error',
] as const;

export type AiErrorCategory = (typeof AI_ERROR_CATEGORIES)[number];

export interface AiUsageLogDocument extends Document {
  provider: 'deepseek';
  generationType: AiGenerationType;
  modelUsed: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  status: AiUsageStatus;
  errorCategory: AiErrorCategory;
  durationMs: number;
  createdAt: Date;
  updatedAt: Date;
}

const AiUsageLogSchema = new Schema<AiUsageLogDocument>(
  {
    provider: {
      type: String,
      enum: ['deepseek'],
      default: 'deepseek',
      required: true,
    },
    generationType: {
      type: String,
      enum: AI_GENERATION_TYPES,
      required: true,
      index: true,
    },
    modelUsed: {
      type: String,
      required: true,
      trim: true,
    },
    inputTokens: {
      type: Number,
      default: null,
      min: 0,
    },
    outputTokens: {
      type: Number,
      default: null,
      min: 0,
    },
    totalTokens: {
      type: Number,
      default: null,
      min: 0,
    },
    status: {
      type: String,
      enum: AI_USAGE_STATUSES,
      required: true,
      index: true,
    },
    errorCategory: {
      type: String,
      enum: AI_ERROR_CATEGORIES,
      default: 'none',
      required: true,
    },
    durationMs: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

AiUsageLogSchema.index({ createdAt: -1 });
AiUsageLogSchema.index({ generationType: 1, createdAt: -1 });

export const AiUsageLog: Model<AiUsageLogDocument> =
  mongoose.models.AiUsageLog ||
  mongoose.model<AiUsageLogDocument>('AiUsageLog', AiUsageLogSchema);
