/**
 * Phase 4 Automated Verification Suite (Subphases 4A–4F + Privacy & Security)
 *
 * Run:
 *   npm run test:phase4
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import {
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  signAuthToken,
} from '../middleware/auth.ts';
import {
  Campaign,
  CampaignRecipient,
  EmailMessage,
  Lead,
  Suppression,
  UnsubscribeToken,
} from '../models/index.ts';
import { bouncesRouter } from '../routes/bounces.ts';
import { unsubscribeRouter } from '../routes/unsubscribe.ts';
import { classifySmtpBounceError } from '../utils/bounceProcessor.ts';
import {
  createCampaignSchema,
  serializeCampaign,
  serializeCampaignRecipient,
  updateCampaignSchema,
} from '../utils/campaignValidation.ts';
import {
  processCampaignBatch,
  reconcileStaleRecipients,
} from '../utils/campaignWorker.ts';
import {
  buildThreadHeaders,
  generateSmtpMessageId,
  normalizeReplySubject,
} from '../utils/emailThreading.ts';
import {
  buildRecipientContext,
  extractPlaceholders,
  renderCampaignMessageForRecipient,
} from '../utils/placeholderEngine.ts';
import {
  hashUnsubscribeToken,
  resolvePublicAppBaseUrl,
} from '../utils/suppression.ts';

let passed = 0;
async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err);
    process.exitCode = 1;
  }
}

async function main() {
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost/test-only';
  process.env.ACCESS_CODE = process.env.ACCESS_CODE || 'test-access-code';

  // 1. Subphase 4A — Campaign validation & serialization
  await runTest('1. [4A] Campaign schemas reject CRLF subjects, invalid Reply-To, and serialize fields cleanly', () => {
    const okCreate = createCampaignSchema.safeParse({
      name: 'Q2 Growth',
      mailboxId: new mongoose.Types.ObjectId().toHexString(),
      replyTo: 'replies@example.com',
      subjectTemplate: 'Hello {{first_name}}',
      bodyTextTemplate: 'Hi {{first_name}}',
      sendConfig: { batchSize: 10, delayMs: 500, concurrency: 2, threadFollowUps: true },
    });
    assert.equal(okCreate.success, true);

    const badSubject = createCampaignSchema.safeParse({
      name: 'Bad',
      mailboxId: '507f1f77bcf86cd799439011',
      subjectTemplate: 'Hi\r\nBcc: evil@attacker.com',
    });
    assert.equal(badSubject.success, false);

    const badUpdate = updateCampaignSchema.safeParse({ replyTo: 'not-an-email' });
    assert.equal(badUpdate.success, false);

    const now = new Date();
    const campId = new mongoose.Types.ObjectId();
    const serialized = serializeCampaign(
      {
        _id: campId,
        name: 'Test Camp',
        status: 'Draft',
        mailboxId: '507f1f77bcf86cd799439011',
        subjectTemplate: 'Hi',
        bodyTextTemplate: 'Body',
        createdAt: now,
        updatedAt: now,
      },
      {
        counts: {
          pending: 3,
          queued: 0,
          sending: 0,
          sent: 2,
          failed: 1,
          bounced: 0,
          ambiguous: 0,
          skipped_suppressed: 1,
          cancelled: 0,
        },
        mailboxName: 'Primary',
        mailboxEmail: 'outreach@example.com',
        mailboxVerified: true,
        mailboxEnabled: true,
      }
    );
    assert.equal(serialized.totalRecipients, 7);
    assert.equal(serialized.sentCount, 2);
    assert.equal(serialized.failedCount, 1);
    assert.equal(serialized.counts.skipped_suppressed, 1);

    const recSerialized = serializeCampaignRecipient({
      _id: new mongoose.Types.ObjectId(),
      campaignId: campId,
      email: 'alex@example.com',
      status: 'queued',
      missingPlaceholders: ['plan_tier'],
      createdAt: now,
      updatedAt: now,
    });
    assert.deepEqual(recSerialized.missingPlaceholders, ['plan_tier']);
    assert.equal(recSerialized.status, 'queued');
  });

  // 2. Subphase 4B — Placeholder engine, aliases, custom CSV columns, XSS & CRLF safety
  await runTest('2. [4B] Placeholder engine resolves aliases/customFields, tracks missing keys, and neutralizes XSS/CRLF', () => {
    const keys = extractPlaceholders('Hi {{first_name}} at {{ org }} ({{Plan Tier}})');
    assert.deepEqual(keys, ['first_name', 'org', 'plan_tier']);

    const ctx = buildRecipientContext({
      fullName: 'Maya Chen',
      email: 'maya@northstar.example',
      company: 'Northstar Ops',
      role: 'VP Revenue',
      customFields: { plan_tier: '<script>alert(1)</script>Enterprise' },
    });
    assert.equal(ctx.first_name, 'Maya');
    assert.equal(ctx.last_name, 'Chen');
    assert.equal(ctx.org, 'Northstar Ops');
    assert.equal(ctx.title, 'VP Revenue');

    const rendered = renderCampaignMessageForRecipient({
      subjectTemplate: 'Re: {{company}}\r\nInjected',
      bodyTextTemplate: 'Hi {{first_name}} on {{plan_tier}} in {{unknown_col}}',
      bodyHtmlTemplate:
        '<p>Hi {{first_name}} at {{company}} ({{plan_tier}})</p><script>steal()</script><img src=x onerror=alert(1)>',
      recipient: {
        fullName: 'Maya Chen',
        company: 'Northstar & Co',
        customFields: { plan_tier: '<b>Pro</b>' },
      },
    });

    assert.equal(rendered.subject.includes('\r'), false);
    assert.equal(rendered.subject.includes('\n'), false);
    assert.deepEqual(rendered.missingPlaceholders, ['unknown_col']);
    assert.equal(rendered.html.includes('<script'), false);
    assert.equal(rendered.html.includes('onerror'), false);
    assert.ok(rendered.html.includes('Northstar &amp; Co'));
    assert.ok(rendered.html.includes('&lt;b&gt;Pro&lt;/b&gt;'));
  });

  // 3. Subphase 4C — Worker stale reconciliation & idempotent batch sending
  await runTest('3. [4C] reconcileStaleRecipients reconciles sent & ambiguous sends without duplicate delivery', async () => {
    const campId = new mongoose.Types.ObjectId().toHexString();
    const recSentId = new mongoose.Types.ObjectId();
    const recUnknownId = new mongoose.Types.ObjectId();
    const recNoMsgId = new mongoose.Types.ObjectId();

    const makeRec = (id: mongoose.Types.ObjectId) => {
      const obj: Record<string, unknown> = {
        _id: id,
        campaignId: campId,
        status: 'sending',
        savedCount: 0,
        async save() {
          obj.savedCount = Number(obj.savedCount) + 1;
          return obj;
        },
      };
      return obj;
    };

    const recSent = makeRec(recSentId);
    const recUnknown = makeRec(recUnknownId);
    const recNoMsg = makeRec(recNoMsgId);

    const origRecFind = CampaignRecipient.find;
    const origMsgFindOne = EmailMessage.findOne;

    (CampaignRecipient as unknown as { find: () => Promise<unknown[]> }).find = async () => [
      recSent,
      recUnknown,
      recNoMsg,
    ];
    (EmailMessage as unknown as { findOne: (q: { idempotencyKey: string }) => unknown }).findOne = (
      query: { idempotencyKey: string }
    ) => ({
      sort: () => ({
        lean: async () => {
          if (query.idempotencyKey === `campaign-${campId}-recipient-${String(recSentId)}`) {
            return {
              _id: new mongoose.Types.ObjectId(),
              status: 'Sent',
              sentAt: new Date(),
              messageId: '<msg-1@example.com>',
              threadId: 'thread-1',
            };
          }
          if (query.idempotencyKey === `campaign-${campId}-recipient-${String(recUnknownId)}`) {
            return {
              _id: new mongoose.Types.ObjectId(),
              status: 'unknown',
              errorCode: 'AMBIGUOUS_DELIVERY',
              error: 'Post-DATA socket timeout',
            };
          }
          return null;
        },
      }),
    });

    try {
      const count = await reconcileStaleRecipients(campId, new Date());
      assert.equal(count, 3);
      assert.equal(recSent.status, 'sent');
      assert.equal(recSent.smtpMessageId, '<msg-1@example.com>');
      assert.equal(recUnknown.status, 'ambiguous');
      assert.equal(recNoMsg.status, 'queued');
    } finally {
      CampaignRecipient.find = origRecFind;
      EmailMessage.findOne = origMsgFindOne;
    }
  });

  await runTest('4. [4C] processCampaignBatch enforces idempotencyKey and pauses cleanly on QUOTA_EXCEEDED', async () => {
    const campId = new mongoose.Types.ObjectId().toHexString();
    const recId = new mongoose.Types.ObjectId();

    const campaignDoc: Record<string, unknown> = {
      _id: campId,
      status: 'Sending',
      mailboxId: new mongoose.Types.ObjectId().toHexString(),
      replyTo: 'reply@example.com',
      subjectTemplate: 'Hello {{first_name}}',
      bodyTextTemplate: 'Hi {{first_name}}',
      bodyHtmlTemplate: '',
      sendConfig: {
        batchSize: 5,
        delayMs: 0,
        concurrency: 1,
        dailySendCap: null,
        threadFollowUps: false,
      },
    };

    const recDoc: Record<string, unknown> = {
      _id: recId,
      campaignId: campId,
      email: 'alex@example.com',
      firstName: 'Alex',
      fullName: 'Alex Morgan',
      renderedSubject: 'Hello Alex',
      renderedText: 'Hi Alex',
      renderedHtml: '<p>Hi Alex</p>',
      status: 'queued',
      attempts: 1,
      async save() {
        return recDoc;
      },
    };

    const origCampFindOneAndUpdate = Campaign.findOneAndUpdate;
    const origCampFindById = Campaign.findById;
    const origCampUpdateOne = Campaign.updateOne;
    const origRecFind = CampaignRecipient.find;
    const origRecExists = CampaignRecipient.exists;
    const origRecFindOneAndUpdate = CampaignRecipient.findOneAndUpdate;
    const origRecAggregate = CampaignRecipient.aggregate;
    const origSupFind = Suppression.find;
    const origLeadFind = Lead.find;

    let pausedStatusSet = '';
    let capturedIdempotencyKey = '';

    (Campaign as unknown as { findOneAndUpdate: () => Promise<unknown> }).findOneAndUpdate =
      async () => campaignDoc;
    (Campaign as unknown as { findById: () => unknown }).findById = () => ({
      select: () => ({ lean: async () => campaignDoc }),
    });
    (Campaign as unknown as { updateOne: (_q: unknown, u: { $set?: { status?: string } }) => Promise<unknown> }).updateOne =
      async (_q: unknown, u: { $set?: { status?: string } }) => {
        if (u.$set?.status) {
          pausedStatusSet = u.$set.status;
          campaignDoc.status = u.$set.status;
        }
        return { modifiedCount: 1 };
      };
    (CampaignRecipient as unknown as { find: () => Promise<unknown[]> }).find = async () => [];
    (CampaignRecipient as unknown as { exists: () => Promise<unknown> }).exists = async () => ({
      _id: recId,
    });
    (CampaignRecipient as unknown as { findOneAndUpdate: () => Promise<unknown> }).findOneAndUpdate =
      async () => recDoc;
    (CampaignRecipient as unknown as { aggregate: () => Promise<unknown[]> }).aggregate = async () => [
      { _id: { campaignId: campId, status: 'queued' }, count: 1 },
    ];
    (Suppression as unknown as { find: () => unknown }).find = () => ({
      select: () => ({ lean: async () => [] }),
    });
    (Lead as unknown as { find: () => unknown }).find = () => ({
      select: () => ({ lean: async () => [] }),
    });

    try {
      const batchRes = await processCampaignBatch(campId, {
        sleep: async () => {},
        sendEmail: async (input) => {
          capturedIdempotencyKey = input.idempotencyKey || '';
          return {
            ok: false,
            httpStatus: 429,
            code: 'QUOTA_EXCEEDED',
            error: 'Mailbox daily quota reached.',
          };
        },
      });

      assert.equal(capturedIdempotencyKey, `campaign-${campId}-recipient-${String(recId)}`);
      assert.equal(batchRes.paused, true);
      assert.equal(pausedStatusSet, 'Paused');
      assert.equal(recDoc.status, 'queued');
      assert.equal(recDoc.attempts, 0);
    } finally {
      Campaign.findOneAndUpdate = origCampFindOneAndUpdate;
      Campaign.findById = origCampFindById;
      Campaign.updateOne = origCampUpdateOne;
      CampaignRecipient.find = origRecFind;
      CampaignRecipient.exists = origRecExists;
      CampaignRecipient.findOneAndUpdate = origRecFindOneAndUpdate;
      CampaignRecipient.aggregate = origRecAggregate;
      Suppression.find = origSupFind;
      Lead.find = origLeadFind;
    }
  });

  // 4. Subphase 4D — Email Threading helpers
  await runTest('5. [4D] Threading helpers generate RFC Message-IDs, normalize Re: subjects, and build headers', () => {
    const msgId = generateSmtpMessageId('Founder@NorthStar.com');
    assert.match(msgId, /^<[^@\s]+@northstar\.com>$/);

    assert.equal(normalizeReplySubject('Quick note'), 'Re: Quick note');
    assert.equal(normalizeReplySubject('Re: Quick note'), 'Re: Quick note');

    const headers = buildThreadHeaders({
      messageId: '<new@northstar.com>',
      inReplyTo: '<prev@northstar.com>',
      references: ['<root@northstar.com>', '<prev@northstar.com>'],
    });
    assert.equal(headers['Message-ID'], '<new@northstar.com>');
    assert.equal(headers['In-Reply-To'], '<prev@northstar.com>');
    assert.equal(headers.References, '<root@northstar.com> <prev@northstar.com>');
  });

  // 5. Subphase 4E — Unsubscribe hashing, public URL resolution, and RFC 8058 endpoints
  await runTest('6. [4E] Unsubscribe token hashing & routes handle invalid 404, GET HTML, and RFC 8058 POST', async () => {
    const hashA = hashUnsubscribeToken('secret-token-value-1234');
    const hashB = hashUnsubscribeToken('secret-token-value-1234');
    assert.equal(hashA, hashB);
    assert.equal(hashA.length, 64);

    assert.equal(
      resolvePublicAppBaseUrl('https://outreach.example.com/'),
      'https://outreach.example.com'
    );
    assert.equal(resolvePublicAppBaseUrl('javascript:alert(1)'), '');

    const origReadyState = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    const origTokFindOne = UnsubscribeToken.findOne;
    const origSupFindOneAndUpdate = Suppression.findOneAndUpdate;
    const origLeadUpdateOne = Lead.updateOne;
    const origRecFind = CampaignRecipient.find;

    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });

    const validRawToken = 'validUnsubscribeToken_123456';
    const validHash = hashUnsubscribeToken(validRawToken);
    let savedUsageMethod = '';

    (UnsubscribeToken as unknown as { findOne: (q: { tokenHash: string }) => Promise<unknown> }).findOne =
      async (q: { tokenHash: string }) => {
        if (q.tokenHash !== validHash) return null;
        const mockTok: {
          _id: mongoose.Types.ObjectId;
          tokenHash: string;
          email: string;
          usedMethod?: string;
          save: () => Promise<void>;
        } = {
          _id: new mongoose.Types.ObjectId(),
          tokenHash: validHash,
          email: 'prospect@example.com',
          async save() {
            savedUsageMethod = mockTok.usedMethod || '';
          },
        };
        return mockTok;
      };
    (Suppression as unknown as { findOneAndUpdate: () => Promise<unknown> }).findOneAndUpdate =
      async () => ({});
    (Lead as unknown as { updateOne: () => Promise<unknown> }).updateOne = async () => ({});
    (CampaignRecipient as unknown as { find: () => unknown }).find = () => ({
      select: () => ({ lean: async () => [] }),
    });

    const app = express();
    app.use('/api/unsubscribe', unsubscribeRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const invalidGet = await fetch(
        `http://127.0.0.1:${port}/api/unsubscribe/does_not_exist_12345`
      );
      assert.equal(invalidGet.status, 404);
      assert.equal(invalidGet.headers.get('x-robots-tag'), 'noindex, nofollow');

      const validGet = await fetch(
        `http://127.0.0.1:${port}/api/unsubscribe/${validRawToken}`
      );
      assert.equal(validGet.status, 200);
      const html = await validGet.text();
      assert.ok(html.includes('You have been unsubscribed'));
      assert.ok(html.includes('noindex, nofollow'));
      assert.equal(savedUsageMethod, 'GET');

      const validPost = await fetch(
        `http://127.0.0.1:${port}/api/unsubscribe/${validRawToken}`,
        { method: 'POST' }
      );
      assert.equal(validPost.status, 200);
      const postJson = (await validPost.json()) as { ok: boolean; unsubscribed: boolean };
      assert.equal(postJson.unsubscribed, true);
    } finally {
      server.close();
      UnsubscribeToken.findOne = origTokFindOne;
      Suppression.findOneAndUpdate = origSupFindOneAndUpdate;
      Lead.updateOne = origLeadUpdateOne;
      CampaignRecipient.find = origRecFind;
      if (origReadyState) {
        Object.defineProperty(mongoose.connection, 'readyState', origReadyState);
      }
    }
  });

  // 6. Subphase 4F — Bounce classification & bounce route auth guard
  await runTest('7. [4F] Bounce classifier distinguishes 550/5.1.1 hard bounces from 535 auth, 4xx soft, and timeouts', async () => {
    const hard = classifySmtpBounceError({
      responseCode: 550,
      response: '550 5.1.1 The email account does not exist',
    });
    assert.equal(hard.isHardBounce, true);
    assert.equal(hard.bounceType, 'hard');

    const auth = classifySmtpBounceError({ responseCode: 535, message: 'Auth failed' });
    assert.equal(auth.isHardBounce, false);
    assert.equal(auth.bounceType, 'none');

    const soft = classifySmtpBounceError({ responseCode: 421, message: 'Try again later' });
    assert.equal(soft.isHardBounce, false);
    assert.equal(soft.bounceType, 'soft');

    const timeout = classifySmtpBounceError({ code: 'ETIMEDOUT', message: 'Socket timeout' });
    assert.equal(timeout.isHardBounce, false);
    assert.equal(timeout.bounceType, 'none');

    // Bounce route rejects unauthenticated requests
    const app = express();
    app.use(express.json());
    app.use('/api/bounces', bouncesRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const unauth = await fetch(`http://127.0.0.1:${port}/api/bounces/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'b@example.com', bounceType: 'hard' }),
      });
      assert.equal(unauth.status, 401);

      const { token } = signAuthToken();
      assert.ok(token.length > 10);
    } finally {
      server.close();
    }
  });

  // 7. Post-Phase-4 — Rate limit lockout & search-engine privacy files
  await runTest('8. [Privacy] Login lockout triggers after 5 failures and robots.txt/noindex protect deployment', () => {
    const testIp = '198.51.100.42';
    resetLoginAttempts(testIp);
    for (let i = 0; i < 4; i += 1) {
      const res = recordFailedLogin(testIp);
      assert.equal(res.locked, false);
    }
    const fifth = recordFailedLogin(testIp);
    assert.equal(fifth.locked, true);
    assert.equal(checkLoginRateLimit(testIp).allowed, false);
    resetLoginAttempts(testIp);

    const robotsPath = path.resolve(process.cwd(), 'public', 'robots.txt');
    const robots = fs.readFileSync(robotsPath, 'utf8');
    assert.ok(robots.includes('Disallow: /'));

    const indexHtmlPath = path.resolve(process.cwd(), 'index.html');
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    assert.ok(indexHtml.includes('name="robots" content="noindex, nofollow"'));
  });

  console.log(`\nPhase 4 test summary: ${passed}/8 test groups passed.`);
}

main().catch((err) => {
  console.error('Phase 4 test runner failed:', err);
  process.exit(1);
});
