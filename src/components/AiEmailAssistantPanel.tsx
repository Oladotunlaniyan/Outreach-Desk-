import { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  RefreshCw,
  RotateCcw,
  Sparkles,
  UserCheck,
  Wand2,
  X,
} from 'lucide-react';
import type {
  AiCtaSuggestion,
  AiEmailLength,
  AiEmailMode,
  AiGeneratedEmailDraft,
  AiGenerateEmailPayload,
  AiRewriteAction,
  AiRewritePayload,
  AiStatusResponse,
  AiSubjectLineSuggestion,
  AiWritingTone,
  LeadItem,
  SenderProfileItem,
} from '../types/outreach';

interface AiEmailAssistantPanelProps {
  aiStatus: AiStatusResponse | null;
  loadingStatus: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  leads: LeadItem[];
  loadingLeads: boolean;
  selectedLeadId: string;
  onSelectLeadId: (leadId: string) => void;
  senderProfile: SenderProfileItem | null;
  useSenderProfile: boolean;
  onToggleUseSenderProfile: (value: boolean) => void;
  includeWritingSamples: boolean;
  onToggleIncludeWritingSamples: (value: boolean) => void;
  onOpenSenderSettings?: () => void;
  recipientEmail: string;
  currentSubject: string;
  currentText: string;
  currentHtml: string;
  sending: boolean;
  aiBusy: boolean;
  aiActionLabel: string | null;
  aiError: string | null;
  pendingDraft: AiGeneratedEmailDraft | null;
  subjectSuggestions: AiSubjectLineSuggestion[] | null;
  ctaSuggestions: AiCtaSuggestion[] | null;
  lastGenerationKind: 'generate' | AiRewriteAction | null;
  onGenerate: (payload: AiGenerateEmailPayload) => void;
  onRewrite: (payload: AiRewritePayload) => void;
  onSuggestSubjects: (options: { tone: AiWritingTone; instructions: string }) => void;
  onSuggestCtas: (options: {
    tone: AiWritingTone;
    mode: AiEmailMode;
    instructions: string;
  }) => void;
  onCancelAi: () => void;
  onAcceptDraft: (draft: AiGeneratedEmailDraft) => void;
  onDiscardDraft: () => void;
  onRegenerateLast: () => void;
  onApplySubject: (subject: string) => void;
  onDismissSubjects: () => void;
  onApplyCta: (cta: string, mode: 'append' | 'replace_last') => void;
  onDismissCtas: () => void;
}

const MODE_OPTIONS: Array<{ value: AiEmailMode; label: string }> = [
  { value: 'first_contact', label: 'First contact' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'sales', label: 'Sales' },
  { value: 'general', label: 'General professional' },
];

const TONE_OPTIONS: Array<{ value: AiWritingTone; label: string }> = [
  { value: 'professional', label: 'Professional' },
  { value: 'conversational', label: 'Conversational' },
  { value: 'direct', label: 'Direct' },
  { value: 'persuasive', label: 'Persuasive' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'formal', label: 'Formal' },
];

const LENGTH_OPTIONS: Array<{ value: AiEmailLength; label: string }> = [
  { value: 'short', label: 'Short' },
  { value: 'medium', label: 'Medium' },
  { value: 'detailed', label: 'Detailed' },
];

const QUICK_INSTRUCTION_PRESETS = [
  'Keep it under 120 words',
  'Less salesy',
  'More direct',
  'Focus on practical value',
  'Soft low-friction question',
];

const REWRITE_BUTTONS: Array<{ action: AiRewriteAction; label: string }> = [
  { action: 'rewrite', label: 'Rewrite' },
  { action: 'improve', label: 'Improve' },
  { action: 'shorten', label: 'Shorten' },
  { action: 'expand', label: 'Expand' },
  { action: 'change_tone', label: 'Change tone' },
];

