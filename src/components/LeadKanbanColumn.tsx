import { useDroppable } from '@dnd-kit/react';
import { RefreshCw } from 'lucide-react';
import type { LeadBoardColumn, LeadStatus } from '../types/outreach';
import { LeadKanbanCard } from './LeadKanbanCard';

interface LeadKanbanColumnProps {
  column: LeadBoardColumn;
  hasActiveFilters: boolean;
  pendingLeadIds: Set<string>;
  loadingMore: boolean;
  onSelectLead: (leadId: string) => void;
  onStatusChange: (leadId: string, nextStatus: LeadStatus) => void;
  onLoadMore: (status: LeadStatus) => void;
  columnRef?: (el: HTMLElement | null) => void;
}

export function LeadKanbanColumn({
  column,
  hasActiveFilters,
  pendingLeadIds,
  loadingMore,
  onSelectLead,
  onStatusChange,
  onLoadMore,
  columnRef,
}: LeadKanbanColumnProps) {
  const { ref: droppableRef, isDropTarget } = useDroppable({
    id: column.status,
    data: {
      status: column.status,
    },
  });

  const setRefs = (el: HTMLElement | null) => {
    droppableRef(el);
    columnRef?.(el);
  };

  const remaining = Math.max(0, column.filteredTotal - column.leads.length);

  return (
    <section
      ref={setRefs}
      aria-label={`${column.status} stage`}
      className={`w-[85vw] sm:w-[300px] shrink-0 snap-center md:snap-align-none rounded-xl border transition-colors flex flex-col max-h-[calc(100vh-280px)] min-h-[420px] ${
        isDropTarget
          ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/25'
          : 'border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-900/50'
      }`}
    >
      {/* Column Header */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 shrink-0">
        <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
          {column.status}
        </h3>
        <div
          className="font-mono text-xs text-slate-600 dark:text-slate-400 tabular-nums whitespace-nowrap shrink-0"
          title={
            hasActiveFilters
              ? `${column.filteredTotal} matching active filters out of ${column.totalInStatus} total in ${column.status}`
              : `${column.totalInStatus} leads in ${column.status}`
          }
        >
          {hasActiveFilters && column.filteredTotal !== column.totalInStatus
            ? `${column.filteredTotal} / ${column.totalInStatus}`
            : column.filteredTotal}
        </div>
      </div>

      {/* Column Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {column.leads.length === 0 ? (
          <div
            className={`rounded-lg border border-dashed px-3 py-8 text-center text-xs transition-colors ${
              isDropTarget
                ? 'border-blue-400 text-blue-700 dark:text-blue-300'
                : 'border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400'
            }`}
          >
            {isDropTarget
              ? `Drop to move to ${column.status}`
              : hasActiveFilters && column.totalInStatus > 0
                ? `No matching leads in ${column.status}`
                : `No leads in ${column.status}`}
          </div>
        ) : (
          column.leads.map((lead) => (
            <LeadKanbanCard
              key={lead.id}
              lead={lead}
              isPending={pendingLeadIds.has(lead.id)}
              onSelectLead={onSelectLead}
              onStatusChange={onStatusChange}
            />
          ))
        )}
      </div>

      {/* Load More Pagination */}
      {column.hasMore && (
        <div className="p-3 pt-2 border-t border-slate-200/70 dark:border-slate-800 shrink-0">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => onLoadMore(column.status)}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors min-h-[36px]"
          >
            {loadingMore ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                <span>Loading...</span>
              </>
            ) : (
              <span className="font-mono tabular-nums">
                Load more ({remaining.toLocaleString()} left)
              </span>
            )}
          </button>
        </div>
      )}
    </section>
  );
}
