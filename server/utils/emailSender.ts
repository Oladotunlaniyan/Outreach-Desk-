import crypto from 'node:crypto';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { EmailMessage, Lead, Mailbox } from '../models/index.ts';
import {
  MailboxEncryptionError,
  decryptMailboxSecret,
  getMailboxEncryptionStatus,
} from './mailboxCrypto.ts';
import {
  sanitizeHeaderDisplayName,
  serializeEmailHistoryItem,
  stripHtmlTags,
  type SerializedEmailHistoryItem,
} from './emailValidation.ts';
import {
  commitQuotaReservation,
  getMailboxQuota,
  getUtcDateKey,
  markQuotaReservationAmbiguous,
  releaseQuotaReservation,
  reserveDailyQuotaSlot,
  type MailboxQuotaSnapshot,
} from './quotaManager.ts';
import {
  resolveAndValidateSmtpHost,
  validateAndResolveSmtpSecurity,
  type ResolvedSmtpAddress,
} from './smtpSecurity.ts';
import { sanitizeSmtpError } from './smtpVerifier.ts';

import {
  buildThreadHeaders,
  generateSmtpMessageId,
  resolveReplyThreadContext,
} from './emailThreading.ts';
import {
  classifySmtpBounceError,
  processHardBounce,
} from './bounceProcessor.ts';
import {
  createUnsubscribeToken,
  isEmailSuppressed,
  resolvePublicAppBaseUrl,
} from './suppression.ts';
import { logEvent } from './logger.ts';

export interface SendEmailInput {
  mailboxId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  idempotencyKey?: string;
  leadId?: string;
  campaignId?: string;
  campaignRecipientId?: string;
  threadWithPrevious?: boolean;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  includeUnsubscribe?: boolean;
  appBaseUrl?: string;
}

export interface SendMailResultInfo {
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
  response?: string;
}

export interface EmailSenderDeps {
  createTransport?: (options: SMTPTransport.Options) => {
    sendMail: (mailOptions: Record<string, unknown>) => Promise<SendMailResultInfo>;
    close: () => void;
  };
  lookupHost?: (
    hostname: string,
    options: { all: true; verbatim: true }
  ) => Promise<Array<{ address: string; family: number }>>;
  tlsOptions?: SMTPTransport.Options['tls'];
}

export type SendEmailServiceResult =
  | {
      ok: true;
      httpStatus: number;
      deduplicated?: boolean;
      email: SerializedEmailHistoryItem;
      quota: MailboxQuotaSnapshot;
    }
  | {
      ok: false;
      httpStatus: number;
      code: string;
      error: string;
      ambiguous?: boolean;
      bounceType?: 'hard' | 'soft';
      email?: SerializedEmailHistoryItem;
      quota?: MailboxQuotaSnapshot;
    };

function buildValidatedDnsLookup(addresses: ResolvedSmtpAddress[]) {
  return (
    _hostname: string,
    optionsOrCb: unknown,
    maybeCb?: unknown
  ): void => {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (
      err: Error | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number
    ) => void;
    const opts =
      typeof optionsOrCb === 'object' && optionsOrCb !== null
        ? (optionsOrCb as { all?: boolean })
        : {};

    if (opts.all) {
      cb(
        null,
        addresses.map((item) => ({ address: item.address, family: item.family }))
      );
      return;
    }
    const primary = addresses[0];
    cb(null, primary.address, primary.family);
  };
}

