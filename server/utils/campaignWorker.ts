import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { getDatabaseStatus } from '../config/db.ts';
import {
  Campaign,
  CampaignRecipient,
  EmailMessage,
} from '../models/index.ts';
import { registerCampaignWorkerTrigger } from '../routes/campaigns.ts';
import { recomputeCampaignStats } from './campaignValidation.ts';
import {
  sendEmailViaMailbox,
  type EmailSenderDeps,
  type SendEmailInput,
  type SendEmailServiceResult,
} from './emailSender.ts';
import { normalizeReplySubject, resolveReplyThreadContext } from './emailThreading.ts';
import { renderCampaignMessageForRecipient } from './placeholderEngine.ts';
import { isEmailSuppressed } from './suppression.ts';
import { logEvent } from './logger.ts';

const WORKER_LEASE_MS = 60_000;
const RECIPIENT_LEASE_MS = 60_000;

export interface CampaignWorkerDeps {
  sendEmail?: (
    input: SendEmailInput,
    deps?: EmailSenderDeps
  ) => Promise<SendEmailServiceResult>;
  sleep?: (ms: number) => Promise<void>;
  workerId?: string;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reconcileStaleRecipients(
  campaignId: string,
  now = new Date()
): Promise<number> {
  const stale = await CampaignRecipient.find({
    campaignId,
    status: 'sending',
    $or: [
      { leaseExpiresAt: { $lte: now } },
      { leaseExpiresAt: { $exists: false } },
    ],
  });

  let reconciled = 0;
  for (const rec of stale) {
    const idempotencyKey = `campaign-${campaignId}-recipient-${String(rec._id)}`;
    const existingMsg = await EmailMessage.findOne({ idempotencyKey })
      .sort({ createdAt: -1 })
      .lean();

    if (existingMsg) {
      const normalized = String(existingMsg.status).toLowerCase();
      if (normalized === 'sent') {
        rec.status = 'sent';
        rec.sentAt = existingMsg.sentAt || now;
        rec.emailMessageId = existingMsg._id as mongoose.Types.ObjectId;
        rec.smtpMessageId = existingMsg.messageId;
        rec.threadId = existingMsg.threadId;
        rec.leaseOwner = undefined;
        rec.leaseExpiresAt = undefined;
        await rec.save();
        reconciled += 1;
        continue;
      }

      if (normalized === 'unknown') {
        rec.status = 'ambiguous';
        rec.emailMessageId = existingMsg._id as mongoose.Types.ObjectId;
        rec.lastErrorCode = existingMsg.errorCode || 'AMBIGUOUS_DELIVERY';
        rec.lastError =
          existingMsg.error ||
          'Previous send ended in an unknown state; blocked from automatic retry.';
        rec.leaseOwner = undefined;
        rec.leaseExpiresAt = undefined;
        await rec.save();
        reconciled += 1;
        continue;
      }

      if (normalized === 'bounced') {
        rec.status = 'bounced';
        rec.emailMessageId = existingMsg._id as mongoose.Types.ObjectId;
        rec.lastErrorCode = existingMsg.errorCode || 'HARD_BOUNCE';
        rec.lastError = existingMsg.error || 'Hard bounced';
        rec.leaseOwner = undefined;
        rec.leaseExpiresAt = undefined;
        await rec.save();
        reconciled += 1;
        continue;
      }
    }

    // Safe to return to queued because no confirmed/unknown EmailMessage exists
    rec.status = 'queued';
    rec.leaseOwner = undefined;
    rec.leaseExpiresAt = undefined;
    await rec.save();
    reconciled += 1;
  }

  if (reconciled > 0) {
    logEvent('info', 'worker.stale_recipients_reconciled', {
      campaignId,
      reconciledCount: reconciled,
    });
  }

  return reconciled;
}

export interface ProcessBatchResult {
  processedCount: number;
  sentCount: number;
  failedCount: number;
  bouncedCount: number;
  ambiguousCount: number;
  skippedCount: number;
  paused: boolean;
  completed: boolean;
  hasMore: boolean;
}

export async function processCampaignBatch(
  campaignId: string,
  deps: CampaignWorkerDeps = {}
): Promise<ProcessBatchResult> {
  const workerId = deps.workerId || `worker-${crypto.randomUUID().slice(0, 8)}`;
  const sendEmailFn = deps.sendEmail ?? sendEmailViaMailbox;
  const sleepFn = deps.sleep ?? defaultSleep;

  const result: ProcessBatchResult = {
    processedCount: 0,
    sentCount: 0,
    failedCount: 0,
    bouncedCount: 0,
    ambiguousCount: 0,
    skippedCount: 0,
    paused: false,
    completed: false,
    hasMore: false,
  };

  if (!mongoose.isValidObjectId(campaignId)) {
    return result;
  }

  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + WORKER_LEASE_MS);

