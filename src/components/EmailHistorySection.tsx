import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  HelpCircle,
  Mail,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import type {
  EmailHistoryItem,
  EmailSendingStatus,
  EmailsListResponse,
  MailboxItem,
  MailboxesListResponse,
} from '../types/outreach';
import type { EmailComposerDraft } from './EmailComposer';

interface EmailHistorySectionProps {
  refreshSignal: number;
  onOpenComposer: (draft?: EmailComposerDraft) => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
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

function StatusDisplay({ status }: { status: EmailSendingStatus }) {
  switch (status) {
    case 'sent':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>Sent</span>
        </span>
      );
    case 'failed':
    case 'bounced':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400 whitespace-nowrap">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{status === 'bounced' ? 'Bounced' : 'Failed'}</span>
        </span>
      );
    case 'unknown':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 whitespace-nowrap">
          <HelpCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Unknown</span>
        </span>
      );
    case 'sending':
    case 'queued':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-400 whitespace-nowrap">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span>{status === 'sending' ? 'Sending' : 'Queued'}</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 whitespace-nowrap">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span className="capitalize">{status}</span>
        </span>
      );
  }
}

export function EmailHistorySection({
  refreshSignal,
  onOpenComposer,
}: EmailHistorySectionProps) {
  const [emails, setEmails] = useState<EmailHistoryItem[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxItem[]>([]);
  const [totalEmails, setTotalEmails] = useState(0);
  const [totalFiltered, setTotalFiltered] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [statusFilter, setStatusFilter] = useState('all');
  const [mailboxFilter, setMailboxFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedEmail, setSelectedEmail] = useState<EmailHistoryItem | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    apiFetch<MailboxesListResponse>('/api/mailboxes?includeArchived=true')
      .then((res) => {
        if (active) setMailboxes(res.mailboxes);
      })
      .catch(() => {
        // Optional filter dropdown; ignore transient fetch failure here
      });
    return () => {
      active = false;
    };
  }, [refreshSignal]);

  const loadEmails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '25',
        status: statusFilter,
      });
      if (mailboxFilter) params.set('mailboxId', mailboxFilter);
      if (debouncedSearch) params.set('search', debouncedSearch);

      const res = await apiFetch<EmailsListResponse>(`/api/emails?${params.toString()}`);
      setEmails(res.emails);
      setTotalEmails(res.totalEmails);
      setTotalFiltered(res.pagination.totalFiltered);
      setTotalPages(res.pagination.totalPages);
      if (res.pagination.page !== page) {
        setPage(res.pagination.page);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to load email sending history.'
      );
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, mailboxFilter, debouncedSearch]);

  useEffect(() => {
    void loadEmails();
  }, [loadEmails, refreshSignal]);

  async function inspectEmail(item: EmailHistoryItem) {
    setSelectedEmail(item);
    setLoadingDetail(true);
    try {
      const res = await apiFetch<{ email: EmailHistoryItem }>(`/api/emails/${item.id}`);
      setSelectedEmail(res.email);
    } catch {
      // Keep list snapshot if detail refresh fails
    } finally {
      setLoadingDetail(false);
    }
  }

  const hasActiveFilters =
    statusFilter !== 'all' || mailboxFilter !== '' || debouncedSearch !== '';

  return (
    <div className="space-y-5">
      {/* Header & Primary Action */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
            Outbox &amp; sending logs
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Track outbound SMTP delivery status, server diagnostics, and daily quota usage
            <span aria-hidden="true"> · </span>
            <span className="font-mono tabular-nums">{totalEmails.toLocaleString()}</span> total recorded
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadEmails()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 min-h-[36px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenComposer()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-xs font-medium transition-colors min-h-[36px] whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Compose email</span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col md:flex-row gap-3">
        <div className="relative flex-1 min-w-0">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by recipient email or subject..."
            aria-label="Search email logs"
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <div className="flex flex-col sm:flex-row gap-3 shrink-0">
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by delivery status"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            <option value="all">All statuses</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="unknown">Unknown</option>
            <option value="sending">Sending</option>
            <option value="queued">Queued</option>
          </select>

          <select
            value={mailboxFilter}
            onChange={(e) => {
              setMailboxFilter(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by mailbox"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 max-w-full sm:max-w-[220px]"
          >
            <option value="">All mailboxes</option>
            {mailboxes.map((mb) => (
              <option key={mb.id} value={mb.id}>
                {mb.name}
                {mb.archived ? ' (Archived)' : ''}
              </option>
            ))}
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                setDebouncedSearch('');
                setStatusFilter('all');
                setMailboxFilter('');
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-sm text-red-700 dark:text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadEmails()}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 self-start sm:self-auto"
          >
            Retry
          </button>
        </div>
      )}

      {/* Email History Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        {loading && emails.length === 0 ? (
          <div className="p-6 space-y-3" aria-busy="true">
            {Array.from({ length: 5 }).map((_, idx) => (
              <div
                key={idx}
                className="h-12 rounded-lg bg-slate-100 dark:bg-slate-800/70 animate-pulse"
              />
            ))}
          </div>
        ) : emails.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <Mail className="h-8 w-8 mx-auto text-slate-300 dark:text-slate-700" />
            <h3 className="mt-3 font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              {hasActiveFilters ? 'No matching email logs' : 'No emails sent yet'}
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              {hasActiveFilters
                ? 'Try adjusting your search query or status filters.'
                : 'Send your first outbound email from a verified SMTP mailbox to inspect delivery logs here.'}
            </p>
            {!hasActiveFilters && (
              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => onOpenComposer()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-xs font-medium transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Compose email</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-5">Status</th>
                    <th className="py-3 px-4">Recipient</th>
                    <th className="py-3 px-4">Subject</th>
                    <th className="py-3 px-4">Mailbox</th>
                    <th className="py-3 px-5 text-right">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                  {emails.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() => void inspectEmail(item)}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                    >
                      <td className="py-3.5 px-5 align-top">
                        <StatusDisplay status={item.status} />
                      </td>
                      <td className="py-3.5 px-4 align-top">
                        <div className="font-mono text-xs text-slate-900 dark:text-slate-100 break-all">
                          {item.toEmail}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[220px]">
                          From {item.fromEmail}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 align-top max-w-xs">
                        <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {item.subject}
                        </div>
                        {item.error && (
                          <div className="mt-0.5 text-xs text-red-600 dark:text-red-400 truncate">
                            {item.error}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 align-top text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {item.mailboxName}
                      </td>
                      <td className="py-3.5 px-5 align-top text-right font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                        {formatDateTime(item.sentAt || item.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Footer */}
            <div className="flex items-center justify-between gap-4 px-5 py-3 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
              <div className="font-mono tabular-nums">
                Page {page} of {totalPages}
                <span aria-hidden="true"> · </span>
                {totalFiltered.toLocaleString()} result{totalFiltered === 1 ? '' : 's'}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span>Prev</span>
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
                >
                  <span>Next</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Email Metadata Detail Modal */}
      {selectedEmail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-[1px] p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Email delivery metadata"
        >
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <StatusDisplay status={selectedEmail.status} />
                  {loadingDetail && (
                    <RefreshCw className="h-3 w-3 animate-spin text-slate-400" />
                  )}
                </div>
                <h3 className="mt-1 font-display text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {selectedEmail.subject}
                </h3>
              </div>

              <button
                type="button"
                onClick={() => setSelectedEmail(null)}
                aria-label="Close email details"
                className="inline-flex items-center justify-center rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              {selectedEmail.error && (
                <div
                  className={`rounded-lg border p-3.5 ${
                    selectedEmail.status === 'unknown'
                      ? 'border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200'
                      : 'border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-200'
                  }`}
                >
                  <div className="font-semibold">
                    {selectedEmail.errorCode || 'Delivery issue'}
                  </div>
                  <div className="mt-1">{selectedEmail.error}</div>
                </div>
              )}

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 border-t border-slate-200 dark:border-slate-800 pt-4">
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Recipient</dt>
                  <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100 break-all">
                    {selectedEmail.toEmail}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Sender mailbox</dt>
                  <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                    {selectedEmail.mailboxName}
                    <span className="block font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {selectedEmail.fromEmail}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Reply-To</dt>
                  <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100 break-all">
                    {selectedEmail.replyTo || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Content parts</dt>
                  <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                    {[
                      selectedEmail.hasText ? 'Plain text' : null,
                      selectedEmail.hasHtml ? 'HTML' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Metadata only'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Created (UTC/local)</dt>
                  <dd className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {formatDateTime(selectedEmail.createdAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Sent timestamp</dt>
                  <dd className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {formatDateTime(selectedEmail.sentAt)}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-slate-500 dark:text-slate-400">SMTP Message-ID</dt>
                  <dd className="mt-0.5 font-mono text-[11px] text-slate-900 dark:text-slate-100 break-all">
                    {selectedEmail.messageId || '—'}
                  </dd>
                </div>
                {selectedEmail.attemptMeta && (
                  <>
                    <div>
                      <dt className="text-slate-500 dark:text-slate-400">Duration</dt>
                      <dd className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        {selectedEmail.attemptMeta.durationMs !== null
                          ? `${selectedEmail.attemptMeta.durationMs} ms`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 dark:text-slate-400">SMTP response</dt>
                      <dd className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        {selectedEmail.attemptMeta.smtpResponseCode ?? '—'}
                        {selectedEmail.attemptMeta.acceptedCount !== null
                          ? ` · ${selectedEmail.attemptMeta.acceptedCount} accepted`
                          : ''}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
              {selectedEmail.status === 'failed' ? (
                <button
                  type="button"
                  onClick={() => {
                    const draft: EmailComposerDraft = {
                      mailboxId: selectedEmail.mailboxId,
                      to: selectedEmail.toEmail,
                      replyTo: selectedEmail.replyTo ?? undefined,
                      subject: selectedEmail.subject,
                    };
                    setSelectedEmail(null);
                    onOpenComposer(draft);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Reuse in composer</span>
                </button>
              ) : (
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {selectedEmail.status === 'unknown'
                    ? 'Ambiguous delivery state — verify before resending.'
                    : 'Message bodies are omitted from sending logs.'}
                </span>
              )}

              <button
                type="button"
                onClick={() => setSelectedEmail(null)}
                className="rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-4 py-1.5 text-xs font-medium hover:opacity-90"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