export function AiEmailAssistantPanel({
  aiStatus,
  loadingStatus,
  isExpanded,
  onToggleExpanded,
  leads,
  loadingLeads,
  selectedLeadId,
  onSelectLeadId,
  senderProfile,
  useSenderProfile,
  onToggleUseSenderProfile,
  includeWritingSamples,
  onToggleIncludeWritingSamples,
  onOpenSenderSettings,
  recipientEmail,
  currentSubject,
  currentText,
  currentHtml,
  sending,
  aiBusy,
  aiActionLabel,
  aiError,
  pendingDraft,
  subjectSuggestions,
  ctaSuggestions,
  lastGenerationKind,
  onGenerate,
  onRewrite,
  onSuggestSubjects,
  onSuggestCtas,
  onCancelAi,
  onAcceptDraft,
  onDiscardDraft,
  onRegenerateLast,
  onApplySubject,
  onDismissSubjects,
  onApplyCta,
  onDismissCtas,
}: AiEmailAssistantPanelProps) {
  const [mode, setMode] = useState<AiEmailMode>('first_contact');
  const [tone, setTone] = useState<AiWritingTone>('professional');
  const [length, setLength] = useState<AiEmailLength>('medium');
  const [objective, setObjective] = useState('');
  const [instructions, setInstructions] = useState('');
  const [previousContext, setPreviousContext] = useState('');

  const [showManualContext, setShowManualContext] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualCompany, setManualCompany] = useState('');
  const [manualRole, setManualRole] = useState('');
  const [manualNotes, setManualNotes] = useState('');

  const [partnerProposal, setPartnerProposal] = useState('');
  const [partnerRelevance, setPartnerRelevance] = useState('');
  const [partnerMutualValue, setPartnerMutualValue] = useState('');
  const [partnerNextStep, setPartnerNextStep] = useState('');

  const selectedLead = leads.find((l) => l.id === selectedLeadId) || null;
  const aiConfigured = aiStatus ? aiStatus.configured : true;
  const hasDraftBody = Boolean(currentText.trim() || currentHtml.trim());
  const hasDraftSubjectOrBody = Boolean(hasDraftBody || currentSubject.trim());

  function appendPresetInstruction(preset: string) {
    setInstructions((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return preset;
      if (trimmed.toLowerCase().includes(preset.toLowerCase())) return prev;
      return `${trimmed}; ${preset}`;
    });
  }

  function handleGenerateSubmit() {
    const payload: AiGenerateEmailPayload = {
      ...(selectedLeadId ? { leadId: selectedLeadId } : {}),
      ...(!selectedLeadId &&
      (manualName.trim() ||
        manualCompany.trim() ||
        manualRole.trim() ||
        manualNotes.trim() ||
        recipientEmail.trim())
        ? {
            recipient: {
              name: manualName.trim(),
              email: recipientEmail.trim(),
              company: manualCompany.trim(),
              role: manualRole.trim(),
              notes: manualNotes.trim(),
            },
          }
        : {}),
      mode,
      tone,
      length,
      objective: objective.trim(),
      instructions: instructions.trim(),
      ...(mode === 'partnership'
        ? {
            partnershipContext: {
              proposal: partnerProposal.trim(),
              relevance: partnerRelevance.trim(),
              mutualValue: partnerMutualValue.trim(),
              nextStep: partnerNextStep.trim(),
            },
          }
        : {}),
      ...(mode === 'follow_up' && previousContext.trim()
        ? { previousContext: previousContext.trim() }
        : {}),
    };
    onGenerate(payload);
  }

  function handleRewriteClick(action: AiRewriteAction) {
    onRewrite({
      action,
      subject: currentSubject.trim(),
      text: currentText,
      html: currentHtml,
      tone,
      length,
      instructions: instructions.trim(),
      ...(selectedLeadId ? { leadId: selectedLeadId } : {}),
    });
  }

  return (
    <div className="space-y-3">
      {/* Unconfigured DeepSeek Banner */}
      {!loadingStatus && aiStatus && !aiStatus.configured && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 px-4 py-3 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-semibold">DeepSeek API key not configured</div>
            <p className="text-amber-800 dark:text-amber-300">
              Add <code className="font-mono">DEEPSEEK_API_KEY</code> to your server environment to enable AI drafting and draft improvement. You can still write and send emails manually below.
            </p>
          </div>
        </div>
      )}

      {/* Collapsible DeepSeek Assistant Box */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/50 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-slate-50 dark:bg-slate-900/70 border-b border-slate-200/80 dark:border-slate-800">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="flex items-center gap-2 text-left text-xs font-medium text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          >
            <Sparkles className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
            <span>Draft with DeepSeek AI</span>
            <span className="text-slate-400 font-normal">
              {aiStatus?.model ? `· ${aiStatus.model}` : ''}
            </span>
            {isExpanded ? (
              <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            )}
          </button>

          <div className="flex items-center gap-2 shrink-0">
            {aiBusy && (
              <button
                type="button"
                onClick={onCancelAi}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                <X className="h-3 w-3" />
                <span>Cancel</span>
              </button>
            )}
          </div>
        </div>

        {isExpanded && (
          <div className="p-4 space-y-4">
            {/* Lead Context Picker */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="ai-lead-select"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Lead personalization context
                </label>
                {!selectedLeadId && (
                  <button
                    type="button"
                    onClick={() => setShowManualContext((prev) => !prev)}
                    className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {showManualContext ? 'Hide recipient notes' : '+ Add recipient details'}
                  </button>
                )}
              </div>

              <select
                id="ai-lead-select"
                value={selectedLeadId}
                onChange={(e) => onSelectLeadId(e.target.value)}
                disabled={aiBusy || sending || loadingLeads}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60"
              >
                <option value="">
                  {loadingLeads
                    ? 'Loading stored leads...'
                    : 'None — use recipient details manually'}
                </option>
                {leads.map((lead) => (
                  <option key={lead.id} value={lead.id}>
                    {lead.fullName} ({lead.email})
                    {lead.company ? ` — ${lead.company}` : ''}
                    {lead.role ? `, ${lead.role}` : ''}
                  </option>
                ))}
              </select>

              {selectedLead && (
                <div className="text-[11px] text-slate-600 dark:text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
                  <UserCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {selectedLead.fullName}
                  </span>
                  {selectedLead.company && <span>· {selectedLead.company}</span>}
                  {selectedLead.role && <span>· {selectedLead.role}</span>}
                  <span>· Stage: {selectedLead.status}</span>
                  <span>· Notes: {selectedLead.notesCount}</span>
                  {selectedLead.optedOut && (
                    <span className="text-red-600 dark:text-red-400 font-medium">
                      · Opted out
                    </span>
                  )}
                  {selectedLead.bounced && (
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      · Bounced previously
                    </span>
                  )}
                </div>
              )}

              {!selectedLeadId && showManualContext && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2">
                  <input
                    type="text"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    disabled={aiBusy}
                    placeholder="Recipient name"
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <input
                    type="text"
                    value={manualCompany}
                    onChange={(e) => setManualCompany(e.target.value)}
                    disabled={aiBusy}
                    placeholder="Company"
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <input
                    type="text"
                    value={manualRole}
                    onChange={(e) => setManualRole(e.target.value)}
                    disabled={aiBusy}
                    placeholder="Role / title"
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <input
                    type="text"
                    value={manualNotes}
                    onChange={(e) => setManualNotes(e.target.value)}
                    disabled={aiBusy}
                    placeholder="Optional recipient notes or context"
                    className="sm:col-span-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              )}
            </div>

            {/* Sender Intelligence Controls (Compact & Unobtrusive) */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[11px]">
              {senderProfile?.completion.hasMeaningfulProfile ? (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-200 font-medium">
                      <input
                        type="checkbox"
                        checked={useSenderProfile}
                        disabled={aiBusy}
                        onChange={(e) => onToggleUseSenderProfile(e.target.checked)}
                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-600"
                      />
                      <span>Use sender profile</span>
                    </label>

                    {senderProfile.writingSamples.length > 0 && (
                      <label
                        className={`inline-flex items-center gap-1.5 cursor-pointer ${
                          useSenderProfile
                            ? 'text-slate-700 dark:text-slate-300'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={useSenderProfile && includeWritingSamples}
                          disabled={aiBusy || !useSenderProfile}
                          onChange={(e) =>
                            onToggleIncludeWritingSamples(e.target.checked)
                          }
                          className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-600 disabled:opacity-50"
                        />
                        <span>
                          Include writing samples ({senderProfile.writingSamples.length})
                        </span>
                      </label>
                    )}
                  </div>

                  <div className="text-slate-500 dark:text-slate-400 shrink-0">
                    {useSenderProfile
                      ? `${senderProfile.fullName || 'Saved profile'} · ${senderProfile.completion.percentage}% complete`
                      : 'Generating without sender profile'}
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 w-full text-slate-500 dark:text-slate-400">
                  <span>
                    No sender profile saved yet — drafts generate normally without it.
                  </span>
                  {onOpenSenderSettings && (
                    <button
                      type="button"
                      onClick={onOpenSenderSettings}
                      className="font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                    >
                      Add in Settings
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Mode, Tone, Length */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label
                  htmlFor="ai-mode-select"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Email mode
                </label>
                <select
                  id="ai-mode-select"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as AiEmailMode)}
                  disabled={aiBusy}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="ai-tone-select"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Writing tone
                </label>
                <select
                  id="ai-tone-select"
                  value={tone}
                  onChange={(e) => setTone(e.target.value as AiWritingTone)}
                  disabled={aiBusy}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {TONE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Length
                </span>
                <div
                  role="group"
                  aria-label="Email length"
                  className="grid grid-cols-3 rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-white dark:bg-slate-900"
                >
                  {LENGTH_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={aiBusy}
                      onClick={() => setLength(opt.value)}
                      className={`rounded-md py-1 text-[11px] font-medium transition-colors ${
                        length === opt.value
                          ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Mode-Specific Context */}
            {mode === 'partnership' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
                <input
                  type="text"
                  value={partnerProposal}
                  onChange={(e) => setPartnerProposal(e.target.value)}
                  disabled={aiBusy}
                  placeholder="Partnership / collaboration proposal"
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <input
                  type="text"
                  value={partnerRelevance}
                  onChange={(e) => setPartnerRelevance(e.target.value)}
                  disabled={aiBusy}
                  placeholder="Why this partner is relevant"
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <input
                  type="text"
                  value={partnerMutualValue}
                  onChange={(e) => setPartnerMutualValue(e.target.value)}
                  disabled={aiBusy}
                  placeholder="Mutual value / benefit"
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <input
                  type="text"
                  value={partnerNextStep}
                  onChange={(e) => setPartnerNextStep(e.target.value)}
                  disabled={aiBusy}
                  placeholder="Preferred next step (e.g. 15-min intro)"
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            )}

            {mode === 'follow_up' && (
              <div className="space-y-1">
                <label
                  htmlFor="ai-prev-context"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Additional follow-up context{' '}
                  <span className="font-normal text-slate-400">
                    (prior email history is included automatically for selected leads)
                  </span>
                </label>
                <textarea
                  id="ai-prev-context"
                  rows={2}
                  value={previousContext}
                  onChange={(e) => setPreviousContext(e.target.value)}
                  disabled={aiBusy}
                  placeholder="Optional: mention a prior call, demo note, or specific angle for this follow-up..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            )}

            {/* Objective & Instructions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label
                  htmlFor="ai-objective"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Email goal / objective
                  {mode === 'general' && (
                    <span className="text-red-600 dark:text-red-400"> *</span>
                  )}
                </label>
                <input
                  id="ai-objective"
                  type="text"
                  maxLength={1000}
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  disabled={aiBusy}
                  placeholder="e.g. Intro our analytics workflow and ask for feedback"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="ai-instructions"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Additional instructions
                </label>
                <input
                  id="ai-instructions"
                  type="text"
                  maxLength={1000}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  disabled={aiBusy}
                  placeholder="e.g. Reference their website, avoid pricing details"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            {/* Quick instruction presets + Generate trigger */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_INSTRUCTION_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    disabled={aiBusy}
                    onClick={() => appendPresetInstruction(preset)}
                    className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                  >
                    + {preset}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {aiBusy && (
                  <button
                    type="button"
                    onClick={onCancelAi}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleGenerateSubmit}
                  disabled={!aiConfigured || aiBusy || sending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 hover:opacity-90 disabled:opacity-50 px-3.5 py-2 text-xs font-medium text-white dark:text-slate-900 transition-opacity whitespace-nowrap"
                >
                  {aiBusy && aiActionLabel === 'Generating draft...' ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Generating...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Generate draft</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Draft Improvement Toolbar (always accessible when working on a draft) */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 mr-1">
            <Wand2 className="h-3 w-3" />
            <span>Refine draft:</span>
          </span>
          {REWRITE_BUTTONS.map((btn) => (
            <button
              key={btn.action}
              type="button"
              disabled={!aiConfigured || aiBusy || sending || !hasDraftBody}
              onClick={() => handleRewriteClick(btn.action)}
              title={
                btn.action === 'change_tone'
                  ? `Adapt draft to ${tone} tone`
                  : `${btn.label} current email draft`
              }
              className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              {btn.action === 'change_tone' ? `Tone: ${tone}` : btn.label}
            </button>
          ))}
          <button
            type="button"
            disabled={!aiConfigured || aiBusy || sending || !hasDraftSubjectOrBody}
            onClick={() => onSuggestSubjects({ tone, instructions: instructions.trim() })}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            <Lightbulb className="h-3 w-3 text-amber-500" />
            <span>Subject ideas</span>
          </button>
          <button
            type="button"
            disabled={!aiConfigured || aiBusy || sending || !hasDraftBody}
            onClick={() =>
              onSuggestCtas({ tone, mode, instructions: instructions.trim() })
            }
            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            CTA ideas
          </button>
        </div>

        {aiBusy && (
          <div className="flex items-center gap-2 text-[11px] text-blue-600 dark:text-blue-400">
            <RefreshCw className="h-3 w-3 animate-spin" />
            <span>{aiActionLabel || 'Working with DeepSeek...'}</span>
            <button
              type="button"
              onClick={onCancelAi}
              className="font-medium underline text-slate-600 dark:text-slate-300"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* AI Error Banner */}
      {aiError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300 flex items-start gap-2"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{aiError}</span>
        </div>
      )}

      {/* Pending Generated / Revised Draft Proposal (Human Review Required) */}
      {pendingDraft && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50/40 dark:bg-blue-950/20 p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-blue-200/70 dark:border-blue-900/50 pb-2.5">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                <Sparkles className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                <span>
                  {lastGenerationKind && lastGenerationKind !== 'generate'
                    ? `Proposed AI revision (${lastGenerationKind.replace('_', ' ')})`
                    : 'Proposed AI email draft'}
                </span>
              </div>
              <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {pendingDraft.meta.model}
                {' · '}
                {pendingDraft.meta.durationMs}ms
                {pendingDraft.meta.usage.totalTokens !== null
                  ? ` · ${pendingDraft.meta.usage.totalTokens} tokens`
                  : ''}
                {pendingDraft.meta.senderProfileUsed
                  ? ` · sender voice${
                      pendingDraft.meta.writingSamplesUsedCount
                        ? ` + ${pendingDraft.meta.writingSamplesUsedCount} sample${
                            pendingDraft.meta.writingSamplesUsedCount === 1 ? '' : 's'
                          }`
                        : ''
                    }`
                  : ''}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onDiscardDraft}
                disabled={aiBusy}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={onRegenerateLast}
                disabled={aiBusy}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Regenerate</span>
              </button>
              <button
                type="button"
                onClick={() => onAcceptDraft(pendingDraft)}
                disabled={aiBusy}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Accept into composer</span>
              </button>
            </div>
          </div>

          <div className="space-y-2 text-xs">
            <div>
              <span className="font-medium text-slate-500 dark:text-slate-400">Subject: </span>
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {pendingDraft.subject}
              </span>
            </div>
            <pre className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap font-sans leading-relaxed max-h-52 overflow-y-auto">
              {pendingDraft.text}
            </pre>
          </div>

          {(pendingDraft.personalizationNotes.length > 0 ||
            pendingDraft.missingInformation.length > 0) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 text-[11px]">
              {pendingDraft.personalizationNotes.length > 0 && (
                <div className="space-y-1">
                  <div className="font-semibold text-slate-700 dark:text-slate-300">
                    Personalization notes
                  </div>
                  <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-400">
                    {pendingDraft.personalizationNotes.map((note, idx) => (
                      <li key={idx}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}
              {pendingDraft.missingInformation.length > 0 && (
                <div className="space-y-1">
                  <div className="font-semibold text-amber-800 dark:text-amber-300">
                    Missing context & safeguards
                  </div>
                  <ul className="list-disc pl-4 space-y-0.5 text-amber-800/90 dark:text-amber-300/90">
                    {pendingDraft.missingInformation.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Subject Line Suggestions */}
      {subjectSuggestions && subjectSuggestions.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Subject line alternatives
            </div>
            <button
              type="button"
              onClick={onDismissSubjects}
              className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label="Close subject suggestions"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {subjectSuggestions.map((item, idx) => (
              <div
                key={idx}
                className="py-2 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-900 dark:text-slate-100">
                    {item.subject}
                  </div>
                  {item.rationale && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {item.rationale}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onApplySubject(item.subject)}
                  className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0 self-start sm:self-center"
                >
                  Use subject
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* CTA Suggestions */}
      {ctaSuggestions && ctaSuggestions.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Call-to-action ideas
            </div>
            <button
              type="button"
              onClick={onDismissCtas}
              className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label="Close CTA suggestions"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {ctaSuggestions.map((item, idx) => (
              <div
                key={idx}
                className="py-2 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-900 dark:text-slate-100">
                    {item.cta}
                  </div>
                  {item.rationale && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {item.rationale}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0 self-start sm:self-center">
                  <button
                    type="button"
                    onClick={() => onApplyCta(item.cta, 'append')}
                    className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Append
                  </button>
                  <button
                    type="button"
                    onClick={() => onApplyCta(item.cta, 'replace_last')}
                    className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Replace ending
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
