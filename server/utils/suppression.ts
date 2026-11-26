import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { isValidHttpsPublicUrl } from '../config/env.ts';
import {
  CampaignRecipient,
  Lead,
  Suppression,
  UnsubscribeToken,
  type SuppressionReason,
  type SuppressionSource,
} from '../models/index.ts';
import { recomputeCampaignStats } from './campaignValidation.ts';
import { logEvent } from './logger.ts';

export function hashUnsubscribeToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function resolvePublicAppBaseUrl(
  explicitBaseUrl?: string,
  nodeEnvOverride?: string
): string {
  const candidate = (explicitBaseUrl || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!candidate) return '';

  const effectiveNodeEnv = nodeEnvOverride ?? process.env.NODE_ENV ?? 'development';
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) return '';
    if (effectiveNodeEnv === 'production') {
      return isValidHttpsPublicUrl(candidate) ? parsed.origin : '';
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
    return '';
  } catch {
    return '';
  }
}

export async function createUnsubscribeToken(params: {
  email: string;
  leadId?: string | mongoose.Types.ObjectId;
  campaignId?: string | mongoose.Types.ObjectId;
  emailMessageId?: string | mongoose.Types.ObjectId;
  baseUrl?: string;
}): Promise<{
  tokenId: string;
  rawToken: string;
  unsubscribeUrl: string;
}> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const rawToken = crypto.randomBytes(24).toString('base64url');
  const tokenHash = hashUnsubscribeToken(rawToken);

  const doc = await UnsubscribeToken.create({
    tokenHash,
    email: normalizedEmail,
    ...(params.leadId && mongoose.isValidObjectId(String(params.leadId))
      ? { leadId: params.leadId }
      : {}),
    ...(params.campaignId && mongoose.isValidObjectId(String(params.campaignId))
      ? { campaignId: params.campaignId }
      : {}),
    ...(params.emailMessageId && mongoose.isValidObjectId(String(params.emailMessageId))
      ? { emailMessageId: params.emailMessageId }
      : {}),
  });

  const baseUrl = resolvePublicAppBaseUrl(params.baseUrl);
  const unsubscribeUrl = baseUrl
    ? `${baseUrl}/api/unsubscribe/${rawToken}`
    : `/api/unsubscribe/${rawToken}`;

  return {
    tokenId: String(doc._id),
    rawToken,
    unsubscribeUrl,
  };
}

export interface SuppressionCheckResult {
  reason: string;
  source: string;
  detail: string;
}

export async function getSuppressedEmailMap(
  emails: string[]
): Promise<Map<string, SuppressionCheckResult>> {
  const normalized = Array.from(
    new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))
  );
  const map = new Map<string, SuppressionCheckResult>();
  if (normalized.length === 0) return map;

  const [suppressionDocs, suppressedLeadDocs] = await Promise.all([
    Suppression.find({ email: { $in: normalized } })
      .select('email reason source detail')
      .lean(),
    Lead.find({
      email: { $in: normalized },
      $or: [{ optedOut: true }, { bounced: true }, { status: 'Invalid' }],
    })
      .select('email optedOut bounced status bounceReason')
      .lean(),
  ]);

  for (const doc of suppressionDocs) {
    const email = doc.email.toLowerCase();
    map.set(email, {
      reason: doc.reason,
      source: doc.source,
      detail: doc.detail || doc.reason,
    });
  }

  for (const lead of suppressedLeadDocs) {
    const email = lead.email.toLowerCase();
    if (!map.has(email)) {
      const reason = lead.bounced
        ? 'hard_bounce'
        : lead.optedOut
          ? 'unsubscribe'
          : 'lead_invalid';
      map.set(email, {
        reason,
        source: 'lead_record',
        detail:
          lead.bounceReason ||
          (lead.bounced
            ? 'Lead marked as bounced'
            : lead.optedOut
              ? 'Lead opted out'
              : 'Lead status is Invalid'),
      });
    }
  }

  return map;
}

export async function isEmailSuppressed(
  email: string
): Promise<SuppressionCheckResult | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const map = await getSuppressedEmailMap([normalized]);
  return map.get(normalized) ?? null;
}

