import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownUp,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Kanban,
  LayoutList,
  Plus,
  RefreshCw,
  Search,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { EmailComposer, type EmailComposerDraft } from '../components/EmailComposer';
import { LeadDetailDrawer } from '../components/LeadDetailDrawer';
import { LeadFormModal } from '../components/LeadFormModal';
import { LeadKanbanBoard } from '../components/LeadKanbanBoard';
import { ApiError, apiFetch } from '../lib/api';
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  type LeadBoardColumn,
  type LeadBoardResponse,
  type LeadFormPayload,
  type LeadItem,
  type LeadSource,
  type LeadStatus,
  type LeadsListResponse,
} from '../types/outreach';

type DateRangeFilter = 'all' | 'today' | '7d' | '30d' | '90d';
type SortByField = 'createdAt' | 'fullName' | 'lastContactedAt';
type SortOrder = 'asc' | 'desc';
export type LeadsViewMode = 'list' | 'board';

interface LeadsPageProps {
  refreshSignal: number;
  viewMode: LeadsViewMode;
  onChangeViewMode: (mode: LeadsViewMode) => void;
  onNavigateToImport: () => void;
  onNavigateToSettings?: () => void;
  onLeadMutated?: () => void;
}

const BOARD_COLUMN_LIMIT = 15;

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function emptyBoardColumns(): LeadBoardColumn[] {
  return LEAD_STATUSES.map((status) => ({
    status,
    totalInStatus: 0,
    filteredTotal: 0,
    leads: [],
    hasMore: false,
  }));
}

