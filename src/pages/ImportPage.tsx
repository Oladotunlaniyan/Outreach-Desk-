import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import Papa from 'papaparse';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileSpreadsheet,
  RefreshCw,
  Send,
  Upload,
  X,
} from 'lucide-react';
import { ApiError, apiFetch, getStoredToken } from '../lib/api';
import type {
  ClassifiedImportRow,
  ColumnMapping,
  ImportCommitResponse,
  ImportFieldKey,
  ImportPreviewResponse,
  ImportRowClassification,
  ImportRowInput,
  MailboxItem,
  MailboxesListResponse,
} from '../types/outreach';

interface ImportPageProps {
  onImportCompleted: () => void;
  onNavigateToLeads: () => void;
  onCampaignCreated?: () => void;
}

type ImportStep = 'upload' | 'mapping' | 'preview' | 'results';
type PreviewFilter = 'all' | ImportRowClassification;
type ImportDestinationMode = 'leads_only' | 'leads_and_campaign';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DATA_ROWS = 5000;
const PREVIEW_PAGE_SIZE = 50;

interface TargetFieldDefinition {
  key: ImportFieldKey;
  label: string;
  required: boolean;
  helper: string;
  aliases: string[];
}

const TARGET_FIELDS: TargetFieldDefinition[] = [
  {
    key: 'email',
    label: 'Email address',
    required: true,
    helper: 'Used for deduplication and outreach',
    aliases: ['email', 'emailaddress', 'email_address', 'e-mail', 'workemail', 'mail', 'contactemail'],
  },
  {
    key: 'fullName',
    label: 'Full name',
    required: false,
    helper: 'Contact full name',
    aliases: ['name', 'fullname', 'full_name', 'contactname', 'contact_name', 'personname', 'leadname'],
  },
  {
    key: 'company',
    label: 'Company',
    required: false,
    helper: 'Organization or account name',
    aliases: ['company', 'companyname', 'company_name', 'organization', 'organisation', 'org', 'account', 'business'],
  },
  {
    key: 'role',
    label: 'Job title',
    required: false,
    helper: 'Position or role',
    aliases: ['title', 'jobtitle', 'job_title', 'position', 'role', 'designation'],
  },
  {
    key: 'website',
    label: 'Website',
    required: false,
    helper: 'Company or personal URL',
    aliases: ['website', 'url', 'companywebsite', 'company_website', 'domain', 'web', 'site'],
  },
  {
    key: 'linkedinUrl',
    label: 'LinkedIn URL',
    required: false,
    helper: 'LinkedIn profile URL',
    aliases: ['linkedin', 'linkedinurl', 'linkedin_url', 'linkedinprofile', 'linkedin_profile', 'liurl'],
  },
  {
    key: 'location',
    label: 'Location',
    required: false,
    helper: 'City, region, or country',
    aliases: ['location', 'city', 'country', 'region', 'address', 'hq'],
  },
  {
    key: 'source',
    label: 'Source',
    required: false,
    helper: 'Defaults to CSV if unmapped or blank',
    aliases: ['source', 'leadsource', 'lead_source'],
  },
  {
    key: 'status',
    label: 'Pipeline status',
    required: false,
    helper: 'Defaults to New if unmapped or blank',
    aliases: ['status', 'pipelinestatus', 'pipeline_status', 'stage'],
  },
  {
    key: 'notes',
    label: 'Notes',
    required: false,
    helper: 'Initial contact note',
    aliases: ['notes', 'note', 'comments', 'comment', 'description'],
  },
  {
    key: 'tags',
    label: 'Tags',
    required: false,
    helper: 'Semicolon or pipe-separated tags (e.g. saas;q2)',
    aliases: ['tags', 'tag', 'labels', 'label'],
  },
  {
    key: 'subject',
    label: 'Email subject (per row)',
    required: false,
    helper: 'Optional row-level subject override with {{placeholders}}',
    aliases: ['subject', 'emailsubject', 'email_subject', 'campaignsubject'],
  },
  {
    key: 'bodyText',
    label: 'Email body text (per row)',
    required: false,
    helper: 'Optional row-level plain-text body with {{placeholders}}',
    aliases: ['body', 'bodytext', 'body_text', 'emailbody', 'email_body', 'message', 'copy'],
  },
  {
    key: 'bodyHtml',
    label: 'Email body HTML (per row)',
    required: false,
    helper: 'Optional sanitized HTML body override',
    aliases: ['bodyhtml', 'body_html', 'html', 'htmlbody', 'html_body'],
  },
];

