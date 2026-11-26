import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Eye,
  EyeOff,
  Lock,
  Moon,
  RefreshCw,
  Sun,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { ApiError } from '../lib/api';

export function LoginScreen() {
  const { authStatus, statusError, login, refreshStatus } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const [accessCode, setAccessCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const accessCodeConfigured = authStatus?.accessCodeConfigured ?? true;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accessCode.trim() || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      await login(accessCode);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Unable to sign in. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRefreshStatus() {
    setRefreshing(true);
    await refreshStatus();
    setRefreshing(false);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 flex flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="font-display text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
          Outreach Desk
        </span>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors min-h-[40px]"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          <span className="whitespace-nowrap">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h1 className="font-display text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                Unlock Outreach Desk
              </h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Private single-user workspace
              </p>
            </div>
          </div>

          {statusError && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 p-3.5 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p>{statusError}</p>
                <button
                  type="button"
                  onClick={handleRefreshStatus}
                  disabled={refreshing}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-2 hover:opacity-80"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                  Retry connection
                </button>
              </div>
            </div>
          )}

          {!statusError && authStatus && !accessCodeConfigured && (
            <div
              role="status"
              className="mb-5 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 p-3.5 text-sm text-amber-800 dark:text-amber-200"
            >
              <p className="font-medium">Access code not configured</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                Set <code className="font-mono">ACCESS_CODE</code> in your environment secrets and
                restart or refresh to enable sign-in.
              </p>
              <button
                type="button"
                onClick={handleRefreshStatus}
                disabled={refreshing}
                className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-2 hover:opacity-80"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                Check configuration again
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="access-code"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Access code
              </label>
              <div className="relative">
                <input
                  id="access-code"
                  type={showCode ? 'text' : 'password'}
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)}
                  placeholder="Enter your private access code"
                  autoComplete="current-password"
                  autoFocus
                  disabled={submitting || !accessCodeConfigured}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 pr-11 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 dark:focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowCode((prev) => !prev)}
                  aria-label={showCode ? 'Hide access code' : 'Show access code'}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                >
                  {showCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300"
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !accessCode.trim() || !accessCodeConfigured}
              className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:pointer-events-none px-4 py-2.5 text-sm font-medium text-white transition-colors min-h-[42px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
            >
              {submitting ? 'Verifying...' : 'Sign in'}
            </button>
          </form>

          {authStatus && (
            <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>Database: {authStatus.dbConnected ? 'Connected' : authStatus.dbState}</span>
              <span>Rate-limited endpoint</span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
