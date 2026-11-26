import { Lead } from '../models/index.ts';

export interface LeadDuplicateGroup {
  normalizedEmail: string;
  count: number;
  leadIds: string[];
}

export interface LeadIntegrityReport {
  checkedAt: string;
  collectionExists: boolean;
  indexes: Array<{
    name: string;
    key: Record<string, unknown>;
    unique: boolean;
  }>;
  emailUniqueIndexPresent: boolean;
  duplicateEmailGroupsCount: number;
  unnormalizedEmailCount: number;
  status: 'healthy' | 'conflicts_detected' | 'error';
  message: string;
  resolutionGuide: string | null;
  duplicateGroups: LeadDuplicateGroup[];
}

let lastIntegritySummary: Omit<LeadIntegrityReport, 'duplicateGroups'> | null = null;

export function getLastLeadIntegritySummary() {
  return lastIntegritySummary;
}

export async function verifyLeadEmailIntegrity(): Promise<LeadIntegrityReport> {
  const checkedAt = new Date().toISOString();

  try {
    const db = Lead.db.db;
    if (!db) {
      throw new Error('MongoDB database handle is not ready.');
    }

    const collections = await db.listCollections({ name: Lead.collection.collectionName }).toArray();
    const collectionExists = collections.length > 0;

    let rawIndexes: Array<{ name?: string; key?: Record<string, unknown>; unique?: boolean }> = [];
    if (collectionExists) {
      rawIndexes = await Lead.collection.indexes();
    }

    const indexes = rawIndexes.map((idx) => ({
      name: idx.name || 'unnamed',
      key: idx.key || {},
      unique: Boolean(idx.unique),
    }));

    let emailUniqueIndexPresent = indexes.some(
      (idx) => idx.unique && idx.key && idx.key.email === 1
    );

    const duplicateAgg = collectionExists
      ? await Lead.aggregate<{ _id: string; count: number; leadIds: unknown[] }>([
          {
            $project: {
              normalizedEmail: { $toLower: { $trim: { input: { $ifNull: ['$email', ''] } } } },
            },
          },
          {
            $group: {
              _id: '$normalizedEmail',
              count: { $sum: 1 },
              leadIds: { $push: '$_id' },
            },
          },
          {
            $match: {
              count: { $gt: 1 },
            },
          },
          { $limit: 50 },
        ])
      : [];

    const duplicateGroups: LeadDuplicateGroup[] = duplicateAgg.map((group) => ({
      normalizedEmail: group._id,
      count: group.count,
      leadIds: group.leadIds.map((id) => String(id)),
    }));

    const unnormalizedEmailCount = collectionExists
      ? await Lead.countDocuments({
          $expr: {
            $ne: ['$email', { $toLower: { $trim: { input: { $ifNull: ['$email', ''] } } } }],
          },
        })
      : 0;

    if (!emailUniqueIndexPresent && duplicateGroups.length === 0 && unnormalizedEmailCount === 0) {
      await Lead.collection.createIndex({ email: 1 }, { unique: true, background: true });
      const refreshed = await Lead.collection.indexes();
      indexes.length = 0;
      for (const idx of refreshed) {
        indexes.push({
          name: idx.name || 'unnamed',
          key: idx.key || {},
          unique: Boolean(idx.unique),
        });
      }
      emailUniqueIndexPresent = indexes.some(
        (idx) => idx.unique && idx.key && idx.key.email === 1
      );
    }

    const hasConflicts = duplicateGroups.length > 0 || unnormalizedEmailCount > 0;
    const status = hasConflicts ? 'conflicts_detected' : 'healthy';

    const message = hasConflicts
      ? `Detected ${duplicateGroups.length} duplicate email group(s) and ${unnormalizedEmailCount} unnormalized email record(s). Unique index creation was skipped to avoid destructive changes.`
      : emailUniqueIndexPresent
        ? 'Lead email unique index verified with zero conflicting records.'
        : 'No conflicting records found; unique email index pending collection initialization.';

    const resolutionGuide = hasConflicts
      ? 'Review the conflicting lead IDs in the Leads tab, merge any notes manually, update or remove redundant records, normalize email casing, and then re-run index verification.'
      : null;

    const report: LeadIntegrityReport = {
      checkedAt,
      collectionExists,
      indexes,
      emailUniqueIndexPresent,
      duplicateEmailGroupsCount: duplicateGroups.length,
      unnormalizedEmailCount,
      status,
      message,
      resolutionGuide,
      duplicateGroups,
    };

    const { duplicateGroups: _omitPii, ...safeSummary } = report;
    lastIntegritySummary = safeSummary;
    return report;
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Failed to inspect Lead indexes.';
    const report: LeadIntegrityReport = {
      checkedAt,
      collectionExists: false,
      indexes: [],
      emailUniqueIndexPresent: false,
      duplicateEmailGroupsCount: 0,
      unnormalizedEmailCount: 0,
      status: 'error',
      message: errMessage,
      resolutionGuide: null,
      duplicateGroups: [],
    };
    const { duplicateGroups: _omit, ...safeSummary } = report;
    lastIntegritySummary = safeSummary;
    return report;
  }
}
