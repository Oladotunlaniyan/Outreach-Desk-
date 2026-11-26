import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Compass,
  Edit3,
  ExternalLink,
  Mail,
  Pause,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import type {
  AiEmailLength,
  AiStatusResponse,
  AiWritingTone,
  EmailConfidenceLevel,
  MailboxItem,
  MailboxesListResponse,
  ResearchGenerateEmailsResponse,
  ResearchImportResponse,
  ResearchJobItem,
  ResearchJobResponse,
  ResearchJobsListResponse,
  ResearchProspectItem,
  SenderProfileResponse,
} from '../types/outreach';

interface ResearchPageProps {
  refreshSignal?: number;
  onNavigateToLeads: () => void;
  onNavigateToCampaigns: () => void;
  onNavigateToSettings: () => void;
  onImported?: () => void;
}

function safeHttpUrl(rawUrl: string | undefined | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function confidenceBadgeMeta(confidence: EmailConfidenceLevel): {
  label: string;
  classes: string;
} {
  switch (confidence) {
    case 'verified_published':
      return {
        label: 'Verified published',
        classes:
          'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900',
      };
    case 'published_generic':
      return {
        label: 'Published generic',
        classes:
          'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-900',
      };
    case 'inferred_unverified':
      return {
        label: 'Unverified / snippet',
        classes:
          'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900',
      };
    case 'not_found':
    default:
      return {
        label: 'No email found',
        classes:
          'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
      };
  }
}

function jobStatusClasses(status: ResearchJobItem['status']): string {
  switch (status) {
    case 'Running':
    case 'Pending':
      return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-900';
    case 'Completed':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900';
    case 'Paused':
      return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900';
    case 'Failed':
      return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900';
    case 'Cancelled':
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700';
  }
}

function duplicateBadgeLabel(p: ResearchProspectItem): string | null {
  if (!p.duplicateStatus?.isDuplicate) return null;
  switch (p.duplicateStatus.matchType) {
    case 'suppressed':
      return 'Suppressed';
    case 'email':
      return 'Email in Leads';
    case 'website_domain':
      return 'Domain in Leads';
    case 'company_and_location':
      return 'Company in Leads';
    default:
      return 'Duplicate';
  }
}

export function ResearchPage({
  refreshSignal = 0,
  onNavigateToLeads,
  onNavigateToCampaigns,
  onNavigateToSettings,
  onImported,
}: ResearchPageProps) {
  // Search criteria form
  const [industry, setIndustry] = useState('');
  const [location, setLocation] = useState('');
  const [rolesInput, setRolesInput] = useState('Founder, Owner, CEO');
  const [desiredCount, setDesiredCount] = useState(10);
  const [notes, setNotes] = useState('');
  const [startingJob, setStartingJob] = useState(false);

  // Jobs & environment readiness
  const [jobs, setJobs] = useState<ResearchJobItem[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [senderReady, setSenderReady] = useState<boolean | null>(null);
  const [mailboxes, setMailboxes] = useState<MailboxItem[]>([]);

  // Feedback / errors
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [jobActionBusy, setJobActionBusy] = useState(false);

  // Selection for drafts & import
  const [selectedProspectIds, setSelectedProspectIds] = useState<Set<string>>(new Set());

  // Inline contact editor
  const [editingProspectId, setEditingProspectId] = useState<string | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [savingProspect, setSavingProspect] = useState(false);

  // Draft viewer/editor modal
  const [activeDraftProspectId, setActiveDraftProspectId] = useState<string | null>(null);
  const [draftSubjectInput, setDraftSubjectInput] = useState('');
  const [draftBodyInput, setDraftBodyInput] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);

  // First-touch generation controls
  const [draftTone, setDraftTone] = useState<AiWritingTone>('professional');
  const [draftLength, setDraftLength] = useState<AiEmailLength>('short');
  const [draftObjective, setDraftObjective] = useState('');
  const [generatingDrafts, setGeneratingDrafts] = useState(false);

  // Import controls
  const [allowInferredEmails, setAllowInferredEmails] = useState(false);
  const [createDraftCampaign, setCreateDraftCampaign] = useState(false);
  const [campaignName, setCampaignName] = useState('');
  const [selectedMailboxId, setSelectedMailboxId] = useState('');
  const [importingProspects, setImportingProspects] = useState(false);
  const [lastImportResult, setLastImportResult] = useState<ResearchImportResponse | null>(null);

  const activeJob = useMemo(
    () => jobs.find((j) => j.id === selectedJobId) || jobs[0] || null,
    [jobs, selectedJobId]
  );

  const activeDraftProspect = useMemo(
    () => activeJob?.prospects.find((p) => p.id === activeDraftProspectId) || null,
    [activeJob, activeDraftProspectId]
  );

  const loadJobs = useCallback(async () => {
    try {
      const res = await apiFetch<ResearchJobsListResponse>('/api/research/jobs');
      setJobs(res.jobs);
      setSelectedJobId((prev) => {
        if (prev && res.jobs.some((j) => j.id === prev)) return prev;
        return res.jobs[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load AI research jobs.');
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  const loadEnvironmentStatus = useCallback(async () => {
    try {
      const [aiRes, senderRes, mailboxRes] = await Promise.allSettled([
        apiFetch<AiStatusResponse>('/api/ai/status'),
        apiFetch<SenderProfileResponse>('/api/ai/sender-profile'),
        apiFetch<MailboxesListResponse>('/api/mailboxes'),
      ]);
      if (aiRes.status === 'fulfilled') {
        setAiStatus(aiRes.value);
      }
      if (senderRes.status === 'fulfilled') {
        setSenderReady(Boolean(senderRes.value.profile.completion.hasMeaningfulProfile));
      }
      if (mailboxRes.status === 'fulfilled') {
        const active = mailboxRes.value.mailboxes.filter((m) => !m.archived && m.enabled);
        setMailboxes(active);
        setSelectedMailboxId((prev) => prev || active[0]?.id || '');
      }
    } catch {
      // Non-blocking environment check
    }
  }, []);

  useEffect(() => {
    void loadJobs();
    void loadEnvironmentStatus();
  }, [loadJobs, loadEnvironmentStatus, refreshSignal]);

  // Poll active job while Pending/Running
  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status !== 'Running' && activeJob.status !== 'Pending') return;

    const timer = window.setInterval(async () => {
      try {
        const res = await apiFetch<ResearchJobResponse>(`/api/research/jobs/${activeJob.id}`);
        setJobs((prev) => prev.map((j) => (j.id === res.job.id ? res.job : j)));
      } catch {
        // Ignore transient polling hiccup
      }
    }, 2500);

    return () => window.clearInterval(timer);
  }, [activeJob]);

  // Clear selection when switching jobs
  useEffect(() => {
    setSelectedProspectIds(new Set());
    setEditingProspectId(null);
    setActiveDraftProspectId(null);
    setLastImportResult(null);
  }, [selectedJobId]);

  function replaceJobInState(updated: ResearchJobItem) {
    setJobs((prev) => {
      const exists = prev.some((j) => j.id === updated.id);
      if (!exists) return [updated, ...prev];
      return prev.map((j) => (j.id === updated.id ? updated : j));
    });
  }

  async function handleStartResearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    setLastImportResult(null);

    if (!industry.trim() || !location.trim()) {
      setError('Enter both an industry and a location.');
      return;
    }

    setStartingJob(true);
    try {
      const res = await apiFetch<ResearchJobResponse>('/api/research/jobs', {
        method: 'POST',
        body: JSON.stringify({
          industry: industry.trim(),
          location: location.trim(),
          targetRoles: rolesInput.trim(),
          desiredCount,
          notes: notes.trim(),
        }),
      });
      replaceJobInState(res.job);
      setSelectedJobId(res.job.id);
      setFeedback('AI lead research started. Results appear batch-by-batch below.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start AI lead research.');
    } finally {
      setStartingJob(false);
    }
  }

  async function handleJobControl(action: 'pause' | 'resume' | 'cancel') {
    if (!activeJob) return;
    setError(null);
    setFeedback(null);
    setJobActionBusy(true);
    try {
      const res = await apiFetch<ResearchJobResponse>(
        `/api/research/jobs/${activeJob.id}/${action}`,
        { method: 'POST' }
      );
      replaceJobInState(res.job);
      if (action === 'resume') {
        setFeedback('Research resumed from saved checkpoint.');
      } else if (action === 'pause') {
        setFeedback('Research paused. Progress is saved.');
      } else {
        setFeedback('Research job cancelled.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} research job.`);
    } finally {
      setJobActionBusy(false);
    }
  }

  async function handleDeleteJob(jobId: string) {
    setError(null);
    setFeedback(null);
    setJobActionBusy(true);
    try {
      await apiFetch(`/api/research/jobs/${jobId}`, { method: 'DELETE' });
      const remaining = jobs.filter((j) => j.id !== jobId);
      setJobs(remaining);
      setSelectedJobId(remaining[0]?.id ?? null);
      setFeedback('Research job deleted.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete research job.');
    } finally {
      setJobActionBusy(false);
    }
  }

  function toggleProspectSelection(id: string) {
    setSelectedProspectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectReadyProspects() {
    if (!activeJob) return;
    const readyIds = activeJob.prospects
      .filter(
        (p) =>
          p.reviewStatus !== 'imported' &&
          !p.duplicateStatus.isDuplicate &&
          Boolean(p.email) &&
          (p.emailConfidence === 'verified_published' ||
            p.emailConfidence === 'published_generic' ||
            allowInferredEmails)
      )
      .map((p) => p.id);
    setSelectedProspectIds(new Set(readyIds));
  }

  function selectAllProspects() {
    if (!activeJob) return;
    setSelectedProspectIds(
      new Set(activeJob.prospects.filter((p) => p.reviewStatus !== 'imported').map((p) => p.id))
    );
  }

  function clearSelection() {
    setSelectedProspectIds(new Set());
  }

  function startEditingProspect(p: ResearchProspectItem) {
    setEditingProspectId(p.id);
    setEditFullName(p.fullName);
    setEditRole(p.role);
    setEditEmail(p.email);
  }

  async function saveProspectEdit(prospectId: string) {
    if (!activeJob) return;
    setError(null);
    setSavingProspect(true);
    try {
      const res = await apiFetch<ResearchJobResponse>(
        `/api/research/jobs/${activeJob.id}/prospects/${prospectId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            fullName: editFullName.trim(),
            role: editRole.trim(),
            email: editEmail.trim().toLowerCase(),
          }),
        }
      );
      replaceJobInState(res.job);
      setEditingProspectId(null);
      setFeedback('Prospect contact updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update prospect contact.');
    } finally {
      setSavingProspect(false);
    }
  }

  async function handleGenerateFirstTouchEmails(regenerate = false) {
    if (!activeJob || selectedProspectIds.size === 0) return;
    setError(null);
    setFeedback(null);
    setGeneratingDrafts(true);
    try {
      const res = await apiFetch<ResearchGenerateEmailsResponse>(
        `/api/research/jobs/${activeJob.id}/generate-emails`,
        {
          method: 'POST',
          body: JSON.stringify({
            prospectIds: Array.from(selectedProspectIds),
            tone: draftTone,
            length: draftLength,
            objective: draftObjective.trim(),
            useSenderProfile: true,
            includeWritingSamples: true,
            regenerate,
          }),
        }
      );
      replaceJobInState(res.job);
      if (res.warning) {
        setFeedback(res.warning);
      } else {
        setFeedback(
          `Generated ${res.generatedCount} first-touch draft(s)` +
            (res.skippedCount > 0 ? ` (${res.skippedCount} existing draft(s) kept).` : '.') +
            ' Review and edit before importing or sending.'
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to generate first-touch emails.');
    } finally {
      setGeneratingDrafts(false);
    }
  }

  function openDraftEditor(p: ResearchProspectItem) {
    setActiveDraftProspectId(p.id);
    setDraftSubjectInput(p.draftEmail?.subject || '');
    setDraftBodyInput(p.draftEmail?.text || '');
  }

  async function saveDraftEdit(e: FormEvent) {
    e.preventDefault();
    if (!activeJob || !activeDraftProspect) return;
    setError(null);
    setSavingDraft(true);
    try {
      const res = await apiFetch<ResearchJobResponse>(
        `/api/research/jobs/${activeJob.id}/prospects/${activeDraftProspect.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            draftSubject: draftSubjectInput.trim(),
            draftText: draftBodyInput,
          }),
        }
      );
      replaceJobInState(res.job);
      setActiveDraftProspectId(null);
      setFeedback('Email draft saved. Nothing is sent automatically.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save email draft.');
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleApproveAndImport() {
    if (!activeJob || selectedProspectIds.size === 0) return;
    setError(null);
    setFeedback(null);
    setLastImportResult(null);

    if (createDraftCampaign && !selectedMailboxId) {
      setError('Select a mailbox to create a Draft campaign, or uncheck Draft campaign creation.');
      return;
    }

    setImportingProspects(true);
    try {
      const res = await apiFetch<ResearchImportResponse>(
        `/api/research/jobs/${activeJob.id}/import`,
        {
          method: 'POST',
          body: JSON.stringify({
            prospectIds: Array.from(selectedProspectIds),
            allowInferredEmails,
            createDraftCampaign,
            campaignName: campaignName.trim(),
            mailboxId: createDraftCampaign ? selectedMailboxId : '',
          }),
        }
      );
      replaceJobInState(res.job);
      setLastImportResult(res);
      setSelectedProspectIds(new Set());
      onImported?.();
      setFeedback(
        `Imported ${res.summary.importedCount} prospect(s) into Leads` +
          (res.campaign ? ` and created Draft campaign "${res.campaign.name}".` : '.')
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to import approved prospects.');
    } finally {
      setImportingProspects(false);
    }
  }

  const progressPercent = useMemo(() => {
    if (!activeJob) return 0;
    const total = Math.max(1, activeJob.progress.totalCandidatesQueued || activeJob.progress.totalTarget);
    const done = activeJob.progress.processedCandidateCount;
    if (activeJob.status === 'Completed') return 100;
    return Math.min(98, Math.round((done / total) * 100));
  }, [activeJob]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
            AI Lead Research
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Discover real businesses via live web search, verify published contact emails, draft
            first-touch emails with Sender Intelligence, and approve before importing.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadJobs()}
          disabled={loadingJobs}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[36px] self-start sm:self-auto"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loadingJobs ? 'animate-spin' : ''}`} />
          <span>Refresh jobs</span>
        </button>
      </div>

      {/* Environment Readiness Notices */}
      {aiStatus && !aiStatus.configured && (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-white dark:bg-slate-900 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              DeepSeek API key is not configured. Add <code>DEEPSEEK_API_KEY</code> in Settings /
              environment before running AI Lead Research or drafting emails.
            </span>
          </div>
          <button
            type="button"
            onClick={onNavigateToSettings}
            className="rounded-lg border border-amber-300 dark:border-amber-800 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-950/40 shrink-0"
          >
            Open Settings
          </button>
        </div>
      )}

      {senderReady === false && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-slate-600 dark:text-slate-300">
          <span>
            Sender Intelligence profile is incomplete — fill in your sender voice & offerings in
            Settings for stronger personalized first-touch drafts.
          </span>
          <button
            type="button"
            onClick={onNavigateToSettings}
            className="text-blue-600 dark:text-blue-400 font-medium hover:underline shrink-0 text-left"
          >
            Configure Sender Intelligence
          </button>
        </div>
      )}

      {/* Feedback / Errors */}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 px-4 py-3 flex items-start justify-between gap-3 text-sm text-red-700 dark:text-red-300"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-white dark:bg-slate-900 px-4 py-3 flex items-start justify-between gap-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{feedback}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="Dismiss feedback"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {lastImportResult && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-900/60 bg-white dark:bg-slate-900 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-xs text-slate-700 dark:text-slate-300 space-y-1">
            <div className="font-semibold text-slate-900 dark:text-slate-100">
              Import Summary
            </div>
            <div className="font-mono tabular-nums flex flex-wrap gap-x-4 gap-y-1">
              <span>Imported: {lastImportResult.summary.importedCount}</span>
              <span>Skipped duplicates: {lastImportResult.summary.skippedExistingCount}</span>
              <span>Skipped suppressed: {lastImportResult.summary.skippedSuppressedCount}</span>
              <span>Skipped no email: {lastImportResult.summary.skippedNoEmailCount}</span>
              <span>Skipped unverified: {lastImportResult.summary.skippedUnverifiedCount}</span>
            </div>
            {lastImportResult.campaignWarning && (
              <p className="text-amber-700 dark:text-amber-300">{lastImportResult.campaignWarning}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onNavigateToLeads}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-medium"
            >
              View in Leads
            </button>
            {lastImportResult.campaign && (
              <button
                type="button"
                onClick={onNavigateToCampaigns}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Open Draft Campaign
              </button>
            )}
          </div>
        </div>
      )}

      {/* Top Grid: Criteria Form + Saved Research Jobs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Start Research Form */}
        <section className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Compass className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              New Research Query
            </h3>
          </div>

          <form onSubmit={handleStartResearch} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label
                  htmlFor="research-industry"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Industry / Niche *
                </label>
                <input
                  id="research-industry"
                  type="text"
                  required
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="e.g. Boutique dental clinics, B2B SaaS"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div>
                <label
                  htmlFor="research-location"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Location *
                </label>
                <input
                  id="research-location"
                  type="text"
                  required
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Austin, TX or London, UK"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5">
              <div className="sm:col-span-8">
                <label
                  htmlFor="research-roles"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Target Decision-Maker Roles *
                </label>
                <input
                  id="research-roles"
                  type="text"
                  required
                  value={rolesInput}
                  onChange={(e) => setRolesInput(e.target.value)}
                  placeholder="Founder, Managing Partner, Head of Growth"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div className="sm:col-span-4">
                <label
                  htmlFor="research-count"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Desired Leads (1–30)
                </label>
                <input
                  id="research-count"
                  type="number"
                  min={1}
                  max={30}
                  value={desiredCount}
                  onChange={(e) =>
                    setDesiredCount(Math.max(1, Math.min(30, Number(e.target.value) || 10)))
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="research-notes"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Optional Focus Notes
              </label>
              <input
                id="research-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Independent firms with 5-30 staff, avoid franchises"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Runs in resilient batches of 3, caches pages, and never guesses email addresses.
              </p>
              <button
                type="submit"
                disabled={startingJob}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium transition-colors min-h-[40px]"
              >
                <Search className="h-4 w-4" />
                <span>{startingJob ? 'Starting...' : 'Start AI Research'}</span>
              </button>
            </div>
          </form>
        </section>

        {/* Recent Research Jobs */}
        <section className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Research Jobs
            </h3>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {jobs.length} saved
            </span>
          </div>

          {loadingJobs ? (
            <div className="flex-1 flex items-center justify-center py-10 text-xs text-slate-500">
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
              Loading research jobs...
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-10 text-center text-xs text-slate-500 dark:text-slate-400">
              No research jobs yet. Enter an industry, location, and target roles to discover
              prospects.
            </div>
          ) : (
            <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
              {jobs.map((job) => {
                const isSelected = activeJob?.id === job.id;
                return (
                  <div
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/20'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {job.query.industry} · {job.query.location}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                          Roles: {job.query.targetRoles.join(', ')}
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium shrink-0 ${jobStatusClasses(
                          job.status
                        )}`}
                      >
                        {job.status}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      <span>
                        {job.progress.discoveredCount}/{job.progress.totalTarget} leads ·{' '}
                        {job.progress.verifiedEmailCount} verified
                      </span>
                      <span>{formatShortDate(job.createdAt)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Active Job Progress & Prospects Table */}
      {activeJob && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          {/* Job Progress Header */}
          <div className="p-5 border-b border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                    {activeJob.query.industry} in {activeJob.query.location}
                  </h3>
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${jobStatusClasses(
                      activeJob.status
                    )}`}
                  >
                    {activeJob.status}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {activeJob.progress.lastStepMessage}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {(activeJob.status === 'Running' || activeJob.status === 'Pending') && (
                  <button
                    type="button"
                    disabled={jobActionBusy}
                    onClick={() => void handleJobControl('pause')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Pause className="h-3.5 w-3.5" />
                    <span>Pause</span>
                  </button>
                )}

                {(activeJob.status === 'Paused' || activeJob.status === 'Failed') && (
                  <button
                    type="button"
                    disabled={jobActionBusy}
                    onClick={() => void handleJobControl('resume')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-medium"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>Resume Research</span>
                  </button>
                )}

                {activeJob.status !== 'Completed' && activeJob.status !== 'Cancelled' && (
                  <button
                    type="button"
                    disabled={jobActionBusy}
                    onClick={() => void handleJobControl('cancel')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span>Cancel</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={jobActionBusy}
                  onClick={() => void handleDeleteJob(activeJob.id)}
                  aria-label="Delete research job"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Progress Bar & Counters */}
            <div className="space-y-2">
              <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
                <span>
                  Batch {activeJob.progress.currentBatch} ({activeJob.progress.processedCandidateCount}/
                  {activeJob.progress.totalCandidatesQueued} candidates)
                </span>
                <span>
                  Discovered: {activeJob.progress.discoveredCount}/{activeJob.progress.totalTarget}
                </span>
                <span>Verified emails: {activeJob.progress.verifiedEmailCount}</span>
                <span>Imported: {activeJob.progress.importedCount}</span>
                <span>Sites crawled: {activeJob.progress.crawledSitesCount}</span>
              </div>
            </div>

            {activeJob.lastError && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/20 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-start justify-between gap-3">
                <div>
                  <span className="font-semibold">{activeJob.lastError.code}: </span>
                  <span>{activeJob.lastError.message}</span>
                </div>
                {activeJob.resumeAfter && (
                  <span className="font-mono shrink-0">
                    Retry after {formatShortDate(activeJob.resumeAfter)}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Selection, Draft Generation & Import Toolbar */}
          {activeJob.prospects.length > 0 && (
            <div className="px-5 py-4 bg-slate-50/70 dark:bg-slate-950/40 border-b border-slate-200 dark:border-slate-800 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono tabular-nums font-medium text-slate-700 dark:text-slate-200">
                    {selectedProspectIds.size} selected
                  </span>
                  <button
                    type="button"
                    onClick={selectReadyProspects}
                    className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Select ready (new + email)
                  </button>
                  <button
                    type="button"
                    onClick={selectAllProspects}
                    className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Select all unimported
                  </button>
                  {selectedProspectIds.size > 0 && (
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 px-1.5"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* First-Touch Email Generation Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Draft tone"
                    value={draftTone}
                    onChange={(e) => setDraftTone(e.target.value as AiWritingTone)}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200"
                  >
                    <option value="professional">Professional</option>
                    <option value="conversational">Conversational</option>
                    <option value="direct">Direct</option>
                    <option value="friendly">Friendly</option>
                    <option value="persuasive">Persuasive</option>
                    <option value="formal">Formal</option>
                  </select>

                  <select
                    aria-label="Draft length"
                    value={draftLength}
                    onChange={(e) => setDraftLength(e.target.value as AiEmailLength)}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200"
                  >
                    <option value="short">Short</option>
                    <option value="medium">Medium</option>
                    <option value="detailed">Detailed</option>
                  </select>

                  <input
                    type="text"
                    value={draftObjective}
                    onChange={(e) => setDraftObjective(e.target.value)}
                    placeholder="Optional pitch goal..."
                    aria-label="Optional outreach objective"
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 w-44"
                  />

                  <button
                    type="button"
                    disabled={selectedProspectIds.size === 0 || generatingDrafts}
                    onClick={() => void handleGenerateFirstTouchEmails(false)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 dark:border-blue-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>
                      {generatingDrafts ? 'Generating...' : 'Generate First-Touch Drafts'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Approve & Import Bar */}
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pt-2 border-t border-slate-200/80 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowInferredEmails}
                      onChange={(e) => setAllowInferredEmails(e.target.checked)}
                      className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
                    />
                    <span>Include unverified / manually edited emails</span>
                  </label>

                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createDraftCampaign}
                      onChange={(e) => setCreateDraftCampaign(e.target.checked)}
                      className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
                    />
                    <span>Also create Draft campaign (never auto-sent)</span>
                  </label>

                  {createDraftCampaign && (
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label="Draft campaign mailbox"
                        value={selectedMailboxId}
                        onChange={(e) => setSelectedMailboxId(e.target.value)}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200"
                      >
                        {mailboxes.length === 0 ? (
                          <option value="">No active mailboxes</option>
                        ) : (
                          mailboxes.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} ({m.senderEmail})
                            </option>
                          ))
                        )}
                      </select>

                      <input
                        type="text"
                        value={campaignName}
                        onChange={(e) => setCampaignName(e.target.value)}
                        placeholder="Campaign name (optional)"
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 w-48"
                      />
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  disabled={selectedProspectIds.size === 0 || importingProspects}
                  onClick={() => void handleApproveAndImport()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-xs font-medium transition-colors min-h-[36px] shrink-0"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>
                    {importingProspects ? 'Importing...' : 'Approve & Import Selected'}
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* Discovered Prospects List */}
          {activeJob.prospects.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
              {activeJob.status === 'Running' || activeJob.status === 'Pending'
                ? 'Searching the web and verifying published contacts...'
                : 'No prospects recorded for this job yet.'}
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {activeJob.prospects.map((prospect) => {
                const isSelected = selectedProspectIds.has(prospect.id);
                const isEditing = editingProspectId === prospect.id;
                const badge = confidenceBadgeMeta(prospect.emailConfidence);
                const dupLabel = duplicateBadgeLabel(prospect);
                const websiteHref = safeHttpUrl(prospect.website);
                const foundOnHref = safeHttpUrl(prospect.emailEvidence?.foundOnUrl);
                const linkedinHref = safeHttpUrl(prospect.linkedinUrl);

                return (
                  <div
                    key={prospect.id}
                    className={`p-5 transition-colors ${
                      isSelected ? 'bg-blue-50/30 dark:bg-blue-950/10' : ''
                    }`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                      {/* Checkbox + Main Details */}
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={prospect.reviewStatus === 'imported'}
                          onChange={() => toggleProspectSelection(prospect.id)}
                          aria-label={`Select ${prospect.company}`}
                          className="mt-1 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600 disabled:opacity-40"
                        />

                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                              {prospect.company}
                            </span>

                            {websiteHref && (
                              <a
                                href={websiteHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                <span>{prospect.domain || 'Website'}</span>
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}

                            {prospect.location && (
                              <span className="text-xs text-slate-500 dark:text-slate-400">
                                · {prospect.location}
                              </span>
                            )}

                            {dupLabel && (
                              <span className="inline-flex items-center rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                                {dupLabel}
                              </span>
                            )}

                            {prospect.reviewStatus === 'imported' && (
                              <span className="inline-flex items-center rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                                Imported
                              </span>
                            )}
                          </div>

                          {prospect.businessSummary && (
                            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                              {prospect.businessSummary}
                            </p>
                          )}

                          {/* Contact & Email Verification */}
                          {isEditing ? (
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 max-w-2xl">
                              <input
                                type="text"
                                value={editFullName}
                                onChange={(e) => setEditFullName(e.target.value)}
                                placeholder="Decision maker name"
                                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                              />
                              <input
                                type="text"
                                value={editRole}
                                onChange={(e) => setEditRole(e.target.value)}
                                placeholder="Role / title"
                                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                              />
                              <input
                                type="email"
                                value={editEmail}
                                onChange={(e) => setEditEmail(e.target.value)}
                                placeholder="Email address"
                                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                              />
                              <div className="sm:col-span-3 flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={savingProspect}
                                  onClick={() => void saveProspectEdit(prospect.id)}
                                  className="rounded-md bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 text-xs font-medium"
                                >
                                  {savingProspect ? 'Saving...' : 'Save contact'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingProspectId(null)}
                                  className="rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1 text-xs text-slate-600 dark:text-slate-300"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                              <span className="text-slate-800 dark:text-slate-200 font-medium">
                                {prospect.fullName || 'Decision maker not named'}
                                {prospect.role ? ` · ${prospect.role}` : ''}
                              </span>

                              {linkedinHref && (
                                <a
                                  href={linkedinHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>LinkedIn</span>
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}

                              <span className="font-mono text-slate-900 dark:text-slate-100">
                                {prospect.email || '—'}
                              </span>

                              <span
                                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${badge.classes}`}
                              >
                                {badge.label}
                              </span>
                            </div>
                          )}

                          {/* Evidence & Source URLs */}
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
                            <div>
                              <span>{prospect.emailEvidence?.verificationNote}</span>
                              {foundOnHref && (
                                <>
                                  {' · '}
                                  <a
                                    href={foundOnHref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 dark:text-blue-400 hover:underline"
                                  >
                                    Evidence page
                                  </a>
                                </>
                              )}
                            </div>

                            {prospect.sourceUrls.length > 0 && (
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="font-medium text-slate-600 dark:text-slate-300">
                                  Sources:
                                </span>
                                {prospect.sourceUrls.slice(0, 4).map((rawUrl) => {
                                  const safe = safeHttpUrl(rawUrl);
                                  if (!safe) return null;
                                  return (
                                    <a
                                      key={safe}
                                      href={safe}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[260px]"
                                    >
                                      {safe.replace(/^https?:\/\//, '')}
                                    </a>
                                  );
                                })}
                              </div>
                            )}

                            {prospect.duplicateStatus.isDuplicate && prospect.duplicateStatus.reason && (
                              <div className="text-amber-700 dark:text-amber-300">
                                Duplicate check: {prospect.duplicateStatus.reason}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Right Actions: Edit contact + View/Edit Draft */}
                      <div className="flex flex-wrap lg:flex-col items-end gap-2 shrink-0">
                        {prospect.reviewStatus !== 'imported' && !isEditing && (
                          <button
                            type="button"
                            onClick={() => startEditingProspect(prospect)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>Edit contact</span>
                          </button>
                        )}

                        {prospect.draftEmail ? (
                          <button
                            type="button"
                            onClick={() => openDraftEditor(prospect)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/30 px-2.5 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100/70 dark:hover:bg-blue-950/50"
                          >
                            <Mail className="h-3.5 w-3.5" />
                            <span>
                              {prospect.draftEmail.edited ? 'Edit saved draft' : 'Review / Edit draft'}
                            </span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* Compact Draft Preview Snippet */}
                    {prospect.draftEmail && (
                      <div className="mt-3 ml-7 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 px-3.5 py-2.5 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                            Draft Subject: {prospect.draftEmail.subject}
                          </span>
                          <span className="text-[11px] text-slate-500 shrink-0">
                            {prospect.draftEmail.senderProfileUsed
                              ? 'Sender Intelligence used'
                              : 'Standard draft'}{' '}
                            · Never auto-sent
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400 line-clamp-2 whitespace-pre-line">
                          {prospect.draftEmail.text}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Editable First-Touch Draft Modal */}
      {activeDraftProspect && activeDraftProspect.draftEmail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="research-draft-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-[1px] p-4"
        >
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3
                  id="research-draft-modal-title"
                  className="font-display text-base font-semibold text-slate-900 dark:text-slate-100"
                >
                  Edit First-Touch Draft — {activeDraftProspect.company}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {activeDraftProspect.fullName || activeDraftProspect.company}
                  {activeDraftProspect.email ? ` (${activeDraftProspect.email})` : ''} · Saved as
                  editable draft only
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveDraftProspectId(null)}
                aria-label="Close draft editor"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={saveDraftEdit} className="p-5 space-y-4">
              <div>
                <label
                  htmlFor="draft-subject-edit"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Subject
                </label>
                <input
                  id="draft-subject-edit"
                  type="text"
                  required
                  value={draftSubjectInput}
                  onChange={(e) => setDraftSubjectInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label
                  htmlFor="draft-body-edit"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Email Body
                </label>
                <textarea
                  id="draft-body-edit"
                  rows={9}
                  required
                  value={draftBodyInput}
                  onChange={(e) => setDraftBodyInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 leading-relaxed"
                />
              </div>

              {(activeDraftProspect.draftEmail.personalizationNotes.length > 0 ||
                activeDraftProspect.draftEmail.missingInformation.length > 0) && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 text-xs space-y-1.5">
                  {activeDraftProspect.draftEmail.personalizationNotes.length > 0 && (
                    <div>
                      <span className="font-semibold text-slate-700 dark:text-slate-200">
                        Personalization used:{' '}
                      </span>
                      <span className="text-slate-600 dark:text-slate-400">
                        {activeDraftProspect.draftEmail.personalizationNotes.join(' · ')}
                      </span>
                    </div>
                  )}
                  {activeDraftProspect.draftEmail.missingInformation.length > 0 && (
                    <div>
                      <span className="font-semibold text-amber-700 dark:text-amber-300">
                        Missing details:{' '}
                      </span>
                      <span className="text-slate-600 dark:text-slate-400">
                        {activeDraftProspect.draftEmail.missingInformation.join(' · ')}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setActiveDraftProspectId(null)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingDraft}
                  className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-xs font-medium"
                >
                  {savingDraft ? 'Saving...' : 'Save Draft'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