export async function suppressEmail(params: {
  email: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  detail?: string;
  leadId?: string | mongoose.Types.ObjectId;
  campaignId?: string | mongoose.Types.ObjectId;
  emailMessageId?: string | mongoose.Types.ObjectId;
}): Promise<{
  email: string;
  suppressed: boolean;
  skippedRecipientsCount: number;
}> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const now = new Date();
  const detailText = (params.detail || '').trim().slice(0, 500);

  await Suppression.findOneAndUpdate(
    { email: normalizedEmail },
    {
      $set: {
        reason: params.reason,
        source: params.source,
        detail: detailText,
        suppressedAt: now,
        ...(params.leadId && mongoose.isValidObjectId(String(params.leadId))
          ? { leadId: params.leadId }
          : {}),
        ...(params.campaignId && mongoose.isValidObjectId(String(params.campaignId))
          ? { campaignId: params.campaignId }
          : {}),
        ...(params.emailMessageId && mongoose.isValidObjectId(String(params.emailMessageId))
          ? { emailMessageId: params.emailMessageId }
          : {}),
      },
      $setOnInsert: {
        email: normalizedEmail,
      },
    },
    { upsert: true, new: true }
  );

  // Idempotent Lead flag + bounded Lead history update (only append history entry on first transition)
  if (params.reason === 'unsubscribe') {
    const firstOptOut = await Lead.updateOne(
      { email: normalizedEmail, optedOut: { $ne: true } },
      {
        $set: {
          optedOut: true,
          optedOutAt: now,
        },
        $push: {
          history: {
            $each: [
              {
                status: 'Opted Out',
                at: now,
                note: detailText || `Unsubscribed via ${params.source}`,
              },
            ],
            $slice: -200,
          },
        },
      }
    );
    if ((firstOptOut.modifiedCount ?? 0) === 0) {
      await Lead.updateOne(
        { email: normalizedEmail, optedOutAt: { $exists: false } },
        { $set: { optedOut: true, optedOutAt: now } }
      );
    }
  } else if (params.reason === 'hard_bounce') {
    const firstBounce = await Lead.updateOne(
      { email: normalizedEmail, bounced: { $ne: true } },
      {
        $set: {
          bounced: true,
          bouncedAt: now,
          bounceReason: detailText || 'Hard bounce (5xx)',
          status: 'Invalid',
        },
        $push: {
          history: {
            $each: [
              {
                status: 'Invalid',
                at: now,
                note: detailText || 'Hard bounce detected',
              },
            ],
            $slice: -200,
          },
        },
      }
    );
    if ((firstBounce.modifiedCount ?? 0) === 0) {
      await Lead.updateOne(
        { email: normalizedEmail },
        {
          $set: {
            bounced: true,
            status: 'Invalid',
            bounceReason: detailText || 'Hard bounce (5xx)',
          },
        }
      );
    }
  } else {
    const firstManual = await Lead.updateOne(
      { email: normalizedEmail, optedOut: { $ne: true } },
      {
        $set: {
          optedOut: true,
          optedOutAt: now,
        },
        $push: {
          history: {
            $each: [
              {
                status: 'Suppressed',
                at: now,
                note: detailText || 'Added to suppression list manually',
              },
            ],
            $slice: -200,
          },
        },
      }
    );
    if ((firstManual.modifiedCount ?? 0) === 0) {
      await Lead.updateOne(
        { email: normalizedEmail },
        { $set: { optedOut: true } }
      );
    }
  }

  const pendingRecipients = await CampaignRecipient.find({
    email: normalizedEmail,
    status: { $in: ['pending', 'queued'] },
  })
    .select('campaignId')
    .lean();

  let skippedRecipientsCount = 0;
  if (pendingRecipients.length > 0) {
    const skipLabel =
      params.reason === 'hard_bounce'
        ? 'Suppressed: Hard bounce'
        : params.reason === 'unsubscribe'
          ? 'Suppressed: Unsubscribed'
          : 'Suppressed manually';

    const updateRes = await CampaignRecipient.updateMany(
      {
        email: normalizedEmail,
        status: { $in: ['pending', 'queued'] },
      },
      {
        $set: {
          status: 'skipped_suppressed',
          skipReason: skipLabel,
        },
      }
    );
    skippedRecipientsCount = updateRes.modifiedCount ?? 0;

    const affectedCampaignIds = Array.from(
      new Set(pendingRecipients.map((r) => String(r.campaignId)))
    );
    await Promise.all(
      affectedCampaignIds.map((cid) => recomputeCampaignStats(cid))
    );
  }

  logEvent('info', 'suppression.recorded', {
    email: normalizedEmail,
    reason: params.reason,
    source: params.source,
    skippedRecipientsCount,
    campaignId: params.campaignId ? String(params.campaignId) : undefined,
  });

  return {
    email: normalizedEmail,
    suppressed: true,
    skippedRecipientsCount,
  };
}
