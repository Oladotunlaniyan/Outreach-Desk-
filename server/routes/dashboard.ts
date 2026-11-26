import { Router } from 'express';
import { getDatabaseStatus } from '../config/db.ts';
import { getPublicMailboxSummaries } from '../config/env.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  Campaign,
  EmailMessage,
  LEAD_STATUSES,
  Lead,
  Mailbox,
  MailboxUsage,
} from '../models/index.ts';
import { serializeEmailHistoryItem } from '../utils/emailValidation.ts';
import { getUtcDateKey } from '../utils/quotaManager.ts';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get('/overview', async (_req, res) => {
  const dbStatus = getDatabaseStatus();
  const envMailboxes = getPublicMailboxSummaries();
  const now = new Date();
  const todayKey = getUtcDateKey(now);
  const startOfUtcDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );

  const fourteenDaysStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 13, 0, 0, 0, 0)
  );

  const buildEmpty14d = () => {
    const days: Array<{ dateKey: string; label: string; sent: number; failed: number }> = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i, 0, 0, 0, 0)
      );
      const dateKey = getUtcDateKey(d);
      const label = d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
      days.push({ dateKey, label, sent: 0, failed: 0 });
    }
    return days;
  };

  if (!dbStatus.connected) {
    res.json({
      dbConnected: false,
      dbState: dbStatus.state,
      dbError: dbStatus.lastError,
      metrics: null,
      todayStats: null,
      pipelineBreakdown: LEAD_STATUSES.map((status) => ({ status, count: 0 })),
      recentCampaigns: [],
      recentEmailActivity: [],
      mailboxCapacity: envMailboxes.map((mailbox) => ({
        ...mailbox,
        sentToday: 0,
        remainingToday: mailbox.dailyLimit,
      })),
      sendHistory14d: buildEmpty14d(),
    });
    return;
  }

  try {
    const [
      totalLeads,
      emailsSent,
      emailsSentToday,
      sendingFailuresToday,
      repliedCount,
      contactedPoolCount,
      interestedLeads,
      meetingsBooked,
    ] = await Promise.all([
      Lead.countDocuments().exec(),
      EmailMessage.countDocuments({
        direction: 'outbound',
        status: { $in: ['Sent', 'sent'] },
      }).exec(),
      EmailMessage.countDocuments({
        direction: 'outbound',
        status: { $in: ['Sent', 'sent'] },
        createdAt: { $gte: startOfUtcDay },
      }).exec(),
      EmailMessage.countDocuments({
        direction: 'outbound',
        status: { $in: ['Failed', 'failed', 'unknown'] },
        createdAt: { $gte: startOfUtcDay },
      }).exec(),
      Lead.countDocuments({
        status: { $in: ['Replied', 'Interested', 'Meeting', 'Won'] },
      }).exec(),
      Lead.countDocuments({
        status: { $in: ['Contacted', 'Replied', 'Interested', 'Meeting', 'Won', 'Lost'] },
      }).exec(),
      Lead.countDocuments({ status: 'Interested' }).exec(),
      Lead.countDocuments({ status: 'Meeting' }).exec(),
    ]);

    const [
      statusAggregation,
      recentCampaignDocs,
      recentEmailDocs,
      usageDocs,
      dbMailboxDocs,
      allMailboxNames,
      dailySendAgg,
    ] = await Promise.all([
      Lead.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
      Campaign.find()
        .sort({ updatedAt: -1 })
        .limit(6)
        .select(
          'name status mailboxId totalRecipients sentCount failedCount repliedCount bouncedCount manualApproval updatedAt'
        )
        .lean()
        .exec(),
      EmailMessage.find({ direction: 'outbound' })
        .sort({ createdAt: -1 })
        .limit(6)
        .lean()
        .exec(),
      MailboxUsage.find({ dateKey: todayKey }).lean().exec(),
      Mailbox.find({ archived: false, enabled: true })
        .select('-encryptedPassword')
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
      Mailbox.find().select('_id name senderEmail').lean().exec(),
      EmailMessage.aggregate<{ _id: { day: string; status: string }; count: number }>([
        {
          $match: {
            direction: 'outbound',
            createdAt: { $gte: fourteenDaysStart },
            status: { $in: ['sent', 'Sent', 'failed', 'Failed', 'unknown', 'bounced', 'Bounced'] },
          },
        },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
              status: '$status',
            },
            count: { $sum: 1 },
          },
        },
      ]).exec(),
    ]);

    const statusCountMap = new Map<string, number>();
    for (const item of statusAggregation) {
      statusCountMap.set(item._id, item.count);
    }

    const pipelineBreakdown = LEAD_STATUSES.map((status) => ({
      status,
      count: statusCountMap.get(status) ?? 0,
    }));

    const replyRate =
      contactedPoolCount > 0
        ? Number(((repliedCount / contactedPoolCount) * 100).toFixed(1))
        : 0;

    const usageMap = new Map<string, { sentCount: number; reservedCount: number }>();
    for (const usage of usageDocs) {
      usageMap.set(usage.mailboxId, {
        sentCount: usage.sentCount ?? 0,
        reservedCount: usage.reservedCount ?? 0,
      });
    }

    const combinedMailboxes = [
      ...dbMailboxDocs.map((m) => ({
        id: String(m._id),
        label: m.name,
        host: m.smtpHost,
        port: m.smtpPort,
        secure: m.secure,
        fromName: m.senderName,
        fromEmail: m.senderEmail,
        dailyLimit: m.dailyLimit,
        configured: m.verificationStatus === 'verified',
      })),
      ...envMailboxes,
    ];

    const mailboxCapacity = combinedMailboxes.map((mailbox) => {
      const usage = usageMap.get(mailbox.id);
      const sentToday = usage?.sentCount ?? 0;
      const reservedToday = usage?.reservedCount ?? 0;
      return {
        ...mailbox,
        sentToday,
        remainingToday: Math.max(0, mailbox.dailyLimit - sentToday - reservedToday),
      };
    });

    const verifiedActiveMailboxes = mailboxCapacity.filter((m) => m.configured);
    const emailsRemainingToday = verifiedActiveMailboxes.reduce(
      (sum, m) => sum + m.remainingToday,
      0
    );

    const mailboxNameLookup = new Map<string, string>();
    const mailboxEmailLookup = new Map<string, string>();
    for (const mb of allMailboxNames) {
      mailboxNameLookup.set(String(mb._id), mb.name);
      if (mb.senderEmail) {
        mailboxEmailLookup.set(String(mb._id), mb.senderEmail);
      }
    }

    const recentEmailActivity = recentEmailDocs.map((doc) =>
      serializeEmailHistoryItem(doc, mailboxNameLookup)
    );

    const recentCampaigns = recentCampaignDocs.map((c) => ({
      id: String(c._id),
      name: c.name,
      status: c.status,
      mailboxId: c.mailboxId,
      mailboxName: mailboxNameLookup.get(c.mailboxId) || undefined,
      mailboxEmail: mailboxEmailLookup.get(c.mailboxId) || undefined,
      totalRecipients: c.totalRecipients,
      sentCount: c.sentCount,
      failedCount: c.failedCount,
      repliedCount: c.repliedCount,
      bouncedCount: c.bouncedCount,
      approved: Boolean(c.manualApproval?.approved),
      updatedAt: c.updatedAt,
    }));

    const sendHistory14d = buildEmpty14d();
    const dayBucketMap = new Map(sendHistory14d.map((d) => [d.dateKey, d]));
    for (const row of dailySendAgg) {
      const bucket = dayBucketMap.get(row._id.day);
      if (!bucket) continue;
      const lowerStatus = String(row._id.status).toLowerCase();
      if (lowerStatus === 'sent') {
        bucket.sent += row.count;
      } else {
        bucket.failed += row.count;
      }
    }

    res.json({
      dbConnected: true,
      dbState: dbStatus.state,
      dbError: null,
      metrics: {
        totalLeads,
        emailsSent,
        replyRate,
        interestedLeads,
        meetingsBooked,
      },
      todayStats: {
        dateKey: todayKey,
        emailsSentToday,
        emailsRemainingToday,
        activeVerifiedMailboxes: verifiedActiveMailboxes.length,
        sendingFailuresToday,
      },
      pipelineBreakdown,
      recentCampaigns,
      recentEmailActivity,
      mailboxCapacity,
      sendHistory14d,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to load dashboard overview:', err);
    res.status(500).json({
      error: 'Failed to load dashboard overview from database.',
      code: 'DASHBOARD_QUERY_FAILED',
    });
  }
});
