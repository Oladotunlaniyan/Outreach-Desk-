import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Clock,
  Edit3,
  Mail,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import type {
  MailboxEncryptionStatus,
  MailboxFormPayload,
  MailboxItem,
  MailboxTestResponse,
  MailboxesListResponse,
} from '../types/outreach';
import { MailboxFormModal } from './MailboxFormModal';

interface MailboxesSectionProps {
  dbConnected: boolean;
  onMailboxChanged?: () => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return 'Never tested';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MailboxesSection({
  dbConnected,
  onMailboxChanged,
}: MailboxesSectionProps) {
  const [mailboxes, setMailboxes] = useState<MailboxItem[]>([]);
  const [encryptionStatus, setEncryptionStatus] =
    useState<MailboxEncryptionStatus | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [editingMailbox, setEditingMailbox] = useState<MailboxItem | null>(null);

  const [confirmMailbox, setConfirmMailbox] = useState<MailboxItem | null>(null);
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const loadMailboxes = useCallback(async () => {
    if (!dbConnected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = includeArchived ? '?includeArchived=true' : '';
      const res = await apiFetch<MailboxesListResponse>(`/api/mailboxes${query}`);
      setMailboxes(res.mailboxes);
      setEncryptionStatus(res.encryptionStatus);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to load SMTP mailboxes.'
      );
    } finally {
      setLoading(false);
    }
  }, [dbConnected, includeArchived]);