  const campaign = await Campaign.findOneAndUpdate(
    {
      _id: campaignId,
      status: 'Sending',
      $or: [
        { 'lease.expiresAt': { $exists: false } },
        { 'lease.expiresAt': { $lte: now } },
        { 'lease.workerId': workerId },
      ],
    },
    {
      $set: {
        'lease.workerId': workerId,
        'lease.acquiredAt': now,
        'lease.expiresAt': leaseExpiry,
        lastBatchAt: now,
      },
    },
    { new: true }
  );

  if (!campaign) {
    return result;
  }

  try {
    await reconcileStaleRecipients(campaignId, now);

    const batchSize = Math.min(50, Math.max(1, campaign.sendConfig?.batchSize ?? 8));
    const delayMs = Math.min(30000, Math.max(0, campaign.sendConfig?.delayMs ?? 1500));
    const concurrency = Math.min(3, Math.max(1, campaign.sendConfig?.concurrency ?? 1));
    const dailySendCap =
      typeof campaign.sendConfig?.dailySendCap === 'number' &&
      campaign.sendConfig.dailySendCap > 0
        ? campaign.sendConfig.dailySendCap
        : null;
    const threadFollowUps = campaign.sendConfig?.threadFollowUps ?? true;

    let stopRequested = false;

    const processSingleSlot = async (slotIndex: number) => {
      if (stopRequested) return;

      // Re-check live campaign status before claiming next recipient
      const liveCampaign = await Campaign.findById(campaignId)
        .select('status sendConfig mailboxId replyTo subjectTemplate bodyTextTemplate bodyHtmlTemplate')
        .lean();
      if (!liveCampaign || liveCampaign.status !== 'Sending') {
        stopRequested = true;
        return;
      }

      if (dailySendCap !== null) {
        const startOfUtcDay = new Date(
          Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth(),
            new Date().getUTCDate(),
            0,
            0,
            0,
            0
          )
        );
        const sentTodayInCampaign = await EmailMessage.countDocuments({
          campaignId: liveCampaign._id,
          status: { $in: ['sent', 'Sent'] },
          sentAt: { $gte: startOfUtcDay },
        });
        if (sentTodayInCampaign >= dailySendCap) {
          stopRequested = true;
          result.paused = true;
          await Campaign.updateOne(
            { _id: campaignId, status: 'Sending' },
            {
              $set: {
                status: 'Paused',
                pausedAt: new Date(),
                lastError: `Campaign daily send cap (${dailySendCap}/day UTC) reached.`,
              },
            }
          );
          return;
        }
      }

      const claimNow = new Date();
      const recipientLeaseExp = new Date(claimNow.getTime() + RECIPIENT_LEASE_MS);
      const claimed = await CampaignRecipient.findOneAndUpdate(
        { campaignId, status: 'queued' },
        {
          $set: {
            status: 'sending',
            leaseOwner: workerId,
            leaseExpiresAt: recipientLeaseExp,
          },
          $inc: { attempts: 1 },
        },
        { sort: { createdAt: 1 }, new: true }
      );

      if (!claimed) {
        return;
      }

      result.processedCount += 1;

      const suppression = await isEmailSuppressed(claimed.email);
      if (suppression) {
        claimed.status = 'skipped_suppressed';
        claimed.skipReason = suppression.detail;
        claimed.leaseOwner = undefined;
        claimed.leaseExpiresAt = undefined;
        await claimed.save();
        result.skippedCount += 1;
        return;
      }

      const rendered =
        claimed.renderedSubject && (claimed.renderedText || claimed.renderedHtml)
          ? {
              subject: claimed.renderedSubject,
              text: claimed.renderedText,
              html: claimed.renderedHtml,
            }
          : renderCampaignMessageForRecipient({
              subjectTemplate: liveCampaign.subjectTemplate || '',
              bodyTextTemplate: liveCampaign.bodyTextTemplate || '',
              bodyHtmlTemplate: liveCampaign.bodyHtmlTemplate || '',
              customSubject: claimed.customSubject,
              customBodyText: claimed.customBodyText,
              customBodyHtml: claimed.customBodyHtml,
              recipient: claimed,
            });

      let finalSubject = rendered.subject;
      let threadCtx: { threadId?: string; inReplyTo?: string; references?: string[] } = {};

      if (threadFollowUps) {
        const resolved = await resolveReplyThreadContext({
          toEmail: claimed.email,
          leadId: claimed.leadId,
          threadWithPrevious: true,
        });
        if (resolved.inReplyTo) {
          threadCtx = {
            threadId: resolved.threadId,
            inReplyTo: resolved.inReplyTo,
            references: resolved.references,
          };
          if (
            resolved.previousSubject &&
            finalSubject.trim().toLowerCase() === resolved.previousSubject.trim().toLowerCase()
          ) {
            finalSubject = normalizeReplySubject(finalSubject);
          }
        }
      }

      // Re-verify live campaign status immediately prior to SMTP dispatch (prevents mid-claim pause/cancel race)
      const preSendStatus = await Campaign.findById(campaignId).select('status').lean();
      if (!preSendStatus || preSendStatus.status !== 'Sending') {
        if (preSendStatus?.status === 'Cancelled') {
          claimed.status = 'cancelled';
          claimed.skipReason = 'Campaign cancelled by user';
        } else {
          claimed.status = 'queued';
          claimed.attempts = Math.max(0, claimed.attempts - 1);
          result.paused = true;
        }
        claimed.leaseOwner = undefined;
        claimed.leaseExpiresAt = undefined;
        await claimed.save();
        stopRequested = true;
        logEvent('info', 'worker.recipient_halted_on_status_change', {
          campaignId,
          recipientId: String(claimed._id),
          campaignStatus: preSendStatus?.status ?? 'missing',
        });
        return;
      }

      const idempotencyKey = `campaign-${campaignId}-recipient-${String(claimed._id)}`;
      const sendRes = await sendEmailFn({
        mailboxId: liveCampaign.mailboxId,
        to: claimed.email,
        subject: finalSubject,
        text: rendered.text,
        html: rendered.html,
        ...(liveCampaign.replyTo ? { replyTo: liveCampaign.replyTo } : {}),
        idempotencyKey,
        leadId: claimed.leadId ? String(claimed.leadId) : undefined,
        campaignId,
        campaignRecipientId: String(claimed._id),
        threadId: threadCtx.threadId,
        inReplyTo: threadCtx.inReplyTo,
        references: threadCtx.references,
        includeUnsubscribe: true,
      });

      if (sendRes.ok) {
        claimed.status = 'sent';
        claimed.sentAt = sendRes.email.sentAt ? new Date(sendRes.email.sentAt) : new Date();
        if (mongoose.isValidObjectId(sendRes.email.id)) {
          claimed.emailMessageId = new mongoose.Types.ObjectId(sendRes.email.id);
        }
        claimed.smtpMessageId = sendRes.email.messageId || undefined;
        claimed.threadId = sendRes.email.threadId;
        claimed.inReplyTo = sendRes.email.inReplyTo || undefined;
        claimed.references = sendRes.email.references || [];
        claimed.lastError = '';
        claimed.lastErrorCode = '';
        claimed.leaseOwner = undefined;
        claimed.leaseExpiresAt = undefined;
        await claimed.save();
        result.sentCount += 1;
      } else if (
        sendRes.code === 'QUOTA_EXCEEDED' ||
        sendRes.code === 'MAILBOX_DISABLED' ||
        sendRes.code === 'MAILBOX_UNVERIFIED' ||
        sendRes.code === 'MAILBOX_ARCHIVED' ||
        sendRes.code === 'MAILBOX_NOT_FOUND'
      ) {
        claimed.status = 'queued';
        claimed.attempts = Math.max(0, claimed.attempts - 1);
        claimed.leaseOwner = undefined;
        claimed.leaseExpiresAt = undefined;
        await claimed.save();

        stopRequested = true;
        result.paused = true;
        await Campaign.updateOne(
          { _id: campaignId, status: 'Sending' },
          {
            $set: {
              status: 'Paused',
              pausedAt: new Date(),
              lastError: sendRes.error,
            },
          }
        );
      } else if (
        sendRes.ambiguous ||
        sendRes.code === 'AMBIGUOUS_DELIVERY' ||
        sendRes.code === 'AMBIGUOUS_DUPLICATE_BLOCKED' ||
        sendRes.code === 'POST_ACCEPT_DB_ERROR'
      ) {
        claimed.status = 'ambiguous';
        claimed.lastErrorCode = sendRes.code;
        claimed.lastError = sendRes.error;
        if (sendRes.email?.id && mongoose.isValidObjectId(sendRes.email.id)) {
          claimed.emailMessageId = new mongoose.Types.ObjectId(sendRes.email.id);
        }
        claimed.leaseOwner = undefined;
        claimed.leaseExpiresAt = undefined;
        await claimed.save();
        result.ambiguousCount += 1;
      } else if (sendRes.code === 'HARD_BOUNCE' || sendRes.bounceType === 'hard') {
        claimed.status = 'bounced';
        claimed.lastErrorCode = 'HARD_BOUNCE';
        claimed.lastError = sendRes.error;
        if (sendRes.email?.id && mongoose.isValidObjectId(sendRes.email.id)) {
          claimed.emailMessageId = new mongoose.Types.ObjectId(sendRes.email.id);
        }
        claimed.leaseOwner = undefined;
        claimed.leaseExpiresAt = undefined;
        await claimed.save();
        result.bouncedCount += 1;
      } else if (sendRes.code === 'EMAIL_SUPPRESSED') {
        claimed.status = 'skipped_suppressed';
        claimed.skipReason = sendRes.error;
        claimed.leaseOwner = undefined;
        claimed.leaseExpiresAt = undefined;
        await claimed.save();
        result.skippedCount += 1;
      } else {
        claimed.status = 'failed';
        claimed.lastErrorCode = sendRes.code;
        claimed.lastError = sendRes.error;
        if (sendRes.email?.id && mongoose.isValidObjectId(sendRes.email.id)) {
          claimed.emailMessageId = new mongoose.Types.ObjectId(sendRes.email.id);
        }
        claimed.leaseOwner = undefined;
        claimed.leaseExpiresAt = undefined;
        await claimed.save();
        result.failedCount += 1;
      }

      // Renew campaign lease and pace delay between sends
      await Campaign.updateOne(
        { _id: campaignId, 'lease.workerId': workerId },
        {
          $set: {
            'lease.expiresAt': new Date(Date.now() + WORKER_LEASE_MS),
            lastBatchAt: new Date(),
          },
        }
      );

      if (!stopRequested && delayMs > 0 && slotIndex + 1 < batchSize) {
        await sleepFn(delayMs);
      }
    };

