import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  BookOpen,
  Briefcase,
  CheckCircle2,
  Edit3,
  FileText,
  Mail,
  MessageSquare,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import {
  WRITING_SAMPLE_CATEGORY_LABELS,
  type AiEmailLength,
  type AiWritingTone,
  type SenderProfileItem,
  type SenderProfileResponse,
  type WritingSampleCategory,
  type WritingSampleItem,
} from '../types/outreach';

interface SenderProfileSectionProps {
  dbConnected: boolean;
}

type SectionTabId =
  | 'identity'
  | 'work'
  | 'credibility'
  | 'writing'
  | 'email'
  | 'samples';

const SECTION_TABS: Array<{
  id: SectionTabId;
  label: string;
  completionKey: keyof SenderProfileItem['completion']['sections'];
  icon: typeof User;
}> = [
  { id: 'identity', label: 'Identity', completionKey: 'identity', icon: User },
  { id: 'work', label: 'Work & offerings', completionKey: 'work', icon: Briefcase },
  {
    id: 'credibility',
    label: 'Credibility & proof',
    completionKey: 'credibility',
    icon: ShieldCheck,
  },
  {
    id: 'writing',
    label: 'Writing preferences',
    completionKey: 'writingPreferences',
    icon: MessageSquare,
  },
  { id: 'email', label: 'Email preferences', completionKey: 'emailPreferences', icon: Mail },
  { id: 'samples', label: 'Writing samples', completionKey: 'writingSamples', icon: BookOpen },
];

const EMPTY_FORM: Omit<SenderProfileItem, 'exists' | 'id' | 'writingSamples' | 'completion' | 'updatedAt'> = {
  fullName: '',
  professionalTitle: '',
  organizationName: '',
  website: '',
  professionalEmail: '',
  shortIntro: '',
  workDescription: '',
  offerings: '',
  primaryAudience: '',
  problemsSolved: '',
  outreachObjectives: '',
  verifiedAchievements: [],
  relevantExperience: '',
  caseStudies: [],
  approvedMetrics: [],
  relevantPartnerships: [],
  preferredTone: '',
  formalityLevel: '',
  preferredLength: '',
  sentenceStyle: '',
  commonPhrases: [],
  dislikedPhrases: [],
  habitsToAvoid: [],
  defaultSignOff: '',
  emailSignature: '',
  preferredCtaStyle: '',
  includeRoleAndOrgInIntro: true,
  otherOutreachInstructions: '',
};

const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface ListItemsInputProps {
  id: string;
  label: string;
  helper?: string;
  placeholder: string;
  items: string[];
  maxItems: number;
  maxLen: number;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}

