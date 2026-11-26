import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, Eye, EyeOff, Lock, X } from 'lucide-react';
import { ApiError } from '../lib/api';
import type {
  MailboxFormPayload,
  MailboxItem,
  SmtpSecurityMode,
} from '../types/outreach';

interface MailboxFormModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  initialMailbox?: MailboxItem | null;
  encryptionValid: boolean;
  onClose: () => void;
  onSubmit: (payload: MailboxFormPayload) => Promise<void>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MailboxFormModal({
  isOpen,
  mode,
  initialMailbox,
  encryptionValid,
  onClose,
  onSubmit,
}: MailboxFormModalProps) {
  const [name, setName] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [securityMode, setSecurityMode] = useState<SmtpSecurityMode>('starttls');
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [dailyLimit, setDailyLimit] = useState('50');
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setShowPassword(false);
    // Never preload an existing SMTP password into a frontend input
    setSmtpPassword('');

    if (mode === 'edit' && initialMailbox) {
      setName(initialMailbox.name);
      setSenderName(initialMailbox.senderName);
      setSenderEmail(initialMailbox.senderEmail);
      setReplyTo(initialMailbox.replyTo || '');
      setSmtpHost(initialMailbox.smtpHost);
      setSmtpPort(String(initialMailbox.smtpPort));
      setSecurityMode(initialMailbox.securityMode);
      setSmtpUsername(initialMailbox.smtpUsername);
      setDailyLimit(String(initialMailbox.dailyLimit));
      setEnabled(initialMailbox.enabled);
    } else {
      setName('');
      setSenderName('');
      setSenderEmail('');
      setReplyTo('');
      setSmtpHost('');
      setSmtpPort('587');
      setSecurityMode('starttls');
      setSmtpUsername('');
      setDailyLimit('50');
      setEnabled(true);
    }
  }, [isOpen, mode, initialMailbox]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, submitting, onClose]);

  if (!isOpen) return null;

  const parsedPort = Number(smtpPort);
  const portLocksToImplicitTls = parsedPort === 465;
  const portLocksToStartTls = parsedPort === 587;

  function handlePortChange(rawValue: string) {
    setSmtpPort(rawValue);
    const num = Number(rawValue);
    if (num === 465) {
      setSecurityMode('implicit_tls');
    } else if (num === 587 || num === 2525) {
      setSecurityMode('starttls');
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const trimmedName = name.trim();
    const trimmedSenderName = senderName.trim();
    const trimmedSenderEmail = senderEmail.trim().toLowerCase();
    const trimmedReplyTo = replyTo.trim().toLowerCase();
    const trimmedHost = smtpHost.trim().toLowerCase();
    const trimmedUsername = smtpUsername.trim();
    const portNum = Number(smtpPort);
    const limitNum = Number(dailyLimit);

    if (!trimmedName) {
      setError('Mailbox name is required.');
      return;
    }
    if (!trimmedSenderName) {
      setError('Sender display name is required.');
      return;
    }
    if (!EMAIL_PATTERN.test(trimmedSenderEmail)) {
      setError('Please enter a valid sender email address.');
      return;
    }
    if (trimmedReplyTo && !EMAIL_PATTERN.test(trimmedReplyTo)) {
      setError('Please enter a valid Reply-To email address.');
      return;
    }
    if (!trimmedHost) {
      setError('SMTP hostname is required.');
      return;
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError('SMTP port must be a whole number between 1 and 65535.');
      return;
    }
    if (!trimmedUsername) {
      setError('SMTP username is required.');
      return;
    }
    if (mode === 'create' && smtpPassword.length === 0) {
      setError('SMTP password is required.');
      return;
    }
    if ((mode === 'create' || smtpPassword.length > 0) && !encryptionValid) {
      setError(
        'Cannot save SMTP credentials until MAILBOX_ENCRYPTION_KEY is validly configured on the server.'
      );
      return;
    }
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 10000) {
      setError('Daily sending limit must be between 1 and 10,000.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const effectiveSecurity: SmtpSecurityMode =
        portNum === 465
          ? 'implicit_tls'
          : portNum === 587
            ? 'starttls'
            : securityMode;

      await onSubmit({
        name: trimmedName,
        senderName: trimmedSenderName,
        senderEmail: trimmedSenderEmail,
        replyTo: trimmedReplyTo,
        smtpHost: trimmedHost,
        smtpPort: portNum,
        securityMode: effectiveSecurity,
        smtpUsername: trimmedUsername,
        ...(smtpPassword.length > 0 ? { smtpPassword } : {}),
        dailyLimit: limitNum,
        enabled,
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Unable to save mailbox configuration.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mailbox-form-title"
    >
      <div
        className="fixed inset-0"
        onClick={() => {
          if (!submitting) onClose();
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
          <div>
            <h2
              id="mailbox-form-title"
              className="font-display text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              {mode === 'create' ? 'Add SMTP mailbox' : 'Edit SMTP mailbox'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Credentials are encrypted server-side with AES-256-GCM and never returned to the browser
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close modal"
            className="inline-flex items-center justify-center rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors min-h-[40px] min-w-[40px]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5" autoComplete="off">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="mailbox-name"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Mailbox name <span className="text-red-500">*</span>
              </label>
              <input
                id="mailbox-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Primary Outreach"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label
                htmlFor="mailbox-daily-limit"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Daily sending limit <span className="text-red-500">*</span>
              </label>
              <input
                id="mailbox-daily-limit"
                type="number"
                min={1}
                max={10000}
                required
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 font-mono text-sm tabular-nums text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label
                htmlFor="mailbox-sender-name"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Sender display name <span className="text-red-500">*</span>
              </label>
              <input
                id="mailbox-sender-name"
                type="text"
                required
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                placeholder="Alex Rivera"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label
                htmlFor="mailbox-sender-email"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Sender email address <span className="text-red-500">*</span>
              </label>
              <input
                id="mailbox-sender-email"
                type="email"
                required
                value={senderEmail}
                onChange={(e) => setSenderEmail(e.target.value)}
                placeholder="alex@company.com"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div className="sm:col-span-2">
              <label
                htmlFor="mailbox-reply-to"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Default Reply-To email (optional)
              </label>
              <input
                id="mailbox-reply-to"
                type="email"
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
                placeholder="replies@company.com (defaults to sender email if empty)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label
                htmlFor="mailbox-smtp-host"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                SMTP hostname <span className="text-red-500">*</span>
              </label>
              <input
                id="mailbox-smtp-host"
                type="text"
                required
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.gmail.com"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 font-mono text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="mailbox-smtp-port"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  SMTP port <span className="text-red-500">*</span>
                </label>
                <input
                  id="mailbox-smtp-port"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={smtpPort}
                  onChange={(e) => handlePortChange(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-sm tabular-nums text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div>
                <label
                  htmlFor="mailbox-security-mode"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  TLS mode
                </label>
                <select
                  id="mailbox-security-mode"
                  value={
                    portLocksToImplicitTls
                      ? 'implicit_tls'
                      : portLocksToStartTls
                        ? 'starttls'
                        : securityMode
                  }
                  disabled={portLocksToImplicitTls || portLocksToStartTls}
                  onChange={(e) => setSecurityMode(e.target.value as SmtpSecurityMode)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:opacity-75"
                >
                  <option value="starttls">STARTTLS</option>
                  <option value="implicit_tls">Implicit TLS</option>
                </select>
              </div>
            </div>
          </div>

          {/* Port presets */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>Quick ports:</span>
            {[
              { port: '587', label: '587 (STARTTLS)' },
              { port: '465', label: '465 (Implicit TLS)' },
              { port: '2525', label: '2525 (STARTTLS)' },
            ].map((preset) => (
              <button
                key={preset.port}
                type="button"
                onClick={() => handlePortChange(preset.port)}
                className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
                  smtpPort === preset.port
                    ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="mailbox-smtp-username"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                SMTP username <span className="text-red-500">*</span>
              </label>
              <input
                id="mailbox-smtp-username"
                type="text"
                required
                autoComplete="off"
                value={smtpUsername}
                onChange={(e) => setSmtpUsername(e.target.value)}
                placeholder="alex@company.com"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            <div>
              <label
                htmlFor="mailbox-smtp-password"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                SMTP password {mode === 'create' ? <span className="text-red-500">*</span> : '(optional)'}
              </label>
              <div className="relative">
                <input
                  id="mailbox-smtp-password"
                  type={showPassword ? 'text' : 'password'}
                  required={mode === 'create'}
                  autoComplete="new-password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  placeholder={
                    mode === 'edit'
                      ? 'Leave blank to keep saved password'
                      : 'App password or SMTP token'
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 pl-3.5 pr-10 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {mode === 'edit' && (
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Leave blank to retain your currently encrypted SMTP password.
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
            <label className="inline-flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
              />
              <span>Mailbox enabled</span>
            </label>

            <div className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <Lock className="h-3.5 w-3.5 shrink-0" />
              <span>TLS certificate verification is always enforced</span>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[40px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors min-h-[40px]"
            >
              {submitting
                ? mode === 'create'
                  ? 'Encrypting & saving...'
                  : 'Updating...'
                : mode === 'create'
                  ? 'Add mailbox'
                  : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