export function classifySendFailure(err: unknown): {
  ambiguous: boolean;
  errorCode: string;
  message: string;
  smtpResponseCode?: number;
} {
  const errObj = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
    command?: unknown;
    message?: unknown;
  };

  const code = typeof errObj.code === 'string' ? errObj.code.toUpperCase() : '';
  const responseCode =
    typeof errObj.responseCode === 'number' ? errObj.responseCode : undefined;
  const command = typeof errObj.command === 'string' ? errObj.command.toUpperCase() : '';
  const rawMessage = typeof errObj.message === 'string' ? errObj.message : '';
  const lower = rawMessage.toLowerCase();

  // Explicit SMTP server 4xx/5xx rejection is a definitive failure (never ambiguous)
  if (typeof responseCode === 'number' && responseCode >= 400) {
    if (responseCode === 535 || responseCode === 534 || responseCode === 530) {
      const sanitized = sanitizeSmtpError(err);
      return {
        ambiguous: false,
        errorCode: sanitized.errorCode,
        message: sanitized.message,
        smtpResponseCode: responseCode,
      };
    }
    return {
      ambiguous: false,
      errorCode: 'SMTP_REJECTED',
      message: `SMTP server rejected the message (code ${responseCode}). Verify the sender and recipient addresses.`,
      smtpResponseCode: responseCode,
    };
  }

  // Definitive pre-delivery failures (DNS, refused connection, auth, TLS, malformed protocol)
  if (
    code === 'EAUTH' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EDNS' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ETLS' ||
    code === 'EPROTOCOL' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    const sanitized = sanitizeSmtpError(err);
    return {
      ambiguous: false,
      errorCode: sanitized.errorCode,
      message: sanitized.message,
    };
  }

  if (
    code === 'ESOCKET' &&
    (lower.includes('certificate') ||
      lower.includes('tls') ||
      lower.includes('ssl') ||
      lower.includes('wrong version number') ||
      lower.includes('altnames'))
  ) {
    const sanitized = sanitizeSmtpError(err);
    return {
      ambiguous: false,
      errorCode: sanitized.errorCode,
      message: sanitized.message,
    };
  }

  // Failures explicitly occurring during pre-DATA SMTP handshake commands are definitive
  const isPreDataHandshakeCommand =
    command === 'EHLO' ||
    command === 'HELO' ||
    command === 'STARTTLS' ||
    command === 'AUTH';

  const isExplicitPreSessionTimeout =
    lower.includes('greeting never received') ||
    lower.includes('connection timeout') ||
    lower.includes('tls handshake timed out');

  if (isPreDataHandshakeCommand || isExplicitPreSessionTimeout) {
    const sanitized = sanitizeSmtpError(err);
    return {
      ambiguous: false,
      errorCode: sanitized.errorCode,
      message: sanitized.message,
    };
  }

  // Connection drop, reset, stream destruction, or timeout where SMTP 250 OK acceptance cannot be established
  // Note: Nodemailer v10 emits code='ECONNECTION', command='CONN', message='Connection closed unexpectedly'
  // (or stream close/EOF errors if the TLS/TCP socket drops while streaming DATA).
  const isUncertainNetworkDropOrTimeout =
    code === 'ECONNECTION' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    lower.includes('timeout') ||
    lower.includes('connection closed') ||
    lower.includes('socket close') ||
    lower.includes('unexpected close') ||
    lower.includes('stream was destroyed') ||
    lower.includes('premature close') ||
    lower.includes('unexpected eof');

  if (isUncertainNetworkDropOrTimeout) {
    return {
      ambiguous: true,
      errorCode: 'AMBIGUOUS_DELIVERY',
      message:
        'Connection timed out or dropped before receiving SMTP confirmation. Delivery status is unknown; do not automatically resend without verifying.',
    };
  }

  const sanitized = sanitizeSmtpError(err);
  return {
    ambiguous: false,
    errorCode: sanitized.errorCode,
    message: sanitized.message,
  };
}

