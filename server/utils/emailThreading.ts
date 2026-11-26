import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { EmailMessage } from '../models/index.ts';

export function generateSmtpMessageId(senderEmail: string): string {
  const domainPart = senderEmail.split('@')[1]?.trim().toLowerCase() || 'outreachdesk.local';
  const safeDomain = domainPart.replace(/[^a-z0-9.-]/g, '') || 'outreachdesk.local';
  const uniqueId = `${Date.now().toString(36)}.${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return `<${uniqueId}@${safeDomain}>`;
}

export function normalizeReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return 'Re:';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export interface ThreadContextResult {
  threadId: string;
  inReplyTo?: string;
  references: string[];
  previousSubject?: string;
}

export async function resolveReplyThreadContext(params: {
  toEmail: string;
  leadId?: string | mongoose.Types.ObjectId;
  explicitInReplyTo?: string;
  threadWithPrevious?: boolean;
}): Promise<ThreadContextResult> {
  const normalizedEmail = params.toEmail.trim().toLowerCase();

  if (params.explicitInReplyTo?.trim()) {
    const cleanReplyTo = params.explicitInReplyTo.trim();
    const matched = await EmailMessage.findOne({ messageId: cleanReplyTo })
      .select('threadId messageId references subject')
      .lean();
    if (matched) {
      const refs = Array.from(
        new Set([...(matched.references || []), matched.messageId || cleanReplyTo].filter(Boolean))
      ).slice(-20);
      return {
        threadId: matched.threadId || crypto.randomUUID(),
        inReplyTo: cleanReplyTo,
        references: refs,
        previousSubject: matched.subject,
      };
    }
    return {
      threadId: crypto.randomUUID(),
      inReplyTo: cleanReplyTo,
      references: [cleanReplyTo],
    };
  }

  if (params.threadWithPrevious) {
    const matchCriteria: Record<string, unknown>[] = [{ toEmail: normalizedEmail }];
    if (params.leadId && mongoose.isValidObjectId(String(params.leadId))) {
      matchCriteria.unshift({ leadId: new mongoose.Types.ObjectId(String(params.leadId)) });
    }

    const previous = await EmailMessage.findOne({
      $or: matchCriteria,
      status: { $in: ['sent', 'Sent'] },
      messageId: { $exists: true, $ne: '' },
    })
      .sort({ sentAt: -1, createdAt: -1 })
      .select('threadId messageId references subject')
      .lean();

    if (previous && previous.messageId) {
      const refs = Array.from(
        new Set([...(previous.references || []), previous.messageId].filter(Boolean))
      ).slice(-20);
      return {
        threadId: previous.threadId || crypto.randomUUID(),
        inReplyTo: previous.messageId,
        references: refs,
        previousSubject: previous.subject,
      };
    }
  }

  return {
    threadId: crypto.randomUUID(),
    references: [],
  };
}

export function buildThreadHeaders(params: {
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (params.messageId) {
    headers['Message-ID'] = params.messageId;
  }
  if (params.inReplyTo) {
    headers['In-Reply-To'] = params.inReplyTo;
  }
  if (params.references && params.references.length > 0) {
    headers.References = params.references.join(' ');
  }
  return headers;
}
