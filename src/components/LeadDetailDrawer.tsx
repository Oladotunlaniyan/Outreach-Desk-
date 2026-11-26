import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Building2,
  Calendar,
  Check,
  Edit3,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  MessageSquare,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Reply } from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import {
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  type LeadDetailResponse,
  type LeadEmailHistoryItem,
  type LeadItem,
  type LeadNoteItem,
  type LeadStatus,
} from '../types/outreach';

interface LeadDetailDrawerProps {
  leadId: string | null;
  onClose: () => void;
  onEditLead: (lead: LeadItem) => void;
  onDraftEmail?: (lead: LeadItem) => void;
  onFollowUpEmail?: (lead: LeadItem, lastSentEmail: LeadEmailHistoryItem) => void;
  onLeadUpdated: (lead: LeadItem) => void;
  onLeadDeleted: (leadId: string) => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function LeadDetailDrawer({
  leadId,
  onClose,
  onEditLead,
  onDraftEmail,
  onFollowUpEmail,
  onLeadUpdated,
  onLeadDeleted,
}: LeadDetailDrawerProps) {
  const [lead, setLead] = useState<LeadItem | null>(null);
  const [emailHistory, setEmailHistory] = useState<LeadEmailHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletingLead, setDeletingLead] = useState(false);

  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [savingNoteEdit, setSavingNoteEdit] = useState(false);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);

  const fetchDetail = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setConfirmingDelete(false);
    setEditingNoteId(null);
    setNoteError(null);

    try {
      const res = await apiFetch<LeadDetailResponse>(`/api/leads/${id}`);
      setLead(res.lead);
      setEmailHistory(res.emailHistory);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load lead details.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!leadId) {
      setLead(null);
      setEmailHistory([]);
      return;
    }
    void fetchDetail(leadId);
  }, [leadId, fetchDetail]);

  useEffect(() => {
    if (!leadId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [leadId, onClose]);

  if (!leadId) return null;

  async function handleStatusChange(nextStatus: LeadStatus) {
    if (!lead || updatingStatus || nextStatus === lead.status) return;
    setUpdatingStatus(true);
    setError(null);
    try {
      const res = await apiFetch<{ lead: LeadItem }>(`/api/leads/${lead.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setLead(res.lead);
      onLeadUpdated(res.lead);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update status.');
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleDeleteLead() {
    if (!lead || deletingLead) return;
    setDeletingLead(true);
    setError(null);
    try {
      await apiFetch(`/api/leads/${lead.id}`, { method: 'DELETE' });
      onLeadDeleted(lead.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete lead.');
      setDeletingLead(false);
    }
  }

  async function handleAddNote(e: FormEvent) {
    e.preventDefault();
    if (!lead || !newNote.trim() || addingNote) return;
    setAddingNote(true);
    setNoteError(null);
    try {
      const res = await apiFetch<{ lead: LeadItem }>(`/api/leads/${lead.id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ content: newNote.trim() }),
      });
      setLead(res.lead);
      setNewNote('');
      onLeadUpdated(res.lead);
    } catch (err) {
      setNoteError(err instanceof ApiError ? err.message : 'Failed to add note.');
    } finally {
      setAddingNote(false);
    }
  }

  function startEditNote(note: LeadNoteItem) {
    setEditingNoteId(note.id);
    setEditingNoteContent(note.content);
    setNoteError(null);
  }

  async function handleSaveNoteEdit(noteId: string) {
    if (!lead || !editingNoteContent.trim() || savingNoteEdit) return;
    setSavingNoteEdit(true);
    setNoteError(null);
    try {
      const res = await apiFetch<{ lead: LeadItem }>(
        `/api/leads/${lead.id}/notes/${noteId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ content: editingNoteContent.trim() }),
        }
      );
      setLead(res.lead);
      setEditingNoteId(null);
      onLeadUpdated(res.lead);
    } catch (err) {
      setNoteError(err instanceof ApiError ? err.message : 'Failed to update note.');
    } finally {
      setSavingNoteEdit(false);
    }
  }

  async function handleDeleteNote(noteId: string) {
    if (!lead || deletingNoteId) return;
    setDeletingNoteId(noteId);
    setNoteError(null);
    try {
      const res = await apiFetch<{ lead: LeadItem }>(
        `/api/leads/${lead.id}/notes/${noteId}`,
        { method: 'DELETE' }
      );
      setLead(res.lead);
      if (editingNoteId === noteId) {
        setEditingNoteId(null);
      }
      onLeadUpdated(res.lead);
    } catch (err) {
      setNoteError(err instanceof ApiError ? err.message : 'Failed to delete note.');
    } finally {
      setDeletingNoteId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/45 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="Lead details"
    >
      <div className="flex-1" onClick={onClose} aria-hidden="true" />

      <aside className="relative w-full max-w-xl bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 h-full flex flex-col overflow-hidden">
        {/* Drawer Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
              {lead ? lead.fullName : 'Lead details'}
            </h2>
            {lead && (
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {lead.email}
                <span aria-hidden="true"> · </span>
                {LEAD_SOURCE_LABELS[lead.source]}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {lead &&
              onFollowUpEmail &&
              (() => {
                const lastSent = emailHistory.find(
                  (msg) => String(msg.status).toLowerCase() === 'sent'
                );
                if (!lastSent) return null;
                return (
                  <button
                    type="button"
                    onClick={() => onFollowUpEmail(lead, lastSent)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white transition-colors min-h-[36px] whitespace-nowrap"
                  >
                    <Reply className="h-3.5 w-3.5" />
                    <span>Follow up</span>
                  </button>
                );
              })()}
            {lead && onDraftEmail && (
              <button
                type="button"
                onClick={() => onDraftEmail(lead)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-medium text-white dark:text-slate-900 hover:opacity-90 transition-opacity min-h-[36px] whitespace-nowrap"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Draft with AI</span>
              </button>
            )}
            {lead && (
              <button
                type="button"
                onClick={() => onEditLead(lead)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[36px] whitespace-nowrap"
              >
                <Edit3 className="h-3.5 w-3.5" />
                <span>Edit</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close drawer"
              className="inline-flex items-center justify-center rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors min-h-[36px] min-w-[36px]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {loading ? (
            <div className="space-y-4 animate-pulse" aria-busy="true">
              <div className="h-24 rounded-lg bg-slate-100 dark:bg-slate-800" />
              <div className="h-32 rounded-lg bg-slate-100 dark:bg-slate-800" />
              <div className="h-36 rounded-lg bg-slate-100 dark:bg-slate-800" />
            </div>
          ) : error && !lead ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 p-4 text-sm text-red-700 dark:text-red-300"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            </div>
          ) : lead ? (
            <>
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {/* Pipeline Status & Key Dates */}
              <section className="space-y-3 pb-5 border-b border-slate-200 dark:border-slate-800">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <label
                      htmlFor="drawer-pipeline-status"
                      className="block text-xs font-medium text-slate-500 dark:text-slate-400"
                    >
                      Pipeline status
                    </label>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Changes persist immediately
                    </p>
                  </div>
                  <select
                    id="drawer-pipeline-status"
                    value={lead.status}
                    disabled={updatingStatus}
                    onChange={(e) => void handleStatusChange(e.target.value as LeadStatus)}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-medium text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:opacity-50"
                  >
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 text-xs">
                  <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
                    <Calendar className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span>Added:</span>
                    <span className="font-mono text-slate-900 dark:text-slate-100 tabular-nums">
                      {formatDateTime(lead.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
                    <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span>Last contacted:</span>
                    <span className="font-mono text-slate-900 dark:text-slate-100 tabular-nums">
                      {formatDateTime(lead.lastContactedAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
                    <span>Emails sent:</span>
                    <span className="font-mono text-slate-900 dark:text-slate-100 tabular-nums">
                      {(lead.emailCount ?? 0).toLocaleString()}
                    </span>
                  </div>
                  {(lead.optedOut || lead.bounced) && (
                    <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-medium">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        {lead.bounced
                          ? `Bounced${lead.bounceReason ? `: ${lead.bounceReason}` : ''}`
                          : 'Opted out (suppressed)'}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              {/* Contact & Company Information */}
              <section className="space-y-3 pb-5 border-b border-slate-200 dark:border-slate-800">
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Contact & company
                </h3>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt className="text-xs text-slate-500 dark:text-slate-400">Email</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100 break-all">
                      <a
                        href={`mailto:${lead.email}`}
                        className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
                      >
                        {lead.email}
                      </a>
                    </dd>
                  </div>

                  <div>
                    <dt className="text-xs text-slate-500 dark:text-slate-400">Job title</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {lead.role || '—'}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-xs text-slate-500 dark:text-slate-400">Company</dt>
                    <dd className="mt-0.5 flex items-center gap-1.5 text-slate-900 dark:text-slate-100">
                      <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span>{lead.company || '—'}</span>
                    </dd>
                  </div>

                  <div>
                    <dt className="text-xs text-slate-500 dark:text-slate-400">Location</dt>
                    <dd className="mt-0.5 flex items-center gap-1.5 text-slate-900 dark:text-slate-100">
                      <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span>{lead.location || '—'}</span>
                    </dd>
                  </div>

                  <div>
                    <dt className="text-xs text-slate-500 dark:text-slate-400">Website</dt>
                    <dd className="mt-0.5">
                      {lead.website ? (
                        <a
                          href={lead.website}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline break-all"
                        >
                          <Globe className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate max-w-[210px]">{lead.website}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">—</span>
                      )}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-xs text-slate-500 dark:text-slate-400">LinkedIn</dt>
                    <dd className="mt-0.5">
                      {lead.linkedinUrl ? (
                        <a
                          href={lead.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline break-all"
                        >
                          <span className="truncate max-w-[210px]">Profile link</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">—</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </section>

              {/* Notes Section */}
              <section className="space-y-4 pb-5 border-b border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Notes ({lead.notes.length})
                  </h3>
                </div>

                {noteError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300"
                  >
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{noteError}</span>
                  </div>
                )}

                <form onSubmit={handleAddNote} className="space-y-2">
                  <textarea
                    rows={2}
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder="Add a note about this lead..."
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={addingNote || !newNote.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 disabled:opacity-50 px-3.5 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity min-h-[36px]"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>{addingNote ? 'Adding...' : 'Add note'}</span>
                    </button>
                  </div>
                </form>

                {lead.notes.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400 py-2">
                    No notes recorded yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border-t border-slate-200 dark:border-slate-800">
                    {lead.notes.map((note) => {
                      const isEditing = editingNoteId === note.id;
                      const isDeleting = deletingNoteId === note.id;
                      const wasEdited =
                        note.updatedAt &&
                        new Date(note.updatedAt).getTime() - new Date(note.createdAt).getTime() >
                          1000;

                      return (
                        <div key={note.id} className="py-3 space-y-2">
                          {isEditing ? (
                            <div className="space-y-2">
                              <textarea
                                rows={3}
                                value={editingNoteContent}
                                onChange={(e) => setEditingNoteContent(e.target.value)}
                                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                              />
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingNoteId(null)}
                                  disabled={savingNoteEdit}
                                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleSaveNoteEdit(note.id)}
                                  disabled={savingNoteEdit || !editingNoteContent.trim()}
                                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3 py-1 text-xs font-medium text-white"
                                >
                                  <Check className="h-3 w-3" />
                                  <span>{savingNoteEdit ? 'Saving...' : 'Save'}</span>
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
                                {note.content}
                              </p>
                              <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                                <span className="font-mono tabular-nums">
                                  {formatDateTime(note.createdAt)}
                                  {wasEdited ? ' · edited' : ''}
                                </span>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => startEditNote(note)}
                                    className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
                                  >
                                    Edit
                                  </button>
                                  <span aria-hidden="true">·</span>
                                  <button
                                    type="button"
                                    disabled={isDeleting}
                                    onClick={() => void handleDeleteNote(note.id)}
                                    className="text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                                  >
                                    {isDeleting ? 'Deleting...' : 'Delete'}
                                  </button>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Email History Section */}
              <section className="space-y-3 pb-5 border-b border-slate-200 dark:border-slate-800">
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Email history ({emailHistory.length})
                </h3>
                {emailHistory.length === 0 ? (
                  <div className="py-4 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-slate-400 shrink-0" />
                    <span>No email messages recorded for this lead yet.</span>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border-t border-slate-200 dark:border-slate-800">
                    {emailHistory.map((msg) => (
                      <div key={msg.id} className="py-3 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                            {msg.subject}
                          </span>
                          <span className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap shrink-0">
                            {msg.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                            <span aria-hidden="true"> · </span>
                            {msg.status}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          {msg.fromEmail} → {msg.toEmail}
                          <span aria-hidden="true"> · </span>
                          {formatDateTime(msg.sentAt || msg.createdAt)}
                        </div>
                        {msg.bodyText && (
                          <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-3 whitespace-pre-wrap pt-1">
                            {msg.bodyText}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Lead Activity Timeline */}
              {lead.history && lead.history.length > 0 && (
                <section className="space-y-3 pb-5 border-b border-slate-200 dark:border-slate-800">
                  <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Activity timeline ({lead.history.length})
                  </h3>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border-t border-slate-200 dark:border-slate-800">
                    {lead.history.map((entry, idx) => (
                      <div
                        key={entry.id || `${entry.at}-${idx}`}
                        className="py-2.5 flex items-start justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {entry.status}
                          </div>
                          {entry.note && (
                            <div className="text-slate-600 dark:text-slate-400 break-words">
                              {entry.note}
                            </div>
                          )}
                        </div>
                        <span className="font-mono text-[11px] text-slate-400 tabular-nums shrink-0">
                          {formatDateTime(entry.at)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Danger Zone: Delete Lead */}
              <section className="pt-1">
                {!confirmingDelete ? (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:underline"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Delete lead</span>
                  </button>
                ) : (
                  <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 p-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <p className="text-xs text-red-800 dark:text-red-200">
                      Permanently delete <strong>{lead.fullName}</strong> and their notes?
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(false)}
                        disabled={deletingLead}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteLead()}
                        disabled={deletingLead}
                        className="rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-white"
                      >
                        {deletingLead ? 'Deleting...' : 'Confirm delete'}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
