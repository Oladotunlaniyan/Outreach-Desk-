import { Send } from 'lucide-react';
import type { PageId } from '../types/outreach';

interface SectionMeta {
  title: string;
  description: string;
  capabilities: string[];
  icon: typeof Send;
}

type ScaffoldPageId = Exclude<
  PageId,
  'overview' | 'leads' | 'import' | 'pipeline' | 'outbox' | 'settings'
>;

const SECTION_META: Record<ScaffoldPageId, SectionMeta> = {
  campaigns: {
    title: 'Outreach campaigns',
    description:
      'Build campaigns from imported leads, preview every personalized email, select a sender mailbox, and require manual approval before sending.',
    capabilities: [
      'Preview every recipient email before queueing',
      'Import only or import and send with explicit manual approval',
      'Pause, resume, and retry campaigns with duplicate-send prevention',
    ],
    icon: Send,
  },
};

interface SectionScaffoldPageProps {
  page: ScaffoldPageId;
  onBackToOverview: () => void;
}

export function SectionScaffoldPage({ page, onBackToOverview }: SectionScaffoldPageProps) {
  const meta = SECTION_META[page];
  const Icon = meta.icon;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8">
      <div className="max-w-xl">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
          <Icon className="h-5 w-5" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
          {meta.title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          {meta.description}
        </p>

        <ul className="mt-5 space-y-2 border-t border-slate-200 dark:border-slate-800 pt-5 text-sm text-slate-600 dark:text-slate-300">
          {meta.capabilities.map((item) => (
            <li key={item} className="flex items-start gap-2.5">
              <span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500 shrink-0" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <div className="mt-6">
          <button
            type="button"
            onClick={onBackToOverview}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            Back to Overview
          </button>
        </div>
      </div>
    </div>
  );
}
