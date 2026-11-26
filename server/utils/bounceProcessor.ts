import mongoose from 'mongoose';
import { CampaignRecipient, EmailMessage } from '../models/index.ts';
import { recomputeCampaignStats } from './campaignValidation.ts';
import { suppressEmail } from './suppression.ts';

export interface BounceClassification {
  bounceType: 'hard' | 'soft' | 'none';
  isHardBounce: boolean;
  reason: string;
}

const HARD_BOUNCE_MESSAGE_PATTERNS = [
  /5\.1\.1/i,
  /5\.1\.2/i,
  /5\.1\.10/i,
  /user unknown/i,
  /no such user/i,
  /unknown user/i,
  /mailbox unavailable/i,
  /mailbox not found/i,
  /does not exist/i,
  /invalid recipient/i,
  /recipient address rejected/i,
  /bad destination mailbox/i,
  /undeliverable/i,
  /account disabled/i,
  /domain not found/i,
];

const AUTH_OR_CONFIG_CODES = new Set([530, 534, 535, 538]);

export function classifySmtpBounceError(err: unknown): BounceClassification {
  const errObj = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
    response?: unknown;
  };

  const responseCode =
    typeof errObj.responseCode === 'number' ? errObj.responseCode : undefined;
  const rawMessage = [
    typeof errObj.message === 'string' ? errObj.message : '',
    typeof errObj.response === 'string' ? errObj.response : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (typeof responseCode === 'number' && AUTH_OR_CONFIG_CODES.has(responseCode)) {
    return { bounceType: 'none', isHardBounce: false, reason: '' };
  }

  if (
    typeof responseCode === 'number' &&
    responseCode >= 500 &&
    responseCode < 600
  ) {
    const matchesHardText = HARD_BOUNCE_MESSAGE_PATTERNS.some((re) =>
      re.test(rawMessage)
    );
    if (
      responseCode === 550 ||
      responseCode === 551 ||
      responseCode === 553 ||
      matchesHardText
    ) {
      return {
        bounceType: 'hard',
        isHardBounce: true,
        reason: `SMTP ${responseCode} permanent recipient bounce`,
      };
    }
    return {
      bounceType: 'soft',
      isHardBounce: false,
      reason: `SMTP ${responseCode} delivery rejection`,
    };
  }

  if (typeof responseCode === 'number' && responseCode >= 400 && responseCode < 500) {
    return {
      bounceType: 'soft',
      isHardBounce: false,
      reason: `SMTP ${responseCode} temporary failure`,
    };
  }

  return { bounceType: 'none', isHardBounce: false, reason: '' };
}

export async function processHardBounce(params: {
  email: string;
  reason: string;
  source: 'smtp_5xx' | 'webhook' | 'manual';
  emailMessageId?: string | mongoose.Types.ObjectId;
  campaignId?: string | mongoose.Types.ObjectId;
  campaignRecipientId?: string | mongoose.Types.ObjectId;
  smtpMessageId?: string;
}): Promise<{
  email: string;
  updatedEmailMessageId: string | null;
  suppressed: boolean;
  skippedRecipientsCount: number;
}> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const detail = params.reason.trim().slice(0, 500) || 'Hard bounce detected';

  let resolvedEmailMessageId = params.emailMessageId
    ? String(params.emailMessageId)
    : null;
  let resolvedCampaignId = params.campaignId ? String(params.campaignId) : undefined;
  let resolvedRecipientId = params.campaignRecipientId
    ? String(params.campaignRecipientId)
    : undefined;

  if (resolvedEmailMessageId && mongoose.isValidObjectId(resolvedEmailMessageId)) {
    const msg = await EmailMessage.findByIdAndUpdate(
      resolvedEmailMessageId,
      {
        $set: {
          status: 'Bounced',
          bounceType: 'hard',
          errorCode: 'HARD_BOUNCE',
          error: detail,
        },
      },
      { new: true }
    )
      .select('campaignId campaignRecipientId leadId')
      .lean();
    if (msg) {
      if (!resolvedCampaignId && msg.campaignId) {
        resolvedCampaignId = String(msg.campaignId);
      }
      if (!resolvedRecipientId && msg.campaignRecipientId) {
        resolvedRecipientId = String(msg.campaignRecipientId);
      }
    }
  } else if (params.smtpMessageId) {
    const msg = await EmailMessage.findOneAndUpdate(
      { messageId: params.smtpMessageId },
      {
        $set: {
          status: 'Bounced',
          bounceType: 'hard',
          errorCode: 'HARD_BOUNCE',
          error: detail,
        },
      },
      { new: true }
    )
      .select('_id campaignId campaignRecipientId')
      .lean();
    if (msg) {
      resolvedEmailMessageId = String(msg._id);
      if (!resolvedCampaignId && msg.campaignId) {
        resolvedCampaignId = String(msg.campaignId);
      }
      if (!resolvedRecipientId && msg.campaignRecipientId) {
        resolvedRecipientId = String(msg.campaignRecipientId);
      }
    }
  } else {
    const latest = await EmailMessage.findOneAndUpdate(
      { toEmail: normalizedEmail, status: { $in: ['sent', 'Sent'] } },
      {
        $set: {
          status: 'Bounced',
          bounceType: 'hard',
          errorCode: 'HARD_BOUNCE',
          error: detail,
        },
      },
      { sort: { sentAt: -1, createdAt: -1 }, new: true }
    )
      .select('_id campaignId campaignRecipientId')
      .lean();
    if (latest) {
      resolvedEmailMessageId = String(latest._id);
      if (!resolvedCampaignId && latest.campaignId) {
        resolvedCampaignId = String(latest.campaignId);
      }
      if (!resolvedRecipientId && latest.campaignRecipientId) {
        resolvedRecipientId = String(latest.campaignRecipientId);
      }
    }
  }

  if (resolvedRecipientId && mongoose.isValidObjectId(resolvedRecipientId)) {
    const rec = await CampaignRecipient.findByIdAndUpdate(
      resolvedRecipientId,
      {
        $set: {
          status: 'bounced',
          lastErrorCode: 'HARD_BOUNCE',
          lastError: detail,
        },
      },
      { new: true }
    )
      .select('campaignId')
      .lean();
    if (rec) {
      await recomputeCampaignStats(rec.campaignId);
    }
  } else if (resolvedEmailMessageId) {
    const rec = await CampaignRecipient.findOneAndUpdate(
      { emailMessageId: resolvedEmailMessageId },
      {
        $set: {
          status: 'bounced',
          lastErrorCode: 'HARD_BOUNCE',
          lastError: detail,
        },
      },
      { new: true }
    )
      .select('campaignId')
      .lean();
    if (rec) {
      await recomputeCampaignStats(rec.campaignId);
    }
  }

  const suppressResult = await suppressEmail({
    email: normalizedEmail,
    reason: 'hard_bounce',
    source: params.source,
    detail,
    ...(resolvedCampaignId ? { campaignId: resolvedCampaignId } : {}),
    ...(resolvedEmailMessageId ? { emailMessageId: resolvedEmailMessageId } : {}),
  });

  return {
    email: normalizedEmail,
    updatedEmailMessageId: resolvedEmailMessageId,
    suppressed: suppressResult.suppressed,
    skippedRecipientsCount: suppressResult.skippedRecipientsCount,
  };
}
