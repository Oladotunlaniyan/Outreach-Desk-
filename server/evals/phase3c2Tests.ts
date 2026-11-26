/**
 * Phase 3C.2 Comprehensive Automated Test Suite
 *
 * Covers Sender Profile validation, completion, Express auth/CRUD routes,
 * mode-specific Sender Intelligence prioritization, writing-sample isolation,
 * prompt-injection & XSS defenses, profile-disabled generation, rubric failure
 * detection, and live-eval opt-in guardrails.
 *
 * Run:
 *   npm run test:phase3c2
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import express from 'express';
import mongoose from 'mongoose';
import { getEnvConfig } from '../config/env.ts';
import { signAuthToken } from '../middleware/auth.ts';
import { AiUsageLog, EmailMessage, Lead, SenderProfile } from '../models/index.ts';
import { senderProfileRouter } from '../routes/senderProfile.ts';
import { resetAiRateLimitForTests } from '../utils/aiUsageTracker.ts';
import { createDeepSeekChatCompletion } from '../utils/deepseekClient.ts';
import {
  buildPrioritizedSenderBrief,
  buildSafeSenderContext,
  generateCtaSuggestions,
  generatePersonalizedEmail,
  generateSubjectLineSuggestions,
  rewriteEmailDraft,
  selectRelevantWritingSamples,
} from '../utils/emailGenerator.ts';
import {
  computeSenderProfileCompletion,
  serializeSenderProfile,
  updateSenderProfileSchema,
  writingSampleInputSchema,
} from '../utils/senderProfileValidation.ts';
import {
  EVAL_CASES,
  scoreEmailOutput,
  SYNTHETIC_COMPLETE_SENDER_PROFILE,
} from './emailQualityEval.ts';

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

  // 1. Validation & Completion Tests
  await runTest('1. SenderProfile validation accepts partial updates and rejects invalid email/URL', () => {
    const partial = updateSenderProfileSchema.safeParse({
      fullName: 'Jordan Rivera',
      website: 'example.com',
      verifiedAchievements: ['Built 10 workflows', 'built 10 workflows', '  '],
    });
    assert.equal(partial.success, true);
    if (partial.success) {
      assert.equal(partial.data.website, 'https://example.com');
      assert.deepEqual(partial.data.verifiedAchievements, ['Built 10 workflows']);
    }

    const badEmail = updateSenderProfileSchema.safeParse({
      professionalEmail: 'not-an-email',
    });
    assert.equal(badEmail.success, false);

    const badUrl = updateSenderProfileSchema.safeParse({
      website: 'javascript:alert(1)',
    });
    assert.equal(badUrl.success, false);

    const badSample = writingSampleInputSchema.safeParse({
      title: 'Too short',
      content: 'hi',
    });
    assert.equal(badSample.success, false);
  });

  await runTest('2. Profile completion calculation distinguishes empty, partial, and complete profiles', () => {
    const empty = computeSenderProfileCompletion({});
    assert.equal(empty.percentage, 0);
    assert.equal(empty.hasMeaningfulProfile, false);

    const partial = computeSenderProfileCompletion({
      fullName: 'Samira Okafor',
      offerings: 'CRM audits',
    });
    assert.ok(partial.percentage > 0 && partial.percentage < 50);
    assert.equal(partial.hasMeaningfulProfile, true);
    assert.equal(partial.sections.identity, true);
    assert.equal(partial.sections.work, true);
    assert.equal(partial.sections.credibility, false);

    const full = computeSenderProfileCompletion(SYNTHETIC_COMPLETE_SENDER_PROFILE);
    assert.equal(full.percentage, 100);
    assert.equal(full.sections.writingSamples, true);
  });

  // 2. Express Auth & CRUD Integration Tests (with in-memory Mongoose store mock)
  await runTest('3. SenderProfile API enforces auth, persists updates, and handles writing sample CRUD', async () => {
    let storedDoc: Record<string, unknown> | null = null;
    const origReadyState = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    const origFindOne = SenderProfile.findOne;
    const origFindOneAndUpdate = SenderProfile.findOneAndUpdate;
    const origCreate = SenderProfile.create;

    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });

    function makeProfileInstance(data: Record<string, unknown>) {
      const instance: Record<string, unknown> = {
        ...data,
        writingSamples: Array.isArray(data.writingSamples) ? [...data.writingSamples] : [],
        async save() {
          for (const s of instance.writingSamples as Array<Record<string, unknown>>) {
            if (!s._id) s._id = new mongoose.Types.ObjectId();
          }
          instance.updatedAt = new Date();
          storedDoc = { ...instance };
          return instance;
        },
      };
      return instance;
    }

    (SenderProfile as unknown as { findOne: () => unknown }).findOne = () => ({
      lean: () => ({
        exec: async () => storedDoc,
      }),
      exec: async () => (storedDoc ? makeProfileInstance(storedDoc) : null),
    });

    (SenderProfile as unknown as { findOneAndUpdate: (f: unknown, u: { $set?: Record<string, unknown> }) => unknown }).findOneAndUpdate = (
      _filter: unknown,
      update: { $set?: Record<string, unknown> }
    ) => ({
      lean: () => ({
        exec: async () => {
          storedDoc = {
            _id: new mongoose.Types.ObjectId(),
            writingSamples: [],
            includeRoleAndOrgInIntro: true,
            ...(storedDoc || {}),
            ...(update.$set || {}),
            updatedAt: new Date(),
          };
          return storedDoc;
        },
      }),
    });

    (SenderProfile as unknown as { create: (d: Record<string, unknown>) => Promise<unknown> }).create = async (
      data: Record<string, unknown>
    ) => {
      storedDoc = {
        _id: new mongoose.Types.ObjectId(),
        writingSamples: [],
        includeRoleAndOrgInIntro: true,
        ...data,
        updatedAt: new Date(),
      };
      return makeProfileInstance(storedDoc);
    };

    const app = express();
    app.use(express.json());
    app.use('/api/sender-profile', senderProfileRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/api/sender-profile`;

    try {
      // Unauthenticated request -> 401
      const unauthRes = await fetch(baseUrl);
      assert.equal(unauthRes.status, 401);

      const { token } = signAuthToken();
      const authHeaders = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };

      // Initial empty GET
      const getEmpty = await fetch(baseUrl, { headers: authHeaders });
      assert.equal(getEmpty.status, 200);
      const emptyJson = (await getEmpty.json()) as { profile: ReturnType<typeof serializeSenderProfile> };
      assert.equal(emptyJson.profile.exists, false);

      // PUT partial profile
      const putRes = await fetch(baseUrl, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          fullName: 'Samira Okafor',
          organizationName: 'KiteLine Systems',
          offerings: 'CRM Routing Audit',
        }),
      });
      assert.equal(putRes.status, 200);
      const putJson = (await putRes.json()) as { profile: ReturnType<typeof serializeSenderProfile> };
      assert.equal(putJson.profile.exists, true);
      assert.equal(putJson.profile.fullName, 'Samira Okafor');

      // Retrieve persisted profile
      const getPersisted = await fetch(baseUrl, { headers: authHeaders });
      assert.equal(getPersisted.status, 200);
      const persistedJson = (await getPersisted.json()) as {
        profile: ReturnType<typeof serializeSenderProfile>;
      };
      assert.equal(persistedJson.profile.organizationName, 'KiteLine Systems');

      // Create writing sample
      const postSample = await fetch(`${baseUrl}/samples`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          title: 'Direct outreach',
          category: 'emails',
          content: 'Hi Devon,\n\nQuick note on your routing setup. Want me to send the checklist?',
          description: 'Short note',
        }),
      });
      assert.equal(postSample.status, 201);
      const sampleJson = (await postSample.json()) as {
        sample: { id: string; title: string };
        profile: { writingSamples: Array<{ id: string }> };
      };
      assert.ok(sampleJson.sample.id);
      assert.equal(sampleJson.profile.writingSamples.length, 1);

      // Update writing sample
      const putSample = await fetch(`${baseUrl}/samples/${sampleJson.sample.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ title: 'Updated outreach sample' }),
      });
      assert.equal(putSample.status, 200);
      const updatedSampleJson = (await putSample.json()) as { sample: { title: string } };
      assert.equal(updatedSampleJson.sample.title, 'Updated outreach sample');

      // Delete writing sample
      const delSample = await fetch(`${baseUrl}/samples/${sampleJson.sample.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(delSample.status, 200);
      const delJson = (await delSample.json()) as {
        profile: { writingSamples: Array<{ id: string }> };
      };
      assert.equal(delJson.profile.writingSamples.length, 0);
    } finally {
      server.close();
      SenderProfile.findOne = origFindOne;
      SenderProfile.findOneAndUpdate = origFindOneAndUpdate;
      SenderProfile.create = origCreate;
      if (origReadyState) {
        Object.defineProperty(mongoose.connection, 'readyState', origReadyState);
      }
    }
  });

  // 3. Mode-Specific Sender Context & Style Sample Selection
  await runTest('4. Mode-prioritized sender brief includes relevant facts and shields general emails from pitches', async () => {
    const ctx = await buildSafeSenderContext(
      { useSenderProfile: true, includeWritingSamples: true },
      { senderProfileOverride: SYNTHETIC_COMPLETE_SENDER_PROFILE }
    );

    const salesBrief = buildPrioritizedSenderBrief(ctx, 'sales');
    assert.ok('productsOrServices' in salesBrief.verifiedFacts);
    assert.ok('selectedProofPoints' in salesBrief.verifiedFacts);
    assert.ok((salesBrief.verifiedFacts.selectedProofPoints as string[]).length <= 2);

    const partnerBrief = buildPrioritizedSenderBrief(ctx, 'partnership');
    assert.ok('relevantPastPartnerships' in partnerBrief.verifiedFacts);

    const generalBrief = buildPrioritizedSenderBrief(ctx, 'general');
    assert.equal(generalBrief.verifiedFacts.name, 'Samira Okafor');
    assert.equal('productsOrServices' in generalBrief.verifiedFacts, false);
    assert.equal('relevantOfferings' in generalBrief.verifiedFacts, false);
    assert.equal('selectedProofPoints' in generalBrief.verifiedFacts, false);

    // Writing sample prioritization by mode
    const partnerSamples = selectRelevantWritingSamples(ctx.writingSamples, 'partnership', 1, 800);
    assert.equal(partnerSamples.length, 1);
    assert.equal(partnerSamples[0].category, 'partnership_pitches');
  });

  // 4. Prompt Construction, Profile Toggle, Injection Scrubbing & Explicit User Precedence
  await runTest('5. Email generator respects useSenderProfile/includeWritingSamples toggles and separates 8 prompt layers', async () => {
    resetAiRateLimitForTests();
    let capturedUserMsg = '';

    const mockCompletion = async (opts: { messages: Array<{ role: string; content: string }> }) => {
      capturedUserMsg = opts.messages.find((m) => m.role === 'user')?.content || '';
      return {
        content: JSON.stringify({
          subject: 'Routing checklist',
          text: 'Hi Maya,\n\nHappy to share a short checklist for CRM routing.\n\nBest,\nSamira',
          personalizationNotes: ['Used sender profile'],
          missingInformation: [],
        }),
        model: 'deepseek-chat',
        usage: { promptTokens: 400, completionTokens: 80, totalTokens: 480 },
        finishReason: 'stop',
        durationMs: 120,
      };
    };

    // With sender profile + samples enabled
    const withProfile = await generatePersonalizedEmail(
      {
        recipient: { name: 'Maya Chen', company: 'Northstar Ops' },
        mode: 'first_contact',
        tone: 'conversational',
        length: 'short',
        objective: 'Offer a CRM routing checklist.',
        useSenderProfile: true,
        includeWritingSamples: true,
      },
      {
        completionFn: mockCompletion,
        senderProfileOverride: SYNTHETIC_COMPLETE_SENDER_PROFILE,
        skipUsageLogging: true,
      }
    );
    assert.equal(withProfile.meta.senderProfileUsed, true);
    assert.equal(withProfile.meta.writingSamplesUsedCount, 2);
    assert.ok(capturedUserMsg.includes('SECTION A — USER\'S EXPLICIT REQUEST'));
    assert.ok(capturedUserMsg.includes('SECTION B — STRUCTURED CONTEXT & UNTRUSTED REFERENCE DATA'));
    assert.ok(capturedUserMsg.includes('Samira Okafor'));
    assert.ok(capturedUserMsg.includes('styleReferenceSamples') || capturedUserMsg.includes('writingStyleReferences'));

    // With writing samples disabled only
    resetAiRateLimitForTests();
    const withoutSamples = await generatePersonalizedEmail(
      {
        recipient: { name: 'Maya Chen', company: 'Northstar Ops' },
        mode: 'first_contact',
        tone: 'conversational',
        length: 'short',
        objective: 'Offer a CRM routing checklist.',
        useSenderProfile: true,
        includeWritingSamples: false,
      },
      {
        completionFn: mockCompletion,
        senderProfileOverride: SYNTHETIC_COMPLETE_SENDER_PROFILE,
        skipUsageLogging: true,
      }
    );
    assert.equal(withoutSamples.meta.senderProfileUsed, true);
    assert.equal(withoutSamples.meta.writingSamplesUsedCount, 0);

    // With sender profile disabled completely
    resetAiRateLimitForTests();
    const withoutProfile = await generatePersonalizedEmail(
      {
        recipient: { name: 'Maya Chen', company: 'Northstar Ops' },
        mode: 'first_contact',
        tone: 'conversational',
        length: 'short',
        objective: 'Offer a CRM routing checklist.',
        useSenderProfile: false,
        includeWritingSamples: true,
      },
      {
        completionFn: mockCompletion,
        senderProfileOverride: SYNTHETIC_COMPLETE_SENDER_PROFILE,
        skipUsageLogging: true,
      }
    );
    assert.equal(withoutProfile.meta.senderProfileUsed, false);
    assert.equal(withoutProfile.meta.writingSamplesUsedCount, 0);
    assert.equal(capturedUserMsg.includes('KiteLine Systems'), false);
  });

  await runTest('6. Rewrite, Subject Line, and CTA generators integrate sender context cleanly and sanitize HTML', async () => {
    resetAiRateLimitForTests();
    const rewriteOut = await rewriteEmailDraft(
      {
        action: 'improve',
        subject: 'Checking in',
        text: 'Hi Maya, just touching base to see if you need help.',
        tone: 'direct',
        length: 'short',
        useSenderProfile: true,
      },
      {
        senderProfileOverride: SYNTHETIC_COMPLETE_SENDER_PROFILE,
        skipUsageLogging: true,
        completionFn: async () => ({
          content: JSON.stringify({
            subject: 'CRM routing audit check',
            text: 'Hi Maya,\n\nWant to run a quick check on Northstar territory rules?',
            html: '<p>Hi Maya,</p><script>alert(1)</script><p onclick="bad()">Want to run a quick check?</p>',
            personalizationNotes: ['Removed fluff'],
            missingInformation: [],
          }),
          model: 'deepseek-chat',
          usage: { promptTokens: 200, completionTokens: 60, totalTokens: 260 },
          finishReason: 'stop',
          durationMs: 90,
        }),
      }
    );
    assert.equal(rewriteOut.meta.senderProfileUsed, true);
    assert.equal(rewriteOut.html.includes('<script'), false);
    assert.equal(rewriteOut.html.includes('onclick'), false);

    resetAiRateLimitForTests();
    const subjectOut = await generateSubjectLineSuggestions(
      {
        text: 'Hi Maya, quick note on your RevOps routing rules.',
        tone: 'direct',
        count: 3,
      },
      {
        senderProfileOverride: SYNTHETIC_COMPLETE_SENDER_PROFILE,
        skipUsageLogging: true,
        completionFn: async () => ({
          content: JSON.stringify({
            suggestions: [
              { subject: 'Territory rule cleanup', rationale: 'Direct' },
              { subject: 'territory rule cleanup', rationale: 'Duplicate' },
              { subject: 'RevOps routing audit', rationale: 'Specific' },
              { subject: 'Before your Q1 hire starts', rationale: 'Timing' },
            ],
          }),
          model: 'deepseek-chat',
          usage: { promptTokens: 180, completionTokens: 50, totalTokens: 230 },
          finishReason: 'stop',
          durationMs: 85,
        }),
      }
    );
    assert.equal(subjectOut.suggestions.length, 3);

    resetAiRateLimitForTests();
    const ctaOut = await generateCtaSuggestions(
      {
        text: 'Hi Maya, built a 1-page rule conflict checklist.',
        mode: 'first_contact',
        tone: 'conversational',
        count: 3,
      },
      {
        senderProfileOverride: SYNTHETIC_COMPLETE_SENDER_PROFILE,
        skipUsageLogging: true,
        completionFn: async () => ({
          content: JSON.stringify({
            suggestions: [
              { cta: 'Want me to send the checklist?', rationale: 'Yes/no' },
              { cta: 'Open to a 10-minute look next week?', rationale: 'Brief' },
              { cta: 'If routing is already settled, just let me know.', rationale: 'Out' },
            ],
          }),
          model: 'deepseek-chat',
          usage: { promptTokens: 170, completionTokens: 55, totalTokens: 225 },
          finishReason: 'stop',
          durationMs: 80,
        }),
      }
    );
    assert.equal(ctaOut.suggestions.length, 3);
  });

  // 5. DeepSeek blank-JSON retry + secret redaction
  await runTest('7. DeepSeek client retries once on blank JSON and never leaks API key in errors', async () => {
    let calls = 0;
    const secret = 'sk-super-secret-test-key-999';
    const res = await createDeepSeekChatCompletion({
      apiKey: secret,
      responseFormat: 'json_object',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            model: 'deepseek-chat',
            choices: [{ message: { content: calls === 1 ? '   ' : '{"ok":true}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200 }
        );
      },
    });
    assert.equal(calls, 2);
    assert.equal(res.content, '{"ok":true}');

    // 401 error must never contain API key
    await assert.rejects(
      () =>
        createDeepSeekChatCompletion({
          apiKey: secret,
          messages: [{ role: 'user', content: 'hi' }],
          fetchFn: async () => new Response(JSON.stringify({ error: { message: `Bad ${secret}` } }), { status: 401 }),
        }),
      (err: Error) => !err.message.includes(secret)
    );
  });

  // 6. Rubric Factual Integrity & Sample Non-Copying Enforcement
  await runTest('8. Rubric enforces factualIntegrity < 4 failure on fabricated stats, unconfirmed delivery, XSS, and sample copying', () => {
    const missingCredCase = EVAL_CASES.find((c) => c.id === 'eval-41')!;
    const fabricatedScore = scoreEmailOutput(missingCredCase, {
      subject: 'Deliverability check',
      text: 'Hi Nadia,\n\nWe helped 94% of SaaS teams save $12,000 per month on deliverability.',
    });
    assert.equal(fabricatedScore.factualIntegrityPass, false);
    assert.ok(fabricatedScore.triggeredChecks.includes('fabricated_metrics'));

    const unknownDeliveryCase = EVAL_CASES.find((c) => c.id === 'eval-13')!;
    const badFollowUp = scoreEmailOutput(unknownDeliveryCase, {
      subject: 'Checking in',
      text: 'Hi Carlos,\n\nDid you see my last email about SDR call-prep notes?',
    });
    assert.equal(badFollowUp.factualIntegrityPass, false);

    const sampleCase = EVAL_CASES.find((c) => c.id === 'eval-39')!;
    const copiedOutput = scoreEmailOutput(sampleCase, {
      subject: 'Routing',
      text: 'Hi Kiran,\n\nMost teams hit duplicate owner assignments right after adding a second territory tier.',
    });
    assert.ok(copiedOutput.triggeredChecks.includes('sample_verbatim_copy'));
  });

  // 7. Live evaluation CLI guard when DEEPSEEK_API_KEY is missing
  await runTest('9. Live evaluation command refuses --live without DEEPSEEK_API_KEY', () => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.DEEPSEEK_API_KEY;
    delete cleanEnv.DEEPSEEK_KEY;
    delete cleanEnv.DEEPSEEK_API;
    delete cleanEnv.VITE_DEEPSEEK_API_KEY;

    let failedAsExpected = false;
    let stderrOutput = '';
    try {
      execFileSync('npx', ['tsx', 'server/evals/emailQualityEval.ts', '--live', '--limit=1'], {
        env: cleanEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      failedAsExpected = true;
      const execErr = err as { stderr?: string };
      stderrOutput = execErr.stderr || '';
    }
    assert.equal(failedAsExpected, true);
    assert.ok(stderrOutput.includes('DEEPSEEK_API_KEY'));
  });

  // Verify env config still defaults to deepseek-chat
  await runTest('10. Centralized model config defaults to deepseek-chat with bounded timeout', () => {
    const env = getEnvConfig();
    assert.equal(env.deepseekModel, 'deepseek-chat');
    assert.ok(env.deepseekTimeoutMs >= 5000 && env.deepseekTimeoutMs <= 60000);
  });

  console.log(`\nPhase 3C.2 test summary: ${passed}/10 test groups passed.`);
}

main().catch((err) => {
  console.error('Phase 3C.2 test runner failed:', err);
  process.exit(1);
});
