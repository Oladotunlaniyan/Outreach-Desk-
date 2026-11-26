import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { MailboxesSection } from '../components/MailboxesSection';
import { SenderProfileSection } from '../components/SenderProfileSection';
import { ApiError, apiFetch, getStoredToken } from '../lib/api';
import { useTheme } from '../context/ThemeContext';
import type { SettingsOverviewResponse } from '../types/outreach';

interface SettingsPageProps {
  onMailboxChanged?: () => void;
}

export function SettingsPage({ onMailboxChanged }: SettingsPageProps) {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<SettingsOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<SettingsOverviewResponse>('/api/settings/overview');
      setSettings(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (
      !settings?.database.configured ||
      settings.database.connected ||
      settings.database.state !== 'connecting'
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      void loadSettings();
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [settings, loadSettings]);

  async function handleReconnectDatabase() {
    setReconnecting(true);
    setError(null);
    try {
      await apiFetch('/api/settings/database/reconnect', { method: 'POST' });
      await loadSettings();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to reconnect to MongoDB Atlas.'
      );
      await loadSettings();
    } finally {
      setReconnecting(false);
    }
  }

  async function handleDownloadCsvTemplate() {
    try {
      const token = getStoredToken();
      const res = await fetch('/api/leads/import/template', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'outreach-desk-import-template.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      // Ignore transient download error
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 p-4 flex items-center gap-3 text-sm text-red-700 dark:text-red-300"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Managed SMTP Mailboxes */}
      <MailboxesSection
        dbConnected={Boolean(settings?.database.connected)}
        onMailboxChanged={onMailboxChanged}
      />

      {/* Sender Intelligence & Writing Voice */}
      <SenderProfileSection dbConnected={Boolean(settings?.database.connected)} />

      {/* CSV Import & Placeholder Reference */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3">
            <FileSpreadsheet className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                CSV import & campaign placeholder guide
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Supported tokens for campaign templates and per-row CSV email subjects/bodies
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleDownloadCsvTemplate()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors self-start sm:self-auto whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Download CSV template</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-600 dark:text-slate-300">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-1.5">
            <div className="font-semibold text-slate-900 dark:text-slate-100">
              Built-in placeholder tokens
            </div>
            <div className="font-mono leading-relaxed text-[11px]">
              {'{{first_name}}'}, {'{{last_name}}'}, {'{{full_name}}'}, {'{{email}}'}, {'{{company}}'},{' '}
              {'{{role}}'}, {'{{website}}'}, {'{{location}}'}, {'{{industry}}'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-1.5">
            <div className="font-semibold text-slate-900 dark:text-slate-100">
              Custom CSV columns & per-row overrides
            </div>
            <p className="leading-relaxed">
              Unmapped CSV columns become lowercase underscore tokens (e.g.{' '}
              <code className="font-mono">Plan Tier</code> →{' '}
              <code className="font-mono">{'{{plan_tier}}'}</code>). Separate multiple{' '}
              <code className="font-mono">tags</code> with <code className="font-mono">;</code> or{' '}
              <code className="font-mono">|</code>, and map <code className="font-mono">subject</code>{' '}
              / <code className="font-mono">bodyText</code> for per-recipient copy.
            </p>
          </div>
        </div>
      </section>

      {/* Appearance */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Appearance
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Choose your preferred workspace theme
            </p>
          </div>
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setTheme('light')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                theme === 'light'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Light
            </button>
            <button
              type="button"
              onClick={() => setTheme('dark')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                theme === 'dark'
                  ? 'bg-slate-900 text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Dark
            </button>
          </div>
        </div>
      </section>

      {/* Infrastructure Status */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Server environment & connections
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Secrets and credentials remain strictly on the server
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadSettings()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {loading && !settings ? (
          <div className="p-6 space-y-4 animate-pulse">
            <div className="h-12 rounded-lg bg-slate-100 dark:bg-slate-800" />
            <div className="h-12 rounded-lg bg-slate-100 dark:bg-slate-800" />
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            <div className="px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-start gap-3">
                <Database className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    MongoDB Atlas
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {settings?.database.connected
                      ? 'Connected and ready for atomic operations'
                      : settings?.database.lastError || `State: ${settings?.database.state ?? 'unknown'}`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                  {settings?.database.connected ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  )}
                  {settings?.database.connected ? 'Connected' : 'Not connected'}
                </span>
                <button
                  type="button"
                  onClick={() => void handleReconnectDatabase()}
                  disabled={reconnecting || !settings?.database.configured}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {reconnecting ? 'Connecting...' : 'Reconnect'}
                </button>
              </div>
            </div>

            <div className="px-6 py-4 flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <KeyRound className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Mailbox credential encryption
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    AES-256-GCM (<code className="font-mono">MAILBOX_ENCRYPTION_KEY</code>, 32-byte Base64)
                  </div>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 shrink-0">
                {settings?.mailboxEncryption?.valid ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                )}
                {settings?.mailboxEncryption?.valid
                  ? 'Valid key'
                  : settings?.mailboxEncryption?.configured
                    ? 'Invalid key'
                    : 'Missing key'}
              </span>
            </div>

            <div className="px-6 py-4 flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Access code & token signing
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    ACCESS_CODE: {settings?.auth.accessCodeConfigured ? 'Set' : 'Missing'}
                    <span aria-hidden="true"> · </span>
                    JWT_SECRET:{' '}
                    {settings?.auth.jwtSecretConfigured ? 'Persistent env' : 'Ephemeral runtime'}
                  </div>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 shrink-0">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                Protected
              </span>
            </div>

            <div className="px-6 py-4 flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Sparkles className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    DeepSeek API (AI email generation)
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Model:{' '}
                    <code className="font-mono">
                      {settings?.deepseek?.model || 'deepseek-chat'}
                    </code>
                    <span aria-hidden="true"> · </span>
                    <code className="font-mono">DEEPSEEK_API_KEY</code> stays strictly server-side
                  </div>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 shrink-0">
                {settings?.deepseek?.configured ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                )}
                {settings?.deepseek?.configured ? 'Configured' : 'Missing key'}
              </span>
            </div>

            {settings?.productionReadiness && (
              <div className="px-6 py-4 space-y-2.5 bg-slate-50/50 dark:bg-slate-950/30">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Production configuration checklist ({settings.productionReadiness.nodeEnv})
                  </span>
                  <span
                    className={`font-semibold ${
                      settings.productionReadiness.readyForProduction
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {settings.productionReadiness.readyForProduction
                      ? 'Ready for production'
                      : 'Action needed for production'}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {settings.productionReadiness.checks.map((chk) => (
                    <div
                      key={chk.key}
                      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 flex items-start gap-2 text-xs"
                    >
                      {chk.ok ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {chk.label}{' '}
                          <span className="font-mono text-[11px] text-slate-400">
                            ({chk.severity})
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {chk.message}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Legacy Environment-Variable Mailboxes (shown only if configured) */}
      {settings && settings.mailboxes.length > 0 && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Environment-configured SMTP mailboxes
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Read-only fallback mailboxes defined via <code className="font-mono">SMTP_MAILBOX_1_*</code> environment variables
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-6">Label</th>
                  <th className="py-3 px-4">From</th>
                  <th className="py-3 px-4">SMTP Server</th>
                  <th className="py-3 px-4 text-right">Daily Limit</th>
                  <th className="py-3 px-6 text-right">Config</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                {settings.mailboxes.map((mailbox) => (
                  <tr key={mailbox.id}>
                    <td className="py-3.5 px-6 font-medium text-slate-900 dark:text-slate-100">
                      {mailbox.label}
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-300">
                      {mailbox.fromName} &lt;{mailbox.fromEmail}&gt;
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-600 dark:text-slate-400">
                      {mailbox.host}:{mailbox.port} ({mailbox.secure ? 'TLS' : 'STARTTLS'})
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono text-xs text-slate-900 dark:text-slate-100 tabular-nums">
                      {mailbox.dailyLimit}
                    </td>
                    <td className="py-3.5 px-6 text-right text-xs font-medium text-slate-700 dark:text-slate-300">
                      {mailbox.configured ? 'Complete' : 'Incomplete'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