    if (concurrency <= 1) {
      for (let i = 0; i < batchSize; i += 1) {
        if (stopRequested) break;
        const queuedExists = await CampaignRecipient.exists({
          campaignId,
          status: 'queued',
        });
        if (!queuedExists) break;
        await processSingleSlot(i);
      }
    } else {
      let nextSlot = 0;
      const runLane = async () => {
        while (!stopRequested) {
          const slot = nextSlot++;
          if (slot >= batchSize) break;
          const queuedExists = await CampaignRecipient.exists({
            campaignId,
            status: 'queued',
          });
          if (!queuedExists) break;
          await processSingleSlot(slot);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, batchSize) }, () => runLane())
      );
    }

    const counts = await recomputeCampaignStats(campaignId);
    const remainingQueued = counts.queued + counts.sending;

    if (!result.paused) {
      const currentCampaign = await Campaign.findById(campaignId).select('status').lean();
      if (currentCampaign?.status === 'Sending' && remainingQueued === 0) {
        await Campaign.updateOne(
          { _id: campaignId, status: 'Sending' },
          {
            $set: {
              status: 'Completed',
              completedAt: new Date(),
            },
            $unset: { lease: 1 },
          }
        );
        result.completed = true;
      } else {
        result.hasMore = remainingQueued > 0 && currentCampaign?.status === 'Sending';
      }
    }

    logEvent('info', 'worker.batch_finished', {
      campaignId,
      workerId,
      ...result,
    });

    return result;
  } finally {
    await Campaign.updateOne(
      { _id: campaignId, 'lease.workerId': workerId },
      { $unset: { lease: 1 } }
    );
  }
}