  useEffect(() => {
    void loadMailboxes();
  }, [loadMailboxes]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 6000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  function openCreateModal() {
    setFormMode('create');
    setEditingMailbox(null);
    setFormOpen(true);
  }

  function openEditModal(mailbox: MailboxItem) {
    setFormMode('edit');
    setEditingMailbox(mailbox);
    setFormOpen(true);
  }

  async function handleFormSubmit(payload: MailboxFormPayload) {
    if (formMode === 'create') {
      const res = await apiFetch<{ mailbox: MailboxItem }>('/api/mailboxes', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setFeedback({
        type: 'success',
        message: `Added mailbox "${res.mailbox.name}". Run a connection test to verify SMTP login.`,
      });
      await loadMailboxes();
      onMailboxChanged?.();
    } else if (editingMailbox) {
      const res = await apiFetch<{ mailbox: MailboxItem }>(
        `/api/mailboxes/${editingMailbox.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      );
      setMailboxes((prev) =>
        prev.map((m) => (m.id === res.mailbox.id ? res.mailbox : m))
      );
      setFeedback({
        type: 'success',
        message: `Updated mailbox "${res.mailbox.name}".`,
      });
      onMailboxChanged?.();
    }
  }

  async function handleToggleEnabled(mailbox: MailboxItem) {
    if (togglingId || mailbox.archived) return;
    setTogglingId(mailbox.id);
    setError(null);
    try {
      const res = await apiFetch<{ mailbox: MailboxItem }>(
        `/api/mailboxes/${mailbox.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !mailbox.enabled }),
        }
      );
      setMailboxes((prev) =>
        prev.map((m) => (m.id === res.mailbox.id ? res.mailbox : m))
      );
      setFeedback({
        type: 'success',
        message: res.mailbox.enabled
          ? `Enabled "${res.mailbox.name}".`
          : `Disabled "${res.mailbox.name}".`,
      });
      onMailboxChanged?.();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Unable to update mailbox enabled state.'
      );
    } finally {
      setTogglingId(null);
    }
  }

  async function handleRestoreMailbox(mailbox: MailboxItem) {
    if (togglingId) return;
    setTogglingId(mailbox.id);
    setError(null);
    try {
      const res = await apiFetch<{ mailbox: MailboxItem }>(
        `/api/mailboxes/${mailbox.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ archived: false, enabled: true }),
        }
      );
      setFeedback({
        type: 'success',
        message: `Restored "${res.mailbox.name}".`,
      });
      await loadMailboxes();
      onMailboxChanged?.();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to restore mailbox.'
      );
    } finally {
      setTogglingId(null);
    }
  }

  async function handleTestConnection(mailbox: MailboxItem) {
    if (testingId || mailbox.archived) return;
    setTestingId(mailbox.id);
    setError(null);
    try {
      const res = await apiFetch<MailboxTestResponse>(
        `/api/mailboxes/${mailbox.id}/test`,
        {
          method: 'POST',
        }
      );
      setMailboxes((prev) =>
        prev.map((m) => (m.id === res.mailbox.id ? res.mailbox : m))
      );
      setFeedback({
        type: res.ok ? 'success' : 'error',
        message: `${mailbox.name}: ${res.message}`,
      });
      onMailboxChanged?.();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to test SMTP connection.'
      );
      await loadMailboxes();
    } finally {
      setTestingId(null);
    }
  }

  async function handleConfirmArchiveOrDelete() {
    if (!confirmMailbox || archiving) return;
    setArchiving(true);
    setError(null);
    try {
      const query =
        confirmPermanent && !confirmMailbox.referencedByHistory
          ? '?permanent=true'
          : '';
      const res = await apiFetch<{ ok: boolean; action: 'archived' | 'deleted' }>(
        `/api/mailboxes/${confirmMailbox.id}${query}`,
        {
          method: 'DELETE',
        }
      );
      setFeedback({
        type: 'success',
        message:
          res.action === 'deleted'
            ? `Permanently deleted "${confirmMailbox.name}".`
            : `Archived "${confirmMailbox.name}". Existing email history was preserved.`,
      });
      setConfirmMailbox(null);
      setConfirmPermanent(false);
      await loadMailboxes();
      onMailboxChanged?.();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to archive mailbox.'
      );
    } finally {
      setArchiving(false);
    }
  }

  const encryptionValid = encryptionStatus?.valid ?? true;

  return (
    <section
      aria-label="SMTP mailboxes"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            SMTP mailboxes
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Configure sender accounts with encrypted credentials and verify SMTP login without sending email
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none mr-1">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
            />
            <span>Show archived</span>
          </label>
          <button
            type="button"
            onClick={() => void loadMailboxes()}
            disabled={loading || !dbConnected}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap min-h-[36px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            disabled={!dbConnected || !encryptionValid}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3.5 py-1.5 text-xs font-medium text-white transition-colors whitespace-nowrap min-h-[36px]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add mailbox</span>
          </button>
        </div>
      </div>

      {/* Encryption Key Warning */}
      {encryptionStatus && !encryptionStatus.valid && (
        <div
          role="alert"
          className="mx-6 mt-5 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 p-4 flex items-start gap-3"
        >
          <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-slate-900 dark:text-slate-100">
              Mailbox encryption key required
            </div>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
              {encryptionStatus.error}
            </p>
            <p className="text-slate-500 dark:text-slate-400">
              Generate a key with{' '}
              <code className="font-mono text-slate-800 dark:text-slate-200">
                openssl rand -base64 32
              </code>{' '}
              and set <code className="font-mono">MAILBOX_ENCRYPTION_KEY</code> in your server environment secrets.
            </p>
          </div>
        </div>
      )}

      {/* Operation Feedback */}
      {feedback && (
        <div
          role="status"
          className={`mx-6 mt-5 rounded-lg border px-4 py-3 flex items-center justify-between gap-3 text-sm ${
            feedback.type === 'success'
              ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
              : 'border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/30 text-red-800 dark:text-red-200'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            )}
            <span>{feedback.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="Dismiss feedback"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div
          role="alert"
          className="mx-6 mt-5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/30 px-4 py-3 flex items-center justify-between gap-3 text-sm text-red-700 dark:text-red-300"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Content */}
      {!dbConnected ? (
        <div className="px-6 py-10 text-center">
          <Mail className="h-7 w-7 mx-auto text-slate-300 dark:text-slate-700" />
          <h3 className="mt-2.5 font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Database connection required
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            Connect MongoDB Atlas below to store and test SMTP mailboxes.
          </p>
        </div>
      ) : loading && mailboxes.length === 0 ? (
        <div className="p-6 space-y-3 animate-pulse" aria-busy="true">
          <div className="h-16 rounded-lg bg-slate-100 dark:bg-slate-800" />
          <div className="h-16 rounded-lg bg-slate-100 dark:bg-slate-800" />
        </div>
      ) : mailboxes.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <Mail className="h-8 w-8 mx-auto text-slate-300 dark:text-slate-700" />
          <h3 className="mt-3 font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            No SMTP mailboxes configured
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            Add your SMTP account to verify host resolution, TLS negotiation, and authentication before future sending phases.
          </p>
          <div className="mt-5">
            <button
              type="button"
              onClick={openCreateModal}
              disabled={!encryptionValid}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span>Add first mailbox</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-slate-200 dark:divide-slate-800 mt-2">
          {mailboxes.map((mailbox) => {
            const isTesting = testingId === mailbox.id;
            const isToggling = togglingId === mailbox.id;

            return (
              <div
                key={mailbox.id}
                className={`px-6 py-4 space-y-3 ${
                  mailbox.archived ? 'opacity-65 bg-slate-50/60 dark:bg-slate-950/40' : ''
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  {/* Primary Info */}
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-medium text-sm text-slate-900 dark:text-slate-100 truncate">
                        {mailbox.name}
                      </span>
                      <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                        ·
                      </span>
                      <span className="text-xs text-slate-600 dark:text-slate-300 truncate">
                        {mailbox.senderName} &lt;{mailbox.senderEmail}&gt;
                      </span>
                      {mailbox.archived && (
                        <>
                          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            Archived
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono">
                        {mailbox.smtpHost}:{mailbox.smtpPort}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {mailbox.securityMode === 'implicit_tls'
                          ? 'Implicit TLS'
                          : 'STARTTLS'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>User: {mailbox.smtpUsername}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        Limit: {mailbox.dailyLimit}/day
                      </span>
                    </div>

                    {/* Verification Status Row */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs pt-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        {mailbox.verificationStatus === 'verified' ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span className="text-emerald-700 dark:text-emerald-400">
                              Verified
                            </span>
                          </>
                        ) : mailbox.verificationStatus === 'failed' ? (
                          <>
                            <AlertCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                            <span className="text-red-700 dark:text-red-400">
                              Verification failed
                            </span>
                          </>
                        ) : (
                          <>
                            <Clock className="h-3.5 w-3.5 text-slate-400" />
                            <span className="text-slate-600 dark:text-slate-400">
                              Untested
                            </span>
                          </>
                        )}
                      </span>
                      <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        Last tested: {formatDateTime(mailbox.lastTestedAt)}
                      </span>
                      {!mailbox.archived && (
                        <>
                          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                            ·
                          </span>
                          <span
                            className={
                              mailbox.enabled
                                ? 'text-slate-600 dark:text-slate-300'
                                : 'text-amber-700 dark:text-amber-400'
                            }
                          >
                            {mailbox.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {mailbox.archived ? (
                      <button
                        type="button"
                        onClick={() => void handleRestoreMailbox(mailbox)}
                        disabled={isToggling}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors min-h-[36px] whitespace-nowrap"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Restore</span>
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleTestConnection(mailbox)}
                          disabled={isTesting || !encryptionValid}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors min-h-[36px] whitespace-nowrap"
                        >
                          {isTesting ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Wifi className="h-3.5 w-3.5" />
                          )}
                          <span>{isTesting ? 'Testing...' : 'Test connection'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleToggleEnabled(mailbox)}
                          disabled={isToggling}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors min-h-[36px] whitespace-nowrap"
                        >
                          <span>{mailbox.enabled ? 'Disable' : 'Enable'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => openEditModal(mailbox)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[36px] whitespace-nowrap"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setConfirmMailbox(mailbox);
                            setConfirmPermanent(false);
                          }}
                          aria-label={`Archive ${mailbox.name}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors min-h-[36px] whitespace-nowrap"
                        >
                          <Archive className="h-3.5 w-3.5" />
                          <span>Archive</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Sanitized Last Error */}
                {mailbox.lastVerificationError && (
                  <p className="text-xs text-red-700 dark:text-red-300 bg-red-50/70 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">
                    {mailbox.lastVerificationError}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Mailbox Modal */}
      <MailboxFormModal
        isOpen={formOpen}
        mode={formMode}
        initialMailbox={editingMailbox}
        encryptionValid={encryptionValid}
        onClose={() => setFormOpen(false)}
        onSubmit={handleFormSubmit}
      />

      {/* Archive / Delete Confirmation Modal */}
      {confirmMailbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mailbox-archive-title"
        >
          <div
            className="fixed inset-0"
            onClick={() => {
              if (!archiving) setConfirmMailbox(null);
            }}
            aria-hidden="true"
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3
                  id="mailbox-archive-title"
                  className="font-display text-base font-semibold text-slate-900 dark:text-slate-100"
                >
                  Archive mailbox &ldquo;{confirmMailbox.name}&rdquo;?
                </h3>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Archiving disables this mailbox while preserving all linked email history and sending usage records.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmMailbox(null)}
                disabled={archiving}
                aria-label="Close confirmation"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {confirmMailbox.referencedByHistory ? (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-3.5 py-2.5 text-xs text-slate-600 dark:text-slate-300">
                This mailbox is referenced by existing email or campaign history and will be archived rather than deleted.
              </div>
            ) : (
              <label className="flex items-start gap-2.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmPermanent}
                  onChange={(e) => setConfirmPermanent(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-700 text-red-600 focus:ring-red-600"
                />
                <span>
                  Permanently delete instead of archiving (allowed because no email history references this mailbox)
                </span>
              </label>
            )}

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setConfirmMailbox(null)}
                disabled={archiving}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 min-h-[40px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmArchiveOrDelete()}
                disabled={archiving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white min-h-[40px]"
              >
                {confirmPermanent && !confirmMailbox.referencedByHistory ? (
                  <Trash2 className="h-4 w-4" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                <span>
                  {archiving
                    ? 'Processing...'
                    : confirmPermanent && !confirmMailbox.referencedByHistory
                      ? 'Delete permanently'
                      : 'Archive mailbox'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
