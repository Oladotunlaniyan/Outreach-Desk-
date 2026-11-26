export type PageId =
  | 'overview'
  | 'leads'
  | 'research'
  | 'import'
  | 'campaigns'
  | 'pipeline'
  | 'outbox'
  | 'settings';

export const LEAD_STATUSES = [
  'New',
  'Contacted',
  'Replied',
  'Interested',
  'Meeting',
  'Won',
  'Lost',
  'Invalid',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = ['manual', 'csv', 'ai_research'] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  manual: 'Manual',
  csv: 'CSV',
  ai_research: 'AI Research',
};

export type DatabaseConnectionState =
  | 'unconfigured'
  | 'disconnected'
  | 'connected'
  | 'connecting'
  | 'disconnecting';

export interface AuthStatusResponse {
  accessCodeConfigured: boolean;
  dbConfigured: boolean;
  dbConnected: boolean;
  dbState: DatabaseConnectionState;
  geminiConfigured: boolean;
  deepseekConfigured?: boolean;
}

export interface LoginResponse {
  token: string;
  expiresInSeconds: number;
  role: 'owner';
}

export interface SessionResponse {
  authenticated: boolean;
  role: 'owner';
  expiresAt: string | null;
}

export interface DashboardMetrics {
  totalLeads: number;
  emailsSent: number;
  replyRate: number;
  interestedLeads: number;
  meetingsBooked: number;
}

export interface PipelineBreakdownItem {
  status: LeadStatus;
  count: number;
}

export type CampaignStatus =
  | 'Draft'
  | 'Approved'
  | 'Sending'
  | 'Paused'
  | 'Completed'
  | 'Cancelled'
  | 'Failed';

export interface CampaignActivityItem {
  id: string;
  name: string;
  status: CampaignStatus;
  mailboxId: string;
  mailboxName?: string;
  mailboxEmail?: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  repliedCount: number;
  bouncedCount: number;
  approved: boolean;
  updatedAt: string;
}

export interface DailySendHistoryItem {
  dateKey: string;
  label: string;
  sent: number;
  failed: number;
}

export interface MailboxCapacityItem {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  fromName: string;
  fromEmail: string;
  dailyLimit: number;
  configured: boolean;
  sentToday: number;
  remainingToday: number;
}

export interface DashboardTodayStats {
  dateKey: string;
  emailsSentToday: number;
  emailsRemainingToday: number;
  activeVerifiedMailboxes: number;
  sendingFailuresToday: number;
}

export interface DashboardOverviewResponse {
  dbConnected: boolean;
  dbState: DatabaseConnectionState;
  dbError: string | null;
  metrics: DashboardMetrics | null;
  todayStats: DashboardTodayStats | null;
  pipelineBreakdown: PipelineBreakdownItem[];
  recentCampaigns: CampaignActivityItem[];
  recentEmailActivity: EmailHistoryItem[];
  mailboxCapacity: MailboxCapacityItem[];
  sendHistory14d?: DailySendHistoryItem[];
}

export interface MailboxEncryptionStatus {
  configured: boolean;
  valid: boolean;
  error: string | null;
}

export type SmtpSecurityMode = 'implicit_tls' | 'starttls';
export type MailboxVerificationStatus = 'untested' | 'verified' | 'failed';

export interface MailboxQuotaSnapshot {
  mailboxId: string;
  dateKey: string;
  timezone: 'UTC';
  dailyLimit: number;
  sentToday: number;
  reservedToday: number;
  unknownToday: number;
  remainingToday: number;
  resetsAt: string;
}

export interface MailboxQuotaResponse {
  mailbox: {
    id: string;
    name: string;
    senderName: string;
    senderEmail: string;
    enabled: boolean;
    archived: boolean;
    verificationStatus: MailboxVerificationStatus;
    dailyLimit: number;
  };
  quota: MailboxQuotaSnapshot;
}

