import { getDatabaseStatus } from '../config/db.ts';
import {
  AiUsageLog,
  type AiErrorCategory,
  type AiGenerationType,
  type AiUsageStatus,
} from '../models/index.ts';

const MINUTE_WINDOW_MS = 60 * 1000;
const HOUR_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 15;
const MAX_REQUESTS_PER_HOUR = 120;

const requestTimestamps: number[] = [];

function pruneTimestamps(now: number): void {
  const cutoff = now - HOUR_WINDOW_MS;
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= cutoff) {
    requestTimestamps.shift();
  }
}

export function checkAiRateLimit(now: number = Date.now()): {
  allowed: boolean;
  retryAfterSeconds: number;
  remainingThisMinute: number;
  remainingThisHour: number;
} {
  pruneTimestamps(now);

  const minuteCutoff = now - MINUTE_WINDOW_MS;
  const lastMinute = requestTimestamps.filter((ts) => ts > minuteCutoff);
  const lastHourCount = requestTimestamps.length;

  if (lastMinute.length >= MAX_REQUESTS_PER_MINUTE) {
    const oldestInMinute = lastMinute[0];
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldestInMinute + MINUTE_WINDOW_MS - now) / 1000)
    );
    return {
      allowed: false,
      retryAfterSeconds,
      remainingThisMinute: 0,
      remainingThisHour: Math.max(0, MAX_REQUESTS_PER_HOUR - lastHourCount),
    };
  }

  if (lastHourCount >= MAX_REQUESTS_PER_HOUR) {
    const oldestInHour = requestTimestamps[0];
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldestInHour + HOUR_WINDOW_MS - now) / 1000)
    );
    return {
      allowed: false,
      retryAfterSeconds,
      remainingThisMinute: Math.max(0, MAX_REQUESTS_PER_MINUTE - lastMinute.length),
      remainingThisHour: 0,
    };
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
    remainingThisMinute: MAX_REQUESTS_PER_MINUTE - lastMinute.length,
    remainingThisHour: MAX_REQUESTS_PER_HOUR - lastHourCount,
  };
}

export function recordAiRateLimitHit(now: number = Date.now()): void {
  pruneTimestamps(now);
  requestTimestamps.push(now);
}

export function resetAiRateLimitForTests(): void {
  requestTimestamps.length = 0;
}

export interface RecordAiUsageInput {
  generationType: AiGenerationType;
  modelUsed: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  status: AiUsageStatus;
  errorCategory?: AiErrorCategory;
  durationMs: number;
}

export async function recordAiUsageLog(entry: RecordAiUsageInput): Promise<void> {
  try {
    const db = getDatabaseStatus();
    if (!db.connected) return;

    await AiUsageLog.create({
      provider: 'deepseek',
      generationType: entry.generationType,
      modelUsed: entry.modelUsed || 'deepseek-chat',
      inputTokens:
        typeof entry.inputTokens === 'number' && entry.inputTokens >= 0
          ? entry.inputTokens
          : null,
      outputTokens:
        typeof entry.outputTokens === 'number' && entry.outputTokens >= 0
          ? entry.outputTokens
          : null,
      totalTokens:
        typeof entry.totalTokens === 'number' && entry.totalTokens >= 0
          ? entry.totalTokens
          : null,
      status: entry.status,
      errorCategory: entry.errorCategory ?? 'none',
      durationMs: Math.max(0, Math.round(entry.durationMs)),
    });
  } catch (err) {
    // Usage logging must never break primary generation responses or leak payloads
    console.warn(
      '[Outreach Desk] Failed to persist AI usage log:',
      err instanceof Error ? err.message : 'Unknown error'
    );
  }
}

export async function getAiUsageSummary(): Promise<{
  totalRequestsToday: number;
  successfulToday: number;
  totalTokensToday: number;
} | null> {
  const db = getDatabaseStatus();
  if (!db.connected) return null;

  const now = new Date();
  const startOfUtcDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );

  const logs = await AiUsageLog.find({ createdAt: { $gte: startOfUtcDay } })
    .select('status totalTokens')
    .lean()
    .exec();

  let successfulToday = 0;
  let totalTokensToday = 0;
  for (const row of logs) {
    if (row.status === 'success') successfulToday += 1;
    if (typeof row.totalTokens === 'number') totalTokensToday += row.totalTokens;
  }

  return {
    totalRequestsToday: logs.length,
    successfulToday,
    totalTokensToday,
  };
}