const activeLoops = new Map<string, Promise<void>>();

export function triggerCampaignWorker(campaignId: string): void {
  if (!mongoose.isValidObjectId(campaignId)) return;
  if (activeLoops.has(campaignId)) return;

  const runner = (async () => {
    try {
      while (true) {
        const db = getDatabaseStatus();
        if (!db.connected) break;

        const batchResult = await processCampaignBatch(campaignId);
        if (!batchResult.hasMore || batchResult.paused || batchResult.completed) {
          break;
        }
        await defaultSleep(200);
      }
    } catch (err) {
      logEvent('error', 'worker.loop_error', { campaignId, error: err });
      await Campaign.updateOne(
        { _id: campaignId },
        {
          $set: {
            lastError:
              err instanceof Error ? err.message : 'Unexpected campaign worker error.',
          },
          $unset: { lease: 1 },
        }
      ).catch(() => {});
    } finally {
      activeLoops.delete(campaignId);
    }
  })();

  activeLoops.set(campaignId, runner);
}

export async function recoverInterruptedCampaigns(): Promise<number> {
  const db = getDatabaseStatus();
  if (!db.connected) return 0;

  const activeCampaigns = await Campaign.find({ status: 'Sending' })
    .select('_id')
    .lean();

  for (const camp of activeCampaigns) {
    const idStr = String(camp._id);
    await reconcileStaleRecipients(idStr, new Date());
    triggerCampaignWorker(idStr);
  }

  return activeCampaigns.length;
}

registerCampaignWorkerTrigger(triggerCampaignWorker);
