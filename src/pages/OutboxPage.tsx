import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import {
  EmailComposer,
  type EmailComposerDraft,
} from '../components/EmailComposer';
import { EmailHistorySection } from '../components/EmailHistorySection';
import type { SendEmailResponse } from '../types/outreach';

interface OutboxPageProps {
  refreshSignal: number;
  onEmailSent: () => void;
  onNavigateToSettings: () => void;
}

export function OutboxPage({
  refreshSignal,
  onEmailSent,
  onNavigateToSettings,
}: OutboxPageProps) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState<EmailComposerDraft | null>(null);
  const [localRefreshSignal, setLocalRefreshSignal] = useState(0);
  const [lastSentBanner, setLastSentBanner] = useState<string | null>(null);

  function handleOpenComposer(draft?: EmailComposerDraft) {
    setComposerDraft(draft ?? null);
    setComposerOpen(true);
  }

  function handleSent(response: SendEmailResponse) {
    setLocalRefreshSignal((prev) => prev + 1);
    onEmailSent();
    setLastSentBanner(
      response.deduplicated
        ? `Email to ${response.email.toEmail} was already sent (duplicate submission prevented).`
        : `Email sent to ${response.email.toEmail}. Remaining today for ${response.email.mailboxName}: ${response.quota.remainingToday}/${response.quota.dailyLimit}.`
    );
  }

  return (
    <div className="space-y-5">
      {lastSentBanner && (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-white dark:bg-slate-900 px-4 py-3 flex items-center justify-between gap-3 text-xs text-emerald-700 dark:text-emerald-300"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{lastSentBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setLastSentBanner(null)}
            className="text-xs font-medium underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <EmailHistorySection
        refreshSignal={refreshSignal + localRefreshSignal}
        onOpenComposer={handleOpenComposer}
      />

      <EmailComposer
        isOpen={composerOpen}
        initialDraft={composerDraft}
        onClose={() => setComposerOpen(false)}
        onSent={handleSent}
        onNavigateToSettings={onNavigateToSettings}
      />
    </div>
  );
}
