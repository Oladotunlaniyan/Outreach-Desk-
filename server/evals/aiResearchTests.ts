/**
 * AI Lead Research Automated Test Suite
 *
 * Covers:
 * 1. Public web fetch SSRF & URL validation guards
 * 2. Real web search + crawl + zero email fabrication guard
 * 3. DeepSeek free-tier rate-limit (429) pause + checkpointed resume without re-searching
 * 4. ResearchCache hit skips redundant website crawls / search calls
 * 5. Duplicate detection (email, website domain, company, and Suppression list)
 * 6. First-touch draft generation reusing Sender Intelligence, partial 429 survival, editable & never auto-sent
 * 7. Approve & Import into existing Lead system (source: 'ai_research') + optional Draft campaign
 * 8. Express /api/research auth guard & CRUD/action endpoints
 *
 * Run:
 *   npm run test:research
 */
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { signAuthToken } from '../middleware/auth.ts';
import {
  Campaign,
  CampaignRecipient,
  Lead,
  LeadResearchJob,
  Mailbox,
  SenderProfile,
  Suppression,
} from '../models/index.ts';
import { researchRouter } from '../routes/research.ts';
import { resetAiRateLimitForTests } from '../utils/aiUsageTracker.ts';
import { DeepSeekClientError } from '../utils/deepseekClient.ts';
import {
  annotateProspectDuplicates,
  crawlCandidateWebsite,
  createLeadResearchJob,
  generateResearchDraftEmails,
  importApprovedResearchProspects,
  performRealWebSearch,
  runResearchJobUntilStop,
  type WebSearchHit,
} from '../utils/leadResearcher.ts';
import { assertPublicHttpTarget, fetchSafePublicUrl, validatePublicHttpUrl } from '../utils/webFetchSecurity.ts';

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

interface StoredJobDoc extends Record<string, unknown> {
  _id: mongoose.Types.ObjectId;
  query: Record<string, unknown>;
  status: string;
  progress: Record<string, unknown>;
  searchQueriesExecuted: string[];
  rawCandidates: Array<Record<string, unknown>>;
  prospects: Array<Record<string, unknown>>;
  lastError: Record<string, unknown> | null;
  resumeAfter: Date | null;
  workerLease?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  save: () => Promise<StoredJobDoc>;
}

function createInMemoryResearchJobHarness() {
  const jobs = new Map<string, StoredJobDoc>();

  function attachSave(doc: Record<string, unknown>): StoredJobDoc {
    const obj = doc as StoredJobDoc;
    if (!obj._id) obj._id = new mongoose.Types.ObjectId();
    if (!obj.createdAt) obj.createdAt = new Date();
    if (!obj.updatedAt) obj.updatedAt = new Date();
    if (!Array.isArray(obj.searchQueriesExecuted)) obj.searchQueriesExecuted = [];
    if (!Array.isArray(obj.rawCandidates)) obj.rawCandidates = [];
    if (!Array.isArray(obj.prospects)) obj.prospects = [];

    obj.save = async () => {
      for (const p of obj.prospects) {
        if (!p._id) p._id = new mongoose.Types.ObjectId();
      }
      obj.updatedAt = new Date();
      jobs.set(String(obj._id), obj);
      return obj;
    };
    jobs.set(String(obj._id), obj);
    return obj;
  }

  const origCreate = LeadResearchJob.create;
  const origFindById = LeadResearchJob.findById;
  const origFind = LeadResearchJob.find;
  const origFindOneAndUpdate = LeadResearchJob.findOneAndUpdate;
  const origFindByIdAndDelete = LeadResearchJob.findByIdAndDelete;

  (LeadResearchJob as unknown as { create: (d: Record<string, unknown>) => Promise<StoredJobDoc> }).create =
    async (data: Record<string, unknown>) => {
      const doc = attachSave({
        ...data,
        searchQueriesExecuted: data.searchQueriesExecuted || [],
        rawCandidates: data.rawCandidates || [],
        prospects: data.prospects || [],
        lastError: null,
        resumeAfter: null,
      });
      return doc;
    };

  (LeadResearchJob as unknown as { findById: (id: string) => unknown }).findById = (id: string) => {
    const found = jobs.get(String(id)) || null;
    const queryObj = {
      select: () => ({
        lean: async () => (found ? { ...found } : null),
      }),
      lean: async () => (found ? { ...found } : null),
      then: (resolve: (val: StoredJobDoc | null) => void, reject?: (err: unknown) => void) =>
        Promise.resolve(found).then(resolve, reject),
    };
    return queryObj;
  };

  (LeadResearchJob as unknown as { find: () => unknown }).find = () => ({
    sort: () => ({
      limit: async (n: number) =>
        Array.from(jobs.values())
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, n),
    }),
  });

  (LeadResearchJob as unknown as { findOneAndUpdate: (f: Record<string, unknown>, u: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> }) => Promise<StoredJobDoc | null> }).findOneAndUpdate =
    async (filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> }) => {
      if (update.$setOnInsert && Object.keys(update.$setOnInsert).length === 0) {
        throw new Error("MongoServerError: '$setOnInsert' is empty.");
      }
      const found = jobs.get(String(filter._id));
      if (!found) return null;
      const allowedStatuses = (filter.status as { $in?: string[] })?.$in || [];
      if (allowedStatuses.length > 0 && !allowedStatuses.includes(found.status)) {
        return null;
      }
      if (update.$set) {
        Object.assign(found, update.$set);
      }
      found.updatedAt = new Date();
      return found;
    };

  (LeadResearchJob as unknown as { findByIdAndDelete: (id: string) => unknown }).findByIdAndDelete = (
    id: string
  ) => ({
    lean: async () => {
      const found = jobs.get(String(id)) || null;
      if (found) jobs.delete(String(id));
      return found;
    },
  });

  return {
    jobs,
    restore() {
      LeadResearchJob.create = origCreate;
      LeadResearchJob.findById = origFindById;
      LeadResearchJob.find = origFind;
      LeadResearchJob.findOneAndUpdate = origFindOneAndUpdate;
      LeadResearchJob.findByIdAndDelete = origFindByIdAndDelete;
    },
  };
}

