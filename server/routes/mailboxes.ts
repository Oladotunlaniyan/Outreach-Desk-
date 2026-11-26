import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import { Campaign, EmailMessage, Mailbox, MailboxUsage } from '../models/index.ts';
import { isDuplicateKeyError } from '../utils/leadValidation.ts';
import {
  MailboxEncryptionError,
  decryptMailboxSecret,
  encryptMailboxSecret,
  getMailboxEncryptionStatus,
} from '../utils/mailboxCrypto.ts';
import {
  createMailboxSchema,
  serializeMailbox,
  updateMailboxSchema,
} from '../utils/mailboxValidation.ts';
import {
  buildQuotaSnapshot,
  getMailboxQuota,
  getUtcDateKey,
} from '../utils/quotaManager.ts';
import {
  validateAndResolveSmtpSecurity,
  validateSmtpHostFormat,
} from '../utils/smtpSecurity.ts';
import { verifyMailboxSmtpConnection } from '../utils/smtpVerifier.ts';

export const mailboxesRouter = Router();

mailboxesRouter.use(requireAuth);

mailboxesRouter.use((_req: Request, res: Response, next: NextFunction) => {
  const db = getDatabaseStatus();
  if (!db.connected) {
    res.status(503).json({
      error: db.lastError || 'MongoDB Atlas is not connected.',
      code: 'DB_UNAVAILABLE',
    });
    return;
  }
  next();
});

