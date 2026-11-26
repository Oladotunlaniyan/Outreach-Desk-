import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  Clock,
  Database,
  HelpCircle,
  Mail,
  MessageSquare,
  PauseCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import type { DashboardOverviewResponse, PageId } from '../types/outreach';

function formatActivityTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface OverviewPageProps {
  onNavigate: (page: PageId) => void;
  refreshSignal: number;
}

export function OverviewPage({ onNavigate, refreshSignal }: OverviewPageProps) {
  const [data, setData] = useState<DashboardOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch<DashboardOverviewResponse>('/api/dashboard/overview');
      setData(response);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to load dashboard overview.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, refreshSignal]);

  if (loading && !data) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading overview">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, idx) => (
            <div
              key={idx}
              className="h-28 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 animate-pulse"
            >
              <div className="h-3.5 w-24 rounded bg-slate-200 dark:bg-slate-800" />
              <div className="mt-4 h-7 w-16 rounded bg-slate-200 dark:bg-slate-800" />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 h-72 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 animate-pulse" />
          <div className="lg:col-span-5 h-72 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 animate-pulse" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
      >
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Could not load overview
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{error}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadOverview()}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-900 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  const metrics = data?.metrics;
  const todayStats = data?.todayStats;
  const dbConnected = Boolean(data?.dbConnected);
  const mailboxCapacity = data?.mailboxCapacity ?? [];
  const recentCampaigns = data?.recentCampaigns ?? [];
  const recentEmailActivity = data?.recentEmailActivity ?? [];
  const pipelineBreakdown = data?.pipelineBreakdown ?? [];
  const sendHistory14d = data?.sendHistory14d ?? [];
  const total14dSent = sendHistory14d.reduce((sum, d) => sum + d.sent, 0);
  const total14dFailed = sendHistory14d.reduce((sum, d) => sum + d.failed, 0);
  const max14dDayTotal = Math.max(
    1,
    ...sendHistory14d.map((d) => d.sent + d.failed)
  );

  const kpiCards = [
    {
      label: 'Total leads',
      value: metrics ? metrics.totalLeads.toLocaleString() : '—',
      subtext: dbConnected ? 'Stored in database' : 'Database offline',
      icon: Users,
    },
    {
      label: 'Emails sent',
      value: metrics ? metrics.emailsSent.toLocaleString() : '—',
      subtext: dbConnected ? 'Confirmed outbound' : 'Database offline',
      icon: Send,
    },
    {
      label: 'Reply rate',
      value: metrics ? `${metrics.replyRate.toFixed(1)}%` : '—',
      subtext: dbConnected ? 'Of contacted leads' : 'Database offline',
      icon: MessageSquare,
    },
    {
      label: 'Interested leads',
      value: metrics ? metrics.interestedLeads.toLocaleString() : '—',
      subtext: dbConnected ? 'Marked Interested' : 'Database offline',
      icon: Sparkles,
    },
    {
      label: 'Meetings booked',
      value: metrics ? metrics.meetingsBooked.toLocaleString() : '—',
      subtext: dbConnected ? 'In Meeting stage' : 'Database offline',
      icon: CalendarCheck,
    },
  ];

  return (
    <div className="space-y-6">
      {!dbConnected && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <Database className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                MongoDB Atlas connection required
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                {data?.dbError ||
                  'Configure MONGODB_URI in your environment secrets to persist leads, campaigns, and outbox history.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className="inline-flex items-center justify-center rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
          >
            Open Settings
          </button>
        </div>
      )}

      {/* Primary KPI Row */}
      <section aria-label="Outreach metrics">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {kpiCards.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.label}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5"
              >
                <div className="flex items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
                  <span className="text-sm font-medium">{item.label}</span>
                  <Icon className="h-4 w-4 shrink-0" />
                </div>
                <div className="mt-3 font-mono text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 tabular-nums">
                  {item.value}
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{item.subtext}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Today's SMTP Sending & Capacity Summary */}
      <section aria-label="Today's email operations">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Sent today (UTC)
              </div>
              <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                {todayStats ? todayStats.emailsSentToday.toLocaleString() : '—'}
              </div>
            </div>
            <Send className="h-4 w-4 text-slate-400 shrink-0" />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Remaining today (UTC)
              </div>
              <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                {todayStats ? todayStats.emailsRemainingToday.toLocaleString() : '—'}
              </div>
            </div>
            <Mail className="h-4 w-4 text-slate-400 shrink-0" />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Verified active mailboxes
              </div>
              <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                {todayStats ? todayStats.activeVerifiedMailboxes.toLocaleString() : '—'}
              </div>
            </div>
            <ShieldCheck className="h-4 w-4 text-slate-400 shrink-0" />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Sending issues today
              </div>
              <div
                className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
                  todayStats && todayStats.sendingFailuresToday > 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-slate-900 dark:text-slate-100'
                }`}
              >
                {todayStats ? todayStats.sendingFailuresToday.toLocaleString() : '—'}
              </div>
            </div>
            <AlertTriangle
              className={`h-4 w-4 shrink-0 ${
                todayStats && todayStats.sendingFailuresToday > 0
                  ? 'text-red-500 dark:text-red-400'
                  : 'text-slate-400'
              }`}
            />
          </div>
        </div>
      </section>

      {/* 14-Day Send Activity Chart */}
      {sendHistory14d.length > 0 && (
        <section
          aria-label="14-day send activity"
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                14-day outbound activity
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Daily confirmed deliveries and failed/bounced attempts (UTC)
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs tabular-nums">
              <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                <span className="h-2.5 w-2.5 rounded-xs bg-blue-600 dark:bg-blue-500 inline-block" />
                <span>Sent:</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                  {total14dSent.toLocaleString()}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                <span className="h-2.5 w-2.5 rounded-xs bg-red-500 dark:bg-red-400 inline-block" />
                <span>Issues:</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                  {total14dFailed.toLocaleString()}
                </span>
              </span>
            </div>
          </div>

          <div className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1.5 items-end h-32 pt-2 border-b border-slate-200 dark:border-slate-800 pb-2">
            {sendHistory14d.map((day) => {
              const total = day.sent + day.failed;
              const sentHeightPct = Math.round((day.sent / max14dDayTotal) * 100);
              const failedHeightPct = Math.round((day.failed / max14dDayTotal) * 100);
              return (
                <div
                  key={day.dateKey}
                  title={`${day.label} (${day.dateKey}): ${day.sent} sent, ${day.failed} issues`}
                  className="h-full flex flex-col justify-end items-center gap-1 group"
                >
                  <div className="w-full max-w-[26px] flex-1 flex flex-col justify-end gap-0.5">
                    {day.failed > 0 && (
                      <div
                        className="w-full rounded-t-xs bg-red-500 dark:bg-red-400 transition-all"
                        style={{ height: `${Math.max(4, failedHeightPct)}%` }}
                      />
                    )}
                    {day.sent > 0 ? (
                      <div
                        className={`w-full bg-blue-600 dark:bg-blue-500 transition-all ${
                          day.failed === 0 ? 'rounded-t-xs' : ''
                        }`}
                        style={{ height: `${Math.max(6, sentHeightPct)}%` }}
                      />
                    ) : total === 0 ? (
                      <div className="w-full h-[2px] bg-slate-200 dark:bg-slate-800 rounded-xs" />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1.5 text-center">
            {sendHistory14d.map((day, idx) => (
              <div
                key={day.dateKey}
                className="font-mono text-[10px] text-slate-500 dark:text-slate-400 tabular-nums truncate"
              >
                {idx === 0 || idx === 6 || idx === 13 ? day.label : ''}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Main Two-Column Content */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Campaign Activity & Recent Outbox Activity */}
        <div className="lg:col-span-7 space-y-6">
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Campaign activity
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Recent outreach sequences and sending progress
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('campaigns')}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              View campaigns
            </button>
          </div>

          {recentCampaigns.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Send className="h-8 w-8 mx-auto text-slate-300 dark:text-slate-700" />
              <h3 className="mt-3 font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                No campaigns recorded yet
              </h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                {dbConnected
                  ? 'Import leads from CSV or create your first outreach campaign to track progress here.'
                  : 'Connect MongoDB Atlas to store and track campaign sending activity.'}
              </p>
              <div className="mt-5 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => onNavigate('import')}
                  className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap"
                >
                  Import CSV
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('campaigns')}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap"
                >
                  Open Campaigns
                </button>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-6">Campaign</th>
                    <th className="py-3 px-4">State</th>
                    <th className="py-3 px-4 text-right">Sent</th>
                    <th className="py-3 px-6 text-right">Replies</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                  {recentCampaigns.map((campaign) => {
                    const progress =
                      campaign.totalRecipients > 0
                        ? Math.round((campaign.sentCount / campaign.totalRecipients) * 100)
                        : 0;
                    return (
                      <tr
                        key={campaign.id}
                        onClick={() => onNavigate('campaigns')}
                        className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3.5 px-6">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {campaign.name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {campaign.mailboxName || campaign.mailboxId}
                            <span aria-hidden="true"> · </span>
                            {campaign.approved ? 'Approved' : 'Awaiting approval'}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-xs font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {campaign.status === 'Completed' ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                            ) : campaign.status === 'Paused' ? (
                              <PauseCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                            ) : (
                              <Send className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                            )}
                            {campaign.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-xs text-slate-700 dark:text-slate-300 tabular-nums whitespace-nowrap">
                          {campaign.sentCount}/{campaign.totalRecipients} ({progress}%)
                        </td>
                        <td className="py-3.5 px-6 text-right font-mono text-xs text-slate-700 dark:text-slate-300 tabular-nums">
                          {campaign.repliedCount}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent Outbound Email Activity */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Recent email activity
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Latest SMTP deliveries and failure logs
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('outbox')}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              Open outbox
            </button>
          </div>

          {recentEmailActivity.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <Mail className="h-7 w-7 mx-auto text-slate-300 dark:text-slate-700" />
              <h3 className="mt-2.5 font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                No outbound emails logged yet
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                {dbConnected
                  ? 'Send a direct message from Outbox using any verified SMTP mailbox.'
                  : 'Connect MongoDB Atlas to record email sending activity.'}
              </p>
              {dbConnected && (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => onNavigate('outbox')}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                  >
                    Go to Outbox
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {recentEmailActivity.map((item) => (
                <div
                  key={item.id}
                  className="px-6 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                      {item.subject}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      <span className="font-mono">{item.toEmail}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{item.mailboxName}</span>
                    </div>
                    {item.error && (
                      <div className="text-xs text-red-600 dark:text-red-400 truncate">
                        {item.error}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0 space-y-0.5">
                    <div className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap">
                      {item.status === 'sent' ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-emerald-700 dark:text-emerald-400">Sent</span>
                        </>
                      ) : item.status === 'failed' || item.status === 'bounced' ? (
                        <>
                          <AlertCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                          <span className="text-red-700 dark:text-red-400">Failed</span>
                        </>
                      ) : item.status === 'unknown' ? (
                        <>
                          <HelpCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                          <span className="text-amber-700 dark:text-amber-400">Unknown</span>
                        </>
                      ) : (
                        <>
                          <Clock className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                          <span className="text-blue-700 dark:text-blue-400 capitalize">
                            {item.status}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {formatActivityTime(item.sentAt || item.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        </div>

        {/* Right Column: Mailbox Sending Capacity & Pipeline Breakdown */}
        <div className="lg:col-span-5 space-y-6">
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Mailbox sending capacity
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Daily SMTP limits enforced server-side
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
              >
                Configure
              </button>
            </div>

            {mailboxCapacity.length === 0 ? (
              <div className="px-6 py-8 text-center">
                <Mail className="h-7 w-7 mx-auto text-slate-300 dark:text-slate-700" />
                <h3 className="mt-2.5 font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  No SMTP mailboxes configured
                </h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Add and verify an SMTP sender account in Settings to track daily capacity here.
                </p>
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => onNavigate('settings')}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                  >
                    Configure mailboxes
                  </button>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {mailboxCapacity.map((mailbox) => {
                  const pct =
                    mailbox.dailyLimit > 0
                      ? Math.min(100, Math.round((mailbox.sentToday / mailbox.dailyLimit) * 100))
                      : 0;
                  return (
                    <div key={mailbox.id} className="px-6 py-4 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                            {mailbox.label}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {mailbox.fromEmail}
                            <span aria-hidden="true"> · </span>
                            {mailbox.configured ? 'Verified' : 'Unverified'}
                          </div>
                        </div>
                        <div className="font-mono text-xs font-medium text-slate-700 dark:text-slate-300 tabular-nums whitespace-nowrap shrink-0">
                          {mailbox.sentToday} / {mailbox.dailyLimit}
                        </div>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full transition-all ${
                            pct >= 90
                              ? 'bg-red-600 dark:bg-red-500'
                              : pct >= 70
                                ? 'bg-amber-500'
                                : 'bg-blue-600 dark:bg-blue-500'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Pipeline stages
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('pipeline')}
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
              >
                Open board
              </button>
            </div>
            <div className="grid grid-cols-2 divide-y divide-slate-200 dark:divide-slate-800">
              {pipelineBreakdown.map((stage, idx) => (
                <div
                  key={stage.status}
                  className={`flex items-center justify-between px-5 py-3 text-sm ${
                    idx % 2 === 0 ? 'border-r border-slate-200 dark:border-slate-800' : ''
                  }`}
                >
                  <span className="text-slate-600 dark:text-slate-400">{stage.status}</span>
                  <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                    {dbConnected ? stage.count.toLocaleString() : '—'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