function mockEmptyLeadsAndSuppressions(
  existingLeads: Array<Record<string, unknown>> = [],
  suppressions: Array<Record<string, unknown>> = []
) {
  const origLeadFind = Lead.find;
  const origLeadCreate = Lead.create;
  const origSupFind = Suppression.find;

  const createdLeads: Array<Record<string, unknown>> = [];

  (Lead as unknown as { find: (q?: Record<string, unknown>) => unknown }).find = (
    query?: Record<string, unknown>
  ) => {
    const emailIn = (query?.email as { $in?: string[] } | undefined)?.$in;
    const hasOrFilter = Array.isArray(query?.$or);
    const filtered = existingLeads.filter((l) => {
      if (emailIn && !emailIn.includes(String(l.email).toLowerCase())) {
        return false;
      }
      if (hasOrFilter) {
        return Boolean(l.optedOut) || Boolean(l.bounced) || l.status === 'Invalid';
      }
      return true;
    });

    return {
      select: () => ({
        lean: async () => filtered,
      }),
      lean: async () => filtered,
    };
  };

  (Lead as unknown as { create: (doc: Record<string, unknown>) => Promise<Record<string, unknown>> }).create =
    async (doc: Record<string, unknown>) => {
      const saved = { _id: new mongoose.Types.ObjectId(), ...doc };
      createdLeads.push(saved);
      existingLeads.push(saved);
      return saved;
    };

  (Suppression as unknown as { find: (q?: Record<string, unknown>) => unknown }).find = (
    query?: Record<string, unknown>
  ) => {
    const emailIn = (query?.email as { $in?: string[] } | undefined)?.$in;
    const filtered = emailIn
      ? suppressions.filter((s) => emailIn.includes(String(s.email).toLowerCase()))
      : suppressions;
    return {
      select: () => ({
        lean: async () => filtered,
      }),
      lean: async () => filtered,
    };
  };

  return {
    createdLeads,
    restore() {
      Lead.find = origLeadFind;
      Lead.create = origLeadCreate;
      Suppression.find = origSupFind;
    },
  };
}