export interface MailboxItem {
  id: string;
  name: string;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  securityMode: SmtpSecurityMode;
  secure: boolean;
  dailyLimit: number;
  enabled: boolean;
  archived: boolean;
  archivedAt: string | null;
  verificationStatus: MailboxVerificationStatus;
  lastTestedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationError: string;
  hasCredentials: boolean;
  referencedByHistory?: boolean;
  quota?: MailboxQuotaSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface MailboxFormPayload {
  name: string;
  senderName: string;
  senderEmail: string;
  replyTo?: string;
  smtpHost: string;
  smtpPort: number;
  securityMode: SmtpSecurityMode;
  smtpUsername: string;
  smtpPassword?: string;
  dailyLimit: number;
  enabled: boolean;
}

export interface MailboxesListResponse {
  encryptionStatus: MailboxEncryptionStatus;
  mailboxes: MailboxItem[];
}

export interface MailboxTestResponse {
  ok: boolean;
  message: string;
  errorCode: string | null;
  mailbox: MailboxItem;
}

export type EmailSendingStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'bounced'
  | 'cancelled';

export interface EmailAttemptMeta {
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  smtpResponseCode: number | null;
  acceptedCount: number | null;
  rejectedCount: number | null;
  ambiguous: boolean;
}

export interface EmailHistoryItem {
  id: string;
  mailboxId: string;
  mailboxName: string;
  leadId: string | null;
  campaignId?: string | null;
  campaignRecipientId?: string | null;
  direction: 'outbound' | 'inbound';
  status: EmailSendingStatus;
  toEmail: string;
  fromEmail: string;
  replyTo: string | null;
  subject: string;
  hasHtml: boolean;
  hasText: boolean;
  messageId: string | null;
  inReplyTo?: string | null;
  references?: string[];
  threadId: string;
  bounceType?: 'hard' | 'soft' | 'unknown' | null;
  attempts: number;
  error: string | null;
  errorCode: string | null;
  attemptMeta: EmailAttemptMeta | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailsListResponse {
  emails: EmailHistoryItem[];
  pagination: {
    page: number;
    limit: number;
    totalFiltered: number;
    totalPages: number;
  };
  totalEmails: number;
}

export interface SendEmailPayload {
  mailboxId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  idempotencyKey?: string;
  leadId?: string;
  threadWithPrevious?: boolean;
  inReplyTo?: string;
}

export interface SendEmailResponse {
  ok: boolean;
  deduplicated?: boolean;
  email: EmailHistoryItem;
  quota: MailboxQuotaSnapshot;
}

export interface ProductionReadinessCheckItem {
  key: string;
  label: string;
  ok: boolean;
  severity: 'required' | 'recommended';
  message: string;
}

export interface SettingsOverviewResponse {
  database: {
    configured: boolean;
    connected: boolean;
    state: DatabaseConnectionState;
    lastError: string | null;
  };
  auth: {
    accessCodeConfigured: boolean;
    jwtSecretConfigured: boolean;
  };
  geminiConfigured: boolean;
  deepseek?: {
    configured: boolean;
    model: string;
    baseUrl: string;
  };
  mailboxEncryption: MailboxEncryptionStatus;
  productionReadiness?: {
    nodeEnv: string;
    readyForProduction: boolean;
    checks: ProductionReadinessCheckItem[];
  };
  mailboxes: Array<{
    id: string;
    label: string;
    host: string;
    port: number;
    secure: boolean;
    fromName: string;
    fromEmail: string;
    dailyLimit: number;
    configured: boolean;
  }>;
}

export type AiEmailMode =
  | 'first_contact'
  | 'follow_up'
  | 'partnership'
  | 'sales'
  | 'general';

export type AiWritingTone =
  | 'professional'
  | 'conversational'
  | 'direct'
  | 'persuasive'
  | 'friendly'
  | 'formal';

export type AiEmailLength = 'short' | 'medium' | 'detailed';

export type AiRewriteAction =
  | 'rewrite'
  | 'improve'
  | 'shorten'
  | 'expand'
  | 'change_tone';

export interface AiStatusResponse {
  provider: 'deepseek';
  configured: boolean;
  available: boolean;
  model: string;
  baseUrl: string;
  status: 'ready' | 'configured' | 'missing_api_key' | 'invalid_credentials' | 'unreachable';
  message: string;
  usageToday: {
    totalRequestsToday: number;
    successfulToday: number;
    totalTokensToday: number;
  } | null;
}

export interface AiGeneratedEmailDraft {
  subject: string;
  text: string;
  html: string;
  personalizationNotes: string[];
  missingInformation: string[];
  meta: {
    provider: 'deepseek';
    model: string;
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    };
    durationMs: number;
    senderProfileUsed?: boolean;
    writingSamplesUsedCount?: number;
  };
}

export interface AiGenerateEmailPayload {
  leadId?: string;
  recipient?: {
    name?: string;
    firstName?: string;
    email?: string;
    company?: string;
    role?: string;
    industry?: string;
    website?: string;
    notes?: string;
  };
  mode: AiEmailMode;
  tone: AiWritingTone;
  length: AiEmailLength;
  objective?: string;
  instructions?: string;
  partnershipContext?: {
    proposal?: string;
    relevance?: string;
    mutualValue?: string;
    nextStep?: string;
  };
  previousContext?: string;
  useSenderProfile?: boolean;
  includeWritingSamples?: boolean;
}

export interface AiRewritePayload {
  action: AiRewriteAction;
  subject?: string;
  text?: string;
  html?: string;
  tone: AiWritingTone;
  length: AiEmailLength;
  instructions?: string;
  leadId?: string;
  useSenderProfile?: boolean;
  includeWritingSamples?: boolean;
}

export interface AiDraftResponse {
  ok: boolean;
  draft: AiGeneratedEmailDraft;
}

export interface AiSubjectLineSuggestion {
  subject: string;
  rationale: string;
}

export interface AiSubjectLinesResponse {
  ok: boolean;
  suggestions: AiSubjectLineSuggestion[];
  meta: AiGeneratedEmailDraft['meta'];
}

export interface AiCtaSuggestion {
  cta: string;
  rationale: string;
}

export interface AiCtaSuggestionsResponse {
  ok: boolean;
  suggestions: AiCtaSuggestion[];
  meta: AiGeneratedEmailDraft['meta'];
}

export type WritingSampleCategory =
  | 'emails'
  | 'professional_messages'
  | 'partnership_pitches'
  | 'follow_ups'
  | 'general_writing';

export const WRITING_SAMPLE_CATEGORY_LABELS: Record<WritingSampleCategory, string> = {
  emails: 'Emails',
  professional_messages: 'Professional messages',
  partnership_pitches: 'Partnership pitches',
  follow_ups: 'Follow-ups',
  general_writing: 'General writing',
};

export interface WritingSampleItem {
  id: string;
  title: string;
  category: WritingSampleCategory;
  content: string;
  description: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface SenderProfileCompletion {
  percentage: number;
  completedFields: number;
  totalFields: number;
  hasMeaningfulProfile: boolean;
  sections: {
    identity: boolean;
    work: boolean;
    credibility: boolean;
    writingPreferences: boolean;
    emailPreferences: boolean;
    writingSamples: boolean;
  };
}

export interface SenderProfileItem {
  exists: boolean;
  id: string | null;
  fullName: string;
  professionalTitle: string;
  organizationName: string;
  website: string;
  professionalEmail: string;
  shortIntro: string;
  workDescription: string;
  offerings: string;
  primaryAudience: string;
  problemsSolved: string;
  outreachObjectives: string;
  verifiedAchievements: string[];
  relevantExperience: string;
  caseStudies: string[];
  approvedMetrics: string[];
  relevantPartnerships: string[];
  preferredTone: '' | AiWritingTone;
  formalityLevel: '' | 'casual' | 'balanced' | 'formal';
  preferredLength: '' | AiEmailLength;
  sentenceStyle: string;
  commonPhrases: string[];
  dislikedPhrases: string[];
  habitsToAvoid: string[];
  defaultSignOff: string;
  emailSignature: string;
  preferredCtaStyle: string;
  includeRoleAndOrgInIntro: boolean;
  otherOutreachInstructions: string;
  writingSamples: WritingSampleItem[];
  completion: SenderProfileCompletion;
  updatedAt: string | null;
}

export interface SenderProfileResponse {
  profile: SenderProfileItem;
}

export interface WritingSamplePayload {
  title: string;
  category: WritingSampleCategory;
  content: string;
  description?: string;
}

export interface LeadNoteItem {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface LeadHistoryItem {
  id: string;
  status: string;
  at: string;
  note: string;
}

export interface LeadItem {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  role: string;
  website: string;
  linkedinUrl: string;
  location: string;
  industry: string;
  status: LeadStatus;
  source: LeadSource;
  tags?: string[];
  notes: LeadNoteItem[];
  notesCount: number;
  customFields?: Record<string, string>;
  optedOut: boolean;
  optedOutAt?: string | null;
  bounced: boolean;
  bouncedAt?: string | null;
  bounceReason?: string;
  emailCount?: number;
  lastSenderId?: string;
  lastContactedAt: string | null;
  lastRepliedAt: string | null;
  meetingBookedAt: string | null;
  history?: LeadHistoryItem[];
  createdAt: string;
  updatedAt: string;
}

export interface LeadEmailHistoryItem {
  id: string;
  direction: 'outbound' | 'inbound';
  status:
    | 'Queued'
    | 'Sending'
    | 'Sent'
    | 'Failed'
    | 'Bounced'
    | 'Cancelled'
    | EmailSendingStatus;
  toEmail: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  messageId: string | null;
  inReplyTo?: string | null;
  references?: string[];
  threadId: string;
  error: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface LeadsListResponse {
  leads: LeadItem[];
  pagination: {
    page: number;
    limit: number;
    totalFiltered: number;
    totalPages: number;
  };
  totalLeads: number;
}

export interface LeadDetailResponse {
  lead: LeadItem;
  emailHistory: LeadEmailHistoryItem[];
}

export interface LeadFormPayload {
  fullName: string;
  email: string;
  company: string;
  role: string;
  website: string;
  linkedinUrl: string;
  location: string;
  source: LeadSource;
  status: LeadStatus;
  initialNote?: string;
}

export type ImportFieldKey =
  | 'fullName'
  | 'email'
  | 'company'
  | 'role'
  | 'website'
  | 'linkedinUrl'
  | 'location'
  | 'source'
  | 'status'
  | 'notes'
  | 'tags'
  | 'subject'
  | 'bodyText'
  | 'bodyHtml';

export type ColumnMapping = Record<ImportFieldKey, string>;

export interface ImportRowInput {
  rowNumber: number;
  fullName: string;
  email: string;
  company: string;
  role: string;
  website: string;
  linkedinUrl: string;
  location: string;
  source: string;
  status: string;
  notes: string;
  tags?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  customFields?: Record<string, string>;
}

export type ImportRowClassification =
  | 'ready'
  | 'invalid'
  | 'existing_in_db'
  | 'duplicate_in_csv'
  | 'suppressed';

export interface ClassifiedImportRow {
  rowNumber: number;
  classification: ImportRowClassification;
  errors: string[];
  existingEmailCount?: number;
  suppressionReason?: string;
  renderedPreview?: {
    subject: string;
    text: string;
    html: string;
    missingPlaceholders: string[];
  };
  data: {
    fullName: string;
    email: string;
    company: string;
    role: string;
    website: string;
    linkedinUrl: string;
    location: string;
    source: string;
    status: string;
    notes: string;
    tags?: string[];
    subject?: string;
    bodyText?: string;
    bodyHtml?: string;
    customFields?: Record<string, string>;
  };
}

export interface ImportPreviewResponse {
  summary: {
    totalRows: number;
    validRowsCount: number;
    readyCount: number;
    invalidCount: number;
    existingInDbCount: number;
    duplicateInCsvCount: number;
    suppressedCount?: number;
    totalDuplicatesCount: number;
    missingPlaceholdersCount?: number;
  };
  rows: ClassifiedImportRow[];
}

export interface ImportCommitResponse {
  summary: {
    totalRows: number;
    importedCount: number;
    skippedExistingCount: number;
    skippedCsvDuplicateCount: number;
    skippedSuppressedCount?: number;
    skippedDuplicatesTotal: number;
    invalidCount: number;
    failedCount: number;
    totalLeads: number;
  };
  invalidRows: Array<{ rowNumber: number; email: string; reason: string }>;
  duplicateRows: Array<{
    rowNumber: number;
    email: string;
    classification: ImportRowClassification;
    reason: string;
  }>;
  failedRows: Array<{ rowNumber: number; email: string; reason: string }>;
  campaign?: CampaignItem;
  campaignLaunchWarning?: string;
}

export interface LeadBoardColumn {
  status: LeadStatus;
  totalInStatus: number;
  filteredTotal: number;
  leads: LeadItem[];
  hasMore: boolean;
}

export interface LeadBoardResponse {
  columns: LeadBoardColumn[];
  totalLeads: number;
  totalFiltered: number;
  limitPerColumn: number;
}

export type CampaignRecipientStatus =
  | 'pending'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'bounced'
  | 'ambiguous'
  | 'skipped_suppressed'
  | 'cancelled';

export interface CampaignRecipientCounts {
  pending: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  bounced: number;
  ambiguous: number;
  skipped_suppressed: number;
  cancelled: number;
}

export interface CampaignSendConfig {
  batchSize: number;
  delayMs: number;
  concurrency: number;
  dailySendCap: number | null;
  threadFollowUps: boolean;
}

export interface CampaignItem {
  id: string;
  name: string;
  description: string;
  status: CampaignStatus;
  mailboxId: string;
  mailboxName?: string;
  mailboxEmail?: string;
  mailboxVerified?: boolean;
  mailboxEnabled?: boolean;
  replyTo: string;
  subjectTemplate: string;
  bodyHtmlTemplate: string;
  bodyTextTemplate: string;
  sendConfig: CampaignSendConfig;
  approved: boolean;
  approvedAt: string | null;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  repliedCount: number;
  bouncedCount: number;
  counts: CampaignRecipientCounts;
  lastError: string;
  startedAt: string | null;
  pausedAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  lastBatchAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRecipientItem {
  id: string;
  campaignId: string;
  leadId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  role: string;
  website: string;
  location: string;
  industry: string;
  customFields: Record<string, string>;
  customSubject: string;
  customBodyHtml: string;
  customBodyText: string;
  renderedSubject: string;
  renderedHtml: string;
  renderedText: string;
  missingPlaceholders: string[];
  status: CampaignRecipientStatus;
  skipReason: string;
  emailMessageId: string | null;
  smtpMessageId: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
  attempts: number;
  lastError: string;
  lastErrorCode: string;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignsListResponse {
  campaigns: CampaignItem[];
}

export interface CampaignDetailResponse {
  campaign: CampaignItem;
  mailboxQuota: MailboxQuotaSnapshot | null;
  recipients: CampaignRecipientItem[];
  pagination: {
    page: number;
    limit: number;
    totalFiltered: number;
    totalPages: number;
  };
}

export type SuppressionReason = 'unsubscribe' | 'hard_bounce' | 'manual';

export interface SuppressionItem {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  detail: string;
  leadId: string | null;
  campaignId: string | null;
  suppressedAt: string;
}

export interface SuppressionsListResponse {
  suppressions: SuppressionItem[];
  counts: Record<SuppressionReason, number>;
  totalSuppressions: number;
  pagination: {
    page: number;
    limit: number;
    totalFiltered: number;
    totalPages: number;
  };
}

export type ResearchJobStatus =
  | 'Pending'
  | 'Running'
  | 'Paused'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

export type EmailConfidenceLevel =
  | 'verified_published'
  | 'published_generic'
  | 'inferred_unverified'
  | 'not_found';

export type ProspectReviewStatus = 'pending' | 'approved' | 'rejected' | 'imported';

export interface ResearchProspectDraftEmail {
  subject: string;
  text: string;
  html: string;
  personalizationNotes: string[];
  missingInformation: string[];
  generatedAt: string | null;
  model: string;
  senderProfileUsed: boolean;
  edited: boolean;
}

export interface ResearchProspectItem {
  id: string;
  company: string;
  domain: string;
  industry: string;
  location: string;
  website: string;
  businessSummary: string;
  fullName: string;
  firstName: string;
  lastName: string;
  role: string;
  email: string;
  emailConfidence: EmailConfidenceLevel;
  emailEvidence: {
    foundOnUrl: string;
    contactType: 'personal' | 'role_based' | 'snippet_only' | 'none';
    verificationNote: string;
  };
  sourceUrls: string[];
  linkedinUrl: string;
  relevanceNotes: string;
  duplicateStatus: {
    isDuplicate: boolean;
    matchType: 'none' | 'email' | 'website_domain' | 'company_and_location' | 'suppressed';
    existingLeadId?: string;
    existingLeadName?: string;
    existingLeadEmail?: string;
    reason: string;
  };
  reviewStatus: ProspectReviewStatus;
  importedLeadId: string | null;
  draftEmail: ResearchProspectDraftEmail | null;
}

export interface ResearchJobItem {
  id: string;
  query: {
    industry: string;
    location: string;
    targetRoles: string[];
    desiredCount: number;
    notes: string;
  };
  status: ResearchJobStatus;
  progress: {
    totalTarget: number;
    discoveredCount: number;
    verifiedEmailCount: number;
    importedCount: number;
    searchedQueriesCount: number;
    crawledSitesCount: number;
    batchSize: number;
    currentBatch: number;
    processedCandidateCount: number;
    totalCandidatesQueued: number;
    lastStepMessage: string;
  };
  searchQueriesExecuted: string[];
  prospects: ResearchProspectItem[];
  lastError: {
    code: string;
    message: string;
    retryAfterSeconds: number | null;
    at: string | null;
  } | null;
  resumeAfter: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchJobsListResponse {
  jobs: ResearchJobItem[];
}

export interface ResearchJobResponse {
  job: ResearchJobItem;
}

export interface ResearchGenerateEmailsResponse {
  ok: boolean;
  job: ResearchJobItem;
  generatedCount: number;
  skippedCount: number;
  pausedRateLimit: boolean;
  retryAfterSeconds?: number;
  warning?: string;
}

export interface ResearchImportResponse {
  ok: boolean;
  job: ResearchJobItem;
  summary: {
    requestedCount: number;
    importedCount: number;
    skippedExistingCount: number;
    skippedSuppressedCount: number;
    skippedNoEmailCount: number;
    skippedUnverifiedCount: number;
  };
  campaign?: CampaignItem;
  campaignWarning?: string;
}