function normalizeHeaderKey(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizeCustomPlaceholderKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function emptyMapping(): ColumnMapping {
  return {
    fullName: '',
    email: '',
    company: '',
    role: '',
    website: '',
    linkedinUrl: '',
    location: '',
    source: '',
    status: '',
    notes: '',
    tags: '',
    subject: '',
    bodyText: '',
    bodyHtml: '',
  };
}

function autoDetectColumnMapping(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();
  const usedHeaders = new Set<string>();

  for (const field of TARGET_FIELDS) {
    const normalizedAliases = field.aliases.map((a) => normalizeHeaderKey(a));
    const matched = headers.find((header) => {
      if (usedHeaders.has(header)) return false;
      const norm = normalizeHeaderKey(header);
      return normalizedAliases.includes(norm);
    });

    if (matched) {
      mapping[field.key] = matched;
      usedHeaders.add(matched);
    }
  }

  return mapping;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function classificationLabel(classification: ImportRowClassification): string {
  switch (classification) {
    case 'ready':
      return 'Ready to import';
    case 'existing_in_db':
      return 'Already in DB';
    case 'duplicate_in_csv':
      return 'Duplicate in CSV';
    case 'suppressed':
      return 'Suppressed';
    case 'invalid':
      return 'Invalid';
  }
}

export function ImportPage({
  onImportCompleted,
  onNavigateToLeads,
  onCampaignCreated,
}: ImportPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState<ImportStep>('upload');
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<{ name: string; size: number } | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [rawRecords, setRawRecords] = useState<Array<Record<string, string>>>([]);
  const [mapping, setMapping] = useState<ColumnMapping>(emptyMapping);

  const [importMode, setImportMode] = useState<ImportDestinationMode>('leads_only');
  const [mailboxes, setMailboxes] = useState<MailboxItem[]>([]);
  const [campaignName, setCampaignName] = useState('');
  const [campaignMailboxId, setCampaignMailboxId] = useState('');
  const [campaignReplyTo, setCampaignReplyTo] = useState('');
  const [campaignSubjectTpl, setCampaignSubjectTpl] = useState(
    'Quick question for {{first_name}} at {{company}}'
  );
  const [campaignBodyTextTpl, setCampaignBodyTextTpl] = useState(
    'Hi {{first_name}},\n\nWanted to reach out regarding {{company}}.\n\nOpen to a quick chat?\n\nBest,'
  );
  const [includeExistingInCampaign, setIncludeExistingInCampaign] = useState(true);
  const [launchImmediately, setLaunchImmediately] = useState(false);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<ImportPreviewResponse | null>(null);
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>('all');
  const [previewPage, setPreviewPage] = useState(1);
  const [inspectedRow, setInspectedRow] = useState<ClassifiedImportRow | null>(null);

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<ImportCommitResponse | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<MailboxesListResponse>('/api/mailboxes')
      .then((res) => {
        if (!active) return;
        const available = res.mailboxes.filter((m) => !m.archived);
        setMailboxes(available);
        const preferred =
          available.find((m) => m.enabled && m.verificationStatus === 'verified') ||
          available[0];
        if (preferred) {
          setCampaignMailboxId((prev) => prev || preferred.id);
          setCampaignReplyTo((prev) => prev || preferred.replyTo || '');
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function handleDownloadTemplate() {
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

  function resetAll() {
    setStep('upload');
    setDragging(false);
    setParsing(false);
    setFileError(null);
    setSelectedFile(null);
    setCsvHeaders([]);
    setRawRecords([]);
    setMapping(emptyMapping());
    setImportMode('leads_only');
    setCampaignName('');
    setLaunchImmediately(false);
    setPreviewLoading(false);
    setPreviewError(null);
    setPreviewResult(null);
    setPreviewFilter('all');
    setPreviewPage(1);
    setInspectedRow(null);
    setCommitting(false);
    setCommitError(null);
    setCommitResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function handleFileSelected(file: File | null) {
    if (!file) return;
    setFileError(null);

    const lowerName = file.name.toLowerCase();
    const validExtension = lowerName.endsWith('.csv');
    const validMime =
      !file.type ||
      file.type === 'text/csv' ||
      file.type === 'application/csv' ||
      file.type === 'application/vnd.ms-excel' ||
      file.type === 'text/plain';

    if (!validExtension || !validMime) {
      setFileError('Please select a valid .csv file.');
      return;
    }

    if (file.size === 0) {
      setFileError('The selected CSV file is empty.');
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setFileError(
        `File size (${formatBytes(file.size)}) exceeds the ${formatBytes(MAX_FILE_SIZE_BYTES)} limit.`
      );
      return;
    }

    setParsing(true);

    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
      complete: (results) => {
        setParsing(false);

        if (results.errors.length > 0 && results.data.length === 0) {
          setFileError(results.errors[0]?.message || 'Could not parse CSV file.');
          return;
        }

        const headers = (results.meta.fields || []).filter((h) => h.trim().length > 0);
        if (headers.length === 0) {
          setFileError('No CSV column headers were detected.');
          return;
        }

        const normalizedRows: Array<Record<string, string>> = [];
        for (const rawRow of results.data) {
          const rowObj: Record<string, string> = {};
          let hasNonEmptyCell = false;
          for (const h of headers) {
            const val = rawRow[h];
            const str = val === null || val === undefined ? '' : String(val).trim();
            if (str) hasNonEmptyCell = true;
            rowObj[h] = str;
          }
          if (hasNonEmptyCell) {
            normalizedRows.push(rowObj);
          }
        }

        if (normalizedRows.length === 0) {
          setFileError('The CSV file contains headers but no data rows.');
          return;
        }

        if (normalizedRows.length > MAX_DATA_ROWS) {
          setFileError(
            `This CSV has ${normalizedRows.length.toLocaleString()} rows, which exceeds the ${MAX_DATA_ROWS.toLocaleString()}-row limit per import.`
          );
          return;
        }

        setSelectedFile({ name: file.name, size: file.size });
        setCsvHeaders(headers);
        setRawRecords(normalizedRows);
        setMapping(autoDetectColumnMapping(headers));
        setPreviewResult(null);
        setPreviewError(null);
        setCommitResult(null);
        setCommitError(null);
        setStep('mapping');
      },
      error: (err) => {
        setParsing(false);
        setFileError(err.message || 'Failed to read CSV file.');
      },
    });
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (parsing) return;
    const file = e.dataTransfer.files?.[0] || null;
    handleFileSelected(file);
  }

  const unmappedCustomHeaders = useMemo(() => {
    const mappedSet = new Set(Object.values(mapping).filter(Boolean));
    return csvHeaders.filter((h) => !mappedSet.has(h));
  }, [csvHeaders, mapping]);

  function buildMappedRows(): ImportRowInput[] {
    const mappedSet = new Set(Object.values(mapping).filter(Boolean));
    const customHeaders = csvHeaders.filter((h) => !mappedSet.has(h));

    return rawRecords.map((record, index) => {
      const customFields: Record<string, string> = {};
      for (const h of customHeaders) {
        const key = normalizeCustomPlaceholderKey(h);
        const val = record[h];
        if (key && val) {
          customFields[key] = val;
        }
      }
      return {
        rowNumber: index + 1,
        fullName: mapping.fullName ? record[mapping.fullName] || '' : '',
        email: mapping.email ? record[mapping.email] || '' : '',
        company: mapping.company ? record[mapping.company] || '' : '',
        role: mapping.role ? record[mapping.role] || '' : '',
        website: mapping.website ? record[mapping.website] || '' : '',
        linkedinUrl: mapping.linkedinUrl ? record[mapping.linkedinUrl] || '' : '',
        location: mapping.location ? record[mapping.location] || '' : '',
        source: mapping.source ? record[mapping.source] || '' : '',
        status: mapping.status ? record[mapping.status] || '' : '',
        notes: mapping.notes ? record[mapping.notes] || '' : '',
        tags: mapping.tags ? record[mapping.tags] || '' : '',
        subject: mapping.subject ? record[mapping.subject] || '' : '',
        bodyText: mapping.bodyText ? record[mapping.bodyText] || '' : '',
        bodyHtml: mapping.bodyHtml ? record[mapping.bodyHtml] || '' : '',
        customFields,
      };
    });
  }

  async function handleRunPreview() {
    if (!mapping.email || previewLoading) return;
    if (importMode === 'leads_and_campaign') {
      if (!campaignName.trim()) {
        setPreviewError('Enter a campaign name before continuing.');
        return;
      }
      if (!campaignMailboxId) {
        setPreviewError('Select a sender mailbox for the campaign.');
        return;
      }
      if (!mapping.subject && !campaignSubjectTpl.trim()) {
        setPreviewError('Provide a fallback subject template or map a CSV subject column.');
        return;
      }
      if (!mapping.bodyText && !mapping.bodyHtml && !campaignBodyTextTpl.trim()) {
        setPreviewError('Provide a fallback body template or map a CSV body column.');
        return;
      }
    }

    setPreviewLoading(true);
    setPreviewError(null);

    try {
      const rows = buildMappedRows();
      const res = await apiFetch<ImportPreviewResponse>('/api/leads/import/preview', {
        method: 'POST',
        body: JSON.stringify({
          rows,
          ...(importMode === 'leads_and_campaign'
            ? {
                templatePreview: {
                  subjectTemplate: campaignSubjectTpl,
                  bodyTextTemplate: campaignBodyTextTpl,
                },
              }
            : {}),
        }),
      });
      setPreviewResult(res);
      setPreviewFilter('all');
      setPreviewPage(1);
      setStep('preview');
    } catch (err) {
      setPreviewError(
        err instanceof ApiError ? err.message : 'Failed to validate CSV rows.'
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCommitImport() {
    if (!previewResult || committing) return;
    const canCommitLeads = previewResult.summary.readyCount > 0;
    const canCommitCampaign =
      importMode === 'leads_and_campaign' &&
      (previewResult.summary.readyCount > 0 ||
        (includeExistingInCampaign && previewResult.summary.existingInDbCount > 0));
    if (!canCommitLeads && !canCommitCampaign) return;

    setCommitting(true);
    setCommitError(null);

    try {
      const rows = buildMappedRows();
      const res = await apiFetch<ImportCommitResponse>('/api/leads/import', {
        method: 'POST',
        body: JSON.stringify({
          rows,
          mode: importMode,
          ...(importMode === 'leads_and_campaign'
            ? {
                campaign: {
                  name: campaignName.trim(),
                  mailboxId: campaignMailboxId,
                  replyTo: campaignReplyTo.trim(),
                  subjectTemplate: campaignSubjectTpl,
                  bodyTextTemplate: campaignBodyTextTpl,
                  includeExistingLeadsInCampaign: includeExistingInCampaign,
                  launchImmediately,
                },
              }
            : {}),
        }),
      });
      setCommitResult(res);
      setStep('results');
    } catch (err) {
      setCommitError(
        err instanceof ApiError ? err.message : 'Failed to commit CSV import.'
      );
    } finally {
      setCommitting(false);
    }
  }

  const filteredPreviewRows = useMemo<ClassifiedImportRow[]>(() => {
    if (!previewResult) return [];
    if (previewFilter === 'all') return previewResult.rows;
    return previewResult.rows.filter((r) => r.classification === previewFilter);
  }, [previewResult, previewFilter]);

  const previewTotalPages = Math.max(
    1,
    Math.ceil(filteredPreviewRows.length / PREVIEW_PAGE_SIZE)
  );
  const pagedPreviewRows = useMemo(() => {
    const start = (previewPage - 1) * PREVIEW_PAGE_SIZE;
    return filteredPreviewRows.slice(start, start + PREVIEW_PAGE_SIZE);
  }, [filteredPreviewRows, previewPage]);

  const steps: Array<{ id: ImportStep; label: string; number: string }> = [
    { id: 'upload', label: 'Upload CSV', number: '01' },
    { id: 'mapping', label: 'Map columns', number: '02' },
    { id: 'preview', label: 'Preview & duplicates', number: '03' },
    { id: 'results', label: 'Import summary', number: '04' },
  ];

  return (
    <div className="space-y-6">
      {/* Top Action & Step Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
            CSV lead import
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Parse prospect lists, map columns, inspect duplicates, and import eligible contacts
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => void handleDownloadTemplate()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>CSV template</span>
          </button>

          <button
            type="button"
            onClick={onNavigateToLeads}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Leads</span>
          </button>
        </div>
      </div>

      {/* Step Progression */}
      <nav
        aria-label="Import progress"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-3.5 grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        {steps.map((item) => {
          const isCurrent = item.id === step;
          const stepIndex = steps.findIndex((s) => s.id === item.id);
          const currentIndex = steps.findIndex((s) => s.id === step);
          const isCompleted = stepIndex < currentIndex;
          return (
            <div
              key={item.id}
              className={`flex items-center gap-2.5 text-xs font-medium ${
                isCurrent
                  ? 'text-blue-600 dark:text-blue-400'
                  : isCompleted
                    ? 'text-slate-900 dark:text-slate-100'
                    : 'text-slate-400 dark:text-slate-500'
              }`}
            >
              <span className="font-mono tabular-nums">{item.number}.</span>
              <span className="truncate">{item.label}</span>
            </div>
          );
        })}
      </nav>

      {/* Step 1: Upload CSV */}
      {step === 'upload' && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragging(false);
            }}
            onDrop={handleDrop}
            className={`rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
              dragging
                ? 'border-blue-500 bg-blue-50/40 dark:bg-blue-950/20'
                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
            }`}
          >
            <Upload className="h-9 w-9 mx-auto text-slate-400 dark:text-slate-500" />
            <h3 className="mt-4 font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              {parsing ? 'Parsing CSV file...' : 'Drop your CSV file here'}
            </h3>
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Supports quoted fields, embedded commas, and UTF-8 characters. Maximum{' '}
              <span className="font-mono">5 MB</span> and{' '}
              <span className="font-mono">5,000</span> data rows.
            </p>

            <div className="mt-6 flex items-center justify-center">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => handleFileSelected(e.target.files?.[0] || null)}
                className="hidden"
                id="csv-upload-input"
              />
              <label
                htmlFor="csv-upload-input"
                className="cursor-pointer inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 text-sm font-medium transition-colors min-h-[40px]"
              >
                <FileSpreadsheet className="h-4 w-4" />
                <span>{parsing ? 'Reading file...' : 'Choose CSV file'}</span>
              </label>
            </div>
          </div>

          {fileError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{fileError}</span>
            </div>
          )}
        </section>
      )}

      {/* Step 2: Column Mapping */}
      {step === 'mapping' && selectedFile && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <FileSpreadsheet className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {selectedFile.name}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  {formatBytes(selectedFile.size)} · {rawRecords.length.toLocaleString()} rows ·{' '}
                  {csvHeaders.length} columns
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={resetAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 self-start sm:self-auto whitespace-nowrap"
            >
              <X className="h-3.5 w-3.5" />
              <span>Cancel file</span>
            </button>
          </div>

          <div className="p-6 space-y-5">
            {previewError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300"
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{previewError}</span>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <th className="py-2.5 pr-4">Lead field</th>
                    <th className="py-2.5 px-4">CSV column</th>
                    <th className="py-2.5 pl-4">First-row sample</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                  {TARGET_FIELDS.map((field) => {
                    const mappedHeader = mapping[field.key];
                    const sampleValue = mappedHeader ? rawRecords[0]?.[mappedHeader] || '' : '';
                    return (
                      <tr key={field.key}>
                        <td className="py-3 pr-4 align-top">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {field.label}{' '}
                            {field.required && <span className="text-red-500">*</span>}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {field.helper}
                          </div>
                        </td>
                        <td className="py-3 px-4 align-top min-w-[220px]">
                          <select
                            aria-label={`Map ${field.label}`}
                            value={mappedHeader}
                            onChange={(e) =>
                              setMapping((prev) => ({
                                ...prev,
                                [field.key]: e.target.value,
                              }))
                            }
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                          >
                            <option value="">
                              {field.required ? '— Select email column —' : '— Skip / Default —'}
                            </option>
                            {csvHeaders.map((header) => (
                              <option key={header} value={header}>
                                {header}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3 pl-4 align-top text-xs text-slate-600 dark:text-slate-300 max-w-[260px] truncate">
                          {sampleValue || <span className="text-slate-400">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {unmappedCustomHeaders.length > 0 && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  Custom columns detected as placeholders:
                </span>{' '}
                <span className="font-mono">
                  {unmappedCustomHeaders
                    .map((h) => `{{${normalizeCustomPlaceholderKey(h)}}}`)
                    .join(', ')}
                </span>
              </div>
            )}

            {/* Import Destination Toggle */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Import destination
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Save new leads only, or create a campaign from this CSV
                  </div>
                </div>
                <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 self-start">
                  <button
                    type="button"
                    onClick={() => setImportMode('leads_only')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      importMode === 'leads_only'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Leads only
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setImportMode('leads_and_campaign');
                      if (!campaignName && selectedFile) {
                        setCampaignName(selectedFile.name.replace(/\.csv$/i, ''));
                      }
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      importMode === 'leads_and_campaign'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Leads + Campaign
                  </button>
                </div>
              </div>

              {importMode === 'leads_and_campaign' && (
                <div className="space-y-4 pt-3 border-t border-slate-200 dark:border-slate-800">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Campaign name *
                      </label>
                      <input
                        type="text"
                        value={campaignName}
                        onChange={(e) => setCampaignName(e.target.value)}
                        placeholder="Q2 CSV Outreach"
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Sender mailbox *
                      </label>
                      <select
                        value={campaignMailboxId}
                        onChange={(e) => {
                          setCampaignMailboxId(e.target.value);
                          const mb = mailboxes.find((m) => m.id === e.target.value);
                          if (mb && !campaignReplyTo) setCampaignReplyTo(mb.replyTo || '');
                        }}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                      >
                        <option value="">Select mailbox</option>
                        {mailboxes.map((mb) => (
                          <option key={mb.id} value={mb.id}>
                            {mb.name} ({mb.senderEmail})
                            {mb.verificationStatus !== 'verified' ? ' — unverified' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Reply-To (optional)
                      </label>
                      <input
                        type="email"
                        value={campaignReplyTo}
                        onChange={(e) => setCampaignReplyTo(e.target.value)}
                        placeholder="replies@yourdomain.com"
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Fallback subject template{' '}
                        {mapping.subject ? '(used when CSV subject is blank)' : '*'}
                      </label>
                      <input
                        type="text"
                        value={campaignSubjectTpl}
                        onChange={(e) => setCampaignSubjectTpl(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Fallback plain-text body{' '}
                        {mapping.bodyText ? '(used when CSV body is blank)' : '*'}
                      </label>
                      <textarea
                        rows={3}
                        value={campaignBodyTextTpl}
                        onChange={(e) => setCampaignBodyTextTpl(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-4 text-xs text-slate-700 dark:text-slate-300">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={includeExistingInCampaign}
                        onChange={(e) => setIncludeExistingInCampaign(e.target.checked)}
                      />
                      <span>Include existing non-suppressed DB leads in this campaign</span>
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={launchImmediately}
                        onChange={(e) => setLaunchImmediately(e.target.checked)}
                      />
                      <span>Launch sending immediately after import (requires verified mailbox)</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            {!mapping.email && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Select the CSV column containing email addresses to run duplicate detection and preview.
              </p>
            )}

            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={resetAll}
                disabled={previewLoading}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                Choose another file
              </button>

              <button
                type="button"
                onClick={() => void handleRunPreview()}
                disabled={!mapping.email || previewLoading}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-5 py-2.5 text-sm font-medium text-white transition-colors"
              >
                {previewLoading ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>Checking duplicates...</span>
                  </>
                ) : (
                  <>
                    <span>Preview & check duplicates</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Step 3: Preview & Duplicate Check */}
      {step === 'preview' && previewResult && (
        <div className="space-y-5">
          {/* Summary KPI Row */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Total rows</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                {previewResult.summary.totalRows.toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Ready to import</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {previewResult.summary.readyCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Already in DB</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-amber-600 dark:text-amber-400 tabular-nums">
                {previewResult.summary.existingInDbCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Duplicate in CSV</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-amber-600 dark:text-amber-400 tabular-nums">
                {previewResult.summary.duplicateInCsvCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Suppressed</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-amber-600 dark:text-amber-400 tabular-nums">
                {(previewResult.summary.suppressedCount ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Invalid rows</div>
              <div className="mt-1.5 font-mono text-xl font-semibold text-red-600 dark:text-red-400 tabular-nums">
                {previewResult.summary.invalidCount.toLocaleString()}
              </div>
            </div>
          </div>

          {(previewResult.summary.missingPlaceholdersCount ?? 0) > 0 && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-white dark:bg-slate-900 px-4 py-3 flex items-center gap-2.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                {previewResult.summary.missingPlaceholdersCount} row(s) have missing placeholder values that will default to empty strings. Click Preview on any row to inspect.
              </span>
            </div>
          )}

          {commitError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 px-4 py-3 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{commitError}</span>
            </div>
          )}

          {/* Filter Tabs & Preview Table */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 self-start">
                {(
                  [
                    { id: 'all', label: `All (${previewResult.summary.totalRows})` },
                    { id: 'ready', label: `Ready (${previewResult.summary.readyCount})` },
                    {
                      id: 'existing_in_db',
                      label: `In DB (${previewResult.summary.existingInDbCount})`,
                    },
                    {
                      id: 'duplicate_in_csv',
                      label: `CSV Dup (${previewResult.summary.duplicateInCsvCount})`,
                    },
                    {
                      id: 'suppressed',
                      label: `Suppressed (${previewResult.summary.suppressedCount ?? 0})`,
                    },
                    { id: 'invalid', label: `Invalid (${previewResult.summary.invalidCount})` },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setPreviewFilter(tab.id);
                      setPreviewPage(1);
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      previewFilter === tab.id
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <span className="text-xs text-slate-500 dark:text-slate-400">
                Suppressed contacts and duplicates are automatically protected
              </span>
            </div>

            {pagedPreviewRows.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                No rows in this category.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-3 px-4">Row</th>
                      <th className="py-3 px-4">Result</th>
                      <th className="py-3 px-4">Name</th>
                      <th className="py-3 px-4">Email</th>
                      <th className="py-3 px-4">Company</th>
                      <th className="py-3 px-4">Details / Warnings</th>
                      <th className="py-3 px-4 text-right">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                    {pagedPreviewRows.map((row) => (
                      <tr key={`${row.rowNumber}-${row.data.email}`}>
                        <td className="py-3 px-4 font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                          {row.rowNumber}
                        </td>
                        <td className="py-3 px-4 font-medium whitespace-nowrap">
                          <span
                            className={
                              row.classification === 'ready'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : row.classification === 'invalid'
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-amber-600 dark:text-amber-400'
                            }
                          >
                            {classificationLabel(row.classification)}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-900 dark:text-slate-100 max-w-[160px] truncate">
                          {row.data.fullName || '—'}
                        </td>
                        <td className="py-3 px-4 text-slate-700 dark:text-slate-300 max-w-[200px] truncate">
                          {row.data.email || '—'}
                        </td>
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-300 max-w-[160px] truncate">
                          {row.data.company || '—'}
                        </td>
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                          <div>
                            {row.errors.length > 0
                              ? row.errors.join(' ')
                              : `${row.data.status} · ${row.data.source}`}
                          </div>
                          {typeof row.existingEmailCount === 'number' && row.existingEmailCount > 0 && (
                            <div className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                              Already emailed {row.existingEmailCount}×
                            </div>
                          )}
                          {row.renderedPreview &&
                            row.renderedPreview.missingPlaceholders.length > 0 && (
                              <div className="text-[11px] text-amber-600 dark:text-amber-400">
                                Missing: {row.renderedPreview.missingPlaceholders.join(', ')}
                              </div>
                            )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {row.renderedPreview ? (
                            <button
                              type="button"
                              onClick={() => setInspectedRow(row)}
                              className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                            >
                              <Eye className="h-3 w-3" />
                              <span>Preview</span>
                            </button>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {previewTotalPages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-mono tabular-nums">
                  Page {previewPage} of {previewTotalPages}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={previewPage <= 1}
                    onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>Prev</span>
                  </button>
                  <button
                    type="button"
                    disabled={previewPage >= previewTotalPages}
                    onClick={() => setPreviewPage((p) => Math.min(previewTotalPages, p + 1))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Final Confirmation Bar */}
            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="text-xs text-slate-600 dark:text-slate-300">
                {previewResult.summary.readyCount > 0 ? (
                  <>
                    Ready to save{' '}
                    <strong className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {previewResult.summary.readyCount.toLocaleString()}
                    </strong>{' '}
                    eligible new leads
                    {importMode === 'leads_and_campaign' ? ` and create campaign "${campaignName}"` : ''}.
                  </>
                ) : importMode === 'leads_and_campaign' &&
                  includeExistingInCampaign &&
                  previewResult.summary.existingInDbCount > 0 ? (
                  <>
                    No new leads to insert;{' '}
                    <strong className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {previewResult.summary.existingInDbCount.toLocaleString()}
                    </strong>{' '}
                    existing lead(s) will be added to campaign "{campaignName}".
                  </>
                ) : (
                  'No eligible leads to import from this CSV.'
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setStep('mapping')}
                  disabled={committing}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                >
                  Edit mapping
                </button>
                <button
                  type="button"
                  disabled={
                    committing ||
                    (previewResult.summary.readyCount === 0 &&
                      !(
                        importMode === 'leads_and_campaign' &&
                        includeExistingInCampaign &&
                        previewResult.summary.existingInDbCount > 0
                      ))
                  }
                  onClick={() => void handleCommitImport()}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-5 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap"
                >
                  {committing ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      <span>
                        {importMode === 'leads_and_campaign'
                          ? 'Importing & building campaign...'
                          : 'Importing leads...'}
                      </span>
                    </>
                  ) : (
                    <span>
                      {importMode === 'leads_and_campaign'
                        ? 'Confirm import & create campaign'
                        : `Confirm & import ${previewResult.summary.readyCount.toLocaleString()}`}
                    </span>
                  )}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Step 4: Import Results */}
      {step === 'results' && commitResult && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Import complete
              </h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Processed {commitResult.summary.totalRows.toLocaleString()} CSV rows. Your database now
                contains {commitResult.summary.totalLeads.toLocaleString()} total leads.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Imported</div>
              <div className="mt-1.5 font-mono text-2xl font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {commitResult.summary.importedCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Skipped duplicates</div>
              <div className="mt-1.5 font-mono text-2xl font-semibold text-amber-600 dark:text-amber-400 tabular-nums">
                {commitResult.summary.skippedDuplicatesTotal.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Rejected (invalid)</div>
              <div className="mt-1.5 font-mono text-2xl font-semibold text-red-600 dark:text-red-400 tabular-nums">
                {commitResult.summary.invalidCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Failed writes</div>
              <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                {commitResult.summary.failedCount.toLocaleString()}
              </div>
            </div>
          </div>

          {(commitResult.failedRows.length > 0 ||
            commitResult.invalidRows.length > 0 ||
            commitResult.duplicateRows.length > 0) && (
            <div className="space-y-2">
              <h4 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Skipped & rejected rows (
                {commitResult.failedRows.length +
                  commitResult.invalidRows.length +
                  commitResult.duplicateRows.length}
                )
              </h4>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/60">
                      <th className="py-2.5 px-4">Row</th>
                      <th className="py-2.5 px-4">Email</th>
                      <th className="py-2.5 px-4">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {[
                      ...commitResult.failedRows,
                      ...commitResult.invalidRows,
                      ...commitResult.duplicateRows,
                    ]
                      .slice(0, 100)
                      .map((item, idx) => (
                        <tr key={`${item.rowNumber}-${idx}`}>
                          <td className="py-2 px-4 font-mono tabular-nums text-slate-500">
                            {item.rowNumber}
                          </td>
                          <td className="py-2 px-4 text-slate-900 dark:text-slate-100">
                            {item.email || '—'}
                          </td>
                          <td className="py-2 px-4 text-slate-600 dark:text-slate-400">
                            {item.reason}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {commitResult.campaignLaunchWarning && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
              {commitResult.campaignLaunchWarning}
            </div>
          )}

          {commitResult.campaign && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Campaign "{commitResult.campaign.name}" ({commitResult.campaign.status})
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {commitResult.campaign.totalRecipients.toLocaleString()} recipient(s) queued/added
                </div>
              </div>
              {onCampaignCreated && (
                <button
                  type="button"
                  onClick={onCampaignCreated}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-xs font-medium transition-colors whitespace-nowrap self-start sm:self-auto"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Open Campaigns</span>
                </button>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onImportCompleted}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 text-sm font-medium transition-colors"
            >
              View imported leads
            </button>
            <button
              type="button"
              onClick={resetAll}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
            >
              Import another CSV
            </button>
          </div>
        </section>
      )}

      {/* Row Personalized Preview Modal */}
      {inspectedRow?.renderedPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Row personalized email preview"
        >
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Personalized preview (Row {inspectedRow.rowNumber})
                </h3>
                <p className="text-xs font-mono text-slate-500">{inspectedRow.data.email}</p>
              </div>
              <button
                type="button"
                onClick={() => setInspectedRow(null)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close row preview"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6 space-y-4 text-xs">
              {inspectedRow.renderedPreview.missingPlaceholders.length > 0 && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-amber-700 dark:text-amber-300">
                  Missing placeholder values:{' '}
                  <span className="font-mono">
                    {inspectedRow.renderedPreview.missingPlaceholders.join(', ')}
                  </span>
                </div>
              )}
              <div>
                <div className="text-slate-500 mb-1">Subject</div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {inspectedRow.renderedPreview.subject || '—'}
                </div>
              </div>
              <div>
                <div className="text-slate-500 mb-1">Plain text</div>
                <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 whitespace-pre-wrap font-sans text-slate-800 dark:text-slate-200">
                  {inspectedRow.renderedPreview.text || '—'}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
