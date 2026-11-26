import { MailboxUsage, type MailboxUsageDocument } from '../models/index.ts';
import { isDuplicateKeyError } from './leadValidation.ts';

export interface MailboxQuotaSnapshot {
  mailboxId: string;
  dateKey: string;
  timezone: 'UTC';
  dailyLimit: number;
  sentToday: number;
  reservedToday: number;
  unknownToday: number;
  remainingToday: number;
  resetsAt: string;
}

export function getUtcDateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function getNextUtcMidnightIso(date: Date = new Date()): string {
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0)
  );
  return next.toISOString();
}

export function buildQuotaSnapshot(
  mailboxId: string,
  dailyLimit: number,
  usage: Partial<Pick<MailboxUsageDocument, 'sentCount' | 'reservedCount' | 'unknownCount'>> | null,
  now: Date = new Date()
): MailboxQuotaSnapshot {
  const sentToday = Math.max(0, usage?.sentCount ?? 0);
  const reservedToday = Math.max(0, usage?.reservedCount ?? 0);
  const unknownToday = Math.max(0, usage?.unknownCount ?? 0);
  const remainingToday = Math.max(0, dailyLimit - sentToday - reservedToday);

  return {
    mailboxId,
    dateKey: getUtcDateKey(now),
    timezone: 'UTC',
    dailyLimit,
    sentToday,
    reservedToday,
    unknownToday,
    remainingToday,
    resetsAt: getNextUtcMidnightIso(now),
  };
}

export async function getMailboxQuota(
  mailboxId: string,
  dailyLimit: number,
  now: Date = new Date()
): Promise<MailboxQuotaSnapshot> {
  const dateKey = getUtcDateKey(now);
  const usage = await MailboxUsage.findOne({ mailboxId, dateKey }).lean();
  return buildQuotaSnapshot(mailboxId, dailyLimit, usage, now);
}

async function ensureUsageDocument(mailboxId: string, dateKey: string): Promise<void> {
  try {
    await MailboxUsage.findOneAndUpdate(
      { mailboxId, dateKey },
      {
        $setOnInsert: {
          mailboxId,
          dateKey,
          sentCount: 0,
          reservedCount: 0,
          unknownCount: 0,
        },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
  }
}

export async function reserveDailyQuotaSlot(
  mailboxId: string,
  dailyLimit: number,
  now: Date = new Date()
): Promise<{ reserved: true; quota: MailboxQuotaSnapshot } | { reserved: false; quota: MailboxQuotaSnapshot }> {
  const dateKey = getUtcDateKey(now);
  await ensureUsageDocument(mailboxId, dateKey);

  // Single-document atomic reservation ensures concurrent sends cannot exceed dailyLimit
  const reservedDoc = await MailboxUsage.findOneAndUpdate(
    {
      mailboxId,
      dateKey,
      $expr: {
        $lt: [
          {
            $add: [
              { $ifNull: ['$sentCount', 0] },
              { $ifNull: ['$reservedCount', 0] },
            ],
          },
          dailyLimit,
        ],
      },
    },
    { $inc: { reservedCount: 1 } },
    { new: true }
  ).lean();

  if (!reservedDoc) {
    const current = await MailboxUsage.findOne({ mailboxId, dateKey }).lean();
    return {
      reserved: false,
      quota: buildQuotaSnapshot(mailboxId, dailyLimit, current, now),
    };
  }

  return {
    reserved: true,
    quota: buildQuotaSnapshot(mailboxId, dailyLimit, reservedDoc, now),
  };
}

export async function commitQuotaReservation(
  mailboxId: string,
  dateKey: string
): Promise<void> {
  await MailboxUsage.updateOne(
    { mailboxId, dateKey, reservedCount: { $gt: 0 } },
    { $inc: { sentCount: 1, reservedCount: -1 } }
  );
}

export async function releaseQuotaReservation(
  mailboxId: string,
  dateKey: string
): Promise<void> {
  await MailboxUsage.updateOne(
    { mailboxId, dateKey, reservedCount: { $gt: 0 } },
    { $inc: { reservedCount: -1 } }
  );
}

export async function markQuotaReservationAmbiguous(
  mailboxId: string,
  dateKey: string
): Promise<void> {
  await MailboxUsage.updateOne(
    { mailboxId, dateKey, reservedCount: { $gt: 0 } },
    { $inc: { reservedCount: -1, unknownCount: 1 } }
  );
}
