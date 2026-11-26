import { useDraggable } from '@dnd-kit/react';
import { Building2, GripVertical, MapPin, RefreshCw } from 'lucide-react';
import {
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  type LeadItem,
  type LeadStatus,
} from '../types/outreach';

interface LeadKanbanCardProps {
  lead: LeadItem;
  isPending: boolean;
  onSelectLead: (leadId: string) => void;
  onStatusChange: (leadId: string, nextStatus: LeadStatus) => void;
}

export function formatCardDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function LeadKanbanCardContent({
  lead,
  isOverlay = false,
}: {
  lead: LeadItem;
  isOverlay?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
            {lead.fullName}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {lead.email}
          </div>
        </div>
        {isOverlay && (
          <GripVertical className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
        )}
      </div>

      {(lead.company || lead.role) && (
        <div className="text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1.5 min-w-0">
          <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <span className="truncate">
            {[lead.company, lead.role].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}

      {lead.location && (
        <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 min-w-0">
          <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <span className="truncate">{lead.location}</span>
        </div>
      )}

      <div className="pt-1 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
        <span>{LEAD_SOURCE_LABELS[lead.source]}</span>
        <span className="font-mono tabular-nums">{formatCardDate(lead.createdAt)}</span>
      </div>
    </div>
  );
}

export function LeadKanbanCard({
  lead,
  isPending,
  onSelectLead,
  onStatusChange,
}: LeadKanbanCardProps) {
  const { ref, isDragSource } = useDraggable({
    id: lead.id,
    data: {
      lead,
      status: lead.status,
    },
    disabled: isPending,
  });

  return (
    <article
      ref={ref}
      onClick={() => {
        if (!isDragSource) {
          onSelectLead(lead.id);
        }
      }}
      className={`group rounded-lg border bg-white dark:bg-slate-900 p-3.5 transition-all select-none ${
        isDragSource
          ? 'opacity-40 border-blue-400 dark:border-blue-500'
          : isPending
            ? 'opacity-75 border-slate-200 dark:border-slate-800 cursor-wait'
            : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 cursor-pointer'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelectLead(lead.id);
          }}
          className="text-left min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-sm"
        >
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
            {lead.fullName}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {lead.email}
          </div>
        </button>

        <button
          type="button"
          data-drag-handle="true"
          disabled={isPending}
          aria-label={`Drag ${lead.fullName} from ${lead.status}. Press Space or Enter to pick up, arrow keys to move, Space or Enter to drop.`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center justify-center rounded-md p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-grab active:cursor-grabbing shrink-0 min-h-[32px] min-w-[32px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          {isPending ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-600 dark:text-blue-400" />
          ) : (
            <GripVertical className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      <div className="space-y-1.5 mt-2">
        {(lead.company || lead.role) && (
          <div className="text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1.5 min-w-0">
            <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
            <span className="truncate">
              {[lead.company, lead.role].filter(Boolean).join(' · ')}
            </span>
          </div>
        )}

        {lead.location && (
          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 min-w-0">
            <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
            <span className="truncate">{lead.location}</span>
          </div>
        )}

        <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span>{LEAD_SOURCE_LABELS[lead.source]}</span>
          <span className="font-mono tabular-nums">{formatCardDate(lead.createdAt)}</span>
        </div>

        {/* Accessible quick status switcher on touch/mobile */}
        <div
          className="md:hidden pt-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <select
            data-no-drag="true"
            aria-label={`Move ${lead.fullName} to pipeline status`}
            value={lead.status}
            disabled={isPending}
            onChange={(e) => onStatusChange(lead.id, e.target.value as LeadStatus)}
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 min-h-[36px]"
          >
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                Move to: {s}
              </option>
            ))}
          </select>
        </div>
      </div>
    </article>
  );
}