mailboxesRouter.get('/', async (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';
  const now = new Date();
  const dateKey = getUtcDateKey(now);

  try {
    const query = includeArchived ? {} : { archived: false };
    const [docs, usageDocs] = await Promise.all([
      Mailbox.find(query)
        .select('-encryptedPassword')
        .sort({ archived: 1, createdAt: -1 })
        .lean(),
      MailboxUsage.find({ dateKey }).lean(),
    ]);

    const referencedIds = new Set<string>();
    await Promise.all(
      docs.map(async (doc) => {
        const idStr = String(doc._id);
        const [hasEmail, hasCampaign] = await Promise.all([
          EmailMessage.exists({ mailboxId: idStr }),
          Campaign.exists({ mailboxId: idStr }),
        ]);
        if (hasEmail || hasCampaign) {
          referencedIds.add(idStr);
        }
      })
    );
    const usageMap = new Map(usageDocs.map((u) => [u.mailboxId, u]));

    res.json({
      encryptionStatus: getMailboxEncryptionStatus(),
      mailboxes: docs.map((doc) => {
        const idStr = String(doc._id);
        return serializeMailbox(doc, {
          hasCredentials: true,
          referencedByHistory: referencedIds.has(idStr),
          quota: buildQuotaSnapshot(idStr, doc.dailyLimit, usageMap.get(idStr) ?? null, now),
        });
      }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to list mailboxes:', err);
    res.status(500).json({
      error: 'Failed to load mailboxes from database.',
      code: 'MAILBOX_LIST_FAILED',
    });
  }
});

mailboxesRouter.get('/:id/quota', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid mailbox ID.', code: 'INVALID_ID' });
    return;
  }

  try {
    const mailbox = await Mailbox.findById(id)
      .select('name senderName senderEmail replyTo dailyLimit enabled archived verificationStatus')
      .lean();
    if (!mailbox) {
      res.status(404).json({ error: 'Mailbox not found.', code: 'NOT_FOUND' });
      return;
    }

    const quota = await getMailboxQuota(String(mailbox._id), mailbox.dailyLimit);
    res.json({
      mailbox: {
        id: String(mailbox._id),
        name: mailbox.name,
        senderName: mailbox.senderName,
        senderEmail: mailbox.senderEmail,
        replyTo: mailbox.replyTo || '',
        enabled: Boolean(mailbox.enabled),
        archived: Boolean(mailbox.archived),
        verificationStatus: mailbox.verificationStatus ?? 'untested',
        dailyLimit: mailbox.dailyLimit,
      },
      quota,
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to load mailbox quota:', err);
    res.status(500).json({
      error: 'Failed to retrieve mailbox daily sending quota.',
      code: 'MAILBOX_QUOTA_FAILED',
    });
  }
});

mailboxesRouter.post('/', async (req, res) => {
  const encryptionStatus = getMailboxEncryptionStatus();
  if (!encryptionStatus.valid) {
    res.status(503).json({
      error:
        encryptionStatus.error ||
        'MAILBOX_ENCRYPTION_KEY is missing or invalid on the server.',
      code: 'MAILBOX_ENCRYPTION_UNCONFIGURED',
    });
    return;
  }

  const parsed = createMailboxSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid mailbox configuration.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const data = parsed.data;
  const hostCheck = validateSmtpHostFormat(data.smtpHost);
  if (!hostCheck.ok) {
    res.status(400).json({ error: hostCheck.error, code: 'INVALID_SMTP_HOST' });
    return;
  }

  const securityCheck = validateAndResolveSmtpSecurity(
    data.smtpPort,
    data.securityMode
  );
  if (!securityCheck.ok) {
    res.status(400).json({ error: securityCheck.error, code: 'INVALID_SMTP_PORT' });
    return;
  }

  try {
    const duplicate = await Mailbox.findOne({
      archived: false,
      $or: [
        { name: data.name },
        {
          senderEmail: data.senderEmail,
          smtpHost: hostCheck.host,
          smtpPort: securityCheck.port,
        },
      ],
    })
      .select('name senderEmail')
      .lean();

    if (duplicate) {
      res.status(409).json({
        error:
          duplicate.name === data.name
            ? `An active mailbox named "${data.name}" already exists.`
            : `An active mailbox for ${data.senderEmail} on ${hostCheck.host}:${securityCheck.port} already exists.`,
        code: 'DUPLICATE_MAILBOX',
      });
      return;
    }

    const mailboxId = new mongoose.Types.ObjectId();
    const encryptedPassword = encryptMailboxSecret(
      data.smtpPassword,
      String(mailboxId)
    );

    const created = await Mailbox.create({
      _id: mailboxId,
      name: data.name,
      senderName: data.senderName,
      senderEmail: data.senderEmail,
      replyTo: data.replyTo || '',
      smtpHost: hostCheck.host,
      smtpPort: securityCheck.port,
      smtpUsername: data.smtpUsername,
      securityMode: securityCheck.securityMode,
      secure: securityCheck.secure,
      encryptedPassword,
      dailyLimit: data.dailyLimit,
      enabled: data.enabled,
      archived: false,
      verificationStatus: 'untested',
      lastVerificationError: '',
    });

    res.status(201).json({
      mailbox: serializeMailbox(created, {
        hasCredentials: true,
        referencedByHistory: false,
      }),
    });
  } catch (err) {
    if (err instanceof MailboxEncryptionError) {
      res.status(503).json({
        error: err.message,
        code: 'MAILBOX_ENCRYPTION_UNCONFIGURED',
      });
      return;
    }
    if (isDuplicateKeyError(err)) {
      res.status(409).json({
        error: 'A mailbox with this name or SMTP configuration already exists.',
        code: 'DUPLICATE_MAILBOX',
      });
      return;
    }
    console.error('[Outreach Desk] Failed to create mailbox:', err);
    res.status(500).json({
      error: 'Failed to save mailbox configuration.',
      code: 'MAILBOX_CREATE_FAILED',
    });
  }
});

mailboxesRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid mailbox ID.', code: 'INVALID_ID' });
    return;
  }

  const parsed = updateMailboxSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid mailbox update payload.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({
      error: 'No fields provided to update.',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  try {
    const existing = await Mailbox.findById(id).select('+encryptedPassword');
    if (!existing) {
      res.status(404).json({ error: 'Mailbox not found.', code: 'NOT_FOUND' });
      return;
    }

    const nextName = updates.name ?? existing.name;
    const nextSenderEmail = updates.senderEmail ?? existing.senderEmail;
    const nextHostInput = updates.smtpHost ?? existing.smtpHost;
    const nextPortInput = updates.smtpPort ?? existing.smtpPort;
    const nextArchived = updates.archived ?? existing.archived;

    const hostCheck = validateSmtpHostFormat(nextHostInput);
    if (!hostCheck.ok) {
      res.status(400).json({ error: hostCheck.error, code: 'INVALID_SMTP_HOST' });
      return;
    }

    const requestedMode =
      updates.securityMode ??
      (updates.smtpPort !== undefined && updates.smtpPort !== existing.smtpPort
        ? undefined
        : existing.securityMode);

    const securityCheck = validateAndResolveSmtpSecurity(
      nextPortInput,
      requestedMode
    );
    if (!securityCheck.ok) {
      res.status(400).json({ error: securityCheck.error, code: 'INVALID_SMTP_PORT' });
      return;
    }

    if (!nextArchived) {
      const duplicate = await Mailbox.findOne({
        _id: { $ne: existing._id },
        archived: false,
        $or: [
          { name: nextName },
          {
            senderEmail: nextSenderEmail,
            smtpHost: hostCheck.host,
            smtpPort: securityCheck.port,
          },
        ],
      })
        .select('name')
        .lean();

      if (duplicate) {
        res.status(409).json({
          error:
            duplicate.name === nextName
              ? `Another active mailbox named "${nextName}" already exists.`
              : `Another active mailbox for ${nextSenderEmail} on ${hostCheck.host}:${securityCheck.port} already exists.`,
          code: 'DUPLICATE_MAILBOX',
        });
        return;
      }
    }

    const hasNewPassword =
      typeof updates.smtpPassword === 'string' && updates.smtpPassword.length > 0;

    if (hasNewPassword) {
      const encryptionStatus = getMailboxEncryptionStatus();
      if (!encryptionStatus.valid) {
        res.status(503).json({
          error:
            encryptionStatus.error ||
            'MAILBOX_ENCRYPTION_KEY is missing or invalid on the server.',
          code: 'MAILBOX_ENCRYPTION_UNCONFIGURED',
        });
        return;
      }
    }

    const connectionConfigChanged =
      hostCheck.host !== existing.smtpHost ||
      securityCheck.port !== existing.smtpPort ||
      securityCheck.securityMode !== existing.securityMode ||
      (updates.smtpUsername !== undefined &&
        updates.smtpUsername !== existing.smtpUsername) ||
      hasNewPassword;

    existing.name = nextName;
    if (updates.senderName !== undefined) existing.senderName = updates.senderName;
    existing.senderEmail = nextSenderEmail;
    if (updates.replyTo !== undefined) existing.replyTo = updates.replyTo;
    existing.smtpHost = hostCheck.host;
    existing.smtpPort = securityCheck.port;
    existing.securityMode = securityCheck.securityMode;
    existing.secure = securityCheck.secure;
    if (updates.smtpUsername !== undefined) {
      existing.smtpUsername = updates.smtpUsername;
    }
    if (updates.dailyLimit !== undefined) {
      existing.dailyLimit = updates.dailyLimit;
    }
    if (updates.enabled !== undefined) {
      existing.enabled = updates.enabled;
    }
    if (updates.archived !== undefined) {
      existing.archived = updates.archived;
      existing.archivedAt = updates.archived ? new Date() : undefined;
      if (updates.archived) {
        existing.enabled = false;
      }
    }

    if (hasNewPassword && updates.smtpPassword) {
      existing.encryptedPassword = encryptMailboxSecret(
        updates.smtpPassword,
        String(existing._id)
      );
    }

    if (connectionConfigChanged) {
      existing.verificationStatus = 'untested';
      existing.lastVerificationError = '';
    }

    await existing.save();

    const [hasEmails, hasCampaigns] = await Promise.all([
      EmailMessage.exists({ mailboxId: String(existing._id) }),
      Campaign.exists({ mailboxId: String(existing._id) }),
    ]);

    res.json({
      mailbox: serializeMailbox(existing, {
        hasCredentials: Boolean(existing.encryptedPassword?.ciphertext),
        referencedByHistory: Boolean(hasEmails || hasCampaigns),
      }),
    });
  } catch (err) {
    if (err instanceof MailboxEncryptionError) {
      res.status(503).json({
        error: err.message,
        code: 'MAILBOX_ENCRYPTION_UNCONFIGURED',
      });
      return;
    }
    if (isDuplicateKeyError(err)) {
      res.status(409).json({
        error: 'Another active mailbox already uses this name or SMTP endpoint.',
        code: 'DUPLICATE_MAILBOX',
      });
      return;
    }
    console.error('[Outreach Desk] Failed to update mailbox:', err);
    res.status(500).json({
      error: 'Failed to update mailbox configuration.',
      code: 'MAILBOX_UPDATE_FAILED',
    });
  }
});

mailboxesRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid mailbox ID.', code: 'INVALID_ID' });
    return;
  }

  const requestPermanent = req.query.permanent === 'true';

  try {
    const existing = await Mailbox.findById(id).select('-encryptedPassword');
    if (!existing) {
      res.status(404).json({ error: 'Mailbox not found.', code: 'NOT_FOUND' });
      return;
    }

    const [hasEmails, hasCampaigns] = await Promise.all([
      EmailMessage.exists({ mailboxId: id }),
      Campaign.exists({ mailboxId: id }),
    ]);
    const referencedByHistory = Boolean(hasEmails || hasCampaigns);

    if (requestPermanent && !referencedByHistory) {
      await Mailbox.deleteOne({ _id: existing._id });
      res.json({
        ok: true,
        action: 'deleted',
        id,
        referencedByHistory: false,
      });
      return;
    }

    if (requestPermanent && referencedByHistory) {
      res.status(409).json({
        error:
          'This mailbox is referenced by existing email or campaign history and cannot be permanently deleted. Archive it instead to preserve history.',
        code: 'MAILBOX_REFERENCED_BY_HISTORY',
      });
      return;
    }

    existing.archived = true;
    existing.archivedAt = existing.archivedAt || new Date();
    existing.enabled = false;
    await existing.save();

    res.json({
      ok: true,
      action: 'archived',
      id,
      referencedByHistory,
      mailbox: serializeMailbox(existing, {
        hasCredentials: true,
        referencedByHistory,
      }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to archive/delete mailbox:', err);
    res.status(500).json({
      error: 'Failed to archive mailbox.',
      code: 'MAILBOX_DELETE_FAILED',
    });
  }
});

mailboxesRouter.post('/:id/test', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid mailbox ID.', code: 'INVALID_ID' });
    return;
  }

  const encryptionStatus = getMailboxEncryptionStatus();
  if (!encryptionStatus.valid) {
    res.status(503).json({
      error:
        encryptionStatus.error ||
        'MAILBOX_ENCRYPTION_KEY is missing or invalid on the server.',
      code: 'MAILBOX_ENCRYPTION_UNCONFIGURED',
    });
    return;
  }

  try {
    const mailbox = await Mailbox.findById(id).select('+encryptedPassword');
    if (!mailbox) {
      res.status(404).json({ error: 'Mailbox not found.', code: 'NOT_FOUND' });
      return;
    }

    if (mailbox.archived) {
      res.status(400).json({
        error: 'Restore an archived mailbox before testing its SMTP connection.',
        code: 'MAILBOX_ARCHIVED',
      });
      return;
    }

    if (!mailbox.encryptedPassword?.ciphertext) {
      res.status(400).json({
        error: 'No SMTP password is stored for this mailbox. Edit and save a password first.',
        code: 'MISSING_CREDENTIALS',
      });
      return;
    }

    let decryptedPassword: string;
    try {
      decryptedPassword = decryptMailboxSecret(
        mailbox.encryptedPassword,
        String(mailbox._id)
      );
    } catch (err) {
      const sanitizedMsg =
        err instanceof MailboxEncryptionError
          ? err.message
          : 'Unable to decrypt stored SMTP credentials.';

      mailbox.verificationStatus = 'failed';
      mailbox.lastTestedAt = new Date();
      mailbox.lastVerificationError = sanitizedMsg;
      await mailbox.save();

      res.status(500).json({
        ok: false,
        error: sanitizedMsg,
        code: 'DECRYPT_FAILED',
        mailbox: serializeMailbox(mailbox, { hasCredentials: true }),
      });
      return;
    }

    const result = await verifyMailboxSmtpConnection({
      host: mailbox.smtpHost,
      port: mailbox.smtpPort,
      securityMode: mailbox.securityMode,
      username: mailbox.smtpUsername,
      password: decryptedPassword,
    });

    const testedAt = new Date();
    mailbox.lastTestedAt = testedAt;
    if (result.ok) {
      mailbox.verificationStatus = 'verified';
      mailbox.lastVerifiedAt = testedAt;
      mailbox.lastVerificationError = '';
    } else {
      mailbox.verificationStatus = 'failed';
      mailbox.lastVerificationError = result.message;
    }

    await mailbox.save();

    res.status(200).json({
      ok: result.ok,
      message: result.message,
      errorCode: result.errorCode ?? null,
      mailbox: serializeMailbox(mailbox, { hasCredentials: true }),
    });
  } catch (err) {
    console.error('[Outreach Desk] Failed to run SMTP verification:', err);
    res.status(500).json({
      error: 'Unable to complete SMTP connection verification.',
      code: 'SMTP_TEST_FAILED',
    });
  }
});