function ListItemsInput({
  id,
  label,
  helper,
  placeholder,
  items,
  maxItems,
  maxLen,
  disabled,
  onChange,
}: ListItemsInputProps) {
  const [draft, setDraft] = useState('');

  function addItem() {
    const cleaned = draft.trim().slice(0, maxLen);
    if (!cleaned) return;
    if (items.some((i) => i.toLowerCase() === cleaned.toLowerCase())) {
      setDraft('');
      return;
    }
    if (items.length >= maxItems) return;
    onChange([...items, cleaned]);
    setDraft('');
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={id}
          className="block text-xs font-medium text-slate-700 dark:text-slate-300"
        >
          {label}
        </label>
        <span className="text-[11px] font-mono tabular-nums text-slate-400">
          {items.length}/{maxItems}
        </span>
      </div>
      {helper && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">{helper}</p>
      )}
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          value={draft}
          maxLength={maxLen}
          disabled={disabled || items.length >= maxItems}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addItem();
            }
          }}
          placeholder={placeholder}
          className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={addItem}
          disabled={disabled || !draft.trim() || items.length >= maxItems}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Add</span>
        </button>
      </div>
      {items.length > 0 && (
        <ul className="space-y-1.5 pt-1">
          {items.map((item, idx) => (
            <li
              key={`${item}-${idx}`}
              className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200"
            >
              <span className="break-words leading-relaxed">{item}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
                aria-label={`Remove "${item}"`}
                className="text-slate-400 hover:text-red-600 dark:hover:text-red-400 p-0.5 shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SenderProfileSection({ dbConnected }: SenderProfileSectionProps) {
  const [activeTab, setActiveTab] = useState<SectionTabId>('identity');
  const [profile, setProfile] = useState<SenderProfileItem | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    website?: string;
    professionalEmail?: string;
  }>({});
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Writing sample form state
  const [sampleFormOpen, setSampleFormOpen] = useState(false);
  const [editingSampleId, setEditingSampleId] = useState<string | null>(null);
  const [sampleTitle, setSampleTitle] = useState('');
  const [sampleCategory, setSampleCategory] = useState<WritingSampleCategory>('emails');
  const [sampleDescription, setSampleDescription] = useState('');
  const [sampleContent, setSampleContent] = useState('');
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [savingSample, setSavingSample] = useState(false);
  const [deletingSampleId, setDeletingSampleId] = useState<string | null>(null);
  const [confirmDeleteSampleId, setConfirmDeleteSampleId] = useState<string | null>(null);

  const hydrateFromProfile = useCallback((p: SenderProfileItem) => {
    setProfile(p);
    setForm({
      fullName: p.fullName,
      professionalTitle: p.professionalTitle,
      organizationName: p.organizationName,
      website: p.website,
      professionalEmail: p.professionalEmail,
      shortIntro: p.shortIntro,
      workDescription: p.workDescription,
      offerings: p.offerings,
      primaryAudience: p.primaryAudience,
      problemsSolved: p.problemsSolved,
      outreachObjectives: p.outreachObjectives,
      verifiedAchievements: p.verifiedAchievements,
      relevantExperience: p.relevantExperience,
      caseStudies: p.caseStudies,
      approvedMetrics: p.approvedMetrics,
      relevantPartnerships: p.relevantPartnerships,
      preferredTone: p.preferredTone,
      formalityLevel: p.formalityLevel,
      preferredLength: p.preferredLength,
      sentenceStyle: p.sentenceStyle,
      commonPhrases: p.commonPhrases,
      dislikedPhrases: p.dislikedPhrases,
      habitsToAvoid: p.habitsToAvoid,
      defaultSignOff: p.defaultSignOff,
      emailSignature: p.emailSignature,
      preferredCtaStyle: p.preferredCtaStyle,
      includeRoleAndOrgInIntro: p.includeRoleAndOrgInIntro,
      otherOutreachInstructions: p.otherOutreachInstructions,
    });
    setDirty(false);
  }, []);

  const loadProfile = useCallback(async () => {
    if (!dbConnected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<SenderProfileResponse>('/api/sender-profile');
      hydrateFromProfile(res.profile);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to load sender profile.'
      );
    } finally {
      setLoading(false);
    }
  }, [dbConnected, hydrateFromProfile]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  function updateField<K extends keyof typeof EMPTY_FORM>(
    key: K,
    value: (typeof EMPTY_FORM)[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    if (key === 'website' || key === 'professionalEmail') {
      setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  }

  function validateForm(): boolean {
    const nextErrors: { website?: string; professionalEmail?: string } = {};
    const email = form.professionalEmail.trim();
    if (email && !EMAIL_PATTERN.test(email)) {
      nextErrors.professionalEmail = 'Enter a valid professional email address.';
    }

    const rawSite = form.website.trim();
    if (rawSite) {
      const normalized = /^https?:\/\//i.test(rawSite) ? rawSite : `https://${rawSite}`;
      try {
        const parsed = new URL(normalized);
        if (
          (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
          !parsed.hostname.includes('.')
        ) {
          nextErrors.website = 'Enter a valid website URL (e.g. https://example.com).';
        }
      } catch {
        nextErrors.website = 'Enter a valid website URL (e.g. https://example.com).';
      }
    }

    setFieldErrors(nextErrors);
    if (nextErrors.website || nextErrors.professionalEmail) {
      setActiveTab('identity');
      return false;
    }
    return true;
  }

  async function handleSaveProfile(e?: FormEvent) {
    e?.preventDefault();
    if (saving || !dbConnected) return;
    if (!validateForm()) return;

    setSaving(true);
    setFeedback(null);
    setError(null);
    try {
      const res = await apiFetch<{ ok: boolean; profile: SenderProfileItem }>(
        '/api/sender-profile',
        {
          method: 'PUT',
          body: JSON.stringify(form),
        }
      );
      hydrateFromProfile(res.profile);
      setFeedback({
        type: 'success',
        message: 'Sender profile saved. AI email generation will use these updated facts and preferences.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiError ? err.message : 'Unable to save sender profile.',
      });
    } finally {
      setSaving(false);
    }
  }

  function openNewSampleForm() {
    setEditingSampleId(null);
    setSampleTitle('');
    setSampleCategory('emails');
    setSampleDescription('');
    setSampleContent('');
    setSampleError(null);
    setSampleFormOpen(true);
  }

  function openEditSampleForm(sample: WritingSampleItem) {
    setEditingSampleId(sample.id);
    setSampleTitle(sample.title);
    setSampleCategory(sample.category);
    setSampleDescription(sample.description);
    setSampleContent(sample.content);
    setSampleError(null);
    setSampleFormOpen(true);
  }

  async function handleSaveSample(e: FormEvent) {
    e.preventDefault();
    if (savingSample || !dbConnected) return;

    if (!sampleTitle.trim()) {
      setSampleError('Sample title is required.');
      return;
    }
    if (sampleContent.trim().length < 10) {
      setSampleError('Writing sample content must be at least 10 characters.');
      return;
    }

    setSavingSample(true);
    setSampleError(null);
    try {
      const payload = {
        title: sampleTitle.trim(),
        category: sampleCategory,
        description: sampleDescription.trim(),
        content: sampleContent.trim(),
      };

      const res = editingSampleId
        ? await apiFetch<{ ok: boolean; profile: SenderProfileItem }>(
            `/api/sender-profile/samples/${editingSampleId}`,
            {
              method: 'PUT',
              body: JSON.stringify(payload),
            }
          )
        : await apiFetch<{ ok: boolean; profile: SenderProfileItem }>(
            '/api/sender-profile/samples',
            {
              method: 'POST',
              body: JSON.stringify(payload),
            }
          );

      setProfile(res.profile);
      setSampleFormOpen(false);
      setEditingSampleId(null);
      setFeedback({
        type: 'success',
        message: editingSampleId ? 'Writing sample updated.' : 'Writing sample saved.',
      });
    } catch (err) {
      setSampleError(
        err instanceof ApiError ? err.message : 'Unable to save writing sample.'
      );
    } finally {
      setSavingSample(false);
    }
  }

  async function handleDeleteSample(sampleId: string) {
    if (deletingSampleId || !dbConnected) return;
    setDeletingSampleId(sampleId);
    try {
      const res = await apiFetch<{ ok: boolean; profile: SenderProfileItem }>(
        `/api/sender-profile/samples/${sampleId}`,
        { method: 'DELETE' }
      );
      setProfile(res.profile);
      setConfirmDeleteSampleId(null);
      setFeedback({
        type: 'success',
        message: 'Writing sample deleted.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiError ? err.message : 'Unable to delete writing sample.',
      });
    } finally {
      setDeletingSampleId(null);
    }
  }

  const completion = profile?.completion;
  const samples = profile?.writingSamples || [];

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      {/* Header + Completion Indicator */}
      <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Sender intelligence &amp; voice
            </h2>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-2xl">
            Tell DeepSeek who you are, what you offer, verified proof points, and how you naturally write. All fields are optional—missing details are never invented, and partial profiles work normally.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3 shrink-0">
          {completion && (
            <div className="min-w-[190px] rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  Profile completion
                </span>
                <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                  {completion.percentage}%
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-600 dark:bg-blue-500 transition-all duration-300"
                  style={{ width: `${completion.percentage}%` }}
                />
              </div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400">
                {completion.completedFields} of {completion.totalFields} profile areas filled
              </div>
            </div>
          )}

          {activeTab !== 'samples' && (
            <button
              type="button"
              onClick={() => void handleSaveProfile()}
              disabled={!dbConnected || saving || loading}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 hover:opacity-90 disabled:opacity-50 px-3.5 py-2 text-xs font-medium text-white dark:text-slate-900 transition-opacity whitespace-nowrap"
            >
              <Save className="h-3.5 w-3.5" />
              <span>{saving ? 'Saving...' : dirty ? 'Save profile' : 'Save changes'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Feedback / Error Banners */}
      {!dbConnected && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 px-4 py-3 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>Connect MongoDB Atlas below to load and persist your sender profile.</span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mx-6 mt-4 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 px-4 py-3 text-xs text-red-700 dark:text-red-300 flex items-center gap-2"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className={`mx-6 mt-4 rounded-lg border px-4 py-3 text-xs flex items-center gap-2 ${
            feedback.type === 'success'
              ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
              : 'border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Section Navigation */}
      <div className="px-6 pt-4 border-b border-slate-200 dark:border-slate-800 overflow-x-auto">
        <nav className="flex items-center gap-1 min-w-max" aria-label="Sender profile sections">
          {SECTION_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            const hasData = completion?.sections[tab.completionKey];
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{tab.label}</span>
                {tab.id === 'samples' && samples.length > 0 ? (
                  <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                    ({samples.length})
                  </span>
                ) : hasData ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                    title="Section has saved details"
                  />
                ) : null}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Section Content */}
      {loading ? (
        <div className="p-6 space-y-4 animate-pulse">
          <div className="h-10 rounded-lg bg-slate-100 dark:bg-slate-800" />
          <div className="h-24 rounded-lg bg-slate-100 dark:bg-slate-800" />
        </div>
      ) : activeTab !== 'samples' ? (
        <form onSubmit={(e) => void handleSaveProfile(e)} className="p-6 space-y-5">
          {activeTab === 'identity' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-fullName"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Full name
                  </label>
                  <input
                    id="sp-fullName"
                    type="text"
                    maxLength={120}
                    value={form.fullName}
                    onChange={(e) => updateField('fullName', e.target.value)}
                    placeholder="e.g. Jordan Rivera"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-title"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Professional title or role
                  </label>
                  <input
                    id="sp-title"
                    type="text"
                    maxLength={120}
                    value={form.professionalTitle}
                    onChange={(e) => updateField('professionalTitle', e.target.value)}
                    placeholder="e.g. Founder & Principal Consultant"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-org"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Organization or company name
                  </label>
                  <input
                    id="sp-org"
                    type="text"
                    maxLength={160}
                    value={form.organizationName}
                    onChange={(e) => updateField('organizationName', e.target.value)}
                    placeholder="e.g. SignalCraft Labs"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-email"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Professional email address
                  </label>
                  <input
                    id="sp-email"
                    type="email"
                    maxLength={254}
                    value={form.professionalEmail}
                    onChange={(e) => updateField('professionalEmail', e.target.value)}
                    placeholder="you@company.com"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  {fieldErrors.professionalEmail && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      {fieldErrors.professionalEmail}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <label
                    htmlFor="sp-website"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Website
                  </label>
                  <input
                    id="sp-website"
                    type="text"
                    maxLength={250}
                    value={form.website}
                    onChange={(e) => updateField('website', e.target.value)}
                    placeholder="https://yourcompany.com"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  {fieldErrors.website && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      {fieldErrors.website}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sp-shortIntro"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Short professional introduction
                </label>
                <textarea
                  id="sp-shortIntro"
                  rows={3}
                  maxLength={800}
                  value={form.shortIntro}
                  onChange={(e) => updateField('shortIntro', e.target.value)}
                  placeholder="1–2 sentences summarizing your background in your own words."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          )}

          {activeTab === 'work' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="sp-workDescription"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Description of your work
                </label>
                <textarea
                  id="sp-workDescription"
                  rows={3}
                  maxLength={2000}
                  value={form.workDescription}
                  onChange={(e) => updateField('workDescription', e.target.value)}
                  placeholder="What do you actually build, advise on, or operate day to day?"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sp-offerings"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Products, services, or initiatives offered
                </label>
                <textarea
                  id="sp-offerings"
                  rows={3}
                  maxLength={2000}
                  value={form.offerings}
                  onChange={(e) => updateField('offerings', e.target.value)}
                  placeholder="Concrete products, audits, retainers, or programs you offer."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-audience"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Primary audience or customer types
                  </label>
                  <textarea
                    id="sp-audience"
                    rows={2}
                    maxLength={1000}
                    value={form.primaryAudience}
                    onChange={(e) => updateField('primaryAudience', e.target.value)}
                    placeholder="e.g. Seed-to-Series B RevOps leaders, B2B SaaS engineering teams"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-objectives"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Main objectives for outreach
                  </label>
                  <textarea
                    id="sp-objectives"
                    rows={2}
                    maxLength={1500}
                    value={form.outreachObjectives}
                    onChange={(e) => updateField('outreachObjectives', e.target.value)}
                    placeholder="e.g. Start practical technical conversations, arrange co-marketing partnerships, or book scoping audits."
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sp-problemsSolved"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Problems you help solve
                </label>
                <textarea
                  id="sp-problemsSolved"
                  rows={2}
                  maxLength={1500}
                  value={form.problemsSolved}
                  onChange={(e) => updateField('problemsSolved', e.target.value)}
                  placeholder="Specific operational bottlenecks or outcomes you help teams fix."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          )}

          {activeTab === 'credibility' && (
            <div className="space-y-5">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 px-3.5 py-2.5 text-xs text-slate-600 dark:text-slate-400">
                Only list verified, accurate facts you are comfortable referencing in outbound messages. DeepSeek selects at most 1–2 relevant points when helpful and never invents missing metrics.
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <ListItemsInput
                  id="sp-achievements"
                  label="Verified achievements"
                  helper="Concrete milestones or credentials"
                  placeholder="e.g. Built and operated outbound infra for 12 B2B teams"
                  items={form.verifiedAchievements}
                  maxItems={20}
                  maxLen={300}
                  onChange={(next) => updateField('verifiedAchievements', next)}
                />

                <ListItemsInput
                  id="sp-metrics"
                  label="Approved statistics & measurable results"
                  helper="Only exact, defensible metrics you approve for outreach"
                  placeholder="e.g. Cut manual CRM routing cleanup by 6 hrs/week at pilot teams"
                  items={form.approvedMetrics}
                  maxItems={15}
                  maxLen={300}
                  onChange={(next) => updateField('approvedMetrics', next)}
                />

                <ListItemsInput
                  id="sp-caseStudies"
                  label="Case studies"
                  helper="Brief factual summaries of past client outcomes"
                  placeholder="e.g. Helped a 40-person logistics SaaS consolidate duplicate territory rules"
                  items={form.caseStudies}
                  maxItems={15}
                  maxLen={400}
                  onChange={(next) => updateField('caseStudies', next)}
                />

                <ListItemsInput
                  id="sp-partnerships"
                  label="Relevant partnerships, projects, or previous work"
                  helper="Useful for partnership proposals and shared ecosystem credibility"
                  placeholder="e.g. Co-hosted technical benchmark teardown with MetricCraft"
                  items={form.relevantPartnerships}
                  maxItems={15}
                  maxLen={300}
                  onChange={(next) => updateField('relevantPartnerships', next)}
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sp-experience"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Relevant experience
                </label>
                <textarea
                  id="sp-experience"
                  rows={3}
                  maxLength={1500}
                  value={form.relevantExperience}
                  onChange={(e) => updateField('relevantExperience', e.target.value)}
                  placeholder="Domain background, prior roles, or hands-on technical/industry context."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          )}

          {activeTab === 'writing' && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-tone"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Preferred default tone
                  </label>
                  <select
                    id="sp-tone"
                    value={form.preferredTone}
                    onChange={(e) =>
                      updateField('preferredTone', e.target.value as '' | AiWritingTone)
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    <option value="">No default preference</option>
                    <option value="professional">Professional</option>
                    <option value="conversational">Conversational</option>
                    <option value="direct">Direct</option>
                    <option value="persuasive">Persuasive</option>
                    <option value="friendly">Friendly</option>
                    <option value="formal">Formal</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-formality"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Preferred formality level
                  </label>
                  <select
                    id="sp-formality"
                    value={form.formalityLevel}
                    onChange={(e) =>
                      updateField(
                        'formalityLevel',
                        e.target.value as '' | 'casual' | 'balanced' | 'formal'
                      )
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    <option value="">No preference</option>
                    <option value="casual">Casual &amp; relaxed</option>
                    <option value="balanced">Balanced peer-to-peer</option>
                    <option value="formal">Formal executive</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-length"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Preferred default length
                  </label>
                  <select
                    id="sp-length"
                    value={form.preferredLength}
                    onChange={(e) =>
                      updateField('preferredLength', e.target.value as '' | AiEmailLength)
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    <option value="">No preference</option>
                    <option value="short">Short (45–95 words)</option>
                    <option value="medium">Medium (95–155 words)</option>
                    <option value="detailed">Detailed (165–240 words)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sp-sentenceStyle"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Preferred sentence style
                </label>
                <input
                  id="sp-sentenceStyle"
                  type="text"
                  maxLength={400}
                  value={form.sentenceStyle}
                  onChange={(e) => updateField('sentenceStyle', e.target.value)}
                  placeholder="e.g. Short plain sentences, contractions welcome, one idea per paragraph"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                <ListItemsInput
                  id="sp-commonPhrases"
                  label="Words & phrases you use naturally"
                  placeholder="e.g. happy to share a quick note"
                  items={form.commonPhrases}
                  maxItems={30}
                  maxLen={120}
                  onChange={(next) => updateField('commonPhrases', next)}
                />

                <ListItemsInput
                  id="sp-dislikedPhrases"
                  label="Words & phrases you dislike"
                  placeholder="e.g. synergy, quick call, game-changer"
                  items={form.dislikedPhrases}
                  maxItems={40}
                  maxLen={120}
                  onChange={(next) => updateField('dislikedPhrases', next)}
                />

                <ListItemsInput
                  id="sp-habitsToAvoid"
                  label="Specific writing habits to avoid"
                  placeholder="e.g. Never open with flattery"
                  items={form.habitsToAvoid}
                  maxItems={25}
                  maxLen={200}
                  onChange={(next) => updateField('habitsToAvoid', next)}
                />
              </div>
            </div>
          )}

          {activeTab === 'email' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-signOff"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Default sign-off
                  </label>
                  <input
                    id="sp-signOff"
                    type="text"
                    maxLength={120}
                    value={form.defaultSignOff}
                    onChange={(e) => updateField('defaultSignOff', e.target.value)}
                    placeholder="e.g. Best, / Thanks,"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="sp-ctaStyle"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Preferred CTA style
                  </label>
                  <input
                    id="sp-ctaStyle"
                    type="text"
                    maxLength={300}
                    value={form.preferredCtaStyle}
                    onChange={(e) => updateField('preferredCtaStyle', e.target.value)}
                    placeholder="e.g. Ask a simple yes/no question or offer an async 1-pager first"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sp-signature"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Email signature
                </label>
                <textarea
                  id="sp-signature"
                  rows={3}
                  maxLength={800}
                  value={form.emailSignature}
                  onChange={(e) => updateField('emailSignature', e.target.value)}
                  placeholder={'Jordan Rivera\nSignalCraft Labs · https://signalcraft.example'}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 px-3.5 py-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.includeRoleAndOrgInIntro}
                  onChange={(e) =>
                    updateField('includeRoleAndOrgInIntro', e.target.checked)
                  }
                  className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-600"
                />
                <div className="text-xs">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    Include my role and organization in introductions when helpful
                  </div>
                  <p className="text-slate-500 dark:text-slate-400 mt-0.5">
                    Uncheck if you prefer your messages to rely on context and your signature rather than introducing your title in the opening.
                  </p>
                </div>
              </label>

              <div className="space-y-1.5">
                <label
                  htmlFor="sp-otherInstructions"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Other standing instructions for outreach
                </label>
                <textarea
                  id="sp-otherInstructions"
                  rows={3}
                  maxLength={1500}
                  value={form.otherOutreachInstructions}
                  onChange={(e) => updateField('otherOutreachInstructions', e.target.value)}
                  placeholder="e.g. Never quote fixed pricing before scoping; keep follow-ups under 80 words."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {profile?.updatedAt
                ? `Last updated ${formatShortDate(profile.updatedAt)}`
                : 'Not yet saved'}
            </span>
            <button
              type="submit"
              disabled={!dbConnected || saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 hover:opacity-90 disabled:opacity-50 px-4 py-2 text-xs font-medium text-white dark:text-slate-900 transition-opacity"
            >
              <Save className="h-3.5 w-3.5" />
              <span>{saving ? 'Saving...' : 'Save sender profile'}</span>
            </button>
          </div>
        </form>
      ) : (
        /* Tab 6: Writing Samples */
        <div className="p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="space-y-0.5">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Writing samples ({samples.length}/25)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Saved samples act strictly as style references (sentence rhythm, warmth, and directness). DeepSeek will not copy sentences verbatim unless you ask.
              </p>
            </div>
            <button
              type="button"
              onClick={openNewSampleForm}
              disabled={!dbConnected || samples.length >= 25}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 hover:opacity-90 disabled:opacity-50 px-3.5 py-2 text-xs font-medium text-white dark:text-slate-900 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add writing sample</span>
            </button>
          </div>

          {sampleFormOpen && (
            <form
              onSubmit={(e) => void handleSaveSample(e)}
              className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 p-4 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {editingSampleId ? 'Edit writing sample' : 'New writing sample'}
                </div>
                <button
                  type="button"
                  onClick={() => setSampleFormOpen(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  aria-label="Close sample form"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {sampleError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-red-700 dark:text-red-300"
                >
                  {sampleError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="ws-title"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Title <span className="text-red-600 dark:text-red-400">*</span>
                  </label>
                  <input
                    id="ws-title"
                    type="text"
                    required
                    maxLength={140}
                    value={sampleTitle}
                    onChange={(e) => setSampleTitle(e.target.value)}
                    placeholder="e.g. Concise founder cold email"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="ws-category"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Category
                  </label>
                  <select
                    id="ws-category"
                    value={sampleCategory}
                    onChange={(e) =>
                      setSampleCategory(e.target.value as WritingSampleCategory)
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {(
                      Object.keys(WRITING_SAMPLE_CATEGORY_LABELS) as WritingSampleCategory[]
                    ).map((cat) => (
                      <option key={cat} value={cat}>
                        {WRITING_SAMPLE_CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="ws-description"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Optional description
                </label>
                <input
                  id="ws-description"
                  type="text"
                  maxLength={400}
                  value={sampleDescription}
                  onChange={(e) => setSampleDescription(e.target.value)}
                  placeholder="Context for when this voice works best (e.g. technical peers, warm intros)"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="ws-content"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Sample text <span className="text-red-600 dark:text-red-400">*</span>
                  </label>
                  <span className="text-[11px] font-mono tabular-nums text-slate-400">
                    {sampleContent.length}/4000
                  </span>
                </div>
                <textarea
                  id="ws-content"
                  rows={5}
                  required
                  maxLength={4000}
                  value={sampleContent}
                  onChange={(e) => setSampleContent(e.target.value)}
                  placeholder="Paste an authentic email or note you actually wrote..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setSampleFormOpen(false)}
                  disabled={savingSample}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSample}
                  className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3.5 py-1.5 text-xs font-medium text-white"
                >
                  {savingSample
                    ? 'Saving...'
                    : editingSampleId
                      ? 'Update sample'
                      : 'Save sample'}
                </button>
              </div>
            </form>
          )}

          {samples.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-8 text-center space-y-2">
              <FileText className="h-6 w-6 text-slate-400 mx-auto" />
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                No writing samples saved yet
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                Add 1–3 real emails or notes you&apos;ve written so DeepSeek can match your natural cadence without sounding templated.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              {samples.map((sample) => (
                <div key={sample.id} className="p-4 space-y-2 bg-white dark:bg-slate-900">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          {sample.title}
                        </span>
                        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                          · {WRITING_SAMPLE_CATEGORY_LABELS[sample.category]}
                        </span>
                        <span className="text-[11px] font-mono text-slate-400">
                          · {formatShortDate(sample.createdAt)}
                        </span>
                      </div>
                      {sample.description && (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {sample.description}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditSampleForm(sample)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <Edit3 className="h-3 w-3" />
                        <span>Edit</span>
                      </button>

                      {confirmDeleteSampleId === sample.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={deletingSampleId === sample.id}
                            onClick={() => void handleDeleteSample(sample.id)}
                            className="rounded-md bg-red-600 hover:bg-red-700 px-2.5 py-1 text-[11px] font-medium text-white"
                          >
                            {deletingSampleId === sample.id ? 'Deleting...' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteSampleId(null)}
                            className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteSampleId(sample.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>Delete</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3 text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-sans leading-relaxed max-h-36 overflow-y-auto">
                    {sample.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