export function LeadsPage({
  refreshSignal,
  viewMode,
  onChangeViewMode,
  onNavigateToImport,
  onNavigateToSettings,
  onLeadMutated,
}: LeadsPageProps) {
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [totalFiltered, setTotalFiltered] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [boardColumns, setBoardColumns] = useState<LeadBoardColumn[]>(emptyBoardColumns);
  const [boardTotalFiltered, setBoardTotalFiltered] = useState(0);
  const [boardLoading, setBoardLoading] = useState(false);
  const [loadingMoreStatuses, setLoadingMoreStatuses] = useState<Set<LeadStatus>>(new Set());
  const [pendingMoveIds, setPendingMoveIds] = useState<Set<string>>(new Set());
  const pendingMoveIdsRef = useRef<Set<string>>(new Set());

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | LeadStatus>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | LeadSource>('all');
  const [dateRange, setDateRange] = useState<DateRangeFilter>('all');
  const [sortBy, setSortBy] = useState<SortByField>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [editingLead, setEditingLead] = useState<LeadItem | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState<EmailComposerDraft | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const loadLeads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(pageSize),
        sortBy,
        sortOrder,
        status: statusFilter,
        source: sourceFilter,
        dateRange,
      });
      if (debouncedSearch) {
        params.set('search', debouncedSearch);
      }

      const res = await apiFetch<LeadsListResponse>(`/api/leads?${params.toString()}`);
      setLeads(res.leads);
      setTotalLeads(res.totalLeads);
      setTotalFiltered(res.pagination.totalFiltered);
      setTotalPages(res.pagination.totalPages);
      if (res.pagination.page !== page) {
        setPage(res.pagination.page);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load leads.');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sortBy, sortOrder, statusFilter, sourceFilter, dateRange, debouncedSearch]);

  const loadBoard = useCallback(async () => {
    setBoardLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limitPerColumn: String(BOARD_COLUMN_LIMIT),
        sortBy,
        sortOrder,
        source: sourceFilter,
        dateRange,
      });
      if (debouncedSearch) {
        params.set('search', debouncedSearch);
      }

      const res = await apiFetch<LeadBoardResponse>(`/api/leads/board?${params.toString()}`);
      setBoardColumns(res.columns);
      setTotalLeads(res.totalLeads);
      setBoardTotalFiltered(res.totalFiltered);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load pipeline board.');
    } finally {
      setBoardLoading(false);
    }
  }, [sortBy, sortOrder, sourceFilter, dateRange, debouncedSearch]);

  useEffect(() => {
    if (viewMode === 'list') {
      void loadLeads();
    } else {
      void loadBoard();
    }
  }, [viewMode, loadLeads, loadBoard, refreshSignal]);

  const hasActiveBoardFilters =
    Boolean(debouncedSearch) || sourceFilter !== 'all' || dateRange !== 'all';

  const hasActiveListFilters = hasActiveBoardFilters || statusFilter !== 'all';
  const hasActiveFilters = viewMode === 'board' ? hasActiveBoardFilters : hasActiveListFilters;

  function resetFilters() {
    setSearchInput('');
    setDebouncedSearch('');
    setStatusFilter('all');
    setSourceFilter('all');
    setDateRange('all');
    setPage(1);
  }

  function openCreateModal() {
    setFormMode('create');
    setEditingLead(null);
    setFormOpen(true);
  }

  function openEditModal(lead: LeadItem) {
    setFormMode('edit');
    setEditingLead(lead);
    setFormOpen(true);
  }

  function applyLeadUpdateAcrossViews(updated: LeadItem) {
    setLeads((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));

    setBoardColumns((prevCols) => {
      let previousStatus: LeadStatus | null = null;
      for (const col of prevCols) {
        if (col.leads.some((l) => l.id === updated.id)) {
          previousStatus = col.status;
          break;
        }
      }

      if (!previousStatus || previousStatus === updated.status) {
        return prevCols.map((col) => ({
          ...col,
          leads: col.leads.map((l) => (l.id === updated.id ? updated : l)),
        }));
      }

      return prevCols.map((col) => {
        if (col.status === previousStatus) {
          return {
            ...col,
            totalInStatus: Math.max(0, col.totalInStatus - 1),
            filteredTotal: Math.max(0, col.filteredTotal - 1),
            leads: col.leads.filter((l) => l.id !== updated.id),
          };
        }
        if (col.status === updated.status) {
          const withoutDup = col.leads.filter((l) => l.id !== updated.id);
          return {
            ...col,
            totalInStatus: col.totalInStatus + 1,
            filteredTotal: col.filteredTotal + 1,
            leads: [updated, ...withoutDup],
          };
        }
        return col;
      });
    });
  }

  async function handleFormSubmit(payload: LeadFormPayload) {
    if (formMode === 'create') {
      await apiFetch<{ lead: LeadItem }>('/api/leads', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setFeedback(`Added ${payload.fullName} to leads.`);
      setPage(1);
      onLeadMutated?.();
      if (viewMode === 'list') {
        await loadLeads();
      } else {
        await loadBoard();
      }
    } else if (editingLead) {
      const res = await apiFetch<{ lead: LeadItem }>(`/api/leads/${editingLead.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setFeedback(`Updated ${res.lead.fullName}.`);
      applyLeadUpdateAcrossViews(res.lead);
      onLeadMutated?.();
      if (selectedLeadId === res.lead.id) {
        setSelectedLeadId(null);
        window.setTimeout(() => setSelectedLeadId(res.lead.id), 0);
      }
    }
  }

  async function handleInlineStatusChange(leadId: string, nextStatus: LeadStatus) {
    setUpdatingStatusId(leadId);
    setError(null);
    try {
      const res = await apiFetch<{ lead: LeadItem }>(`/api/leads/${leadId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      applyLeadUpdateAcrossViews(res.lead);
      setFeedback(`Updated status for ${res.lead.fullName} to ${nextStatus}.`);
      onLeadMutated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update lead status.');
    } finally {
      setUpdatingStatusId(null);
    }
  }

  async function handleBoardMoveLead(leadId: string, targetStatus: LeadStatus) {
    if (pendingMoveIdsRef.current.has(leadId)) return;

    let movingLead: LeadItem | null = null;
    let sourceStatus: LeadStatus | null = null;
    for (const col of boardColumns) {
      const found = col.leads.find((l) => l.id === leadId);
      if (found) {
        movingLead = found;
        sourceStatus = col.status;
        break;
      }
    }

    if (!movingLead || !sourceStatus || sourceStatus === targetStatus) return;

    const snapshot = boardColumns.map((col) => ({
      ...col,
      leads: [...col.leads],
    }));

    pendingMoveIdsRef.current.add(leadId);
    setPendingMoveIds(new Set(pendingMoveIdsRef.current));
    setError(null);

    const optimisticLead: LeadItem = { ...movingLead, status: targetStatus };

    setBoardColumns((prevCols) =>
      prevCols.map((col) => {
        if (col.status === sourceStatus) {
          const nextLeads = col.leads.filter((l) => l.id !== leadId);
          const nextFiltered = Math.max(0, col.filteredTotal - 1);
          return {
            ...col,
            totalInStatus: Math.max(0, col.totalInStatus - 1),
            filteredTotal: nextFiltered,
            leads: nextLeads,
            hasMore: nextLeads.length < nextFiltered,
          };
        }
        if (col.status === targetStatus) {
          const nextLeads = [optimisticLead, ...col.leads.filter((l) => l.id !== leadId)];
          const nextFiltered = col.filteredTotal + 1;
          return {
            ...col,
            totalInStatus: col.totalInStatus + 1,
            filteredTotal: nextFiltered,
            leads: nextLeads,
            hasMore: nextLeads.length < nextFiltered,
          };
        }
        return col;
      })
    );

    try {
      const res = await apiFetch<{ lead: LeadItem }>(`/api/leads/${leadId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: targetStatus }),
      });

      setBoardColumns((prevCols) =>
        prevCols.map((col) =>
          col.status === targetStatus
            ? {
                ...col,
                leads: col.leads.map((l) => (l.id === leadId ? res.lead : l)),
              }
            : col
        )
      );
      setLeads((prev) => prev.map((item) => (item.id === leadId ? res.lead : item)));
      setFeedback(`Moved ${res.lead.fullName} to ${targetStatus}.`);
      onLeadMutated?.();
    } catch (err) {
      setBoardColumns(snapshot);
      setError(
        err instanceof ApiError
          ? `${err.message} Reverted card to ${sourceStatus}.`
          : `Failed to move lead. Reverted card to ${sourceStatus}.`
      );
    } finally {
      pendingMoveIdsRef.current.delete(leadId);
      setPendingMoveIds(new Set(pendingMoveIdsRef.current));
    }
  }

  async function handleLoadMoreColumn(status: LeadStatus) {
    const column = boardColumns.find((col) => col.status === status);
    if (!column || !column.hasMore || loadingMoreStatuses.has(status)) return;

    const nextPage = Math.floor(column.leads.length / BOARD_COLUMN_LIMIT) + 1;

    setLoadingMoreStatuses((prev) => new Set(prev).add(status));
    setError(null);

    try {
      const params = new URLSearchParams({
        status,
        page: String(nextPage),
        limit: String(BOARD_COLUMN_LIMIT),
        sortBy,
        sortOrder,
        source: sourceFilter,
        dateRange,
      });
      if (debouncedSearch) {
        params.set('search', debouncedSearch);
      }

      const res = await apiFetch<LeadsListResponse>(`/api/leads?${params.toString()}`);

      setBoardColumns((prevCols) =>
        prevCols.map((col) => {
          if (col.status !== status) return col;
          const existingIds = new Set(col.leads.map((l) => l.id));
          const appended = res.leads.filter((l) => !existingIds.has(l.id));
          const merged = [...col.leads, ...appended];
          return {
            ...col,
            filteredTotal: res.pagination.totalFiltered,
            leads: merged,
            hasMore: merged.length < res.pagination.totalFiltered && res.leads.length > 0,
          };
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to load more ${status} leads.`);
    } finally {
      setLoadingMoreStatuses((prev) => {
        const next = new Set(prev);
        next.delete(status);
        return next;
      });
    }
  }

  function handleLeadUpdatedFromDrawer(updated: LeadItem) {
    applyLeadUpdateAcrossViews(updated);
    onLeadMutated?.();
  }

  function handleLeadDeletedFromDrawer(deletedId: string) {
    setFeedback('Lead deleted.');
    setLeads((prev) => prev.filter((item) => item.id !== deletedId));
    setTotalLeads((prev) => Math.max(0, prev - 1));
    setTotalFiltered((prev) => Math.max(0, prev - 1));
    onLeadMutated?.();
    if (viewMode === 'list') {
      void loadLeads();
    } else {
      void loadBoard();
    }
  }

  const displayedMatchingCount = viewMode === 'board' ? boardTotalFiltered : totalFiltered;
  const startIndex = totalFiltered === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, totalFiltered);

  return (
    <div className="space-y-5">
      {/* Top Summary & Primary Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
              {viewMode === 'board' ? 'Pipeline board' : 'All leads'}
            </h2>
            <span className="font-mono text-sm text-slate-500 dark:text-slate-400 tabular-nums">
              {totalLeads.toLocaleString()} total
              {hasActiveFilters ? ` · ${displayedMatchingCount.toLocaleString()} matching` : ''}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {viewMode === 'board'
              ? 'Drag cards across stages or click any card to inspect notes and history'
              : 'Search, filter, inspect notes, and update pipeline stages'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* List / Board View Toggle */}
          <div
            role="group"
            aria-label="Leads view mode"
            className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800"
          >
            <button
              type="button"
              onClick={() => onChangeViewMode('list')}
              aria-pressed={viewMode === 'list'}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap min-h-[34px] ${
                viewMode === 'list'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <LayoutList className="h-3.5 w-3.5" />
              <span>List View</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeViewMode('board')}
              aria-pressed={viewMode === 'board'}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap min-h-[34px] ${
                viewMode === 'board'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <Kanban className="h-3.5 w-3.5" />
              <span>Board View</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onNavigateToImport}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[40px] whitespace-nowrap shrink-0"
          >
            <Upload className="h-4 w-4" />
            <span>Import CSV</span>
          </button>

          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium transition-colors min-h-[40px] whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>Add lead</span>
          </button>
        </div>
      </div>

      {/* Success Feedback */}
      {feedback && (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-white dark:bg-slate-900 px-4 py-3 flex items-center justify-between gap-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{feedback}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="Dismiss message"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search, Filter & Sort Toolbar */}
      <section
        aria-label="Lead filters"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
      >
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className={`${viewMode === 'board' ? 'md:col-span-6' : 'md:col-span-4'} relative`}>
            <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search name, email, or company..."
              aria-label="Search leads"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 pl-10 pr-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            />
          </div>

          {viewMode === 'list' && (
            <div className="md:col-span-2">
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as 'all' | LeadStatus);
                  setPage(1);
                }}
                aria-label="Filter by pipeline status"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              >
                <option value="all">All statuses</option>
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="md:col-span-2">
            <select
              value={sourceFilter}
              onChange={(e) => {
                setSourceFilter(e.target.value as 'all' | LeadSource);
                setPage(1);
              }}
              aria-label="Filter by lead source"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            >
              <option value="all">All sources</option>
              {LEAD_SOURCES.map((src) => (
                <option key={src} value={src}>
                  {LEAD_SOURCE_LABELS[src]}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <select
              value={dateRange}
              onChange={(e) => {
                setDateRange(e.target.value as DateRangeFilter);
                setPage(1);
              }}
              aria-label="Filter by date added"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            >
              <option value="all">Any date</option>
              <option value="today">Added today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </div>

          <div className="md:col-span-2 flex items-center gap-2">
            <select
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value as SortByField);
                setPage(1);
              }}
              aria-label="Sort leads by"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            >
              <option value="createdAt">Date added</option>
              <option value="fullName">Name</option>
              <option value="lastContactedAt">Last contacted</option>
            </select>
            <button
              type="button"
              onClick={() => {
                setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
                setPage(1);
              }}
              title={sortOrder === 'asc' ? 'Ascending order' : 'Descending order'}
              aria-label={`Sort order: ${sortOrder === 'asc' ? 'ascending' : 'descending'}`}
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[38px] min-w-[38px] shrink-0"
            >
              <ArrowDownUp className="h-4 w-4" />
            </button>
          </div>
        </div>

        {hasActiveFilters && (
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-1">
            <span>
              Matching {displayedMatchingCount.toLocaleString()} of {totalLeads.toLocaleString()}{' '}
              total leads
            </span>
            <button
              type="button"
              onClick={resetFilters}
              className="text-blue-600 dark:text-blue-400 font-medium hover:underline"
            >
              Clear filters
            </button>
          </div>
        )}
      </section>

      {/* Error State */}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Lead operation failed
              </h3>
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{error}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => (viewMode === 'list' ? void loadLeads() : void loadBoard())}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Board View */}
      {viewMode === 'board' ? (
        boardLoading && boardColumns.every((c) => c.leads.length === 0) ? (
          <div className="flex gap-4 overflow-x-auto pb-4" aria-busy="true">
            {LEAD_STATUSES.map((s) => (
              <div
                key={s}
                className="w-[85vw] sm:w-[300px] shrink-0 h-[420px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 animate-pulse space-y-3"
              >
                <div className="h-4 w-24 rounded bg-slate-200 dark:bg-slate-800" />
                <div className="h-24 rounded-lg bg-slate-100 dark:bg-slate-800/70" />
                <div className="h-24 rounded-lg bg-slate-100 dark:bg-slate-800/70" />
              </div>
            ))}
          </div>
        ) : (
          <LeadKanbanBoard
            columns={boardColumns}
            hasActiveFilters={hasActiveBoardFilters}
            pendingLeadIds={pendingMoveIds}
            loadingMoreStatuses={loadingMoreStatuses}
            onMoveLead={(leadId, targetStatus) => void handleBoardMoveLead(leadId, targetStatus)}
            onSelectLead={(leadId) => setSelectedLeadId(leadId)}
            onLoadMore={(status) => void handleLoadMoreColumn(status)}
          />
        )
      ) : (
        /* List View Container */
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          {loading && leads.length === 0 ? (
            <div className="divide-y divide-slate-200 dark:divide-slate-800" aria-busy="true">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div
                  key={idx}
                  className="px-6 py-4 flex items-center justify-between gap-4 animate-pulse"
                >
                  <div className="space-y-2 flex-1">
                    <div className="h-4 w-44 rounded bg-slate-200 dark:bg-slate-800" />
                    <div className="h-3 w-64 rounded bg-slate-100 dark:bg-slate-800/70" />
                  </div>
                  <div className="h-8 w-28 rounded bg-slate-100 dark:bg-slate-800" />
                </div>
              ))}
            </div>
          ) : leads.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <Users className="h-8 w-8 mx-auto text-slate-300 dark:text-slate-700" />
              <h3 className="mt-3 font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                {hasActiveFilters ? 'No matching leads' : 'No leads in your desk yet'}
              </h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                {hasActiveFilters
                  ? 'Try adjusting your search terms or clearing active filters.'
                  : 'Add your first contact manually to start tracking conversations and pipeline stages.'}
              </p>
              <div className="mt-5 flex items-center justify-center gap-3">
                {hasActiveFilters ? (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                  >
                    Clear filters
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={openCreateModal}
                      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium transition-colors"
                    >
                      <Plus className="h-4 w-4" />
                      <span>Add first lead</span>
                    </button>
                    <button
                      type="button"
                      onClick={onNavigateToImport}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                    >
                      <Upload className="h-4 w-4" />
                      <span>Import CSV</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-3 px-6">Contact</th>
                      <th className="py-3 px-4">Company & position</th>
                      <th className="py-3 px-4">Source</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Date added</th>
                      <th className="py-3 px-6 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                    {leads.map((lead) => (
                      <tr
                        key={lead.id}
                        onClick={() => setSelectedLeadId(lead.id)}
                        className="cursor-pointer hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-3.5 px-6 max-w-[260px]">
                          <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                            {lead.fullName}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {lead.email}
                          </div>
                        </td>

                        <td className="py-3.5 px-4 max-w-[240px]">
                          <div className="text-slate-900 dark:text-slate-100 truncate">
                            {lead.company || '—'}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {lead.role || '—'}
                          </div>
                        </td>

                        <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {LEAD_SOURCE_LABELS[lead.source]}
                        </td>

                        <td
                          className="py-3.5 px-4 whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <select
                            aria-label={`Pipeline status for ${lead.fullName}`}
                            value={lead.status}
                            disabled={updatingStatusId === lead.id}
                            onChange={(e) =>
                              void handleInlineStatusChange(lead.id, e.target.value as LeadStatus)
                            }
                            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:opacity-50"
                          >
                            {LEAD_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono text-xs text-slate-600 dark:text-slate-400 tabular-nums whitespace-nowrap">
                          {formatShortDate(lead.createdAt)}
                        </td>

                        <td
                          className="py-3.5 px-6 text-right whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => openEditModal(lead)}
                            aria-label={`Edit ${lead.fullName}`}
                            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>Edit</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile & Tablet List */}
              <div className="lg:hidden divide-y divide-slate-200 dark:divide-slate-800">
                {leads.map((lead) => (
                  <div
                    key={lead.id}
                    onClick={() => setSelectedLeadId(lead.id)}
                    className="p-4 space-y-3 cursor-pointer hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {lead.fullName}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {lead.email}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditModal(lead);
                        }}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 shrink-0 min-h-[36px]"
                      >
                        Edit
                      </button>
                    </div>

                    <div className="text-xs text-slate-600 dark:text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>{lead.company || 'No company'}</span>
                      {lead.role && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{lead.role}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{LEAD_SOURCE_LABELS[lead.source]}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {formatShortDate(lead.createdAt)}
                      </span>
                    </div>

                    <div
                      className="flex items-center justify-between gap-2 pt-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="text-xs text-slate-500 dark:text-slate-400">Status</span>
                      <select
                        aria-label={`Pipeline status for ${lead.fullName}`}
                        value={lead.status}
                        disabled={updatingStatusId === lead.id}
                        onChange={(e) =>
                          void handleInlineStatusChange(lead.id, e.target.value as LeadStatus)
                        }
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 min-h-[38px]"
                      >
                        {LEAD_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination Footer */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-mono tabular-nums">
                  Showing {startIndex}–{endIndex} of {totalFiltered.toLocaleString()}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:pointer-events-none min-h-[36px]"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>Previous</span>
                  </button>
                  <span className="font-mono tabular-nums px-2 text-slate-700 dark:text-slate-300">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:pointer-events-none min-h-[36px]"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      <LeadFormModal
        isOpen={formOpen}
        mode={formMode}
        initialLead={editingLead}
        onClose={() => setFormOpen(false)}
        onSubmit={handleFormSubmit}
      />

      <LeadDetailDrawer
        leadId={selectedLeadId}
        onClose={() => setSelectedLeadId(null)}
        onEditLead={(lead) => openEditModal(lead)}
        onDraftEmail={(lead) => {
          setComposerDraft({
            leadId: lead.id,
            to: lead.email,
            mailboxId: lead.lastSenderId || undefined,
            openAiAssistant: true,
          });
          setComposerOpen(true);
        }}
        onFollowUpEmail={(lead, lastSent) => {
          const cleanSub = lastSent.subject.trim();
          const reSubject = /^re:/i.test(cleanSub) ? cleanSub : `Re: ${cleanSub}`;
          setComposerDraft({
            leadId: lead.id,
            to: lead.email,
            mailboxId: lead.lastSenderId || undefined,
            subject: reSubject,
            threadWithPrevious: true,
            inReplyTo: lastSent.messageId || undefined,
            openAiAssistant: false,
          });
          setComposerOpen(true);
        }}
        onLeadUpdated={handleLeadUpdatedFromDrawer}
        onLeadDeleted={handleLeadDeletedFromDrawer}
      />

      <EmailComposer
        isOpen={composerOpen}
        initialDraft={composerDraft}
        onClose={() => setComposerOpen(false)}
        onSent={(res) => {
          setFeedback(`Email sent to ${res.email.toEmail}.`);
          onLeadMutated?.();
          if (viewMode === 'list') {
            void loadLeads();
          } else {
            void loadBoard();
          }
          if (selectedLeadId) {
            const currentId = selectedLeadId;
            setSelectedLeadId(null);
            window.setTimeout(() => setSelectedLeadId(currentId), 0);
          }
        }}
        onNavigateToSettings={onNavigateToSettings}
      />
    </div>
  );
}