async function main() {
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost/test-only';
  process.env.ACCESS_CODE = process.env.ACCESS_CODE || 'test-access-code';

  // 1. SSRF & Public URL Validation
  await runTest('1. Public web fetch blocks loopback, private, metadata, and unsafe redirects', async () => {
    assert.equal(validatePublicHttpUrl('http://127.0.0.1:8080').ok, false);
    assert.equal(validatePublicHttpUrl('http://169.254.169.254/latest/meta-data').ok, false);
    assert.equal(validatePublicHttpUrl('http://10.0.0.5/admin').ok, false);
    assert.equal(validatePublicHttpUrl('http://intranet.local/team').ok, false);
    assert.equal(validatePublicHttpUrl('file:///etc/passwd').ok, false);
    assert.equal(validatePublicHttpUrl('https://user:pass@example.com').ok, false);
    assert.equal(validatePublicHttpUrl('https://acme-dental.example/contact').ok, true);

    const dnsBlocked = await assertPublicHttpTarget('https://rebind.example', async () => [
      { address: '10.12.0.5', family: 4 },
    ]);
    assert.equal(dnsBlocked.ok, false);

    // Redirect to private IP must be rejected before fetching the second hop
    await assert.rejects(
      () =>
        fetchSafePublicUrl('https://public-site.example/', {
          lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
          fetchFn: async () =>
            new Response('', {
              status: 302,
              headers: { location: 'http://169.254.169.254/latest/meta-data' },
            }),
        }),
      /Private or loopback IP|restricted network/i
    );
  });

  // 2. Real web search + crawl + anti-fabrication email guard
  await runTest('2. Anti-fabrication guard rejects guessed emails and preserves verified/generic/snippet confidence', async () => {
    const origReadyState = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 0 });
    const jobHarness = createInMemoryResearchJobHarness();
    const leadMocks = mockEmptyLeadsAndSuppressions();

    try {
      const job = await createLeadResearchJob({
        industry: 'Boutique Architecture',
        location: 'Seattle, WA',
        targetRoles: ['Principal', 'Founder'],
        desiredCount: 3,
        runImmediately: false,
      });

      const hits: WebSearchHit[] = [
        {
          title: 'Northbeam Studio | Architecture in Seattle',
          url: 'https://northbeam-arch.test/',
          snippet: 'Seattle residential architecture led by Maya Lin.',
          query: 'q1',
        },
        {
          title: 'Cascadia Builders LLC',
          url: 'https://cascadia-build.test/',
          snippet: 'Design-build firm in Seattle.',
          query: 'q1',
        },
        {
          title: 'Sound Drafting Co',
          url: 'https://sound-drafting.test/',
          snippet: 'Contact Jordan Lee via snippet jordan@sound-drafting.test',
          query: 'q1',
        },
      ];

      const completed = await runResearchJobUntilStop(String(job._id), {
        skipCache: true,
        skipUsageLogging: true,
        searchWebFn: async () => hits,
        fetchPageFn: async (url) => {
          if (url.startsWith('https://northbeam-arch.test')) {
            if (url.endsWith('/contact')) {
              return {
                ok: true,
                status: 200,
                finalUrl: 'https://northbeam-arch.test/contact',
                contentType: 'text/html',
                body: '<p>Principal: Elena Vance — email <a href="mailto:elena@northbeam-arch.test">elena@northbeam-arch.test</a></p>',
              };
            }
            return {
              ok: true,
              status: 200,
              finalUrl: 'https://northbeam-arch.test/',
              contentType: 'text/html',
              body: '<title>Northbeam Studio</title><a href="/contact">Contact</a><p>Seattle architecture practice.</p>',
            };
          }
          if (url.startsWith('https://cascadia-build.test')) {
            return {
              ok: true,
              status: 200,
              finalUrl: 'https://cascadia-build.test/',
              contentType: 'text/html',
              body: '<title>Cascadia Builders</title><p>Reach our office at hello@cascadia-build.test</p>',
            };
          }
          return {
            ok: true,
            status: 200,
            finalUrl: url,
            contentType: 'text/html',
            body: '<title>Sound Drafting Co</title><p>Architectural drafting services in Seattle.</p>',
          };
        },
        completionFn: async () => ({
          content: JSON.stringify({
            prospects: [
              {
                candidateIndex: 0,
                isRelevantBusiness: true,
                company: 'Northbeam Studio',
                businessSummary: 'Seattle boutique architecture firm.',
                location: 'Seattle, WA',
                fullName: 'Elena Vance',
                role: 'Principal',
                email: 'elena@northbeam-arch.test', // verbatim crawled
              },
              {
                candidateIndex: 1,
                isRelevantBusiness: true,
                company: 'Cascadia Builders',
                businessSummary: 'Seattle design-build studio.',
                location: 'Seattle, WA',
                fullName: '',
                role: 'Founder',
                email: 'fabricated.ceo@cascadia-build.test', // LLM hallucinated email! Must be discarded -> fallback hello@
              },
              {
                candidateIndex: 2,
                isRelevantBusiness: true,
                company: 'Sound Drafting Co',
                businessSummary: 'Drafting studio in Seattle.',
                location: 'Seattle, WA',
                fullName: 'Jordan Lee',
                role: 'Founder',
                email: 'jordan@sound-drafting.test', // snippet only
              },
            ],
          }),
          model: 'deepseek-chat',
          usage: { promptTokens: 100, completionTokens: 120, totalTokens: 220 },
          finishReason: 'stop',
          durationMs: 250,
        }),
      });

      assert.ok(completed);
      assert.equal(completed.status, 'Completed');
      assert.equal(completed.prospects.length, 3);

      const p0 = completed.prospects[0];
      assert.equal(p0.email, 'elena@northbeam-arch.test');
      assert.equal(p0.emailConfidence, 'verified_published');
      assert.ok(p0.sourceUrls.includes('https://northbeam-arch.test/contact'));

      const p1 = completed.prospects[1];
      assert.notEqual(p1.email, 'fabricated.ceo@cascadia-build.test');
      assert.equal(p1.email, 'hello@cascadia-build.test');
      assert.equal(p1.emailConfidence, 'published_generic');

      const p2 = completed.prospects[2];
      assert.equal(p2.email, 'jordan@sound-drafting.test');
      assert.equal(p2.emailConfidence, 'inferred_unverified');
    } finally {
      jobHarness.restore();
      leadMocks.restore();
      if (origReadyState) Object.defineProperty(mongoose.connection, 'readyState', origReadyState);
    }
  });

  // 3. Free-tier 429 pause & checkpointed resume
  await runTest('3. DeepSeek 429 pauses cleanly after Batch 1 and resumes Batch 2 without re-searching', async () => {
    const origReadyState = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 0 });
    const jobHarness = createInMemoryResearchJobHarness();
    const leadMocks = mockEmptyLeadsAndSuppressions();

    try {
      const job = await createLeadResearchJob({
        industry: 'Dental Clinics',
        location: 'Austin, TX',
        targetRoles: ['Owner'],
        desiredCount: 4,
        runImmediately: false,
      });

      let searchCalls = 0;
      let batchCalls = 0;

      const hits: WebSearchHit[] = [
        { title: 'Clinic One', url: 'https://clinic1.test/', snippet: 'c1@clinic1.test', query: 'q' },
        { title: 'Clinic Two', url: 'https://clinic2.test/', snippet: 'c2@clinic2.test', query: 'q' },
        { title: 'Clinic Three', url: 'https://clinic3.test/', snippet: 'c3@clinic3.test', query: 'q' },
        { title: 'Clinic Four', url: 'https://clinic4.test/', snippet: 'c4@clinic4.test', query: 'q' },
      ];

      const searchWebFn = async () => {
        searchCalls += 1;
        return hits;
      };

      const fetchPageFn = async (url: string) => ({
        ok: true,
        status: 200,
        finalUrl: url,
        contentType: 'text/html',
        body: '<p>Austin dental clinic</p>',
      });

      // Run 1: Batch 1 succeeds, Batch 2 hits 429 with retryAfterSeconds > 12 -> pauses cleanly
      const pausedJob = await runResearchJobUntilStop(String(job._id), {
        skipCache: true,
        skipUsageLogging: true,
        sleepFn: async () => {},
        searchWebFn,
        fetchPageFn,
        completionFn: async () => {
          batchCalls += 1;
          if (batchCalls === 1) {
            return {
              content: JSON.stringify({
                prospects: [
                  { candidateIndex: 0, isRelevantBusiness: true, company: 'Clinic One', email: 'c1@clinic1.test' },
                  { candidateIndex: 1, isRelevantBusiness: true, company: 'Clinic Two', email: 'c2@clinic2.test' },
                  { candidateIndex: 2, isRelevantBusiness: true, company: 'Clinic Three', email: 'c3@clinic3.test' },
                ],
              }),
              model: 'deepseek-chat',
              usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
              finishReason: 'stop',
              durationMs: 100,
            };
          }
          throw new DeepSeekClientError('Rate limit reached', 'AI_RATE_LIMITED', 429, 'rate_limit', 30);
        },
      });

      assert.ok(pausedJob);
      assert.equal(pausedJob.status, 'Paused');
      assert.equal(pausedJob.prospects.length, 3);
      assert.equal(pausedJob.progress.processedCandidateCount, 3);
      assert.equal(pausedJob.lastError?.code, 'AI_RATE_LIMITED');
      const searchesBeforeResume = searchCalls;

      // Resume Run 2: must NOT re-call searchWebFn; processes candidateIndex 3 cleanly
      const resumedJob = await runResearchJobUntilStop(String(job._id), {
        skipCache: true,
        skipUsageLogging: true,
        sleepFn: async () => {},
        searchWebFn,
        fetchPageFn,
        completionFn: async () => ({
          content: JSON.stringify({
            prospects: [
              { candidateIndex: 3, isRelevantBusiness: true, company: 'Clinic Four', email: 'c4@clinic4.test' },
            ],
          }),
          model: 'deepseek-chat',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          finishReason: 'stop',
          durationMs: 100,
        }),
      });

      assert.ok(resumedJob);
      assert.equal(resumedJob.status, 'Completed');
      assert.equal(resumedJob.prospects.length, 4);
      assert.equal(searchCalls, searchesBeforeResume, 'Resume must not repeat search queries');
    } finally {
      jobHarness.restore();
      leadMocks.restore();
      if (origReadyState) Object.defineProperty(mongoose.connection, 'readyState', origReadyState);
    }
  });

  // 4. Caching avoids redundant search & crawl calls
  await runTest('4. Research cache reuses search and website crawl results across repeated runs', async () => {
    let searchCount = 0;
    let fetchCount = 0;
    const uniqueDomain = `https://cache-check-${Date.now()}.test/`;

    const firstCrawl = await crawlCandidateWebsite(uniqueDomain, {
      fetchPageFn: async (url) => {
        fetchCount += 1;
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: 'text/html',
          body: '<title>Cached Co</title><p>Email us at team@cache-check.test</p>',
        };
      },
    });
    assert.ok(firstCrawl);
    const fetchesAfterFirst = fetchCount;
    assert.ok(fetchesAfterFirst >= 1);

    const secondCrawl = await crawlCandidateWebsite(uniqueDomain, {
      fetchPageFn: async () => {
        fetchCount += 1;
        throw new Error('Should not have fetched again on cache hit');
      },
    });
    assert.ok(secondCrawl);
    assert.equal(fetchCount, fetchesAfterFirst);
    assert.equal(secondCrawl.domain, firstCrawl.domain);

    // Search cache test using DuckDuckGo fallback fetcher
    const uniqueQuery = `cache test query ${Date.now()}`;
    const firstSearch = await performRealWebSearch(uniqueQuery, {
      fetchPageFn: async () => {
        searchCount += 1;
        return {
          ok: true,
          status: 200,
          finalUrl: 'https://html.duckduckgo.com/html/',
          contentType: 'text/html',
          body: '<a class="result__a" href="https://cached-biz.test/">Cached Biz</a><a class="result__snippet">Snippet</a>',
        };
      },
    });
    assert.equal(firstSearch.length, 1);
    const secondSearch = await performRealWebSearch(uniqueQuery, {
      fetchPageFn: async () => {
        searchCount += 1;
        return { ok: true, status: 200, finalUrl: '', contentType: 'text/html', body: '' };
      },
    });
    assert.equal(secondSearch.length, 1);
    assert.equal(searchCount, 1);
  });

  // 5. Duplicate detection across email, website domain, company, and suppression
  await runTest('5. Duplicate detection flags existing Leads (email, domain, company) and Suppressions', async () => {
    const leadMocks = mockEmptyLeadsAndSuppressions(
      [
        {
          _id: new mongoose.Types.ObjectId(),
          email: 'owner@existing-email.test',
          fullName: 'Alice Existing',
          company: 'Existing Email Co',
          website: 'https://existing-email.test',
        },
        {
          _id: new mongoose.Types.ObjectId(),
          email: 'other@existing-domain.test',
          fullName: 'Bob Domain',
          company: 'Different Name',
          website: 'https://www.existing-domain.test/about',
        },
        {
          _id: new mongoose.Types.ObjectId(),
          email: 'contact@alpha-logistics.test',
          fullName: 'Charlie Alpha',
          company: 'Alpha Logistics LLC',
          website: '',
        },
      ],
      [{ email: 'optout@suppressed-co.test', reason: 'unsubscribe', detail: 'Unsubscribed via RFC 8058' }]
    );

    try {
      const prospects = [
        {
          company: 'Whatever Co',
          domain: 'new-domain.test',
          industry: 'SaaS',
          location: 'NYC',
          website: 'https://new-domain.test',
          businessSummary: '',
          fullName: 'Alice',
          firstName: 'Alice',
          lastName: '',
          role: 'CEO',
          email: 'owner@existing-email.test',
          emailConfidence: 'verified_published' as const,
          emailEvidence: { foundOnUrl: '', contactType: 'personal' as const, verificationNote: '' },
          sourceUrls: [],
          linkedinUrl: '',
          relevanceNotes: '',
          duplicateStatus: { isDuplicate: false, matchType: 'none' as const, reason: '' },
          reviewStatus: 'pending' as const,
        },
        {
          company: 'Domain Match Co',
          domain: 'existing-domain.test',
          industry: 'SaaS',
          location: 'NYC',
          website: 'https://existing-domain.test',
          businessSummary: '',
          fullName: 'Dana',
          firstName: 'Dana',
          lastName: '',
          role: 'VP',
          email: 'dana@existing-domain.test',
          emailConfidence: 'verified_published' as const,
          emailEvidence: { foundOnUrl: '', contactType: 'personal' as const, verificationNote: '' },
          sourceUrls: [],
          linkedinUrl: '',
          relevanceNotes: '',
          duplicateStatus: { isDuplicate: false, matchType: 'none' as const, reason: '' },
          reviewStatus: 'pending' as const,
        },
        {
          company: 'Alpha Logistics Inc.',
          domain: 'alpha-new.test',
          industry: 'Logistics',
          location: 'Chicago',
          website: 'https://alpha-new.test',
          businessSummary: '',
          fullName: 'New Contact',
          firstName: 'New',
          lastName: 'Contact',
          role: 'Ops',
          email: 'new@alpha-new.test',
          emailConfidence: 'verified_published' as const,
          emailEvidence: { foundOnUrl: '', contactType: 'personal' as const, verificationNote: '' },
          sourceUrls: [],
          linkedinUrl: '',
          relevanceNotes: '',
          duplicateStatus: { isDuplicate: false, matchType: 'none' as const, reason: '' },
          reviewStatus: 'pending' as const,
        },
        {
          company: 'Suppressed Co',
          domain: 'suppressed-co.test',
          industry: 'SaaS',
          location: 'NYC',
          website: 'https://suppressed-co.test',
          businessSummary: '',
          fullName: 'Evan',
          firstName: 'Evan',
          lastName: '',
          role: 'CEO',
          email: 'optout@suppressed-co.test',
          emailConfidence: 'verified_published' as const,
          emailEvidence: { foundOnUrl: '', contactType: 'personal' as const, verificationNote: '' },
          sourceUrls: [],
          linkedinUrl: '',
          relevanceNotes: '',
          duplicateStatus: { isDuplicate: false, matchType: 'none' as const, reason: '' },
          reviewStatus: 'pending' as const,
        },
        {
          company: 'Fresh Prospect Co',
          domain: 'fresh-prospect.test',
          industry: 'SaaS',
          location: 'Boston',
          website: 'https://fresh-prospect.test',
          businessSummary: '',
          fullName: 'Grace Hopper',
          firstName: 'Grace',
          lastName: 'Hopper',
          role: 'Founder',
          email: 'grace@fresh-prospect.test',
          emailConfidence: 'verified_published' as const,
          emailEvidence: { foundOnUrl: '', contactType: 'personal' as const, verificationNote: '' },
          sourceUrls: [],
          linkedinUrl: '',
          relevanceNotes: '',
          duplicateStatus: { isDuplicate: false, matchType: 'none' as const, reason: '' },
          reviewStatus: 'pending' as const,
        },
      ];

      await annotateProspectDuplicates(prospects);
      assert.equal(prospects[0].duplicateStatus.matchType, 'email');
      assert.equal(prospects[1].duplicateStatus.matchType, 'website_domain');
      assert.equal(prospects[2].duplicateStatus.matchType, 'company_and_location');
      assert.equal(prospects[3].duplicateStatus.matchType, 'suppressed');
      assert.equal(prospects[4].duplicateStatus.isDuplicate, false);
    } finally {
      leadMocks.restore();
    }
  });

  // 6. First-touch drafting reuses Sender Intelligence & survives partial 429
  await runTest('6. First-touch email generation reuses Sender Intelligence, saves partial drafts on 429, and never sends', async () => {
    resetAiRateLimitForTests();
    const origReadyState = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });
    const jobHarness = createInMemoryResearchJobHarness();
    const origSenderFindOne = SenderProfile.findOne;

    (SenderProfile as unknown as { findOne: () => unknown }).findOne = () => ({
      lean: () => ({
        exec: async () => ({
          fullName: 'Jordan Rivera',
          professionalTitle: 'Founder',
          organizationName: 'Northstar Ops',
          offerings: 'B2B CRM workflow automation',
          preferredTone: 'direct',
          preferredLength: 'short',
          defaultSignOff: 'Best,\nJordan',
          writingSamples: [
            {
              title: 'First touch sample',
              category: 'emails',
              content: 'Hi Maya — saw your team expanded in Austin. Quick question about onboarding.',
              description: 'Short cold intro',
            },
          ],
        }),
      }),
    });

    try {
      const p1Id = new mongoose.Types.ObjectId();
      const p2Id = new mongoose.Types.ObjectId();
      const job = await LeadResearchJob.create({
        query: {
          industry: 'Dental Clinics',
          location: 'Austin, TX',
          targetRoles: ['Owner'],
          desiredCount: 2,
          notes: '',
        },
        status: 'Completed',
        progress: { totalTarget: 2, discoveredCount: 2 },
        prospects: [
          {
            _id: p1Id,
            company: 'Cedar Dental',
            domain: 'cedardental.test',
            industry: 'Dental Clinics',
            location: 'Austin, TX',
            website: 'https://cedardental.test',
            businessSummary: 'Family dental clinic in South Austin.',
            fullName: 'Dr. Nina Patel',
            firstName: 'Nina',
            lastName: 'Patel',
            role: 'Owner',
            email: 'nina@cedardental.test',
            emailConfidence: 'verified_published',
            sourceUrls: ['https://cedardental.test/contact'],
          },
          {
            _id: p2Id,
            company: 'Oak Smile Studio',
            domain: 'oaksmile.test',
            industry: 'Dental Clinics',
            location: 'Austin, TX',
            website: 'https://oaksmile.test',
            businessSummary: 'Cosmetic dentistry in Austin.',
            fullName: 'Dr. Sam Cole',
            firstName: 'Sam',
            lastName: 'Cole',
            role: 'Founder',
            email: 'sam@oaksmile.test',
            emailConfidence: 'verified_published',
            sourceUrls: ['https://oaksmile.test/about'],
          },
        ],
      });

      let calls = 0;
      const result = await generateResearchDraftEmails(
        String(job._id),
        {
          prospectIds: [String(p1Id), String(p2Id)],
          tone: 'direct',
          length: 'short',
        },
        {
          skipUsageLogging: true,
          sleepFn: async () => {},
          completionFn: async (opts) => {
            calls += 1;
            // Verify Sender Intelligence context was injected into system/user prompt
            const joined = opts.messages.map((m) => m.content).join('\n');
            assert.ok(joined.includes('Jordan Rivera') || joined.includes('Northstar Ops'));

            if (calls === 1) {
              return {
                content: JSON.stringify({
                  subject: 'Quick note on Cedar Dental',
                  text: 'Hi Nina,\n\nSaw Cedar Dental in South Austin. Would love to share a quick workflow idea.\n\nBest,\nJordan',
                  html: '<p>Hi Nina,</p><p>Saw Cedar Dental in South Austin. Would love to share a quick workflow idea.</p><p>Best,<br/>Jordan</p>',
                  personalizationNotes: ['Referenced South Austin clinic'],
                  missingInformation: [],
                }),
                model: 'deepseek-chat',
                usage: { promptTokens: 80, completionTokens: 60, totalTokens: 140 },
                finishReason: 'stop',
                durationMs: 120,
              };
            }
            throw new DeepSeekClientError('429 rate limited', 'AI_RATE_LIMITED', 429, 'rate_limit', 25);
          },
        }
      );

      assert.equal(result.generatedCount, 1);
      assert.equal(result.pausedRateLimit, true);
      assert.equal(result.job.prospects[0].draftEmail?.subject, 'Quick note on Cedar Dental');
      assert.equal(result.job.prospects[0].draftEmail?.senderProfileUsed, true);
      assert.equal(result.job.prospects[1].draftEmail, undefined);
    } finally {
      SenderProfile.findOne = origSenderFindOne;
      jobHarness.restore();
      if (origReadyState) Object.defineProperty(mongoose.connection, 'readyState', origReadyState);
    }
  });

  // 7. Approve & Import into existing Lead system + Draft campaign
  await runTest('7. Approve & Import creates Leads (source: ai_research) and optional Draft Campaign without sending', async () => {
    const jobHarness = createInMemoryResearchJobHarness();
    const leadMocks = mockEmptyLeadsAndSuppressions([], [
      { email: 'blocked@suppressed.test', reason: 'unsubscribe', detail: 'Opted out' },
    ]);

    const origMailboxFindById = Mailbox.findById;
    const origCampaignCreate = Campaign.create;
    const origCampaignUpdateOne = Campaign.updateOne;
    const origRecipientInsertMany = CampaignRecipient.insertMany;
    const origRecipientAggregate = CampaignRecipient.aggregate;
    const origRecipientFind = CampaignRecipient.find;

    let createdCampaign: Record<string, unknown> | null = null;
    let insertedRecipients: Array<Record<string, unknown>> = [];

    const mailboxId = new mongoose.Types.ObjectId();
    (Mailbox as unknown as { findById: () => unknown }).findById = () => ({
      select: () => ({
        lean: async () => ({
          _id: mailboxId,
          name: 'Primary Outreach',
          senderEmail: 'sender@northstar.test',
          replyTo: '',
          enabled: true,
          archived: false,
          verificationStatus: 'verified',
        }),
      }),
    });

    (Campaign as unknown as { create: (doc: Record<string, unknown>) => Promise<Record<string, unknown>> }).create =
      async (doc: Record<string, unknown>) => {
        createdCampaign = {
          _id: new mongoose.Types.ObjectId(),
          sendConfig: { batchSize: 10, delayMs: 1000, concurrency: 1, dailySendCap: null, threadFollowUps: true },
          createdAt: new Date(),
          updatedAt: new Date(),
          ...doc,
        };
        return createdCampaign;
      };

    (Campaign as unknown as { updateOne: () => Promise<{ modifiedCount: number }> }).updateOne = async () => ({
      modifiedCount: 1,
    });

    (CampaignRecipient as unknown as { find: () => unknown }).find = () => ({
      select: () => ({
        lean: async () => [],
      }),
    });

    (CampaignRecipient as unknown as { insertMany: (docs: Array<Record<string, unknown>>) => Promise<unknown[]> }).insertMany =
      async (docs: Array<Record<string, unknown>>) => {
        insertedRecipients = docs;
        return docs;
      };

    (CampaignRecipient as unknown as { aggregate: () => Promise<Array<{ _id: { campaignId: unknown; status: string }; count: number }>> }).aggregate =
      async () => [
        {
          _id: {
            campaignId: (createdCampaign as { _id: unknown })?._id,
            status: 'pending',
          },
          count: insertedRecipients.length,
        },
      ];

    try {
      const pVerified = new mongoose.Types.ObjectId();
      const pUnverified = new mongoose.Types.ObjectId();
      const pSuppressed = new mongoose.Types.ObjectId();

      const job = await LeadResearchJob.create({
        query: {
          industry: 'SaaS',
          location: 'Boston, MA',
          targetRoles: ['CTO'],
          desiredCount: 3,
          notes: '',
        },
        status: 'Completed',
        progress: { totalTarget: 3, discoveredCount: 3 },
        prospects: [
          {
            _id: pVerified,
            company: 'Beacon Cloud',
            domain: 'beaconcloud.test',
            industry: 'SaaS',
            location: 'Boston, MA',
            website: 'https://beaconcloud.test',
            businessSummary: 'B2B analytics in Boston.',
            fullName: 'Maya Chen',
            firstName: 'Maya',
            lastName: 'Chen',
            role: 'CTO',
            email: 'maya@beaconcloud.test',
            emailConfidence: 'verified_published',
            emailEvidence: {
              foundOnUrl: 'https://beaconcloud.test/team',
              contactType: 'personal',
              verificationNote: 'Published personal email found verbatim on fetched website.',
            },
            sourceUrls: ['https://beaconcloud.test/team'],
            draftEmail: {
              subject: 'Beacon Cloud + Northstar',
              text: 'Hi Maya, saw Beacon Cloud in Boston.',
              html: '<p>Hi Maya, saw Beacon Cloud in Boston.</p>',
              personalizationNotes: [],
              missingInformation: [],
              edited: true,
            },
          },
          {
            _id: pUnverified,
            company: 'Harbor Data',
            domain: 'harbordata.test',
            industry: 'SaaS',
            location: 'Boston, MA',
            website: 'https://harbordata.test',
            fullName: 'Liam Park',
            firstName: 'Liam',
            lastName: 'Park',
            role: 'CTO',
            email: 'liam@harbordata.test',
            emailConfidence: 'inferred_unverified',
            sourceUrls: ['https://harbordata.test'],
          },
          {
            _id: pSuppressed,
            company: 'Blocked Co',
            domain: 'suppressed.test',
            industry: 'SaaS',
            location: 'Boston, MA',
            website: 'https://suppressed.test',
            fullName: 'Pat Doe',
            firstName: 'Pat',
            lastName: 'Doe',
            role: 'CTO',
            email: 'blocked@suppressed.test',
            emailConfidence: 'verified_published',
            sourceUrls: ['https://suppressed.test'],
          },
        ],
      });

      const imported = await importApprovedResearchProspects(String(job._id), {
        prospectIds: [String(pVerified), String(pUnverified), String(pSuppressed)],
        allowInferredEmails: false,
        createDraftCampaign: true,
        mailboxId: String(mailboxId),
        campaignName: 'Boston SaaS Draft',
      });

      assert.equal(imported.summary.importedCount, 1);
      assert.equal(imported.summary.skippedUnverifiedCount, 1);
      assert.equal(imported.summary.skippedSuppressedCount, 1);
      assert.equal(leadMocks.createdLeads.length, 1);
      assert.equal(leadMocks.createdLeads[0].source, 'ai_research');
      assert.equal(leadMocks.createdLeads[0].email, 'maya@beaconcloud.test');
      assert.ok(createdCampaign);
      assert.equal((createdCampaign as { status: string }).status, 'Draft');
      assert.equal(insertedRecipients.length, 1);
      assert.equal(insertedRecipients[0].status, 'pending');
    } finally {
      Mailbox.findById = origMailboxFindById;
      Campaign.create = origCampaignCreate;
      Campaign.updateOne = origCampaignUpdateOne;
      CampaignRecipient.insertMany = origRecipientInsertMany;
      CampaignRecipient.aggregate = origRecipientAggregate;
      CampaignRecipient.find = origRecipientFind;
      jobHarness.restore();
      leadMocks.restore();
    }
  });

  // 8. Express /api/research Auth Guard & PATCH editing
  await runTest('8. Express /api/research enforces auth and supports prospect & draft editing', async () => {
    const origReadyState = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });
    const jobHarness = createInMemoryResearchJobHarness();
    const leadMocks = mockEmptyLeadsAndSuppressions();

    const pId = new mongoose.Types.ObjectId();
    const seeded = await LeadResearchJob.create({
      query: {
        industry: 'Legal Tech',
        location: 'Chicago, IL',
        targetRoles: ['Managing Partner'],
        desiredCount: 2,
        notes: '',
      },
      status: 'Paused',
      progress: { totalTarget: 2, discoveredCount: 1 },
      prospects: [
        {
          _id: pId,
          company: 'Lakefront Legal',
          domain: 'lakefront.test',
          industry: 'Legal Tech',
          location: 'Chicago, IL',
          website: 'https://lakefront.test',
          fullName: 'Robin Shaw',
          firstName: 'Robin',
          lastName: 'Shaw',
          role: 'Partner',
          email: 'robin@lakefront.test',
          emailConfidence: 'verified_published',
          emailEvidence: {
            foundOnUrl: 'https://lakefront.test/contact',
            contactType: 'personal',
            verificationNote: 'Published personal email found verbatim on fetched website.',
          },
          sourceUrls: ['https://lakefront.test/contact'],
        },
      ],
    });

    const app = express();
    app.use(express.json());
    app.use('/api/research', researchRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/api/research`;
    const { token } = signAuthToken();

    try {
      // Unauthenticated request blocked
      const unauthRes = await fetch(`${baseUrl}/jobs`);
      assert.equal(unauthRes.status, 401);

      // Authenticated list
      const listRes = await fetch(`${baseUrl}/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(listRes.status, 200);
      const listJson = (await listRes.json()) as { jobs: Array<{ id: string }> };
      assert.equal(listJson.jobs.length, 1);

      // Edit draft subject/body via PATCH
      const patchRes = await fetch(`${baseUrl}/jobs/${seeded._id}/prospects/${pId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          draftSubject: 'Edited Subject',
          draftText: 'Edited Body Line',
        }),
      });
      assert.equal(patchRes.status, 200);
      const patchJson = (await patchRes.json()) as {
        job: {
          progress: { verifiedEmailCount: number };
          prospects: Array<{ draftEmail?: { subject: string; edited: boolean } }>;
        };
      };
      assert.equal(patchJson.job.prospects[0].draftEmail?.subject, 'Edited Subject');
      assert.equal(patchJson.job.prospects[0].draftEmail?.edited, true);
      assert.equal(patchJson.job.progress.verifiedEmailCount, 1);

      // Clearing email updates verifiedEmailCount accurately
      const clearRes = await fetch(`${baseUrl}/jobs/${seeded._id}/prospects/${pId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: '' }),
      });
      assert.equal(clearRes.status, 200);
      const clearJson = (await clearRes.json()) as {
        job: { progress: { verifiedEmailCount: number } };
      };
      assert.equal(clearJson.job.progress.verifiedEmailCount, 0);
    } finally {
      server.close();
      jobHarness.restore();
      leadMocks.restore();
      if (origReadyState) Object.defineProperty(mongoose.connection, 'readyState', origReadyState);
    }
  });

  if (process.exitCode && process.exitCode !== 0) {
    console.error(`\nAI Lead Research Tests failed (${passed} passed).`);
    process.exit(1);
  } else {
    console.log(`\nAll ${passed} AI Lead Research tests passed.`);
  }
}

void main();