export async function sendEmailViaMailbox(
  input: SendEmailInput,
  deps: EmailSenderDeps = {}
): Promise<SendEmailServiceResult> {
  if (!mongoose.isValidObjectId(input.mailboxId)) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_MAILBOX_ID',
      error: 'Invalid mailbox ID.',
    };
  }

  const encryptionStatus = getMailboxEncryptionStatus();
  if (!encryptionStatus.valid) {
    return {
      ok: false,
      httpStatus: 503,
      code: 'MAILBOX_ENCRYPTION_UNCONFIGURED',
      error:
        encryptionStatus.error ||
        'MAILBOX_ENCRYPTION_KEY is missing or invalid on the server.',
    };
  }

  const mailbox = await Mailbox.findById(input.mailboxId).select('+encryptedPassword');
  if (!mailbox) {
    return {
      ok: false,
      httpStatus: 404,
      code: 'MAILBOX_NOT_FOUND',
      error: 'Selected mailbox was not found.',
    };
  }

  if (mailbox.archived) {
    return {
      ok: false,
      httpStatus: 403,
      code: 'MAILBOX_ARCHIVED',
      error: 'Archived mailboxes cannot be used to send emails.',
    };
  }

  if (!mailbox.enabled) {
    return {
      ok: false,
      httpStatus: 403,
      code: 'MAILBOX_DISABLED',
      error: 'This mailbox is disabled. Enable it in Settings before sending.',
    };
  }

  if (mailbox.verificationStatus !== 'verified') {
    return {
      ok: false,
      httpStatus: 403,
      code: 'MAILBOX_UNVERIFIED',
      error:
        'This mailbox has not passed SMTP verification yet. Test its connection in Settings before sending.',
    };
  }

  if (!mailbox.encryptedPassword?.ciphertext) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'MISSING_CREDENTIALS',
      error: 'No encrypted SMTP credentials are stored for this mailbox.',
    };
  }

  const trimmedIdempotencyKey = input.idempotencyKey?.trim() || '';
  if (trimmedIdempotencyKey) {
    const existingByKey = await EmailMessage.findOne({
      mailboxId: String(mailbox._id),
      idempotencyKey: trimmedIdempotencyKey,
    }).lean();

    if (existingByKey) {
      const normalizedStatus = String(existingByKey.status).toLowerCase();
      if (normalizedStatus === 'sent') {
        const quota = await getMailboxQuota(String(mailbox._id), mailbox.dailyLimit);
        return {
          ok: true,
          httpStatus: 200,
          deduplicated: true,
          email: serializeEmailHistoryItem(existingByKey),
          quota,
        };
      }
      if (normalizedStatus === 'sending' || normalizedStatus === 'queued') {
        return {
          ok: false,
          httpStatus: 409,
          code: 'DUPLICATE_IN_FLIGHT',
          error: 'This email send request is already in progress.',
        };
      }
      if (normalizedStatus === 'unknown') {
        return {
          ok: false,
          httpStatus: 409,
          code: 'AMBIGUOUS_DUPLICATE_BLOCKED',
          error:
            'A previous attempt with this request key ended in an unknown delivery state and cannot be replayed automatically.',
          ambiguous: true,
          email: serializeEmailHistoryItem(existingByKey),
        };
      }
    }
  }

  const normalizedTo = input.to.trim().toLowerCase();
  const suppression = await isEmailSuppressed(normalizedTo);
  if (suppression) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'EMAIL_SUPPRESSED',
      error: `Recipient ${normalizedTo} is suppressed (${suppression.detail}) and cannot be emailed.`,
    };
  }

  let decryptedPassword: string;
  try {
    decryptedPassword = decryptMailboxSecret(
      mailbox.encryptedPassword,
      String(mailbox._id)
    );
  } catch (err) {
    return {
      ok: false,
      httpStatus: 500,
      code: 'DECRYPT_FAILED',
      error:
        err instanceof MailboxEncryptionError
          ? err.message
          : 'Unable to decrypt stored SMTP credentials.',
    };
  }

  const securityCheck = validateAndResolveSmtpSecurity(
    mailbox.smtpPort,
    mailbox.securityMode
  );
  if (!securityCheck.ok) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_SMTP_CONFIG',
      error: securityCheck.error,
    };
  }

  const dnsResult = await resolveAndValidateSmtpHost(
    mailbox.smtpHost,
    deps.lookupHost
  );
  if (!dnsResult.ok) {
    return {
      ok: false,
      httpStatus: dnsResult.code === 'SSRF_BLOCKED' ? 403 : 400,
      code: dnsResult.code,
      error: dnsResult.error,
    };
  }

  const now = new Date();
  const dateKey = getUtcDateKey(now);
  const mailboxIdStr = String(mailbox._id);

  // Atomic daily quota reservation before creating/dispatching the SMTP send
  const reservation = await reserveDailyQuotaSlot(
    mailboxIdStr,
    mailbox.dailyLimit,
    now
  );
  if (!reservation.reserved) {
    return {
      ok: false,
      httpStatus: 429,
      code: 'QUOTA_EXCEEDED',
      error: `Daily sending limit (${mailbox.dailyLimit}/day UTC) reached for "${mailbox.name}".`,
      quota: reservation.quota,
    };
  }

  // Link lead record automatically if matching email or leadId exists
  const matchingLead =
    input.leadId && mongoose.isValidObjectId(input.leadId)
      ? await Lead.findById(input.leadId).select('_id status email').lean()
      : await Lead.findOne({ email: normalizedTo }).select('_id status email').lean();

  const hasHtml = stripHtmlTags(input.html).length > 0;
  const derivedText = input.text.trim()
    ? input.text.trim()
    : stripHtmlTags(input.html);
  const hasText = derivedText.length > 0;
  const effectiveReplyTo =
    input.replyTo?.trim().toLowerCase() || mailbox.replyTo?.trim().toLowerCase() || '';

  const smtpMessageId = generateSmtpMessageId(mailbox.senderEmail);
  const resolvedThread = input.threadId
    ? {
        threadId: input.threadId,
        inReplyTo: input.inReplyTo,
        references: input.references ?? [],
      }
    : await resolveReplyThreadContext({
        toEmail: normalizedTo,
        leadId: matchingLead?._id,
        explicitInReplyTo: input.inReplyTo,
        threadWithPrevious: Boolean(input.threadWithPrevious),
      });

  const emailDocId = new mongoose.Types.ObjectId();
  let unsubscribeTokenId: string | undefined;
  let extraHeaders: Record<string, string> = buildThreadHeaders({
    messageId: smtpMessageId,
    inReplyTo: resolvedThread.inReplyTo,
    references: resolvedThread.references,
  });

  if (input.includeUnsubscribe !== false) {
    const baseUrl = resolvePublicAppBaseUrl(input.appBaseUrl);
    const unsubToken = await createUnsubscribeToken({
      email: normalizedTo,
      leadId: matchingLead?._id,
      campaignId: input.campaignId,
      emailMessageId: emailDocId,
      baseUrl,
    });
    unsubscribeTokenId = unsubToken.tokenId;

    const listUnsubValues: string[] = [];
    if (/^https?:\/\//i.test(unsubToken.unsubscribeUrl)) {
      listUnsubValues.push(`<${unsubToken.unsubscribeUrl}>`);
      extraHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    const mailtoAddress = effectiveReplyTo || mailbox.senderEmail;
    if (mailtoAddress) {
      listUnsubValues.push(`<mailto:${mailtoAddress}?subject=unsubscribe>`);
    }
    if (listUnsubValues.length > 0) {
      extraHeaders['List-Unsubscribe'] = listUnsubValues.join(', ');
    }
  }

  let emailDoc;
  try {
    emailDoc = await EmailMessage.create({
      _id: emailDocId,
      ...(matchingLead ? { leadId: matchingLead._id } : {}),
      ...(input.campaignId && mongoose.isValidObjectId(input.campaignId)
        ? { campaignId: input.campaignId }
        : {}),
      ...(input.campaignRecipientId && mongoose.isValidObjectId(input.campaignRecipientId)
        ? { campaignRecipientId: input.campaignRecipientId }
        : {}),
      mailboxId: mailboxIdStr,
      mailboxName: mailbox.name,
      direction: 'outbound',
      status: 'sending',
      toEmail: normalizedTo,
      fromEmail: mailbox.senderEmail,
      ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
      subject: input.subject,
      // Privacy rule: avoid storing full HTML/text bodies unless required
      bodyHtml: '',
      bodyText: '',
      hasHtml,
      hasText,
      messageId: smtpMessageId,
      ...(resolvedThread.inReplyTo ? { inReplyTo: resolvedThread.inReplyTo } : {}),
      references: resolvedThread.references,
      threadId: resolvedThread.threadId,
      ...(unsubscribeTokenId ? { unsubscribeTokenId } : {}),
      attempts: 1,
      ...(trimmedIdempotencyKey ? { idempotencyKey: trimmedIdempotencyKey } : {}),
      attemptMeta: {
        startedAt: now,
        ambiguous: false,
      },
    });
  } catch (err) {
    await releaseQuotaReservation(mailboxIdStr, dateKey);
    throw err;
  }

  const transportFactory =
    deps.createTransport ??
    ((opts: SMTPTransport.Options) => nodemailer.createTransport(opts));

  const transporter = transportFactory({
    host: mailbox.smtpHost,
    port: securityCheck.port,
    secure: securityCheck.secure,
    requireTLS: securityCheck.requireTLS,
    ignoreTLS: false,
    auth: {
      user: mailbox.smtpUsername,
      pass: decryptedPassword,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    tls: deps.tlsOptions ?? {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    lookup: buildValidatedDnsLookup(dnsResult.addresses),
  } as SMTPTransport.Options);

  const safeSenderName = sanitizeHeaderDisplayName(mailbox.senderName);
  const fromHeader = safeSenderName
    ? `"${safeSenderName}" <${mailbox.senderEmail}>`
    : mailbox.senderEmail;

  logEvent('info', 'email.attempt_started', {
    mailboxId: mailboxIdStr,
    emailMessageId: String(emailDoc._id),
    campaignId: input.campaignId,
    toEmail: normalizedTo,
  });

  let smtpAcceptedInfo: SendMailResultInfo | null = null;

  try {
    const info = await transporter.sendMail({
      from: fromHeader,
      to: normalizedTo,
      ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
      subject: input.subject,
      ...(hasText ? { text: derivedText } : {}),
      ...(hasHtml ? { html: input.html } : {}),
      messageId: smtpMessageId,
      headers: extraHeaders,
    });

    const completedAt = new Date();
    const acceptedCount = Array.isArray(info.accepted) ? info.accepted.length : 1;
    const rejectedCount = Array.isArray(info.rejected) ? info.rejected.length : 0;

    if (acceptedCount === 0 && rejectedCount > 0) {
      await releaseQuotaReservation(mailboxIdStr, dateKey);
      emailDoc.status = 'failed';
      emailDoc.errorCode = 'RECIPIENT_REJECTED';
      emailDoc.error = 'SMTP server rejected the recipient address.';
      emailDoc.attemptMeta = {
        startedAt: now,
        completedAt,
        durationMs: completedAt.getTime() - now.getTime(),
        acceptedCount,
        rejectedCount,
        ambiguous: false,
      };
      await emailDoc.save();

      logEvent('warn', 'email.recipient_rejected', {
        mailboxId: mailboxIdStr,
        emailMessageId: String(emailDoc._id),
        campaignId: input.campaignId,
      });

      const updatedQuota = await getMailboxQuota(mailboxIdStr, mailbox.dailyLimit);
      return {
        ok: false,
        httpStatus: 502,
        code: 'RECIPIENT_REJECTED',
        error: emailDoc.error,
        email: serializeEmailHistoryItem(emailDoc),
        quota: updatedQuota,
      };
    }

    // Mark SMTP acceptance BEFORE any post-send persistence so DB failures never trigger retry/quota release
    smtpAcceptedInfo = info;

    await commitQuotaReservation(mailboxIdStr, dateKey);

    emailDoc.status = 'sent';
    emailDoc.sentAt = completedAt;
    if (info.messageId) {
      emailDoc.messageId = info.messageId;
    }
    emailDoc.attemptMeta = {
      startedAt: now,
      completedAt,
      durationMs: completedAt.getTime() - now.getTime(),
      acceptedCount,
      rejectedCount,
      ambiguous: false,
    };
    await emailDoc.save();

    if (matchingLead) {
      try {
        const nextStatus = matchingLead.status === 'New' ? 'Contacted' : matchingLead.status;
        await Lead.updateOne(
          { _id: matchingLead._id },
          {
            $set: {
              lastContactedAt: completedAt,
              lastSenderId: mailboxIdStr,
              ...(matchingLead.status === 'New' ? { status: 'Contacted' } : {}),
            },
            $inc: { emailCount: 1 },
            $push: {
              history: {
                $each: [
                  {
                    status: nextStatus,
                    at: completedAt,
                    note: `Email sent via ${mailbox.name}: "${input.subject.slice(0, 120)}"`,
                  },
                ],
                $slice: -200,
              },
            },
          }
        );
      } catch (leadErr) {
        logEvent('warn', 'email.lead_update_failed', {
          mailboxId: mailboxIdStr,
          emailMessageId: String(emailDoc._id),
          leadId: String(matchingLead._id),
          error: leadErr,
        });
      }
    }

    logEvent('info', 'email.sent', {
      mailboxId: mailboxIdStr,
      emailMessageId: String(emailDoc._id),
      campaignId: input.campaignId,
      durationMs: completedAt.getTime() - now.getTime(),
      acceptedCount,
    });

    const updatedQuota = await getMailboxQuota(mailboxIdStr, mailbox.dailyLimit);
    return {
      ok: true,
      httpStatus: 200,
      email: serializeEmailHistoryItem(emailDoc),
      quota: updatedQuota,
    };
  } catch (err) {
    const completedAt = new Date();

    if (smtpAcceptedInfo !== null) {
      logEvent('error', 'email.post_accept_db_error', {
        mailboxId: mailboxIdStr,
        emailMessageId: String(emailDoc._id),
        campaignId: input.campaignId,
        error: err,
      });

      await markQuotaReservationAmbiguous(mailboxIdStr, dateKey).catch(() => {});

      const postAcceptMsg =
        'SMTP server accepted the message, but persisting delivery state failed. Delivery outcome is marked ambiguous; verify before resending.';
      emailDoc.status = 'unknown';
      emailDoc.errorCode = 'POST_ACCEPT_DB_ERROR';
      emailDoc.error = postAcceptMsg;
      if (smtpAcceptedInfo.messageId) {
        emailDoc.messageId = smtpAcceptedInfo.messageId;
      }
      emailDoc.attemptMeta = {
        startedAt: now,
        completedAt,
        durationMs: completedAt.getTime() - now.getTime(),
        ambiguous: true,
      };
      await emailDoc.save().catch(() => {});

      const updatedQuota = await getMailboxQuota(mailboxIdStr, mailbox.dailyLimit).catch(
        () => reservation.quota
      );
      return {
        ok: false,
        httpStatus: 500,
        code: 'POST_ACCEPT_DB_ERROR',
        error: postAcceptMsg,
        ambiguous: true,
        email: serializeEmailHistoryItem(emailDoc),
        quota: updatedQuota,
      };
    }

    const classified = classifySendFailure(err);
    const bounceCheck = classifySmtpBounceError(err);

    if (classified.ambiguous) {
      await markQuotaReservationAmbiguous(mailboxIdStr, dateKey);
      emailDoc.status = 'unknown';
    } else {
      await releaseQuotaReservation(mailboxIdStr, dateKey);
      emailDoc.status = bounceCheck.isHardBounce ? 'Bounced' : 'failed';
      if (bounceCheck.bounceType !== 'none') {
        emailDoc.bounceType = bounceCheck.bounceType;
      }
    }

    emailDoc.errorCode = bounceCheck.isHardBounce ? 'HARD_BOUNCE' : classified.errorCode;
    emailDoc.error = classified.message;
    emailDoc.attemptMeta = {
      startedAt: now,
      completedAt,
      durationMs: completedAt.getTime() - now.getTime(),
      ...(classified.smtpResponseCode !== undefined
        ? { smtpResponseCode: classified.smtpResponseCode }
        : {}),
      ambiguous: classified.ambiguous,
    };
    await emailDoc.save();

    if (bounceCheck.isHardBounce) {
      await processHardBounce({
        email: normalizedTo,
        reason: bounceCheck.reason || classified.message,
        source: 'smtp_5xx',
        emailMessageId: emailDoc._id as mongoose.Types.ObjectId,
        campaignId: input.campaignId,
        campaignRecipientId: input.campaignRecipientId,
      });
    }

    logEvent(classified.ambiguous ? 'warn' : 'info', classified.ambiguous ? 'email.ambiguous' : bounceCheck.isHardBounce ? 'email.hard_bounce' : 'email.send_failed', {
      mailboxId: mailboxIdStr,
      emailMessageId: String(emailDoc._id),
      campaignId: input.campaignId,
      errorCode: emailDoc.errorCode,
      smtpResponseCode: classified.smtpResponseCode,
      ambiguous: classified.ambiguous,
    });

    const updatedQuota = await getMailboxQuota(mailboxIdStr, mailbox.dailyLimit);
    return {
      ok: false,
      httpStatus: classified.ambiguous ? 504 : 502,
      code: bounceCheck.isHardBounce ? 'HARD_BOUNCE' : classified.errorCode,
      error: classified.message,
      ambiguous: classified.ambiguous,
      ...(bounceCheck.bounceType !== 'none' ? { bounceType: bounceCheck.bounceType } : {}),
      email: serializeEmailHistoryItem(emailDoc),
      quota: updatedQuota,
    };
  } finally {
    try {
      transporter.close();
    } catch {
      // Ignore transporter close errors
    }
  }
}
