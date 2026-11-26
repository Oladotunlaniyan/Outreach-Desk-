import { useMemo, useRef, useState } from 'react';
import {
  Accessibility,
  AutoScroller,
  Cursor,
  Feedback,
  PointerActivationConstraints,
  PreventSelection,
} from '@dnd-kit/dom';
import {
  DragDropProvider,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/react';
import { LEAD_STATUSES, type LeadBoardColumn, type LeadItem, type LeadStatus } from '../types/outreach';
import { LeadKanbanCardContent } from './LeadKanbanCard';
import { LeadKanbanColumn } from './LeadKanbanColumn';

interface LeadKanbanBoardProps {
  columns: LeadBoardColumn[];
  hasActiveFilters: boolean;
  pendingLeadIds: Set<string>;
  loadingMoreStatuses: Set<LeadStatus>;
  onMoveLead: (leadId: string, targetStatus: LeadStatus) => void;
  onSelectLead: (leadId: string) => void;
  onLoadMore: (status: LeadStatus) => void;
}

function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

export function LeadKanbanBoard({
  columns,
  hasActiveFilters,
  pendingLeadIds,
  loadingMoreStatuses,
  onMoveLead,
  onSelectLead,
  onLoadMore,
}: LeadKanbanBoardProps) {
  const [activeMobileStatus, setActiveMobileStatus] = useState<LeadStatus>('New');
  const columnRefs = useRef<Partial<Record<LeadStatus, HTMLElement | null>>>({});

  const leadMap = useMemo(() => {
    const map = new Map<string, LeadItem>();
    for (const col of columns) {
      for (const lead of col.leads) {
        map.set(lead.id, lead);
      }
    }
    return map;
  }, [columns]);

  const sensors = useMemo(
    () => [
      PointerSensor.configure({
        activationConstraints: [new PointerActivationConstraints.Distance({ value: 8 })],
        preventActivation: (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return false;
          return Boolean(target.closest('select, option, a, [data-no-drag="true"]'));
        },
      }),
      KeyboardSensor.configure({
        preventActivation: (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return true;
          return !target.closest('[data-drag-handle="true"]');
        },
      }),
    ],
    []
  );

  const plugins = useMemo(
    () => [
      Accessibility.configure({
        announcements: {
          dragstart({ operation }: DragStartEvent) {
            const leadId = String(operation.source?.id || '');
            const lead = leadMap.get(leadId);
            if (!lead) return undefined;
            return `Picked up lead ${lead.fullName} in ${lead.status} stage.`;
          },
          dragover({ operation }: DragOverEvent) {
            const leadId = String(operation.source?.id || '');
            const targetId = operation.target?.id;
            const lead = leadMap.get(leadId);
            if (!lead || !isLeadStatus(targetId)) return undefined;
            return `${lead.fullName} is over ${targetId} stage.`;
          },
          dragend({ operation, canceled }: DragEndEvent) {
            const leadId = String(operation.source?.id || '');
            const targetId = operation.target?.id;
            const lead = leadMap.get(leadId);
            if (!lead) return undefined;
            if (canceled || !isLeadStatus(targetId)) {
              return `Move cancelled. ${lead.fullName} remains in ${lead.status}.`;
            }
            return `Moved ${lead.fullName} from ${lead.status} to ${targetId}.`;
          },
        },
      }),
      AutoScroller,
      Cursor,
      Feedback,
      PreventSelection,
    ],
    [leadMap]
  );

  function scrollToColumn(status: LeadStatus) {
    setActiveMobileStatus(status);
    const el = columnRefs.current[status];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }

  return (
    <div className="space-y-3">
      {/* Mobile Column Navigation Bar */}
      <div
        className="md:hidden flex items-center gap-1.5 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Pipeline stages"
      >
        {columns.map((col) => {
          const active = activeMobileStatus === col.status;
          return (
            <button
              key={col.status}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => scrollToColumn(col.status)}
              className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 min-h-[38px] border transition-colors ${
                active
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300'
              }`}
            >
              <span>{col.status}</span>{' '}
              <span className="font-mono tabular-nums opacity-85">({col.filteredTotal})</span>
            </button>
          );
        })}
      </div>

      <DragDropProvider
        sensors={sensors}
        plugins={plugins}
        onDragEnd={(event) => {
          if (event.canceled) return;
          const leadId = String(event.operation.source?.id || '');
          const targetStatus = event.operation.target?.id;
          if (!leadId || !isLeadStatus(targetStatus)) return;
          const lead = leadMap.get(leadId);
          if (!lead || lead.status === targetStatus) return;
          onMoveLead(leadId, targetStatus);
        }}
      >
        <div className="flex gap-4 overflow-x-auto pb-4 items-start snap-x snap-mandatory md:snap-none">
          {columns.map((column) => (
            <LeadKanbanColumn
              key={column.status}
              column={column}
              hasActiveFilters={hasActiveFilters}
              pendingLeadIds={pendingLeadIds}
              loadingMore={loadingMoreStatuses.has(column.status)}
              onSelectLead={onSelectLead}
              onStatusChange={onMoveLead}
              onLoadMore={onLoadMore}
              columnRef={(el) => {
                columnRefs.current[column.status] = el;
              }}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
          {(source) => {
            const lead = leadMap.get(String(source.id));
            if (!lead) return null;
            return (
              <div className="w-[280px] rounded-lg border border-blue-500 bg-white dark:bg-slate-900 p-3.5 shadow-lg">
                <LeadKanbanCardContent lead={lead} isOverlay />
              </div>
            );
          }}
        </DragOverlay>
      </DragDropProvider>
    </div>
  );
}
