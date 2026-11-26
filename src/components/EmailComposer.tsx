import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Code2,
  Eye,
  FileText,
  Info,
  Mail,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import type {
  AiCtaSuggestion,
  AiCtaSuggestionsResponse,
  AiDraftResponse,
  AiEmailMode,
  AiGeneratedEmailDraft,
  AiGenerateEmailPayload,
  AiRewriteAction,
  AiRewritePayload,
  AiStatusResponse,
  AiSubjectLineSuggestion,
  AiSubjectLinesResponse,
  AiWritingTone,
  LeadDetailResponse,
  LeadItem,
  LeadsListResponse,
  MailboxItem,
  MailboxQuotaResponse,
  MailboxQuotaSnapshot,
  MailboxesListResponse,
  SendEmailResponse,
  SenderProfileItem,
  SenderProfileResponse,
} from '../types/outreach';
import { AiEmailAssistantPanel } from './AiEmailAssistantPanel';

export interface EmailComposerDraft {
  mailboxId?: string;
  leadId?: string;
  openAiAssistant?: boolean;
  threadWithPrevious?: boolean;
  inReplyTo?: string;
  to?: string;
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
}

interface EmailComposerProps {
  isOpen: boolean;
  initialDraft?: EmailComposerDraft | null;
  onClose: () => void;
  onSent: (response: SendEmailResponse) => void;
  onNavigateToSettings?: () => void;
}

