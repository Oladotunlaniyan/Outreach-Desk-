import mongoose, { Schema, type Document, type Model } from 'mongoose';

export type ResearchCacheKind = 'search' | 'site_crawl';

export interface ResearchCacheDocument extends Document {
  cacheKey: string;
  kind: ResearchCacheKind;
  payload: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ResearchCacheSchema = new Schema<ResearchCacheDocument>(
  {
    cacheKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      maxlength: 256,
    },
    kind: {
      type: String,
      enum: ['search', 'site_crawl'],
      required: true,
      index: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

export const ResearchCache: Model<ResearchCacheDocument> =
  mongoose.models.ResearchCache ||
  mongoose.model<ResearchCacheDocument>('ResearchCache', ResearchCacheSchema);
