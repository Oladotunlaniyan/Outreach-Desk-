import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Eye,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import {
  LEAD_STATUSES,
  type CampaignDetailResponse,
  type CampaignItem,
  type CampaignRecipientItem,
  type CampaignRecipientStatus,
  type CampaignSendConfig,
  type CampaignStatus,
  type CampaignsListResponse,
  type LeadItem,
  type LeadsListResponse,
  type MailboxItem,
  type MailboxesListResponse,
  type SuppressionReason,
  type SuppressionsListResponse,
} from '../types/outreach';

interface CampaignsPageProps {
  refreshSignal: number;
  onNavigateToImport: () => void;
  onNavigateToSettings: () => void;
  onCampaignMutated?: () => void;
}

type CampaignsTab = 'campaigns' | 'suppressions';

const PLACEHOLDER_CHIPS = [
  '{{first_name}}',
  '{{last_name}}',
  '{{full_name}}',
  '{{company}}',
  '{{role}}',
  '{{website}}',
  '{{location}}',
];

const RECIPIENT_STATUS_OPTIONS: Array<{ value: 'all' | CampaignRecipientStatus; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'queued', label: 'Queued' },
  { value: 'sending', label: 'Sending' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'ambiguous', label: 'Ambiguous' },
  { value: 'skipped_suppressed', label: 'Suppressed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function formatDateTime(iso: string | null): string {
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

function campaignStatusClasses(status: CampaignStatus): string {
  switch (status) {
    case 'Sending':
      return 'text-blue-600 dark:text-blue-400';
    case 'Completed':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'Paused':
      return 'text-amber-600 dark:text-amber-400';
    case 'Failed':
    case 'Cancelled':
      return 'text-red-600 dark:text-red-400';
    default:
      return 'text-slate-600 dark:text-slate-400';
  }
}

function recipientStatusClasses(status: CampaignRecipientStatus): string {
  switch (status) {
    case 'sent':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'sending':
    case 'queued':
      return 'text-blue-600 dark:text-blue-400';
    case 'failed':
    case 'bounced':
      return 'text-red-600 dark:text-red-400';
    case 'ambiguous':
    case 'skipped_suppressed':
      return 'text-amber-600 dark:text-amber-400';
    default:
      return 'text-slate-600 dark:text-slate-400';
  }
}

function recipientStatusLabel(status: CampaignRecipientStatus): string {
  switch (status) {
    case 'skipped_suppressed':
      return 'Suppressed';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function interpolateClientPreview(
  template: string,
  lead?: {
    email?: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    company?: string;
    role?: string;
    website?: string;
    location?: string;
  }
): string {
  if (!template) return '';
  const target = lead || {
    firstName: 'Alex',
    lastName: 'Morgan',
    fullName: 'Alex Morgan',
    email: 'alex@example.com',
    company: 'Northstar Labs',
    role: 'Head of Growth',
    website: 'https://northstar.example',
    location: 'Austin, TX',
  };
  const firstName =
    target.firstName || (target.fullName || '').trim().split(/\s+/)[0] || '';
  const lastName =
    target.lastName ||
    (target.fullName || '').trim().split(/\s+/).slice(1).join(' ') ||
    '';

  const map: Record<string, string> = {
    first_name: firstName,
    firstname: firstName,
    last_name: lastName,
    lastname: lastName,
    full_name: target.fullName || [firstName, lastName].filter(Boolean).join(' '),
    fullname: target.fullName || [firstName, lastName].filter(Boolean).join(' '),
    name: target.fullName || [firstName, lastName].filter(Boolean).join(' '),
    email: target.email || '',
    company: target.company || '',
    organization: target.company || '',
    org: target.company || '',
    role: target.role || '',
    title: target.role || '',
    job_title: target.role || '',
    website: target.website || '',
    url: target.website || '',
    location: target.location || '',
    city: target.location || '',
  };

  return template.replace(/\{\{\s*([a-zA-Z0-9_.\-\s]+?)\s*\}\}/g, (_m, rawKey: string) => {
    const k = rawKey.trim().toLowerCase().replace(/[\s.-]+/g, '_');
    return map[k] ?? '';
  });
}

function parsePastedRecipients(rawText: string): Array<{
  email: string;
  fullName?: string;
  company?: string;
}> {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: Array<{ email: string; fullName?: string; company?: string }> = [];

  for (const line of lines) {
    const parts = line.split(/[,\t]/).map((p) => p.trim());
    const emailCandidate = parts.find((p) => p.includes('@'))?.toLowerCase();
    if (!emailCandidate || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCandidate)) {
      continue;
    }
    if (seen.has(emailCandidate)) continue;
    seen.add(emailCandidate);
    const nonEmail = parts.filter((p) => p.toLowerCase() !== emailCandidate);
    out.push({
      email: emailCandidate,
      ...(nonEmail[0] ? { fullName: nonEmail[0] } : {}),
      ...(nonEmail[1] ? { company: nonEmail[1] } : {}),
    });
  }
  return out;
}

export function CampaignsPage({
  refreshSignal,
  onNavigateToImport,
  onNavigateToSettings,
  onCampaignMutated,
}: CampaignsPageProps) {
  const [activeTab, setActiveTab] = useState<CampaignsTab>('campaigns');

  // Campaigns list state
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | CampaignStatus>('all');
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Selected campaign detail state
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CampaignDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [recipientFilter, setRecipientFilter] = useState<'all' | CampaignRecipientStatus>('all');
  const [recipientPage, setRecipientPage] = useState(1);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'delete' | null>(null);

  // Preview recipient message modal
  const [previewRecipient, setPreviewRecipient] = useState<CampaignRecipientItem | null>(null);

  // Create / Edit campaign modal state
  const [campaignModalOpen, setCampaignModalOpen] = useState(false);
  const [campaignModalMode, setCampaignModalMode] = useState<'create' | 'edit'>('create');
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formMailboxId, setFormMailboxId] = useState('');
  const [formReplyTo, setFormReplyTo] = useState('');
  const [formSubject, setFormSubject] = useState('');
  const [formBodyText, setFormBodyText] = useState('');
  const [formBodyHtml, setFormBodyHtml] = useState('');
  const [showHtmlField, setShowHtmlField] = useState(false);
  const [formSendConfig, setFormSendConfig] = useState<CampaignSendConfig>({
    batchSize: 8,
    delayMs: 1500,
    concurrency: 1,
    dailySendCap: null,
    threadFollowUps: true,
  });
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Lead / recipient selector inside Create Modal OR Add Recipients Modal
  const [addRecipientsModalOpen, setAddRecipientsModalOpen] = useState(false);
  const [recipientSourceTab, setRecipientSourceTab] = useState<'leads' | 'paste'>('leads');
  const [leadPickerQuery, setLeadPickerQuery] = useState('');
  const [leadPickerStatus, setLeadPickerStatus] = useState<string>('all');
  const [leadPickerItems, setLeadPickerItems] = useState<LeadItem[]>([]);
  const [leadPickerLoading, setLeadPickerLoading] = useState(false);
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [pastedRecipientsText, setPastedRecipientsText] = useState('');
  const [addingRecipients, setAddingRecipients] = useState(false);

  // Suppressions & Bounces tab state
  const [suppressionsData, setSuppressionsData] = useState<SuppressionsListResponse | null>(null);
  const [loadingSuppressions, setLoadingSuppressions] = useState(false);
  const [suppressionError, setSuppressionError] = useState<string | null>(null);
  const [suppressionSearch, setSuppressionSearch] = useState('');
  const [suppressionReasonFilter, setSuppressionReasonFilter] = useState<'all' | SuppressionReason>('all');
  const [suppressionPage, setSuppressionPage] = useState(1);
  const [manualSuppressEmail, setManualSuppressEmail] = useState('');
  const [manualSuppressDetail, setManualSuppressDetail] = useState('');
  const [manualSuppressSubmitting, setManualSuppressSubmitting] = useState(false);
  const [bounceEmail, setBounceEmail] = useState('');
  const [bounceType, setBounceType] = useState<'hard' | 'soft'>('hard');
  const [bounceReason, setBounceReason] = useState('');
  const [bounceSubmitting, setBounceSubmitting] = useState(false);
  const [confirmRemoveSuppressionId, setConfirmRemoveSuppressionId] = useState<string | null>(null);

  const loadCampaignsAndMailboxes = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const [campRes, mbRes] = await Promise.all([
        apiFetch<CampaignsListResponse>(
          `/api/campaigns${params.toString() ? `?${params.toString()}` : ''}`
        ),
        apiFetch<MailboxesListResponse>('/api/mailboxes'),
      ]);
      setCampaigns(campRes.campaigns);
      setMailboxes(mbRes.mailboxes.filter((m) => !m.archived));
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : 'Unable to load campaigns.');
    } finally {
      setLoadingList(false);
    }
  }, [statusFilter]);

  const loadCampaignDetail = useCallback(
    async (campaignId: string, silent = false) => {
      if (!silent) setLoadingDetail(true);
      setDetailError(null);
      try {
        const params = new URLSearchParams({
          page: String(recipientPage),
          limit: '25',
        });
        if (recipientFilter !== 'all') {
          params.set('recipientStatus', recipientFilter);
        }
        const res = await apiFetch<CampaignDetailResponse>(
          `/api/campaigns/${campaignId}?${params.toString()}`
        );
        setDetail(res);
      } catch (err) {
        setDetailError(
          err instanceof ApiError ? err.message : 'Unable to load campaign details.'
        );
      } finally {
        if (!silent) setLoadingDetail(false);
      }
    },
    [recipientFilter, recipientPage]
  );

  const loadSuppressions = useCallback(async () => {
    setLoadingSuppressions(true);
    setSuppressionError(null);
    try {
      const params = new URLSearchParams({
        page: String(suppressionPage),
        limit: '25',
      });
      if (suppressionReasonFilter !== 'all') params.set('reason', suppressionReasonFilter);
      if (suppressionSearch.trim()) params.set('search', suppressionSearch.trim());
      const res = await apiFetch<SuppressionsListResponse>(
        `/api/suppressions?${params.toString()}`
      );
      setSuppressionsData(res);
    } catch (err) {
      setSuppressionError(
        err instanceof ApiError ? err.message : 'Unable to load suppression list.'
      );
    } finally {
      setLoadingSuppressions(false);
    }
  }, [suppressionPage, suppressionReasonFilter, suppressionSearch]);

  const loadLeadsForPicker = useCallback(async () => {
    setLeadPickerLoading(true);
    try {
      const params = new URLSearchParams({ page: '1', limit: '50' });
      if (leadPickerQuery.trim()) params.set('search', leadPickerQuery.trim());
      if (leadPickerStatus !== 'all') params.set('status', leadPickerStatus);
      const res = await apiFetch<LeadsListResponse>(`/api/leads?${params.toString()}`);
      setLeadPickerItems(res.leads);
    } catch {
      setLeadPickerItems([]);
    } finally {
      setLeadPickerLoading(false);
    }
  }, [leadPickerQuery, leadPickerStatus]);

  useEffect(() => {
    if (activeTab === 'campaigns') {
      void loadCampaignsAndMailboxes();
    } else {
      void loadSuppressions();
    }
  }, [activeTab, refreshSignal, loadCampaignsAndMailboxes, loadSuppressions]);

  useEffect(() => {
    if (activeTab === 'campaigns' && selectedCampaignId) {
      void loadCampaignDetail(selectedCampaignId);
    }
  }, [activeTab, refreshSignal, selectedCampaignId, loadCampaignDetail]);

  // Live polling while selected campaign is Sending
  useEffect(() => {
    if (!selectedCampaignId || detail?.campaign.status !== 'Sending') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadCampaignDetail(selectedCampaignId, true);
        void loadCampaignsAndMailboxes();
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [selectedCampaignId, detail?.campaign.status, loadCampaignDetail, loadCampaignsAndMailboxes]);

  useEffect(() => {
    if (campaignModalOpen || addRecipientsModalOpen) {
      void loadLeadsForPicker();
    }
  }, [campaignModalOpen, addRecipientsModalOpen, loadLeadsForPicker]);

  useEffect(() => {
    if (!campaignModalOpen && !addRecipientsModalOpen && !previewRecipient) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (previewRecipient) setPreviewRecipient(null);
        else if (addRecipientsModalOpen) setAddRecipientsModalOpen(false);
        else if (campaignModalOpen) setCampaignModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [campaignModalOpen, addRecipientsModalOpen, previewRecipient]);

  function openCreateModal() {
    const defaultMailbox =
      mailboxes.find((m) => m.enabled && m.verificationStatus === 'verified') ||
      mailboxes[0];
    setCampaignModalMode('create');
    setEditingCampaignId(null);
    setFormName('');
    setFormDescription('');
    setFormMailboxId(defaultMailbox?.id || '');
    setFormReplyTo(defaultMailbox?.replyTo || '');
    setFormSubject('Quick question for {{first_name}} at {{company}}');
    setFormBodyText(
      'Hi {{first_name}},\n\nSaw what {{company}} is building and wanted to share a quick note.\n\nOpen to a brief chat this week?\n\nBest,'
    );
    setFormBodyHtml('');
    setShowHtmlField(false);
    setFormSendConfig({
      batchSize: 8,
      delayMs: 1500,
      concurrency: 1,
      dailySendCap: null,
      threadFollowUps: true,
    });
    setSelectedLeadIds([]);
    setPastedRecipientsText('');
    setFormError(null);
    setCampaignModalOpen(true);
  }

  function openEditModal(camp: CampaignItem) {
    setCampaignModalMode('edit');
    setEditingCampaignId(camp.id);
    setFormName(camp.name);
    setFormDescription(camp.description);
    setFormMailboxId(camp.mailboxId);
    setFormReplyTo(camp.replyTo);
    setFormSubject(camp.subjectTemplate);
    setFormBodyText(camp.bodyTextTemplate);
    setFormBodyHtml(camp.bodyHtmlTemplate);
    setShowHtmlField(Boolean(camp.bodyHtmlTemplate));
    setFormSendConfig({ ...camp.sendConfig });
    setSelectedLeadIds([]);
    setPastedRecipientsText('');
    setFormError(null);
    setCampaignModalOpen(true);
  }

  function appendPlaceholder(token: string) {
    setFormBodyText((prev) => (prev ? `${prev} ${token}` : token));
  }

  async function handleSaveCampaign() {
    if (!formName.trim()) {
      setFormError('Campaign name is required.');
      return;
    }
    if (!formMailboxId) {
      setFormError('Please select a sender mailbox.');
      return;
    }
    if (!formSubject.trim()) {
      setFormError('Subject template is required.');
      return;
    }
    if (!formBodyText.trim() && !formBodyHtml.trim()) {
      setFormError('Provide a plain-text or HTML body template.');
      return;
    }

    setFormSaving(true);
    setFormError(null);
    try {
      if (campaignModalMode === 'create') {
        const inlineRecipients = parsePastedRecipients(pastedRecipientsText);
        const res = await apiFetch<{ campaign: CampaignItem }>('/api/campaigns', {
          method: 'POST',
          body: JSON.stringify({
            name: formName.trim(),
            description: formDescription.trim(),
            mailboxId: formMailboxId,
            replyTo: formReplyTo.trim(),
            subjectTemplate: formSubject.trim(),
            bodyTextTemplate: formBodyText,
            bodyHtmlTemplate: showHtmlField ? formBodyHtml : '',
            sendConfig: formSendConfig,
            leadIds: selectedLeadIds,
            recipients: inlineRecipients,
          }),
        });
        setCampaignModalOpen(false);
        setSelectedCampaignId(res.campaign.id);
        setRecipientPage(1);
        setRecipientFilter('all');
        setFeedback(`Created campaign "${res.campaign.name}".`);
        await loadCampaignsAndMailboxes();
        await loadCampaignDetail(res.campaign.id);
        onCampaignMutated?.();
      } else if (editingCampaignId) {
        const res = await apiFetch<{ campaign: CampaignItem }>(
          `/api/campaigns/${editingCampaignId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              name: formName.trim(),
              description: formDescription.trim(),
              mailboxId: formMailboxId,
              replyTo: formReplyTo.trim(),
              subjectTemplate: formSubject.trim(),
              bodyTextTemplate: formBodyText,
              bodyHtmlTemplate: showHtmlField ? formBodyHtml : '',
              sendConfig: formSendConfig,
            }),
          }
        );
        setCampaignModalOpen(false);
        setFeedback(`Updated campaign "${res.campaign.name}".`);
        await loadCampaignsAndMailboxes();
        if (selectedCampaignId === editingCampaignId) {
          await loadCampaignDetail(editingCampaignId);
        }
        onCampaignMutated?.();
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to save campaign.');
    } finally {
      setFormSaving(false);
    }
  }

  async function handleCampaignLifecycleAction(
    campaignId: string,
    action: 'launch' | 'pause' | 'resume' | 'cancel' | 'retry-failed' | 'delete'
  ) {
    setActionBusy(action);
    setDetailError(null);
    setFeedback(null);
    try {
      if (action === 'delete') {
        await apiFetch(`/api/campaigns/${campaignId}`, { method: 'DELETE' });
        setConfirmAction(null);
        setSelectedCampaignId(null);
        setDetail(null);
        setFeedback('Campaign deleted.');
        await loadCampaignsAndMailboxes();
        onCampaignMutated?.();
        return;
      }

      const res = await apiFetch<{ ok: boolean; campaign: CampaignItem; requeuedCount?: number }>(
        `/api/campaigns/${campaignId}/${action}`,
        { method: 'POST' }
      );
      setConfirmAction(null);
      if (action === 'launch') setFeedback(`Campaign "${res.campaign.name}" launched.`);
      if (action === 'pause') setFeedback(`Campaign "${res.campaign.name}" paused.`);
      if (action === 'resume') setFeedback(`Campaign "${res.campaign.name}" resumed.`);
      if (action === 'cancel') setFeedback(`Campaign "${res.campaign.name}" cancelled.`);
      if (action === 'retry-failed') {
        setFeedback(`Re-queued ${res.requeuedCount ?? 0} failed recipient(s).`);
      }

      await Promise.all([
        loadCampaignsAndMailboxes(),
        loadCampaignDetail(campaignId),
      ]);
      onCampaignMutated?.();
    } catch (err) {
      setDetailError(
        err instanceof ApiError ? err.message : `Failed to ${action} campaign.`
      );
    } finally {
      setActionBusy(null);
    }
  }

  async function handleAddRecipientsToCampaign() {
    if (!selectedCampaignId) return;
    const inlineRecipients = parsePastedRecipients(pastedRecipientsText);
    if (selectedLeadIds.length === 0 && inlineRecipients.length === 0) {
      return;
    }

    setAddingRecipients(true);
    setDetailError(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        summary: { addedCount: number; skippedSuppressedCount: number; duplicateCount: number };
      }>(`/api/campaigns/${selectedCampaignId}/recipients`, {
        method: 'POST',
        body: JSON.stringify({
          leadIds: selectedLeadIds,
          recipients: inlineRecipients,
        }),
      });
      setAddRecipientsModalOpen(false);
      setSelectedLeadIds([]);
      setPastedRecipientsText('');
      setFeedback(
        `Added ${res.summary.addedCount} recipient(s) (${res.summary.skippedSuppressedCount} suppressed, ${res.summary.duplicateCount} duplicate).`
      );
      await Promise.all([
        loadCampaignsAndMailboxes(),
        loadCampaignDetail(selectedCampaignId),
      ]);
      onCampaignMutated?.();
    } catch (err) {
      setDetailError(
        err instanceof ApiError ? err.message : 'Failed to add recipients to campaign.'
      );
    } finally {
      setAddingRecipients(false);
    }
  }

  async function handleRemoveRecipient(recipientId: string) {
    if (!selectedCampaignId) return;
    setActionBusy(`remove-${recipientId}`);
    setDetailError(null);
    try {
      await apiFetch(`/api/campaigns/${selectedCampaignId}/recipients/${recipientId}`, {
        method: 'DELETE',
      });
      await Promise.all([
        loadCampaignsAndMailboxes(),
        loadCampaignDetail(selectedCampaignId),
      ]);
      onCampaignMutated?.();
    } catch (err) {
      setDetailError(
        err instanceof ApiError ? err.message : 'Failed to remove recipient.'
      );
    } finally {
      setActionBusy(null);
    }
  }

  async function handleManualSuppress(e: React.FormEvent) {
    e.preventDefault();
    if (!manualSuppressEmail.trim() || manualSuppressSubmitting) return;
    setManualSuppressSubmitting(true);
    setSuppressionError(null);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; skippedRecipientsCount: number }>(
        '/api/suppressions',
        {
          method: 'POST',
          body: JSON.stringify({
            email: manualSuppressEmail.trim(),
            reason: 'manual',
            detail: manualSuppressDetail.trim() || 'Added to suppression list',
          }),
        }
      );
      setFeedback(
        `Suppressed ${manualSuppressEmail.trim().toLowerCase()}. Skipped ${res.skippedRecipientsCount} queued campaign recipient(s).`
      );
      setManualSuppressEmail('');
      setManualSuppressDetail('');
      await loadSuppressions();
      onCampaignMutated?.();
    } catch (err) {
      setSuppressionError(
        err instanceof ApiError ? err.message : 'Failed to suppress email address.'
      );
    } finally {
      setManualSuppressSubmitting(false);
    }
  }

  async function handleRecordBounce(e: React.FormEvent) {
    e.preventDefault();
    if (!bounceEmail.trim() || bounceSubmitting) return;
    setBounceSubmitting(true);
    setSuppressionError(null);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        results: Array<{
          email: string;
          bounceType: 'hard' | 'soft';
          suppressed: boolean;
          skippedRecipientsCount: number;
        }>;
      }>('/api/bounces/process', {
        method: 'POST',
        body: JSON.stringify({
          email: bounceEmail.trim(),
          bounceType,
          reason:
            bounceReason.trim() ||
            (bounceType === 'hard' ? 'Hard bounce recorded manually' : 'Soft bounce logged'),
          source: 'manual',
        }),
      });
      const first = res.results[0];
      setFeedback(
        first?.bounceType === 'hard'
          ? `Recorded hard bounce for ${first.email}: lead marked Invalid, address suppressed, ${first.skippedRecipientsCount} queued recipient(s) skipped.`
          : `Recorded soft bounce for ${first?.email}.`
      );
      setBounceEmail('');
      setBounceReason('');
      await loadSuppressions();
      onCampaignMutated?.();
    } catch (err) {
      setSuppressionError(
        err instanceof ApiError ? err.message : 'Failed to record bounce event.'
      );
    } finally {
      setBounceSubmitting(false);
    }
  }

  async function handleRemoveSuppression(id: string) {
    setSuppressionError(null);
    try {
      await apiFetch(`/api/suppressions/${id}`, { method: 'DELETE' });
      setConfirmRemoveSuppressionId(null);
      setFeedback('Removed entry from suppression list.');
      await loadSuppressions();
    } catch (err) {
      setSuppressionError(
        err instanceof ApiError ? err.message : 'Failed to remove suppression entry.'
      );
    }
  }

  const firstPreviewLead = useMemo(() => {
    if (selectedLeadIds.length > 0) {
      return leadPickerItems.find((l) => l.id === selectedLeadIds[0]);
    }
    const pasted = parsePastedRecipients(pastedRecipientsText);
    if (pasted.length > 0) return pasted[0];
    return undefined;
  }, [selectedLeadIds, leadPickerItems, pastedRecipientsText]);

  const activeCampaign = detail?.campaign ?? null;
  const activeCounts = activeCampaign?.counts;

  return (
    <div className="space-y-6">
      {/* Top Sub-navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 self-start">
          <button
            type="button"
            onClick={() => setActiveTab('campaigns')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === 'campaigns'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Campaigns
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('suppressions')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === 'suppressions'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Suppressions & Bounces
          </button>
        </div>

        {activeTab === 'campaigns' && !selectedCampaignId && (
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="Filter campaigns by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | CampaignStatus)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 min-h-[36px]"
            >
              <option value="all">All statuses</option>
              <option value="Draft">Draft</option>
              <option value="Sending">Sending</option>
              <option value="Paused">Paused</option>
              <option value="Completed">Completed</option>
              <option value="Cancelled">Cancelled</option>
              <option value="Failed">Failed</option>
            </select>

            <button
              type="button"
              onClick={onNavigateToImport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[36px] whitespace-nowrap"
            >
              <Send className="h-3.5 w-3.5" />
              <span>CSV to Campaign</span>
            </button>

            <button
              type="button"
              onClick={openCreateModal}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-xs font-medium transition-colors min-h-[36px] whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New campaign</span>
            </button>
          </div>
        )}
      </div>

      {feedback && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-white dark:bg-slate-900 px-4 py-3 flex items-center justify-between gap-3 text-sm text-emerald-700 dark:text-emerald-300">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{feedback}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            aria-label="Dismiss notification"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* TAB 1: CAMPAIGNS */}
      {activeTab === 'campaigns' && !selectedCampaignId && (
        <>
          {listError && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 p-4 flex items-center gap-3 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{listError}</span>
            </div>
          )}

          {mailboxes.length === 0 && !loadingList && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Configure an SMTP mailbox first
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Add and verify at least one SMTP mailbox in Settings before launching campaigns.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onNavigateToSettings}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-xs font-medium transition-colors whitespace-nowrap self-start sm:self-auto"
              >
                Open Settings
              </button>
            </div>
          )}

          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            {loadingList && campaigns.length === 0 ? (
              <div className="p-6 space-y-3 animate-pulse">
                <div className="h-12 rounded-lg bg-slate-100 dark:bg-slate-800" />
                <div className="h-12 rounded-lg bg-slate-100 dark:bg-slate-800" />
              </div>
            ) : campaigns.length === 0 ? (
              <div className="px-6 py-12 text-center space-y-3">
                <Mail className="h-8 w-8 mx-auto text-slate-400 dark:text-slate-500" />
                <div className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  No campaigns yet
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                  Create a batch outreach campaign from your existing leads or import a personalized CSV directly into a campaign.
                </p>
                <div className="pt-2 flex flex-wrap justify-center gap-3">
                  <button
                    type="button"
                    onClick={openCreateModal}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                    <span>New campaign</span>
                  </button>
                  <button
                    type="button"
                    onClick={onNavigateToImport}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <span>Import CSV</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-3 px-6">Campaign</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Mailbox</th>
                      <th className="py-3 px-4 text-right">Recipients</th>
                      <th className="py-3 px-4 text-right">Sent</th>
                      <th className="py-3 px-4 text-right">Failed / Bounced</th>
                      <th className="py-3 px-6 text-right">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                    {campaigns.map((camp) => (
                      <tr
                        key={camp.id}
                        onClick={() => {
                          setSelectedCampaignId(camp.id);
                          setRecipientPage(1);
                          setRecipientFilter('all');
                          setConfirmAction(null);
                        }}
                        className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                      >
                        <td className="py-3.5 px-6">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {camp.name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[280px]">
                            {camp.subjectTemplate || 'Per-recipient CSV subject'}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-xs font-semibold whitespace-nowrap">
                          <span className={campaignStatusClasses(camp.status)}>{camp.status}</span>
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300">
                          <div>{camp.mailboxName || 'Mailbox'}</div>
                          <div className="text-slate-400 font-mono">{camp.mailboxEmail || '—'}</div>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                          {camp.totalRecipients.toLocaleString()}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                          {camp.sentCount.toLocaleString()}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                          {(camp.failedCount + camp.bouncedCount).toLocaleString()}
                        </td>
                        <td className="py-3.5 px-6 text-right text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {formatDateTime(camp.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* TAB 1 DETAIL VIEW: CAMPAIGN MONITOR */}
      {activeTab === 'campaigns' && selectedCampaignId && (
        <div className="space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => {
                  setSelectedCampaignId(null);
                  setDetail(null);
                  setConfirmAction(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors shrink-0"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>All campaigns</span>
              </button>

              {activeCampaign && (
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                      {activeCampaign.name}
                    </h2>
                    <span
                      className={`text-xs font-semibold ${campaignStatusClasses(
                        activeCampaign.status
                      )}`}
                    >
                      {activeCampaign.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Sender: {activeCampaign.mailboxName || 'Unknown'} (
                    <span className="font-mono">{activeCampaign.mailboxEmail || '—'}</span>) · Batch{' '}
                    <span className="font-mono tabular-nums">
                      {activeCampaign.sendConfig.batchSize}
                    </span>{' '}
                    · Delay{' '}
                    <span className="font-mono tabular-nums">
                      {activeCampaign.sendConfig.delayMs}ms
                    </span>
                    {activeCampaign.replyTo ? ` · Reply-To: ${activeCampaign.replyTo}` : ''}
                  </p>
                </div>
              )}
            </div>

            {activeCampaign && (
              <div className="flex flex-wrap items-center gap-2">
                {(activeCampaign.status === 'Draft' || activeCampaign.status === 'Approved') && (
                  <button
                    type="button"
                    disabled={actionBusy !== null}
                    onClick={() => void handleCampaignLifecycleAction(activeCampaign.id, 'launch')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-xs font-medium transition-colors min-h-[36px]"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>{actionBusy === 'launch' ? 'Launching...' : 'Launch campaign'}</span>
                  </button>
                )}

                {activeCampaign.status === 'Sending' && (
                  <button
                    type="button"
                    disabled={actionBusy !== null}
                    onClick={() => void handleCampaignLifecycleAction(activeCampaign.id, 'pause')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 px-3.5 py-2 text-xs font-medium transition-colors min-h-[36px]"
                  >
                    <Pause className="h-3.5 w-3.5" />
                    <span>{actionBusy === 'pause' ? 'Pausing...' : 'Pause'}</span>
                  </button>
                )}

                {(activeCampaign.status === 'Paused' || activeCampaign.status === 'Failed') && (
                  <button
                    type="button"
                    disabled={actionBusy !== null}
                    onClick={() => void handleCampaignLifecycleAction(activeCampaign.id, 'resume')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-xs font-medium transition-colors min-h-[36px]"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>{actionBusy === 'resume' ? 'Resuming...' : 'Resume'}</span>
                  </button>
                )}

                {activeCounts && activeCounts.failed > 0 && activeCampaign.status !== 'Cancelled' && (
                  <button
                    type="button"
                    disabled={actionBusy !== null}
                    onClick={() =>
                      void handleCampaignLifecycleAction(activeCampaign.id, 'retry-failed')
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[36px]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Retry failed ({activeCounts.failed})</span>
                  </button>
                )}

                {activeCampaign.status !== 'Completed' && activeCampaign.status !== 'Cancelled' && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedLeadIds([]);
                      setPastedRecipientsText('');
                      setAddRecipientsModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[36px]"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    <span>Add leads</span>
                  </button>
                )}

                {activeCampaign.status !== 'Sending' &&
                  activeCampaign.status !== 'Completed' &&
                  activeCampaign.status !== 'Cancelled' && (
                    <button
                      type="button"
                      onClick={() => openEditModal(activeCampaign)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[36px]"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      <span>Edit</span>
                    </button>
                  )}

                {activeCampaign.status !== 'Completed' &&
                  activeCampaign.status !== 'Cancelled' &&
                  (confirmAction === 'cancel' ? (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={actionBusy !== null}
                        onClick={() =>
                          void handleCampaignLifecycleAction(activeCampaign.id, 'cancel')
                        }
                        className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 py-2 text-xs font-medium min-h-[36px]"
                      >
                        Confirm cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmAction(null)}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-2 text-xs text-slate-600 dark:text-slate-300 min-h-[36px]"
                      >
                        Keep
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmAction('cancel')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[36px]"
                    >
                      <Ban className="h-3.5 w-3.5" />
                      <span>Cancel</span>
                    </button>
                  ))}

                {activeCampaign.status !== 'Sending' &&
                  (confirmAction === 'delete' ? (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={actionBusy !== null}
                        onClick={() =>
                          void handleCampaignLifecycleAction(activeCampaign.id, 'delete')
                        }
                        className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 py-2 text-xs font-medium min-h-[36px]"
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmAction(null)}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-2 text-xs text-slate-600 dark:text-slate-300 min-h-[36px]"
                      >
                        Keep
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmAction('delete')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors min-h-[36px]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete</span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {detailError && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 p-4 flex items-center gap-3 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{detailError}</span>
            </div>
          )}

          {activeCampaign?.lastError && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-white dark:bg-slate-900 p-4 flex items-start gap-3 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Delivery notice</div>
                <div className="text-xs mt-0.5">{activeCampaign.lastError}</div>
              </div>
            </div>
          )}

          {loadingDetail && !detail ? (
            <div className="h-40 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
          ) : (
            activeCampaign &&
            activeCounts && (
              <>
                {/* Analytics KPI Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Total</div>
                    <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      {activeCampaign.totalRecipients.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Queued / Pending</div>
                    <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                      {(activeCounts.queued + activeCounts.pending + activeCounts.sending).toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Sent</div>
                    <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {activeCounts.sent.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Failed</div>
                    <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-red-600 dark:text-red-400">
                      {activeCounts.failed.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Bounced</div>
                    <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-red-600 dark:text-red-400">
                      {activeCounts.bounced.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Ambiguous</div>
                    <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                      {activeCounts.ambiguous.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Suppressed</div>
                    <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                      {activeCounts.skipped_suppressed.toLocaleString()}
                    </div>
                  </div>
                </div>

                {/* Progress & Mailbox Quota Bar */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        Delivery progress
                      </span>
                      <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {activeCounts.sent} / {activeCampaign.totalRecipients} sent
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-blue-600 transition-all"
                        style={{
                          width: `${
                            activeCampaign.totalRecipients > 0
                              ? Math.min(
                                  100,
                                  Math.round(
                                    ((activeCounts.sent +
                                      activeCounts.failed +
                                      activeCounts.bounced +
                                      activeCounts.skipped_suppressed +
                                      activeCounts.cancelled) /
                                      activeCampaign.totalRecipients) *
                                      100
                                  )
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>

                  {detail?.mailboxQuota && (
                    <div className="border-t md:border-t-0 md:border-l border-slate-200 dark:border-slate-800 pt-3 md:pt-0 md:pl-5 text-xs shrink-0">
                      <div className="text-slate-500 dark:text-slate-400">
                        Mailbox UTC daily quota
                      </div>
                      <div className="mt-0.5 font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {detail.mailboxQuota.remainingToday} remaining of{' '}
                        {detail.mailboxQuota.dailyLimit}
                      </div>
                    </div>
                  )}
                </div>

                {/* Recipients Table */}
                <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                        Campaign recipients
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {detail?.pagination.totalFiltered ?? 0} matching recipient(s)
                      </p>
                    </div>

                    <select
                      aria-label="Filter recipients by status"
                      value={recipientFilter}
                      onChange={(e) => {
                        setRecipientFilter(e.target.value as 'all' | CampaignRecipientStatus);
                        setRecipientPage(1);
                      }}
                      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200"
                    >
                      {RECIPIENT_STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!detail || detail.recipients.length === 0 ? (
                    <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                      No recipients in this view.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                            <th className="py-3 px-6">Recipient</th>
                            <th className="py-3 px-4">Rendered Subject</th>
                            <th className="py-3 px-4">Status</th>
                            <th className="py-3 px-4 text-right">Attempts</th>
                            <th className="py-3 px-4">Sent / Note</th>
                            <th className="py-3 px-6 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                          {detail.recipients.map((rec) => (
                            <tr key={rec.id}>
                              <td className="py-3 px-6">
                                <div className="font-medium text-slate-900 dark:text-slate-100">
                                  {rec.email}
                                </div>
                                <div className="text-slate-500 dark:text-slate-400">
                                  {[rec.fullName, rec.company].filter(Boolean).join(' · ') || '—'}
                                </div>
                                {rec.missingPlaceholders.length > 0 && (
                                  <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                                    Missing: {rec.missingPlaceholders.join(', ')}
                                  </div>
                                )}
                              </td>
                              <td className="py-3 px-4 text-slate-700 dark:text-slate-300 max-w-[240px] truncate">
                                {rec.renderedSubject || '—'}
                              </td>
                              <td className="py-3 px-4 font-semibold whitespace-nowrap">
                                <span className={recipientStatusClasses(rec.status)}>
                                  {recipientStatusLabel(rec.status)}
                                </span>
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                                {rec.attempts}
                              </td>
                              <td className="py-3 px-4 text-slate-500 dark:text-slate-400 max-w-[260px] truncate">
                                {rec.sentAt
                                  ? formatDateTime(rec.sentAt)
                                  : rec.skipReason || rec.lastError || '—'}
                              </td>
                              <td className="py-3 px-6 text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setPreviewRecipient(rec)}
                                    className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                                  >
                                    <Eye className="h-3 w-3" />
                                    <span>Preview</span>
                                  </button>
                                  {rec.status !== 'sending' &&
                                    rec.status !== 'sent' &&
                                    rec.status !== 'ambiguous' && (
                                      <button
                                        type="button"
                                        disabled={actionBusy === `remove-${rec.id}`}
                                        onClick={() => void handleRemoveRecipient(rec.id)}
                                        className="rounded border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                                        title="Remove recipient"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {detail && detail.pagination.totalPages > 1 && (
                    <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono tabular-nums">
                        Page {detail.pagination.page} of {detail.pagination.totalPages}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={recipientPage <= 1}
                          onClick={() => setRecipientPage((p) => Math.max(1, p - 1))}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                          Prev
                        </button>
                        <button
                          type="button"
                          disabled={recipientPage >= detail.pagination.totalPages}
                          onClick={() =>
                            setRecipientPage((p) =>
                              Math.min(detail.pagination.totalPages, p + 1)
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                        >
                          Next
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              </>
            )
          )}
        </div>
      )}

      {/* TAB 2: SUPPRESSIONS & BOUNCES */}
      {activeTab === 'suppressions' && (
        <div className="space-y-6">
          {suppressionError && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 p-4 flex items-center gap-3 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{suppressionError}</span>
            </div>
          )}

          {/* Summary KPI Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Total suppressed</div>
              <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {(suppressionsData?.totalSuppressions ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Unsubscribed</div>
              <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                {(suppressionsData?.counts.unsubscribe ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Hard bounced</div>
              <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">
                {(suppressionsData?.counts.hard_bounce ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Manual blocks</div>
              <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                {(suppressionsData?.counts.manual ?? 0).toLocaleString()}
              </div>
            </div>
          </div>

          {/* Action Cards: Manual Suppress & Record Bounce */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <form
              onSubmit={(e) => void handleManualSuppress(e)}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
            >
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-slate-500" />
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Add manual suppression
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Blocks future sends across single emails, CSV imports, and queued campaign recipients.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="email"
                  required
                  placeholder="prospect@company.com"
                  value={manualSuppressEmail}
                  onChange={(e) => setManualSuppressEmail(e.target.value)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
                <input
                  type="text"
                  placeholder="Reason / note (optional)"
                  value={manualSuppressDetail}
                  onChange={(e) => setManualSuppressDetail(e.target.value)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
              <button
                type="submit"
                disabled={manualSuppressSubmitting}
                className="rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-4 py-2 text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {manualSuppressSubmitting ? 'Adding...' : 'Suppress email'}
              </button>
            </form>

            <form
              onSubmit={(e) => void handleRecordBounce(e)}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Record bounce event
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Hard bounces mark the lead <span className="font-medium">Invalid</span>, add to the suppression list, and skip queued campaigns.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="email"
                  required
                  placeholder="bounced@domain.com"
                  value={bounceEmail}
                  onChange={(e) => setBounceEmail(e.target.value)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
                <select
                  aria-label="Bounce type"
                  value={bounceType}
                  onChange={(e) => setBounceType(e.target.value as 'hard' | 'soft')}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                >
                  <option value="hard">Hard bounce (550 / 5.1.1)</option>
                  <option value="soft">Soft bounce (4xx temporary)</option>
                </select>
                <input
                  type="text"
                  placeholder="Diagnostic reason (optional)"
                  value={bounceReason}
                  onChange={(e) => setBounceReason(e.target.value)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
              <button
                type="submit"
                disabled={bounceSubmitting}
                className="rounded-lg bg-red-600 hover:bg-red-700 text-white px-4 py-2 text-xs font-medium disabled:opacity-50 transition-colors"
              >
                {bounceSubmitting ? 'Recording...' : 'Record bounce'}
              </button>
            </form>
          </div>

          {/* Suppression List Table */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="relative flex-1 max-w-xs">
                <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  placeholder="Search suppressed email..."
                  value={suppressionSearch}
                  onChange={(e) => {
                    setSuppressionSearch(e.target.value);
                    setSuppressionPage(1);
                  }}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                />
              </div>

              <select
                aria-label="Filter suppressions by reason"
                value={suppressionReasonFilter}
                onChange={(e) => {
                  setSuppressionReasonFilter(e.target.value as 'all' | SuppressionReason);
                  setSuppressionPage(1);
                }}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200"
              >
                <option value="all">All reasons</option>
                <option value="unsubscribe">Unsubscribe</option>
                <option value="hard_bounce">Hard bounce</option>
                <option value="manual">Manual</option>
              </select>
            </div>

            {loadingSuppressions && !suppressionsData ? (
              <div className="p-6 space-y-3 animate-pulse">
                <div className="h-10 rounded bg-slate-100 dark:bg-slate-800" />
                <div className="h-10 rounded bg-slate-100 dark:bg-slate-800" />
              </div>
            ) : !suppressionsData || suppressionsData.suppressions.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                No suppressed email addresses found.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-3 px-6">Email</th>
                      <th className="py-3 px-4">Reason</th>
                      <th className="py-3 px-4">Source</th>
                      <th className="py-3 px-4">Detail</th>
                      <th className="py-3 px-4">Suppressed at</th>
                      <th className="py-3 px-6 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                    {suppressionsData.suppressions.map((item) => (
                      <tr key={item.id}>
                        <td className="py-3 px-6 font-mono text-slate-900 dark:text-slate-100">
                          {item.email}
                        </td>
                        <td className="py-3 px-4 font-semibold">
                          <span
                            className={
                              item.reason === 'hard_bounce'
                                ? 'text-red-600 dark:text-red-400'
                                : item.reason === 'unsubscribe'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-slate-600 dark:text-slate-300'
                            }
                          >
                            {item.reason.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-500 dark:text-slate-400">
                          {item.source}
                        </td>
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-300 max-w-[260px] truncate">
                          {item.detail || '—'}
                        </td>
                        <td className="py-3 px-4 text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {formatDateTime(item.suppressedAt)}
                        </td>
                        <td className="py-3 px-6 text-right whitespace-nowrap">
                          {confirmRemoveSuppressionId === item.id ? (
                            <span className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleRemoveSuppression(item.id)}
                                className="rounded bg-red-600 text-white px-2.5 py-1 text-xs font-medium"
                              >
                                Remove
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRemoveSuppressionId(null)}
                                className="rounded border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs"
                              >
                                Keep
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmRemoveSuppressionId(item.id)}
                              className="text-slate-500 hover:text-red-600 dark:hover:text-red-400 font-medium"
                            >
                              Unsuppress
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {suppressionsData && suppressionsData.pagination.totalPages > 1 && (
              <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span className="font-mono tabular-nums">
                  Page {suppressionsData.pagination.page} of{' '}
                  {suppressionsData.pagination.totalPages} ·{' '}
                  {suppressionsData.pagination.totalFiltered.toLocaleString()} result(s)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={suppressionPage <= 1 || loadingSuppressions}
                    onClick={() => setSuppressionPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={
                      suppressionPage >= suppressionsData.pagination.totalPages ||
                      loadingSuppressions
                    }
                    onClick={() =>
                      setSuppressionPage((p) =>
                        Math.min(suppressionsData.pagination.totalPages, p + 1)
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* CREATE / EDIT CAMPAIGN MODAL */}
      {campaignModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={campaignModalMode === 'create' ? 'Create campaign' : 'Edit campaign'}
        >
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                {campaignModalMode === 'create' ? 'New outreach campaign' : 'Edit campaign'}
              </h3>
              <button
                type="button"
                onClick={() => setCampaignModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                aria-label="Close modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {formError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-xs text-red-700 dark:text-red-300 flex items-center gap-2"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="camp-form-name"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Campaign name *
                  </label>
                  <input
                    id="camp-form-name"
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Q2 Founder Outreach"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="camp-form-mailbox"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Sender mailbox *
                  </label>
                  <select
                    id="camp-form-mailbox"
                    value={formMailboxId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setFormMailboxId(nextId);
                      const mb = mailboxes.find((m) => m.id === nextId);
                      if (mb && !formReplyTo) {
                        setFormReplyTo(mb.replyTo || '');
                      }
                    }}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  >
                    <option value="">Select mailbox</option>
                    {mailboxes.map((mb) => (
                      <option key={mb.id} value={mb.id}>
                        {mb.name} ({mb.senderEmail})
                        {mb.verificationStatus !== 'verified' ? ' — unverified' : ''}
                        {!mb.enabled ? ' — disabled' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="camp-form-description"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Description (optional)
                  </label>
                  <input
                    id="camp-form-description"
                    type="text"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder="Internal notes about this campaign"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="camp-form-replyto"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Reply-To override (optional)
                  </label>
                  <input
                    id="camp-form-replyto"
                    type="email"
                    value={formReplyTo}
                    onChange={(e) => setFormReplyTo(e.target.value)}
                    placeholder="replies@yourdomain.com"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              {/* Message Template */}
              <div className="space-y-3 rounded-lg border border-slate-200 dark:border-slate-800 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Email template & placeholders
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {PLACEHOLDER_CHIPS.map((token) => (
                      <button
                        key={token}
                        type="button"
                        onClick={() => appendPlaceholder(token)}
                        className="rounded border border-slate-200 dark:border-slate-700 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        {token}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="camp-form-subject"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Subject template *
                  </label>
                  <input
                    id="camp-form-subject"
                    type="text"
                    value={formSubject}
                    onChange={(e) => setFormSubject(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      htmlFor="camp-form-bodytext"
                      className="text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      Plain-text body template *
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowHtmlField((v) => !v)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {showHtmlField ? 'Hide custom HTML' : 'Add custom HTML'}
                    </button>
                  </div>
                  <textarea
                    id="camp-form-bodytext"
                    rows={5}
                    value={formBodyText}
                    onChange={(e) => setFormBodyText(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>

                {showHtmlField && (
                  <div>
                    <label
                      htmlFor="camp-form-bodyhtml"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      Optional HTML template (sanitized before sending)
                    </label>
                    <textarea
                      id="camp-form-bodyhtml"
                      rows={4}
                      value={formBodyHtml}
                      onChange={(e) => setFormBodyHtml(e.target.value)}
                      placeholder="<p>Hi {{first_name}},</p>"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                    />
                  </div>
                )}

                {/* Sample Personalized Preview */}
                <div className="rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 p-3 space-y-1">
                  <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    Live preview ({firstPreviewLead?.email || 'sample recipient'})
                  </div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {interpolateClientPreview(formSubject, firstPreviewLead) || '—'}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap">
                    {interpolateClientPreview(formBodyText, firstPreviewLead) || '—'}
                  </div>
                </div>
              </div>

              {/* Batch Sending Settings */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label
                    htmlFor="camp-form-batchsize"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Batch size (1–50)
                  </label>
                  <input
                    id="camp-form-batchsize"
                    type="number"
                    min={1}
                    max={50}
                    value={formSendConfig.batchSize}
                    onChange={(e) =>
                      setFormSendConfig((c) => ({
                        ...c,
                        batchSize: Math.max(1, Math.min(50, Number(e.target.value) || 1)),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label
                    htmlFor="camp-form-delayms"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Delay ms (250–30000)
                  </label>
                  <input
                    id="camp-form-delayms"
                    type="number"
                    min={250}
                    max={30000}
                    step={250}
                    value={formSendConfig.delayMs}
                    onChange={(e) =>
                      setFormSendConfig((c) => ({
                        ...c,
                        delayMs: Math.max(250, Math.min(30000, Number(e.target.value) || 250)),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label
                    htmlFor="camp-form-concurrency"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Concurrency (1–3)
                  </label>
                  <input
                    id="camp-form-concurrency"
                    type="number"
                    min={1}
                    max={3}
                    value={formSendConfig.concurrency}
                    onChange={(e) =>
                      setFormSendConfig((c) => ({
                        ...c,
                        concurrency: Math.max(1, Math.min(3, Number(e.target.value) || 1)),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label
                    htmlFor="camp-form-dailycap"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Daily cap (optional)
                  </label>
                  <input
                    id="camp-form-dailycap"
                    type="number"
                    min={1}
                    max={10000}
                    placeholder="Mailbox limit"
                    value={formSendConfig.dailySendCap ?? ''}
                    onChange={(e) =>
                      setFormSendConfig((c) => ({
                        ...c,
                        dailySendCap: e.target.value
                          ? Math.max(1, Math.min(10000, Number(e.target.value)))
                          : null,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono tabular-nums"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={formSendConfig.threadFollowUps}
                  onChange={(e) =>
                    setFormSendConfig((c) => ({ ...c, threadFollowUps: e.target.checked }))
                  }
                  className="rounded border-slate-300"
                />
                <span>
                  Thread with prior sent messages to the same recipient (In-Reply-To / References)
                </span>
              </label>

              {/* Initial Recipients Picker on Create */}
              {campaignModalMode === 'create' && (
                <div className="space-y-3 rounded-lg border border-slate-200 dark:border-slate-800 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Recipients ({selectedLeadIds.length} lead(s) +{' '}
                      {parsePastedRecipients(pastedRecipientsText).length} pasted)
                    </span>
                    <div className="inline-flex gap-1 p-0.5 rounded-md bg-slate-100 dark:bg-slate-800">
                      <button
                        type="button"
                        onClick={() => setRecipientSourceTab('leads')}
                        className={`px-2.5 py-1 text-xs rounded ${
                          recipientSourceTab === 'leads'
                            ? 'bg-white dark:bg-slate-900 font-medium'
                            : 'text-slate-500'
                        }`}
                      >
                        From Leads
                      </button>
                      <button
                        type="button"
                        onClick={() => setRecipientSourceTab('paste')}
                        className={`px-2.5 py-1 text-xs rounded ${
                          recipientSourceTab === 'paste'
                            ? 'bg-white dark:bg-slate-900 font-medium'
                            : 'text-slate-500'
                        }`}
                      >
                        Paste Emails
                      </button>
                    </div>
                  </div>

                  {recipientSourceTab === 'leads' ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <input
                          type="search"
                          placeholder="Search leads by name, email, company..."
                          value={leadPickerQuery}
                          onChange={(e) => setLeadPickerQuery(e.target.value)}
                          className="flex-1 min-w-[180px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs"
                        />
                        <select
                          value={leadPickerStatus}
                          onChange={(e) => setLeadPickerStatus(e.target.value)}
                          className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                        >
                          <option value="all">All statuses</option>
                          {LEAD_STATUSES.map((st) => (
                            <option key={st} value={st}>
                              {st}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedLeadIds(
                              leadPickerItems
                                .filter((l) => !l.bounced && !l.optedOut && l.status !== 'Invalid')
                                .map((l) => l.id)
                            )
                          }
                          className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium"
                        >
                          Select eligible ({leadPickerItems.length})
                        </button>
                      </div>

                      <div className="max-h-44 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                        {leadPickerLoading ? (
                          <div className="p-4 text-xs text-slate-500">Loading leads...</div>
                        ) : leadPickerItems.length === 0 ? (
                          <div className="p-4 text-xs text-slate-500">No leads match filter.</div>
                        ) : (
                          leadPickerItems.map((lead) => {
                            const checked = selectedLeadIds.includes(lead.id);
                            const blocked = lead.bounced || lead.optedOut || lead.status === 'Invalid';
                            return (
                              <label
                                key={lead.id}
                                className="flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                              >
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() =>
                                      setSelectedLeadIds((prev) =>
                                        prev.includes(lead.id)
                                          ? prev.filter((id) => id !== lead.id)
                                          : [...prev, lead.id]
                                      )
                                    }
                                  />
                                  <div className="min-w-0 truncate">
                                    <span className="font-medium text-slate-900 dark:text-slate-100">
                                      {lead.fullName || lead.email}
                                    </span>{' '}
                                    <span className="text-slate-500 font-mono">
                                      ({lead.email})
                                    </span>
                                    {lead.company && (
                                      <span className="text-slate-400"> · {lead.company}</span>
                                    )}
                                  </div>
                                </div>
                                <span
                                  className={`text-[11px] shrink-0 ${
                                    blocked ? 'text-red-600 dark:text-red-400' : 'text-slate-500'
                                  }`}
                                >
                                  {lead.bounced
                                    ? 'Bounced'
                                    : lead.optedOut
                                      ? 'Opted out'
                                      : lead.status}
                                </span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </div>
                  ) : (
                    <textarea
                      rows={4}
                      placeholder={
                        'alex@northstar.example, Alex Morgan, Northstar Labs\nsam@acme.example, Sam Rivera, Acme Inc'
                      }
                      value={pastedRecipientsText}
                      onChange={(e) => setPastedRecipientsText(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-xs"
                    />
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setCampaignModalOpen(false)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={formSaving}
                onClick={() => void handleSaveCampaign()}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2 text-sm font-medium"
              >
                {formSaving ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>
                    {campaignModalMode === 'create' ? 'Save draft campaign' : 'Save changes'}
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD RECIPIENTS TO EXISTING CAMPAIGN MODAL */}
      {addRecipientsModalOpen && activeCampaign && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Add recipients to campaign"
        >
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Add recipients to {activeCampaign.name}
              </h3>
              <button
                type="button"
                onClick={() => setAddRecipientsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close add recipients modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="inline-flex gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                <button
                  type="button"
                  onClick={() => setRecipientSourceTab('leads')}
                  className={`px-3 py-1 text-xs rounded ${
                    recipientSourceTab === 'leads'
                      ? 'bg-white dark:bg-slate-900 font-medium'
                      : 'text-slate-500'
                  }`}
                >
                  From Leads ({selectedLeadIds.length})
                </button>
                <button
                  type="button"
                  onClick={() => setRecipientSourceTab('paste')}
                  className={`px-3 py-1 text-xs rounded ${
                    recipientSourceTab === 'paste'
                      ? 'bg-white dark:bg-slate-900 font-medium'
                      : 'text-slate-500'
                  }`}
                >
                  Paste Emails ({parsePastedRecipients(pastedRecipientsText).length})
                </button>
              </div>

              {recipientSourceTab === 'leads' ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="search"
                      placeholder="Search leads..."
                      value={leadPickerQuery}
                      onChange={(e) => setLeadPickerQuery(e.target.value)}
                      className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedLeadIds(
                          leadPickerItems
                            .filter((l) => !l.bounced && !l.optedOut && l.status !== 'Invalid')
                            .map((l) => l.id)
                        )
                      }
                      className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium"
                    >
                      Select eligible
                    </button>
                  </div>
                  <div className="max-h-56 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                    {leadPickerItems.map((lead) => (
                      <label
                        key={lead.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer"
                      >
                        <span className="flex items-center gap-2 truncate">
                          <input
                            type="checkbox"
                            checked={selectedLeadIds.includes(lead.id)}
                            onChange={() =>
                              setSelectedLeadIds((prev) =>
                                prev.includes(lead.id)
                                  ? prev.filter((id) => id !== lead.id)
                                  : [...prev, lead.id]
                              )
                            }
                          />
                          <span className="font-medium">{lead.fullName || lead.email}</span>
                          <span className="text-slate-500 font-mono">({lead.email})</span>
                        </span>
                        <span className="text-slate-400">{lead.status}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <textarea
                  rows={5}
                  placeholder="email, full name, company (one per line)"
                  value={pastedRecipientsText}
                  onChange={(e) => setPastedRecipientsText(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-xs"
                />
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setAddRecipientsModalOpen(false)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  addingRecipients ||
                  (selectedLeadIds.length === 0 &&
                    parsePastedRecipients(pastedRecipientsText).length === 0)
                }
                onClick={() => void handleAddRecipientsToCampaign()}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-xs font-medium"
              >
                {addingRecipients ? 'Adding...' : 'Add recipients'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECIPIENT MESSAGE PREVIEW MODAL */}
      {previewRecipient && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Rendered recipient email preview"
        >
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Personalized message preview
                </h3>
                <p className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  To: {previewRecipient.email}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewRecipient(null)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close preview"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              {previewRecipient.missingPlaceholders.length > 0 && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-amber-700 dark:text-amber-300">
                  Missing placeholder values defaulted to empty:{' '}
                  <span className="font-mono">
                    {previewRecipient.missingPlaceholders.join(', ')}
                  </span>
                </div>
              )}

              <div>
                <div className="text-slate-500 dark:text-slate-400 mb-1">Subject</div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {previewRecipient.renderedSubject || '—'}
                </div>
              </div>

              <div>
                <div className="text-slate-500 dark:text-slate-400 mb-1">Plain-text body</div>
                <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap font-sans">
                  {previewRecipient.renderedText || '—'}
                </pre>
              </div>

              {previewRecipient.renderedHtml && (
                <div>
                  <div className="text-slate-500 dark:text-slate-400 mb-1">
                    Sandboxed HTML render
                  </div>
                  <iframe
                    title="Rendered HTML preview"
                    sandbox=""
                    srcDoc={previewRecipient.renderedHtml}
                    className="w-full h-48 rounded-lg border border-slate-200 dark:border-slate-800 bg-white"
                  />
                </div>
              )}

              {(previewRecipient.smtpMessageId || previewRecipient.threadId) && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                  {previewRecipient.smtpMessageId && (
                    <div>Message-ID: {previewRecipient.smtpMessageId}</div>
                  )}
                  {previewRecipient.inReplyTo && (
                    <div>In-Reply-To: {previewRecipient.inReplyTo}</div>
                  )}
                  {previewRecipient.threadId && <div>Thread ID: {previewRecipient.threadId}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