const SINGLE_EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function stripHtmlForPreview(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatUtcReset(iso: string | undefined): string {
  if (!iso) return '00:00 UTC';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '00:00 UTC';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';
}

export function EmailComposer({
  isOpen,
  initialDraft,
  onClose,
  onSent,
  onNavigateToSettings,
}: EmailComposerProps) {
  const [mailboxes, setMailboxes] = useState<MailboxItem[]>([]);
  const [loadingMailboxes, setLoadingMailboxes] = useState(false);
  const [mailboxLoadError, setMailboxLoadError] = useState<string | null>(null);

  const [mailboxId, setMailboxId] = useState('');
  const [quota, setQuota] = useState<MailboxQuotaSnapshot | null>(null);
  const [loadingQuota, setLoadingQuota] = useState(false);

  const [to, setTo] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [html, setHtml] = useState('');
  const [threadWithPrevious, setThreadWithPrevious] = useState(false);
  const [inReplyTo, setInReplyTo] = useState('');
  const [editorTab, setEditorTab] = useState<'text' | 'html'>('text');
  const [mode, setMode] = useState<'compose' | 'preview'>('compose');

  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => createIdempotencyKey());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAmbiguousError, setIsAmbiguousError] = useState(false);

  // Phase 3C: DeepSeek AI drafting & improvement state
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [loadingAiStatus, setLoadingAiStatus] = useState(false);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiActionLabel, setAiActionLabel] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [pendingAiDraft, setPendingAiDraft] = useState<AiGeneratedEmailDraft | null>(null);
  const [subjectSuggestions, setSubjectSuggestions] = useState<AiSubjectLineSuggestion[] | null>(
    null
  );
  const [ctaSuggestions, setCtaSuggestions] = useState<AiCtaSuggestion[] | null>(null);
  const [draftProvenance, setDraftProvenance] = useState<
    'manual' | 'ai_generated' | 'ai_edited'
  >('manual');
  const [lastGenerationKind, setLastGenerationKind] = useState<
    'generate' | AiRewriteAction | null
  >(null);
  const [senderProfile, setSenderProfile] = useState<SenderProfileItem | null>(null);
  const [useSenderProfile, setUseSenderProfile] = useState(true);
  const [includeWritingSamples, setIncludeWritingSamples] = useState(true);
  const lastGeneratePayloadRef = useRef<AiGenerateEmailPayload | null>(null);
  const lastRewritePayloadRef = useRef<AiRewritePayload | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  const eligibleMailboxes = useMemo(
    () =>
      mailboxes.filter(
        (m) => m.enabled && !m.archived && m.verificationStatus === 'verified'
      ),
    [mailboxes]
  );

  const ineligibleCount = mailboxes.length - eligibleMailboxes.length;
  const selectedMailbox = useMemo(
    () => eligibleMailboxes.find((m) => m.id === mailboxId) || null,
    [eligibleMailboxes, mailboxId]
  );

  const fetchMailboxes = useCallback(async () => {
    setLoadingMailboxes(true);
    setMailboxLoadError(null);
    try {
      const res = await apiFetch<MailboxesListResponse>('/api/mailboxes');
      setMailboxes(res.mailboxes);

      const verified = res.mailboxes.filter(
        (m) => m.enabled && !m.archived && m.verificationStatus === 'verified'
      );
      if (verified.length > 0) {
        const draftMatch =
          initialDraft?.mailboxId &&
          verified.find((m) => m.id === initialDraft.mailboxId);
        const withQuota = verified.find((m) => (m.quota?.remainingToday ?? m.dailyLimit) > 0);
        const defaultTarget = draftMatch || withQuota || verified[0];
        setMailboxId((prev) =>
          prev && verified.some((m) => m.id === prev) ? prev : defaultTarget.id
        );
      } else {
        setMailboxId('');
      }
    } catch (err) {
      setMailboxLoadError(
        err instanceof ApiError ? err.message : 'Unable to load configured mailboxes.'
      );
    } finally {
      setLoadingMailboxes(false);
    }
  }, [initialDraft?.mailboxId]);

  const fetchAiContext = useCallback(async (preselectedLeadId?: string) => {
    setLoadingAiStatus(true);
    setLoadingLeads(true);

    const statusPromise = apiFetch<AiStatusResponse>('/api/ai/status')
      .then((res) => setAiStatus(res))
      .catch(() => {
        setAiStatus(null);
      })
      .finally(() => setLoadingAiStatus(false));

    const leadsPromise = apiFetch<LeadsListResponse>('/api/leads?limit=50&sortBy=createdAt&sortOrder=desc')
      .then(async (res) => {
        let items = res.leads;
        if (preselectedLeadId && !items.some((l) => l.id === preselectedLeadId)) {
          try {
            const detail = await apiFetch<LeadDetailResponse>(`/api/leads/${preselectedLeadId}`);
            items = [detail.lead, ...items];
          } catch {
            // Keep fetched list if lead lookup fails
          }
        }
        setLeads(items);
      })
      .catch(() => {
        setLeads([]);
      })
      .finally(() => setLoadingLeads(false));

    const senderProfilePromise = apiFetch<SenderProfileResponse>('/api/sender-profile')
      .then((res) => setSenderProfile(res.profile))
      .catch(() => {
        setSenderProfile(null);
      });

    await Promise.all([statusPromise, leadsPromise, senderProfilePromise]);
  }, []);

  const fetchQuota = useCallback(async (targetId: string) => {
    if (!targetId) {
      setQuota(null);
      return;
    }
    setLoadingQuota(true);
    try {
      const res = await apiFetch<MailboxQuotaResponse>(`/api/mailboxes/${targetId}/quota`);
      setQuota(res.quota);
    } catch {
      // Fallback to list quota snapshot if single-quota fetch fails transiently
      setQuota((prev) => (prev?.mailboxId === targetId ? prev : null));
    } finally {
      setLoadingQuota(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      aiAbortRef.current?.abort();
      aiAbortRef.current = null;
      return;
    }

    setTo(initialDraft?.to ?? '');
    setReplyTo(initialDraft?.replyTo ?? '');
    setSubject(initialDraft?.subject ?? '');
    setText(initialDraft?.text ?? '');
    setHtml(initialDraft?.html ?? '');
    setThreadWithPrevious(Boolean(initialDraft?.threadWithPrevious));
    setInReplyTo(initialDraft?.inReplyTo ?? '');
    setEditorTab(initialDraft?.html && !initialDraft?.text ? 'html' : 'text');
    setMode('compose');
    setError(null);
    setIsAmbiguousError(false);
    setIdempotencyKey(createIdempotencyKey());
    setSelectedLeadId(initialDraft?.leadId ?? '');
    setAiExpanded(Boolean(initialDraft?.openAiAssistant));
    setAiError(null);
    setPendingAiDraft(null);
    setSubjectSuggestions(null);
    setCtaSuggestions(null);
    setDraftProvenance('manual');
    setLastGenerationKind(null);
    setUseSenderProfile(true);
    setIncludeWritingSamples(true);
    void fetchMailboxes();
    void fetchAiContext(initialDraft?.leadId);
  }, [isOpen, initialDraft, fetchMailboxes, fetchAiContext]);

  useEffect(() => {
    if (!isOpen || !mailboxId) {
      if (!mailboxId) setQuota(null);
      return;
    }
    const listSnapshot = selectedMailbox?.quota;
    if (listSnapshot && listSnapshot.mailboxId === mailboxId) {
      setQuota(listSnapshot);
    }
    void fetchQuota(mailboxId);
  }, [isOpen, mailboxId, selectedMailbox?.quota, fetchQuota]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, sending, onClose]);

  const plainTextFallback = useMemo(() => {
    if (text.trim()) return text.trim();
    if (html.trim()) return stripHtmlForPreview(html);
    return '';
  }, [text, html]);

  const sanitizedPreviewSrcDoc = useMemo(() => {
    if (!html.trim()) return '';
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;margin:16px;word-break:break-word;}</style></head><body>${html}</body></html>`;
  }, [html]);

  if (!isOpen) return null;

  const activeQuota = quota ?? selectedMailbox?.quota ?? null;
  const remainingToday = activeQuota ? activeQuota.remainingToday : selectedMailbox?.dailyLimit ?? 0;
  const quotaExhausted = Boolean(selectedMailbox && activeQuota && remainingToday <= 0);

  function markDraftEdited(fromContentField = false) {
    if (error) setError(null);
    if (isAmbiguousError) setIsAmbiguousError(false);
    if (fromContentField && draftProvenance === 'ai_generated') {
      setDraftProvenance('ai_edited');
    }
    setIdempotencyKey(createIdempotencyKey());
  }

  function handleSelectLead(nextLeadId: string) {
    setSelectedLeadId(nextLeadId);
    if (!nextLeadId) return;
    const found = leads.find((l) => l.id === nextLeadId);
    if (found && !to.trim()) {
      setTo(found.email);
    }
  }

  function cancelAiRequest() {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    setAiBusy(false);
    setAiActionLabel(null);
  }

  async function runGenerateEmail(payload: AiGenerateEmailPayload) {
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    lastGeneratePayloadRef.current = payload;
    lastRewritePayloadRef.current = null;

    setAiBusy(true);
    setAiActionLabel('Generating draft...');
    setAiError(null);

    try {
      const fullPayload: AiGenerateEmailPayload = {
        ...payload,
        useSenderProfile,
        includeWritingSamples: useSenderProfile && includeWritingSamples,
      };
      const res = await apiFetch<AiDraftResponse>('/api/ai/email/generate', {
        method: 'POST',
        body: JSON.stringify(fullPayload),
        signal: controller.signal,
      });
      setPendingAiDraft(res.draft);
      setLastGenerationKind('generate');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setAiError(
        err instanceof ApiError ? err.message : 'Unable to generate email draft with DeepSeek.'
      );
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        setAiBusy(false);
        setAiActionLabel(null);
      }
    }
  }

  async function runRewriteEmail(payload: AiRewritePayload) {
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    lastRewritePayloadRef.current = payload;
    lastGeneratePayloadRef.current = null;

    setAiBusy(true);
    setAiActionLabel(`Applying "${payload.action.replace('_', ' ')}"...`);
    setAiError(null);

    try {
      const fullPayload: AiRewritePayload = {
        ...payload,
        useSenderProfile,
        includeWritingSamples: useSenderProfile && includeWritingSamples,
      };
      const res = await apiFetch<AiDraftResponse>('/api/ai/email/rewrite', {
        method: 'POST',
        body: JSON.stringify(fullPayload),
        signal: controller.signal,
      });
      setPendingAiDraft(res.draft);
      setLastGenerationKind(payload.action);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setAiError(err instanceof ApiError ? err.message : 'Unable to refine email draft.');
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        setAiBusy(false);
        setAiActionLabel(null);
      }
    }
  }

  async function runSuggestSubjects(options: { tone: AiWritingTone; instructions: string }) {
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;

    setAiBusy(true);
    setAiActionLabel('Generating subject ideas...');
    setAiError(null);

    try {
      const res = await apiFetch<AiSubjectLinesResponse>('/api/ai/email/subject-lines', {
        method: 'POST',
        body: JSON.stringify({
          subject: subject.trim(),
          text,
          html,
          tone: options.tone,
          instructions: options.instructions,
          useSenderProfile,
          includeWritingSamples: useSenderProfile && includeWritingSamples,
          ...(selectedLeadId ? { leadId: selectedLeadId } : {}),
        }),
        signal: controller.signal,
      });
      setSubjectSuggestions(res.suggestions);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setAiError(
        err instanceof ApiError ? err.message : 'Unable to generate subject line alternatives.'
      );
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        setAiBusy(false);
        setAiActionLabel(null);
      }
    }
  }

  async function runSuggestCtas(options: {
    tone: AiWritingTone;
    mode: AiEmailMode;
    instructions: string;
  }) {
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;

    setAiBusy(true);
    setAiActionLabel('Generating CTA ideas...');
    setAiError(null);

    try {
      const res = await apiFetch<AiCtaSuggestionsResponse>('/api/ai/email/cta', {
        method: 'POST',
        body: JSON.stringify({
          subject: subject.trim(),
          text,
          html,
          tone: options.tone,
          mode: options.mode,
          instructions: options.instructions,
          useSenderProfile,
          includeWritingSamples: useSenderProfile && includeWritingSamples,
          ...(selectedLeadId ? { leadId: selectedLeadId } : {}),
        }),
        signal: controller.signal,
      });
      setCtaSuggestions(res.suggestions);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setAiError(err instanceof ApiError ? err.message : 'Unable to generate CTA suggestions.');
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        setAiBusy(false);
        setAiActionLabel(null);
      }
    }
  }

  function handleAcceptAiDraft(draft: AiGeneratedEmailDraft) {
    setSubject(draft.subject);
    setText(draft.text);
    setHtml(draft.html);
    setEditorTab('text');
    setDraftProvenance('ai_generated');
    setPendingAiDraft(null);
    setAiError(null);
    setIdempotencyKey(createIdempotencyKey());
    if (selectedLeadId && !to.trim()) {
      const lead = leads.find((l) => l.id === selectedLeadId);
      if (lead) setTo(lead.email);
    }
  }

  function handleRegenerateLast() {
    if (lastGenerationKind === 'generate' && lastGeneratePayloadRef.current) {
      void runGenerateEmail(lastGeneratePayloadRef.current);
    } else if (lastRewritePayloadRef.current) {
      void runRewriteEmail(lastRewritePayloadRef.current);
    }
  }

  function handleApplySubjectSuggestion(nextSubject: string) {
    setSubject(nextSubject);
    if (draftProvenance === 'ai_generated') {
      setDraftProvenance('ai_edited');
    }
    setSubjectSuggestions(null);
    setIdempotencyKey(createIdempotencyKey());
  }

  function handleApplyCtaSuggestion(cta: string, applyMode: 'append' | 'replace_last') {
    const cleanCta = cta.trim();
    const baseText = text.trim() ? text.trim() : stripHtmlForPreview(html);
    let nextText = cleanCta;
    if (baseText) {
      if (applyMode === 'replace_last') {
        const paragraphs = baseText.split(/\n{2,}/);
        if (paragraphs.length > 1) {
          paragraphs[paragraphs.length - 1] = cleanCta;
          nextText = paragraphs.join('\n\n');
        } else {
          nextText = `${baseText}\n\n${cleanCta}`;
        }
      } else {
        nextText = `${baseText}\n\n${cleanCta}`;
      }
    }
    setText(nextText);
    if (html.trim()) {
      // Clear stale HTML so sender uses the updated plain text (or user edits HTML tab)
      setHtml('');
    }
    setEditorTab('text');
    if (draftProvenance === 'ai_generated') {
      setDraftProvenance('ai_edited');
    }
    setCtaSuggestions(null);
    setIdempotencyKey(createIdempotencyKey());
  }

  function validateForm(): string | null {
    if (!selectedMailbox) {
      return 'Select a verified, enabled sender mailbox before sending.';
    }
    if (quotaExhausted) {
      return `Daily UTC sending limit reached for "${selectedMailbox.name}". Wait for reset or select another mailbox.`;
    }
    const trimmedTo = to.trim().toLowerCase();
    if (!trimmedTo || !SINGLE_EMAIL_PATTERN.test(trimmedTo)) {
      return 'Enter a single valid recipient email address.';
    }
    const trimmedReplyTo = replyTo.trim().toLowerCase();
    if (trimmedReplyTo && !SINGLE_EMAIL_PATTERN.test(trimmedReplyTo)) {
      return 'Reply-To must be a valid email address.';
    }
    if (!subject.trim()) {
      return 'Subject line is required.';
    }
    if (/[\r\n]/.test(subject)) {
      return 'Subject cannot contain line breaks.';
    }
    if (!plainTextFallback && !stripHtmlForPreview(html)) {
      return 'Provide email body content in Plain Text or HTML.';
    }
    return null;
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (sending) return;

    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      setIsAmbiguousError(false);
      return;
    }

    setSending(true);
    setError(null);
    setIsAmbiguousError(false);

    try {
      const response = await apiFetch<SendEmailResponse>('/api/emails/send', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          mailboxId,
          to: to.trim().toLowerCase(),
          ...(replyTo.trim() ? { replyTo: replyTo.trim().toLowerCase() } : {}),
          subject: subject.trim(),
          text: text.trim(),
          html: html.trim(),
          idempotencyKey,
          ...(selectedLeadId ? { leadId: selectedLeadId } : {}),
          ...(threadWithPrevious ? { threadWithPrevious: true } : {}),
          ...(inReplyTo.trim() ? { inReplyTo: inReplyTo.trim() } : {}),
        }),
      });

      setTo('');
      setReplyTo('');
      setSubject('');
      setText('');
      setHtml('');
      setThreadWithPrevious(false);
      setInReplyTo('');
      setMode('compose');
      setIdempotencyKey(createIdempotencyKey());
      onSent(response);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const data = (err.data || {}) as {
          ambiguous?: boolean;
          quota?: MailboxQuotaSnapshot;
        };
        if (data.quota) {
          setQuota(data.quota);
        } else if (mailboxId) {
          void fetchQuota(mailboxId);
        }
        setIsAmbiguousError(Boolean(data.ambiguous));
        setError(err.message);
      } else {
        setError('Failed to send email. Please check the server connection and try again.');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Compose email"
    >
      <div className="w-full max-w-3xl max-h-[92vh] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Mail className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <div className="min-w-0">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                Compose outbound email
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Verified SMTP delivery with atomic UTC daily quota enforcement
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-800/60">
              <button
                type="button"
                onClick={() => setMode('compose')}
                disabled={sending}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  mode === 'compose'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                Compose
              </button>
              <button
                type="button"
                onClick={() => setMode('preview')}
                disabled={sending}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  mode === 'preview'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Eye className="h-3 w-3" />
                <span>Preview</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => !sending && onClose()}
              disabled={sending}
              aria-label="Close email composer"
              className="inline-flex items-center justify-center rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <form onSubmit={(e) => void handleSend(e)} className="flex-1 overflow-y-auto flex flex-col">
          <div className="p-6 space-y-5 flex-1">
            {mailboxLoadError && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 px-4 py-3 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-3"
              >
                <span>{mailboxLoadError}</span>
                <button
                  type="button"
                  onClick={() => void fetchMailboxes()}
                  className="font-medium underline shrink-0"
                >
                  Retry
                </button>
              </div>
            )}

            {!loadingMailboxes && !mailboxLoadError && eligibleMailboxes.length === 0 && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-900 dark:text-amber-200 space-y-1">
                    <div className="font-semibold">No verified sender mailbox available</div>
                    <p className="text-amber-800 dark:text-amber-300">
                      Only enabled, non-archived mailboxes that have passed SMTP verification can send emails.
                      {ineligibleCount > 0
                        ? ` (${ineligibleCount} mailbox${ineligibleCount === 1 ? '' : 'es'} currently unverified or disabled.)`
                        : ''}
                    </p>
                  </div>
                </div>
                {onNavigateToSettings && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onNavigateToSettings();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    <span>Configure mailboxes</span>
                  </button>
                )}
              </div>
            )}

            {error && (
              <div
                role="alert"
                className={`rounded-lg border px-4 py-3 text-xs flex items-start gap-2.5 ${
                  isAmbiguousError
                    ? 'border-amber-300 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200'
                    : 'border-red-200 dark:border-red-900/60 bg-red-50/80 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                }`}
              >
                {isAmbiguousError ? (
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1">
                  <div className="font-medium">{error}</div>
                  {isAmbiguousError && (
                    <p className="text-[11px] opacity-90">
                      Your draft has been preserved. Check the Outbox log and your SMTP provider&apos;s sent folder before attempting another send.
                    </p>
                  )}
                </div>
              </div>
            )}

            {mode === 'compose' ? (
              <>
                {/* Sender Mailbox Selector + Live Quota */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="composer-mailbox"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      From mailbox <span className="text-red-600 dark:text-red-400">*</span>
                    </label>
                    {selectedMailbox && activeQuota && (
                      <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {loadingQuota && <RefreshCw className="h-3 w-3 animate-spin" />}
                        <span
                          className={
                            quotaExhausted
                              ? 'text-red-600 dark:text-red-400 font-semibold'
                              : ''
                          }
                        >
                          {activeQuota.remainingToday} / {activeQuota.dailyLimit} remaining today
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Resets {formatUtcReset(activeQuota.resetsAt)}</span>
                      </div>
                    )}
                  </div>

                  <select
                    id="composer-mailbox"
                    value={mailboxId}
                    onChange={(e) => {
                      setMailboxId(e.target.value);
                      markDraftEdited();
                    }}
                    disabled={loadingMailboxes || eligibleMailboxes.length === 0 || sending}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60"
                  >
                    {eligibleMailboxes.length === 0 ? (
                      <option value="">
                        {loadingMailboxes ? 'Loading verified mailboxes...' : 'No verified mailbox available'}
                      </option>
                    ) : (
                      eligibleMailboxes.map((mb) => {
                        const rem = mb.quota ? mb.quota.remainingToday : mb.dailyLimit;
                        return (
                          <option key={mb.id} value={mb.id}>
                            {mb.name} — &quot;{mb.senderName}&quot; &lt;{mb.senderEmail}&gt; ({rem}/{mb.dailyLimit} left today)
                          </option>
                        );
                      })
                    )}
                  </select>

                  {quotaExhausted && selectedMailbox && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      &quot;{selectedMailbox.name}&quot; has reached its daily limit of {selectedMailbox.dailyLimit} emails (UTC).
                    </p>
                  )}
                </div>

                {/* To & Reply-To */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="composer-to"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      To <span className="text-red-600 dark:text-red-400">*</span>
                    </label>
                    <input
                      id="composer-to"
                      type="email"
                      required
                      value={to}
                      onChange={(e) => {
                        setTo(e.target.value);
                        markDraftEdited();
                      }}
                      disabled={sending}
                      placeholder="prospect@company.com"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="composer-reply-to"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      Reply-To <span className="text-slate-400 font-normal">(optional)</span>
                    </label>
                    <input
                      id="composer-reply-to"
                      type="email"
                      value={replyTo}
                      onChange={(e) => {
                        setReplyTo(e.target.value);
                        markDraftEdited();
                      }}
                      disabled={sending}
                      placeholder={
                        selectedMailbox?.replyTo
                          ? `Default: ${selectedMailbox.replyTo}`
                          : selectedMailbox?.senderEmail || 'replies@domain.com'
                      }
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                </div>

                {(selectedLeadId || threadWithPrevious || inReplyTo) && (
                  <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={threadWithPrevious}
                      onChange={(e) => {
                        setThreadWithPrevious(e.target.checked);
                        if (!e.target.checked) setInReplyTo('');
                        markDraftEdited();
                      }}
                      className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
                    />
                    <span>
                      Thread as follow-up (sets In-Reply-To &amp; References headers from prior sent message)
                    </span>
                  </label>
                )}

                {/* Subject */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="composer-subject"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      Subject <span className="text-red-600 dark:text-red-400">*</span>
                    </label>
                    {draftProvenance !== 'manual' && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                        <Sparkles className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                        <span>
                          {draftProvenance === 'ai_generated'
                            ? 'AI-generated draft · Review before sending'
                            : 'AI draft · Edited by you'}
                        </span>
                      </span>
                    )}
                  </div>
                  <input
                    id="composer-subject"
                    type="text"
                    required
                    maxLength={250}
                    value={subject}
                    onChange={(e) => {
                      setSubject(e.target.value);
                      markDraftEdited(true);
                    }}
                    disabled={sending}
                    placeholder="Quick question about Q2 outreach"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                {/* DeepSeek AI Email Assistant */}
                <AiEmailAssistantPanel
                  aiStatus={aiStatus}
                  loadingStatus={loadingAiStatus}
                  isExpanded={aiExpanded}
                  onToggleExpanded={() => setAiExpanded((prev) => !prev)}
                  leads={leads}
                  loadingLeads={loadingLeads}
                  selectedLeadId={selectedLeadId}
                  onSelectLeadId={handleSelectLead}
                  senderProfile={senderProfile}
                  useSenderProfile={useSenderProfile}
                  onToggleUseSenderProfile={setUseSenderProfile}
                  includeWritingSamples={includeWritingSamples}
                  onToggleIncludeWritingSamples={setIncludeWritingSamples}
                  onOpenSenderSettings={
                    onNavigateToSettings
                      ? () => {
                          onClose();
                          onNavigateToSettings();
                        }
                      : undefined
                  }
                  recipientEmail={to}
                  currentSubject={subject}
                  currentText={text}
                  currentHtml={html}
                  sending={sending}
                  aiBusy={aiBusy}
                  aiActionLabel={aiActionLabel}
                  aiError={aiError}
                  pendingDraft={pendingAiDraft}
                  subjectSuggestions={subjectSuggestions}
                  ctaSuggestions={ctaSuggestions}
                  lastGenerationKind={lastGenerationKind}
                  onGenerate={(payload) => void runGenerateEmail(payload)}
                  onRewrite={(payload) => void runRewriteEmail(payload)}
                  onSuggestSubjects={(opts) => void runSuggestSubjects(opts)}
                  onSuggestCtas={(opts) => void runSuggestCtas(opts)}
                  onCancelAi={cancelAiRequest}
                  onAcceptDraft={handleAcceptAiDraft}
                  onDiscardDraft={() => setPendingAiDraft(null)}
                  onRegenerateLast={handleRegenerateLast}
                  onApplySubject={handleApplySubjectSuggestion}
                  onDismissSubjects={() => setSubjectSuggestions(null)}
                  onApplyCta={handleApplyCtaSuggestion}
                  onDismissCtas={() => setCtaSuggestions(null)}
                />

                {/* Body Editor (Plain Text + HTML) */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      Message body <span className="text-red-600 dark:text-red-400">*</span>
                    </span>
                    <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-800/60">
                      <button
                        type="button"
                        onClick={() => setEditorTab('text')}
                        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                          editorTab === 'text'
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                        }`}
                      >
                        <FileText className="h-3 w-3" />
                        <span>Plain text</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditorTab('html')}
                        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                          editorTab === 'html'
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                        }`}
                      >
                        <Code2 className="h-3 w-3" />
                        <span>HTML</span>
                      </button>
                    </div>
                  </div>

                  {editorTab === 'text' ? (
                    <textarea
                      id="composer-body-text"
                      rows={9}
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        markDraftEdited(true);
                      }}
                      disabled={sending}
                      placeholder="Write your plain-text message..."
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 leading-relaxed"
                    />
                  ) : (
                    <textarea
                      id="composer-body-html"
                      rows={9}
                      value={html}
                      onChange={(e) => {
                        setHtml(e.target.value);
                        markDraftEdited(true);
                      }}
                      disabled={sending}
                      placeholder="<p>Hi there,</p><p>Writing to share...</p>"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5 font-mono text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 leading-relaxed"
                    />
                  )}

                  <div className="flex items-start gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                    <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      {html.trim() && !text.trim()
                        ? 'A plain-text fallback will be automatically derived from your HTML before sending.'
                        : html.trim() && text.trim()
                          ? 'Both HTML and custom plain-text versions will be included in the MIME message.'
                          : 'Outbox logs store delivery metadata without persisting full message bodies.'}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              /* Preview Mode */
              <div className="space-y-4">
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4 space-y-2 text-xs">
                  <div className="flex items-baseline gap-2">
                    <span className="w-16 text-slate-500 dark:text-slate-400 shrink-0">From</span>
                    <span className="font-mono text-slate-900 dark:text-slate-100 break-all">
                      {selectedMailbox
                        ? `"${selectedMailbox.senderName}" <${selectedMailbox.senderEmail}>`
                        : 'No mailbox selected'}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="w-16 text-slate-500 dark:text-slate-400 shrink-0">To</span>
                    <span className="font-mono text-slate-900 dark:text-slate-100 break-all">
                      {to.trim() || '—'}
                    </span>
                  </div>
                  {replyTo.trim() && (
                    <div className="flex items-baseline gap-2">
                      <span className="w-16 text-slate-500 dark:text-slate-400 shrink-0">Reply-To</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100 break-all">
                        {replyTo.trim()}
                      </span>
                    </div>
                  )}
                  <div className="flex items-baseline gap-2 pt-1 border-t border-slate-200 dark:border-slate-800">
                    <span className="w-16 text-slate-500 dark:text-slate-400 shrink-0">Subject</span>
                    <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                      {subject.trim() || '—'}
                    </span>
                  </div>
                </div>

                {html.trim() && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      HTML render (sandboxed)
                    </div>
                    <iframe
                      title="Email HTML preview"
                      sandbox=""
                      srcDoc={sanitizedPreviewSrcDoc}
                      className="w-full h-56 rounded-lg border border-slate-200 dark:border-slate-800 bg-white"
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    Plain-text {html.trim() && !text.trim() ? 'fallback (auto-derived)' : 'body'}
                  </div>
                  <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap font-sans leading-relaxed min-h-[120px]">
                    {plainTextFallback || 'No message body entered yet.'}
                  </pre>
                </div>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900 shrink-0">
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
              {selectedMailbox
                ? `Sending via ${selectedMailbox.smtpHost}:${selectedMailbox.smtpPort}`
                : 'Select a verified mailbox'}
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 min-h-[36px]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sending || !selectedMailbox || quotaExhausted}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 text-xs font-medium text-white transition-colors min-h-[36px] whitespace-nowrap"
              >
                {sending ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Sending...</span>
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" />
                    <span>Send email</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
